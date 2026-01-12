// src/index.js
import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import { Client } from '@stomp/stompjs';
import WebSocket from 'ws';
import { sendText, sendLocation } from './forwarder.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

// ✅ yalnız BACKEND/STOMP (newChat) üçün icazəli qruplar
const NEWCHAT_ONLY_GROUPS = new Set(
  String(process.env.NEWCHAT_ONLY_GROUP_JIDS || '120363031082342256@g.us')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);

const {
  PORT = 4242,
  EVOLUTION_API_KEY,
  GROUP_A_JID,
  GROUP_B_JID,
  GROUP_C_JID,
  TARGET_API_BASE = 'https://mototaksi.az:9898',
  WS_URL = 'wss://mototaksi.az:9898/ws',
  ONE_SIGNAL_APP_ID,
  ONE_SIGNAL_REST_API_KEY,
  ANDROID_CHANNEL_ID,
} = process.env;

// ✅ Hədəf (forward) qrupların siyahısı
const DEST_GROUPS = String(process.env.DEST_GROUP_JIDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const SUB_ONLY_TAIL = 'Sifarişi qəbul etmək üçün aylıq abunə haqqı ödəməlisiniz ✅ 5 AZN';

const ALLOWED_GROUPS = new Set([GROUP_A_JID, GROUP_B_JID, GROUP_C_JID].filter(Boolean));

/* ---------------- WA send queue (reliable) ---------------- */
const BURST_WINDOW_MS = Number(process.env.BURST_WINDOW_MS || 5000);

// retry parametrləri
const SEND_RETRY_MAX = Number(process.env.SEND_RETRY_MAX || 8);
const SEND_RETRY_BASE_MS = Number(process.env.SEND_RETRY_BASE_MS || 1200);
const SEND_RETRY_MAX_MS = Number(process.env.SEND_RETRY_MAX_MS || 20000);
const MAX_QUEUE_PER_JID = Number(process.env.MAX_QUEUE_PER_JID || 300);

const sendQueues = new Map();

function getQueue(jid) {
  if (!sendQueues.has(jid)) {
    sendQueues.set(jid, { busy: false, q: [], lastSentMs: 0 });
  }
  return sendQueues.get(jid);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function expBackoff(attempt) {
  const ms = Math.min(SEND_RETRY_MAX_MS, SEND_RETRY_BASE_MS * Math.pow(2, attempt));
  return ms + Math.floor(Math.random() * 250); // jitter
}

function isRetryableError(e) {
  // axios timeout -> çox vaxt göndərilib, sadəcə cavab gecikib
  if (e?.code === 'ECONNABORTED') return false;

  const status = e?.response?.status;
  if (!status) return true;              // digər network error
  if (status === 429 || status === 408) return true;
  if (status >= 500 && status <= 599) return true;
  return false;
}

function enqueueSend(jid, fn) {
  return new Promise((resolve, reject) => {
    const bucket = getQueue(jid);

    if (bucket.q.length >= MAX_QUEUE_PER_JID) {
      return reject(new Error(`Queue overflow for ${jid} (len=${bucket.q.length})`));
    }

    bucket.q.push({ fn, resolve, reject, attempt: 0 });

    if (!bucket.busy) processQueue(jid).catch(() => { });
  });
}

async function processQueue(jid) {
  const bucket = getQueue(jid);
  if (bucket.busy) return;
  bucket.busy = true;

  while (bucket.q.length) {
    const job = bucket.q[0]; // ✅ SHIFT YOX: yalnız success olanda çıxacaq

    // ✅ ilk mesaj dərhal: lastSentMs=0 -> gözləmir
    const now = Date.now();
    const elapsed = now - (bucket.lastSentMs || 0);
    if (bucket.lastSentMs && elapsed < BURST_WINDOW_MS) {
      await sleep(BURST_WINDOW_MS - elapsed);
    }

    try {
      const res = await job.fn();

      // ✅ yalnız UĞURLU göndərişdən sonra
      bucket.lastSentMs = Date.now();
      bucket.q.shift();
      job.resolve(res);

    } catch (e) {
      const retryable = isRetryableError(e);

      if (!retryable || job.attempt >= SEND_RETRY_MAX) {
        // retry yoxdur -> drop + reject
        bucket.q.shift();
        job.reject(e);
      } else {
        job.attempt += 1;
        const waitMs = expBackoff(job.attempt);
        console.error(
          `send retry: jid=${jid} attempt=${job.attempt} wait=${waitMs}ms status=${e?.response?.status || 'na'} msg=${e?.message}`
        );
        await sleep(Math.max(waitMs, BURST_WINDOW_MS));
        // job queue-da qalır, loop yenə cəhd edəcək
      }
    }
  }

  bucket.busy = false;
}

/* ---------------- dedup (LRU-vari) ---------------- */
const processedIds = new Map(); // id -> ts
const DEDUP_WINDOW_MS = Number(process.env.DEDUP_WINDOW_MS || 5 * 60 * 1000);

function seenRecently(id) {
  if (!id) return false;
  const now = Date.now();
  const ts = processedIds.get(id);
  if (ts && now - ts < DEDUP_WINDOW_MS) return true;
  processedIds.set(id, now);

  if (processedIds.size > 50000) {
    const cutoff = now - DEDUP_WINDOW_MS;
    for (const [mid, t] of processedIds) {
      if (t < cutoff) processedIds.delete(mid);
    }
  }
  return false;
}

// A mesaj id -> (destJid -> wasender msgId) xəritəsi
const forwardMap = new Map(); // key -> { ts, dest: { [jid]: msgId } }
const FORWARDMAP_TTL = 24 * 60 * 60 * 1000; // 24 saat

function fmKey(sourceGroupJid, sourceMsgId) {
  return `${sourceGroupJid}::${sourceMsgId}`;
}

function forwardMapPut(sourceGroupJid, sourceMsgId, destJid, msgId, quotedMessage) {
  if (!sourceMsgId || !destJid || !msgId) return;
  const key = fmKey(sourceGroupJid, sourceMsgId);
  const now = Date.now();

  const cur = forwardMap.get(key) || { ts: now, dest: {} };
  cur.ts = now;

  // ✅ B-də bu mesajı bot göndərir → fromMe true
  cur.dest[destJid] = { msgId, quotedMessage: quotedMessage || null, fromMe: true };

  forwardMap.set(key, cur);

  if (forwardMap.size > 20000) {
    const cutoff = now - FORWARDMAP_TTL;
    for (const [k, v] of forwardMap) {
      if (!v?.ts || v.ts < cutoff) forwardMap.delete(k);
    }
  }
}

function forwardMapGetRec(sourceGroupJid, sourceMsgId, destJid) {
  const key = fmKey(sourceGroupJid, sourceMsgId);
  const rec = forwardMap.get(key);
  if (!rec) return null;

  if (Date.now() - rec.ts > FORWARDMAP_TTL) {
    forwardMap.delete(key);
    return null;
  }
  return rec.dest?.[destJid] || null; // {msgId, quotedMessage, fromMe}
}

/* ---------------- helpers ---------------- */

function pickHeaders(req) {
  // yalnız lazım olanlar
  const h = req.headers || {};
  return {
    apikey: h['apikey'],
    authorization: h['authorization'],
    'x-api-key': h['x-api-key'],
    'user-agent': h['user-agent'],
    'content-type': h['content-type'],
    host: h['host'],
  };
}

function normEvent(ev) {
  const s = String(ev || '').trim();
  if (!s) return '';
  // messages.upsert / messages-upsert / MESSAGES_UPSERT -> messages_upsert
  return s.toLowerCase().replace(/[\s.\-]+/g, '_');
}

function shortJson(x, limit = 1200) {
  try {
    const s = JSON.stringify(x);
    return s.length > limit ? s.slice(0, limit) + '…' : s;
  } catch {
    return String(x);
  }
}

// İmza
function verifySignature(req) {
  const apikey = req.get('apikey') || req.body?.apikey;
  return !!apikey && !!EVOLUTION_API_KEY && apikey === EVOLUTION_API_KEY;
}

// Mətni çıxar
function extractText(msg) {
  if (!msg) return null;
  const txt =
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    null;
  return txt;
}

// "994556165535:50@s.whatsapp.net" -> "994556165535"
function parsePhoneFromSNetJid(jid) {
  if (!jid) return null;
  const m = String(jid).match(/^(\d+)(?::\d+)?@s\.whatsapp\.net$/);
  const out = m ? m[1] : null;
  return out;
}

// "279241862209772@lid" -> "279241862209772"
function parseDigitsFromLid(jid) {
  if (!jid) return null;
  const m = String(jid).match(/^(\d+)@lid$/);
  const out = m ? m[1] : String(jid).replace(/@.*/, '');
  return out;
}

function getDestGroupsFor(sourceJid) {
  // 1) B qrupundan gəlirsə: B-yə geri göndərmə, yalnız digər dest-lərə göndər
  /* if (sourceJid === GROUP_B_JID) {
    return DEST_GROUPS.filter(jid => jid !== GROUP_B_JID);
  } */

  // 2) A qrupundan gəlirsə: hər iki dest-ə göndər (listdə nə varsa)
  if (sourceJid === GROUP_A_JID || sourceJid === GROUP_B_JID || sourceJid == GROUP_C_JID) {
    return DEST_GROUPS.slice();
  }

  // fallback
  return DEST_GROUPS.filter(jid => jid !== sourceJid);
}

// JSON içində ilk s.whatsapp.net JID-ni tap
function findFirstSnetJidDeep(any) {
  if (any == null) return null;

  if (typeof any === 'string') {
    if (/^\d+(?::\d+)?@s\.whatsapp\.net$/.test(any)) return any;
    return null;
  }

  if (Array.isArray(any)) {
    for (const v of any) {
      const hit = findFirstSnetJidDeep(v);
      if (hit) return hit;
    }
    return null;
  }

  if (typeof any === 'object') {
    for (const k of Object.keys(any)) {
      const hit = findFirstSnetJidDeep(any[k]);
      if (hit) return hit;
    }
  }
  return null;
}

function normalizeEnvelope(data) {
  // Evolution bəzən:
  // data = { messages: [ ... ] }
  // data = { message: { ... } }
  // data = { ...messageObject... }
  // və ya req.body.data yerinə birbaşa req.body içində fields olur

  const root = data || {};

  // 1) Ən çox rast gəlinən: array messages
  const m1 = Array.isArray(root.messages) ? root.messages[0] : null;

  // 2) bəzən message obyekti
  const m2 = root.message && typeof root.message === 'object' ? root.message : null;

  // 3) bəzən root özü message obyekti olur (key/message var)
  const m3 = (root.key || root.message) ? root : null;

  const env = m1 || m2 || m3 || {};

  // key haradadırsa götür
  const key = env.key || root.key || {};

  // message haradadırsa götür
  const msg = env.message || root.message || env.msg || {};

  // remoteJid bəzən: key.remoteJid, env.remoteJid, env.chatId, env.from, env.to
  const remoteJid =
    key.remoteJid ||
    env.remoteJid ||
    env.chatId ||
    env.from ||
    env.to ||
    root.remoteJid ||
    root.chatId ||
    null;

  const participant =
    key.participant ||
    env.participant ||
    env.sender ||
    env.from ||
    root.participant ||
    root.sender ||
    null;

  const id =
    key.id ||
    env.id ||
    env.messageId ||
    env.stanzaId ||
    root.id ||
    root.messageId ||
    null;

  const fromMe =
    !!key.fromMe ||
    !!env.fromMe ||
    !!env?.key?.fromMe ||
    false;

  // ✅ BUNU ƏLAVƏ ET — Evolution-da reply info çox vaxt buradadır
  const contextInfo =
    env.contextInfo ||
    root.contextInfo ||
    msg.contextInfo ||
    root.message?.contextInfo ||
    null;

  // ✅ timestamp da bəzən env-də olur
  const messageTimestamp =
    env.messageTimestamp ||
    root.messageTimestamp ||
    msg.messageTimestamp ||
    null;

  return {
    key,
    msg,
    remoteJid,
    participant,
    id,
    fromMe,
    contextInfo,        // ✅ əlavə et
    messageTimestamp,   // ✅ əlavə et
    raw: env,
  };

}

// Webhook payload-dan mesaj vaxtını çıxar (ms)
function getMsgTsMs(env) {
  const raw =
    env?.raw?.messageTimestampMs ??
    env?.raw?.messageTimestamp ??        // ✅ əlavə et
    env?.messageTimestamp ??             // ✅ əlavə et (normalizeEnvelope-dən)
    env?.raw?.message?.messageTimestamp ??
    env?.msg?.messageTimestamp ??
    env?.raw?.timestamp ??
    env?.msg?.timestamp ??
    null;

  if (raw == null) return null;

  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;

  return n > 1e12 ? n : n * 1000;
}

function isTooOld(env, maxAgeMs) {
  const ts = getMsgTsMs(env);
  if (!ts) return false; // timestamp yoxdursa bloklama
  return (Date.now() - ts) > maxAgeMs;
}

// Asia/Baku üçün "YYYY-MM-DD HH:mm:ss"
function formatBakuTimestamp(date = new Date()) {
  // sv-SE locale "YYYY-MM-DD HH:mm:ss" verir; timezone-u Asia/Baku edirik
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Baku',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
    .format(date)
    .replace('T', ' ');
  // bəzi Node versiyalarında "YYYY-MM-DD HH.mm.ss" ola bilər — nöqtələri : ilə əvəz edək
  return parts.replaceAll('.', ':');
}

// ---- helpers (digərlərinin yanına əlavə et) ----

// Yalnız STATIK lokasiya (locationMessage). liveLocationMessage nəzərə alınmır.
function getStaticLocation(msg) {
  if (!msg) return null;

  // Bəzən location "view once" içində gəlir
  const core = msg.viewOnceMessageV2?.message || msg;

  const lm = core?.locationMessage;
  if (!lm) return null;

  const lat = Number(lm.degreesLatitude);
  const lng = Number(lm.degreesLongitude);

  return {
    kind: 'location',
    lat, lng,
    name: lm.name || null,
    address: lm.address || null,
    caption: lm.caption || null,
    url: lm.url || `https://maps.google.com/?q=${lat},${lng}`,
    // xam obyekti də qaytaraq ki, tam JSON-u log edək
    _raw: lm,
  };
}

/* ---------------- routes ---------------- */

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post(['/webhook', '/webhook/*'], async (req, res) => {
  // Wasender sürətli 200 istəyir
  res.status(200).json({ received: true });

  // 1) event-i əvvəl çıxar
  const evRaw = req.body?.event;
  const ev = normEvent(evRaw);

  // 2) log
  console.log('WEBHOOK HIT', {
    path: req.originalUrl,
    eventRaw: evRaw,
    eventNorm: ev,
    hasApikey: !!(req.get('apikey') || req.body?.apikey),
    headers: pickHeaders(req),
  });

  // 3) yalnız icazə verdiyin event-lər
  const allowedEvents = new Set(['messages_upsert']);
  if (!allowedEvents.has(ev)) {
    console.log('SKIP: event not allowed', { event: evRaw, ev });
    return;
  }

  // 4) apikey yoxlaması (default: permissive)
  const REQUIRE_WEBHOOK_APIKEY = process.env.REQUIRE_WEBHOOK_APIKEY === '1';

  // Evolution/Wasender bəzən apikey-ni BODY-ə də qoyur
  const gotKey = req.get('apikey') || req.body?.apikey || req.body?.data?.apikey;

  if (REQUIRE_WEBHOOK_APIKEY) {
    // verifySignature req.get('apikey') istifadə edirsə, BODY key-ni header kimi “kopyalamaq” olmur,
    // ona görə verifySignature-ni səndə belə yazmaq daha düz olar:
    // const apikey = req.get('apikey') || req.body?.apikey;
    // return apikey === EVOLUTION_API_KEY;
    if (!verifySignature(req)) {
      console.log('SKIP: invalid apikey', { got: gotKey ? '[present]' : '[missing]' });
      return;
    }
  } else {
    if (!gotKey) console.log('WARN: apikey missing (allowed because REQUIRE_WEBHOOK_APIKEY!=1)');
  }

  // 5) body qısa log
  console.log('UPSERT BODY (short)=', shortJson(req.body, 4000));

  try {
    // ✅ ən stabil: data-dan envelope çıxar
    const env = normalizeEnvelope(req.body?.data || req.body);

    // ✅ group routing (BURDA OLMALIDIR)
    const isNewChatOnlyGroup = NEWCHAT_ONLY_GROUPS.has(env.remoteJid);
    const isAllowedForwardGroup = ALLOWED_GROUPS.has(env.remoteJid);

    if (!isAllowedForwardGroup && !isNewChatOnlyGroup) {
      console.log('SKIP: not allowed group', {
        remoteJid: env.remoteJid,
        allowForward: [...ALLOWED_GROUPS],
        allowNewChatOnly: [...NEWCHAT_ONLY_GROUPS],
      });
      return; // ✅ burda OK, çünki handler-in içindədir
    }

    console.log('WEBHOOK SNAP', {
      id: env?.id ?? null,
      remoteJid: env?.remoteJid ?? null,
      participant: env?.participant ?? null,
      fromMe: !!env?.fromMe,
    });

    // fromMe at
    if (env?.fromMe) {
      console.log('SKIP: fromMe');
      return;
    }

    // ✅ env çıxarılandan dərhal sonra:
    const quoted = extractQuotedFromEnv(env);
    const isReply = !!quoted;

    // ✅ RemoteJid yoxdursa stop
    if (!env?.remoteJid) {
      console.log('SKIP: no remoteJid in env');
      return;
    }

    // ✅ əvvəl freshness (text + location üçün)
    const MAX_AGE_MS = Number(process.env.MAX_AGE_MS || 5 * 60 * 1000);

    if (!isReply && isTooOld(env, MAX_AGE_MS)) {
      console.log('SKIP: too old');
      return;
    }

    // Dedup (ID based)
    // Dedup (yalnız reply DEYİLSƏ)
    if (!isReply && seenRecently(env.id)) {
      console.log('SKIP: dedup (id)');
      return;
    }

    // ✅ Telefonu çıxar: üstünlük BODY-dəki @s.whatsapp.net, sonra participant, sonra @lid
    const foundSnet = findFirstSnetJidDeep(req.body);

    let phone =
      parsePhoneFromSNetJid(foundSnet) ||
      parsePhoneFromSNetJid(env.participant);

    if (!phone) phone = parseDigitsFromLid(env.participant);

    // əvvəl text-i çıxar (reply olsa belə conversation içində olur)
    const textBody = extractText(env.msg);

    const selfLoc = getStaticLocation(env.msg);
    const quotedLoc = getQuotedLocationFromEnv(env);

    // ✅ yalnız bu hallarda location kimi işlət:
    // 1) mesajın özü location-dursa
    // 2) ya da text YOXDUR, amma quoted location var (nadir hallarda)
    const shouldHandleAsLocation = !!selfLoc || (!textBody && !!quotedLoc);
    const effectiveLoc = selfLoc || (shouldHandleAsLocation ? quotedLoc : null);

    if (shouldHandleAsLocation && effectiveLoc) {
      const timestamp = formatBakuTimestamp();

      const normalizedPhone =
        (parsePhoneFromSNetJid(foundSnet) ||
          parsePhoneFromSNetJid(env.participant) ||
          parseDigitsFromLid(env.participant) ||
          '');

      const phonePrefixed = normalizedPhone ? `+${normalizedPhone}`.replace('++', '+') : '';

      const locationTitle =
        (effectiveLoc.caption && effectiveLoc.caption.trim()) ? effectiveLoc.caption :
          (effectiveLoc.name && effectiveLoc.name.trim()) ? effectiveLoc.name :
            '';

      const locNeedle = locationTitle
        ? `${locationTitle} @ ${effectiveLoc.lat.toFixed(6)},${effectiveLoc.lng.toFixed(6)}`
        : `${effectiveLoc.lat.toFixed(6)},${effectiveLoc.lng.toFixed(6)}`;

      if (!isReply) {

        const dupLoc = await isDuplicateByLastChats(locNeedle, "location", phonePrefixed);

        if (dupLoc) {
          console.log("SKIP: duplicate by last chats (location)");
          return;
        }
      }

      // ✅ Reply mesajlar BACKEND/STOMP-ə getməsin
      if (isReply) {
        console.log('SKIP BACKEND/STOMP (location): reply message');
      } else {
        // ✅ BACKEND/STOMP üçün newChat (location)
        const newChat = {
          id: Date.now(),
          groupId: "0",
          userId: 2,
          username: "Sifariş Qrupu İstifadəçisi",
          phone: phonePrefixed,
          isSeenIds: [],
          messageType: "location",
          isReply: "false",
          userType: "customer",
          message: locNeedle,
          timestamp,
          isCompleted: false,
          locationLat: effectiveLoc.lat,
          locationLng: effectiveLoc.lng,
          thumbnail: effectiveLoc._raw?.jpegThumbnail || null
        };

        try { publishStomp('/app/sendChatMessage', newChat); } catch (e) { }
        try {
          const oneSignalIds = await fetchPushTargets(0);
          if (oneSignalIds.length) {
            const preview = (newChat.message && newChat.message.trim())
              ? newChat.message.slice(0, 140)
              : `${effectiveLoc.lat.toFixed(6)}, ${effectiveLoc.lng.toFixed(6)}`;

            await sendPushNotification(oneSignalIds, '🪄🪄 Yeni Sifariş!!', `📍 ${preview}`);
          }
        } catch (e) { }
      }

      // ✅ STOMP-dan SONRA — WhatsApp qruplarına REAL location forward + mapping
      try {
        const targets = getDestGroupsFor(env.remoteJid);
        console.log('FORWARD targets (loc)=', targets);

        // ✅ NEWCHAT ONLY qrupdursa WhatsApp forward etmə
        if (isNewChatOnlyGroup) {
          console.log('SKIP WA FORWARD (location): newChatOnly group', { remoteJid: env.remoteJid });
          return;
        }

        for (const jid of targets) {
          let replyTo;
          let destQuotedMessage;
          let destFromMe = true; // ✅ default

          if (isReply && quoted?.stanzaId) {
            const rec = forwardMapGetRec(env.remoteJid, quoted.stanzaId, jid);
            replyTo = rec?.msgId || undefined;
            destQuotedMessage = rec?.quotedMessage || null;
            destFromMe = rec?.fromMe ?? true; // ✅ assign
          }

          let sentLocationMsgId = null;

          try {
            const respLoc = await enqueueSend(jid, () => sendLocation({
              to: jid,
              latitude: effectiveLoc.lat,
              longitude: effectiveLoc.lng,
              name: effectiveLoc.name || effectiveLoc.caption || '',
              address: effectiveLoc.address || '',
              replyTo,
              quotedMessage: destQuotedMessage || undefined,
              quotedText: quoted?.text || undefined,
              quotedFromMe: destFromMe,
            }));

            sentLocationMsgId = respLoc?.msgId || respLoc?.data?.msgId || null;

            // ✅ mapping (reply üçün lazımdır)
            if (sentLocationMsgId) {
              const quotedMessageForDest = {
                locationMessage: {
                  degreesLatitude: effectiveLoc.lat,
                  degreesLongitude: effectiveLoc.lng,
                  name: effectiveLoc.name || '',
                  address: effectiveLoc.address || '',
                  jpegThumbnail: effectiveLoc._raw?.jpegThumbnail || undefined,
                },
              };
              Object.keys(quotedMessageForDest.locationMessage).forEach(k => {
                if (quotedMessageForDest.locationMessage[k] === undefined) delete quotedMessageForDest.locationMessage[k];
              });

              forwardMapPut(env.remoteJid, env.id, jid, sentLocationMsgId, quotedMessageForDest);
            }

          } catch (err) {
            console.error('sendLocation failed (NO FALLBACK)', err?.response?.data || err?.message);
            // ❌ Heç bir text göndərmə
            // istəsən notify üçün 1 dənə admin log / push edə bilərsən, amma WA-ya link atma
          }

          // ✅ Tail: reply DEYİLSƏ həmişə göndər (location uğurlu da olsa, fallback da olsa)
          if (!isReply) {
            await enqueueSend(jid, () => sendText({
              to: jid,
              text: `Sifarişi qəbul etmək üçün əlaqə: ${phonePrefixed || '—'}`
            }));
          }
        }

      } catch (e) {
        console.error('Forward (location) error:', e?.response?.data || e.message);
      }

      return;
    }

    // 2) text
    if (!textBody) {
      console.log('SKIP: no textBody');
      return;
    }

    const timestamp = formatBakuTimestamp();
    const normalizedPhone = phone ? `+${phone}`.replace('++', '+') : '';
    const cleanMessage = String(textBody);

    // ✅ shouldBlockMessage filtri
    if (shouldBlockMessage(cleanMessage, isReply)) {
      console.log('SKIP: blocked by shouldBlockMessage');
      return;
    }

    // ✅ DB-based dublikat (reply deyilsə)
    if (!isReply) {
      const dup = await isDuplicateByLastChats(cleanMessage, "text", normalizedPhone);
      if (dup) {
        console.log("SKIP: duplicate by last chats (text)");
        return;
      }
    }

    // ✅ Reply mesajlar BACKEND/STOMP-ə getməsin
    if (isReply) {
      console.log('SKIP BACKEND/STOMP (text): reply message');
    } else {
      // ✅ BACKEND/STOMP newChat (text)
      const newChat = {
        id: Date.now(),
        groupId: "0",
        userId: 2,
        username: 'Sifariş Qrupu İstifadəçisi',
        phone: normalizedPhone,
        isSeenIds: [],
        messageType: "text",
        isReply: "false",
        userType: "customer",
        message: cleanMessage,
        timestamp,
        isCompleted: false,
      };

      try { publishStomp('/app/sendChatMessage', newChat); } catch (e) { }

      // ✅ OneSignal push (yalnız non-reply)
      try {
        const oneSignalIds = await fetchPushTargets(0);
        if (oneSignalIds.length) {
          const preview = (cleanMessage || '').slice(0, 140);
          await sendPushNotification(oneSignalIds, '🪄🪄 Yeni Sifariş!!', `📩 ${preview}`);
        }
      } catch (e) { }
    }

    // ✅ STOMP-dan SONRA — WhatsApp qruplarına forward (replyTo + map)
    try {
      const targets = getDestGroupsFor(env.remoteJid);
      console.log('FORWARD targets (text)=', targets);

      const phoneForTail = normalizedPhone || '—';
      let bridgedBase = cleanMessage;

      // ✅ NEWCHAT ONLY qrupdursa WhatsApp forward etmə
      if (isNewChatOnlyGroup) {
        console.log('SKIP WA FORWARD (text): newChatOnly group', { remoteJid: env.remoteJid });
        return;
      }

      for (const jid of targets) {
        let replyTo;
        let destQuotedMessage;
        let destFromMe = true;

        if (isReply && quoted?.stanzaId) {
          const rec = forwardMapGetRec(env.remoteJid, quoted.stanzaId, jid);
          replyTo = rec?.msgId || undefined;
          destQuotedMessage = rec?.quotedMessage || null;
          destFromMe = rec?.fromMe ?? true; // ✅ assign
        }

        if (isReply) {
          console.log("REPLY DEBUG", {
            sourceQuotedStanzaId: quoted?.stanzaId,
            destReplyTo: replyTo || null,
            quotedText: quoted?.text || null,
            quotedParticipant: quoted?.participant || null,
          });
        }

        let bridged = bridgedBase;
        if (!isReply) bridged = `${bridged}\n\nSifarişi qəbul etmək üçün əlaqə: ${phoneForTail}`;

        const resp = await enqueueSend(jid, () => sendText({
          to: jid,
          text: bridged,
          replyTo,
          quotedText: quoted?.text || undefined,
          quotedMessage: destQuotedMessage || undefined, // ✅ əsas
          quotedFromMe: destFromMe,
        }));

        // ✅ Mapping yalnız “əsas” mesajlar üçün (reply-lərdə env.id map etmək çox vaxt lazım olmur)
        const msgId = resp?.msgId || resp?.data?.msgId;
        if (msgId) {
          forwardMapPut(env.remoteJid, env.id, jid, msgId);
        }

      }
    } catch (e) {
      console.error('Forward (text) error:', e?.response?.data || e.message);
    }
  } catch (e) {
    console.error('Webhook handler error:', e?.response?.data || e.message);
  }
});

function isValidUUID(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(String(s || '').trim());
}

async function sendPushNotification(ids, title, body) {
  // normalize incoming ids and keep only valid OneSignal UUIDs
  const input = (Array.isArray(ids) ? ids : [ids]).map(x => String(x || '').trim());
  const validInput = [...new Set(input.filter(isValidUUID))];
  if (!validInput.length) {
    return;
  }

  // fetch users and keep ONLY those with appVersion >= 25
  let v25Ids = [];
  try {
    const usersRes = await axios.get(`${TARGET_API_BASE}/api/v5/user`, { timeout: 15000 });
    const users = Array.isArray(usersRes?.data) ? usersRes.data : [];

    const v25Set = new Set(
      users
        .filter(u => Number(u?.appVersion) >= 25 && u?.oneSignal && isValidUUID(String(u.oneSignal)))
        .map(u => String(u.oneSignal).trim())
    );

    // intersect provided ids with v25 set
    v25Ids = validInput.filter(id => v25Set.has(id));
  } catch (err) {
    console.error('sendPushNotification: failed to load users; aborting send. Err =', err?.message);
    return; // hard stop: do NOT send if we can’t verify users
  }

  if (!v25Ids.length) {
    return;
  }

  const payload = {
    app_id: ONE_SIGNAL_APP_ID,
    include_subscription_ids: v25Ids,
    headings: { en: title },
    contents: { en: body },
    android_channel_id: ANDROID_CHANNEL_ID,
    data: { screen: 'OrderGroup', groupId: 1 },
  };

  const fire = async (tag) => {
    try {
      const res = await axios.post('https://onesignal.com/api/v1/notifications', payload, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${ONE_SIGNAL_REST_API_KEY}`,
        },
        timeout: 15000,
      });
      return true;
    } catch (e) {
      console.error(`OneSignal push error (${tag}):`, e?.response?.data || e.message);
      return false;
    }
  };

  // one attempt + single retry
  const ok = await fire('try1');
  if (!ok) {
    await new Promise(r => setTimeout(r, 2000));
    await fire('retry');
  }
}

async function fetchPushTargets(senderUserId = 0) {
  try {
    const [usersRes, groupRes] = await Promise.all([
      axios.get(`${TARGET_API_BASE}/api/v5/user`, { timeout: 15000 }),
      axios.get(`${TARGET_API_BASE}/api/v5/chat_group/1`, { timeout: 15000 }),
    ]);

    const mutedList = Array.isArray(groupRes?.data?.mutedUserIds)
      ? groupRes.data.mutedUserIds.map(Number)
      : [];

    const all = usersRes?.data || [];
    return all
      .filter(u =>
        Number(u.id) !== Number(senderUserId) &&
        !(u.userType || '').includes('customer') &&
        !mutedList.includes(Number(u.id)) &&
        !!u.oneSignal
      )
      .map(u => u.oneSignal)
      .filter(Boolean);
  } catch (e) {
    console.error('fetchPushTargets error:', e?.response?.data || e.message);
    return [];
  }
}

function shouldBlockMessage(raw, isReply = false) {
  if (!raw) return false;

  const text = String(raw).normalize('NFKC');
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  const exactBlockSet = new Set([
    'tapıldı', 'tapildi', 'verildi', 'verdim',
    'hazır', 'hazir', 'hazirdi', 'hazırdır', 'hazirdir',
    '✅', '➕',
  ]);

  if (exactBlockSet.has(lower)) return true;

  // ✅ tək "+" yalnız reply DEYİLSƏ bloklansın
  if (!isReply && /^\s*\++\s*$/.test(text)) return true;

  const cancelRe = /\b(l[əe]ğ?v|legv|stop)\b/i;
  if (cancelRe.test(text)) return true;

  if (/\btap(i|ı)ld(i|ı)\b/i.test(text)) return true;

  if (/\+994[\d\s-]{7,}/.test(lower)) return true;

  return false;
}

const CHAT_LIMIT = Number(process.env.CHAT_LIMIT || 10);
const CHAT_GROUP_IDS = String(process.env.CHAT_GROUP_IDS || "0,1");

// mesajı stabil müqayisə üçün normalize
function normMsg(s) {
  return String(s || "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

// /api/chats çağırışı (limit + groupIds)
async function getChats(params) {
  // sənin yazdığın kimi:
  // export const getChats = (params) => api.get('/api/chats', { params });
  // backend-də isə axios ilə:
  return axios.get(`${TARGET_API_BASE}/api/chats`, {
    params,
    timeout: 15000,
  });
}

/**
 * Dublikat yoxla:
 * - messageText: incoming text (və ya locationTitle)
 * - messageType: "text" | "location"
 * - phone: +994... (istəsən daxil et)
 */
async function isDuplicateByLastChats(messageText, messageType = "text", phone = "") {
  const needle = normMsg(messageText);
  if (!needle) return false;

  try {
    const resp = await getChats({ limit: CHAT_LIMIT, groupIds: CHAT_GROUP_IDS });
    const data = resp?.data;

    // API iki cür qayıda bilər: {messages:[...]} və ya birbaşa array
    const list =
      Array.isArray(data?.messages) ? data.messages :
        Array.isArray(data) ? data :
          [data?.message || data].filter(Boolean);

    if (!list.length) return false;

    // optional: phone da yoxlamağa qatmaq istəyirsənsə
    const phoneNeedle = String(phone || "").trim();

    return list.some((c) => {
      const m = normMsg(c?.message);
      if (!m) return false;

      const t = String(c?.messageType || c?.type || "").toLowerCase();
      const sameType = !messageType ? true : (t === String(messageType).toLowerCase());

      // phone check: istəyirsənsə aktiv et
      const samePhone = !phoneNeedle
        ? true
        : (String(c?.phone || "").trim() === phoneNeedle);

      return sameType && samePhone && (m === needle);
    });

  } catch (e) {
    // endpoint yatıbsa dublikat bloklamayaq (fail-open)
    console.error("isDuplicateByLastChats error:", e?.response?.status, e?.response?.data || e?.message);
    return false;
  }
}

function extractQuotedFromEnv(env) {
  const ctx = env?.contextInfo || null;
  const q = ctx?.quotedMessage;
  if (!q) return null;

  const qt =
    q.conversation ||
    q.extendedTextMessage?.text ||
    q.imageMessage?.caption ||
    q.videoMessage?.caption ||
    q.documentMessage?.caption ||
    q.documentMessage?.fileName ||
    (q.locationMessage ? `[location] ${q.locationMessage.name || ''}`.trim() : null) ||
    (q.audioMessage?.ptt ? '[voice]' : null) ||
    null;

  return {
    text: qt,
    participant: ctx?.participant || null,
    stanzaId: ctx?.stanzaId || ctx?.quotedMessageId || ctx?.quotedMsgId || null,    // quoted msg id (incoming)
    quotedMessage: q,                   // ✅ ƏN VACİB: obyektin özü
    _rawCtx: ctx,
  };
}

function getQuotedLocationFromEnv(env) {
  const ctx = env?.contextInfo || null;
  const lm = ctx?.quotedMessage?.locationMessage;
  if (!lm) return null;

  const lat = Number(lm.degreesLatitude);
  const lng = Number(lm.degreesLongitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  return {
    kind: 'location',
    lat, lng,
    name: lm.name || null,
    address: lm.address || null,
    caption: lm.caption || null,
    url: lm.url || `https://maps.google.com/?q=${lat},${lng}`,
    _raw: lm,
    _fromQuoted: true,
  };
}

/* ---------------- STOMP (WebSocket) client ---------------- */
let stompClient = null;
let stompReady = false;
const publishQueue = []; // bağlanana qədər yığılsın

function initStomp() {
  if (stompClient) return;

  stompClient = new Client({
    brokerURL: WS_URL,
    // Node mühitində WebSocket factory gərəkdir:
    webSocketFactory: () => new WebSocket(WS_URL),
    reconnectDelay: 5000,
    heartbeatIncoming: 20000,
    heartbeatOutgoing: 20000,
    onConnect: () => {
      stompReady = true;
      // queue boşalt
      while (publishQueue.length) {
        const { destination, body } = publishQueue.shift();
        try {
          stompClient.publish({ destination, body });
        } catch (e) {
          console.error('STOMP publish (flush) error:', e?.message);
        }
      }
    },
    onStompError: (frame) => {
      stompReady = false;
      console.error('STOMP error:', frame.headers?.message, frame.body);
    },
    onWebSocketClose: () => {
      stompReady = false;
    },
    debug: (str) => {
    },
  });

  stompClient.activate();
}

function publishStomp(destination, payloadObj) {
  const body = JSON.stringify(payloadObj);
  if (stompClient && stompReady) {
    try {
      stompClient.publish({ destination, body });
    } catch (e) {
      console.error('STOMP publish error, queueing:', e?.message);
      publishQueue.push({ destination, body });
    }
  } else {
    publishQueue.push({ destination, body });
    initStomp();
  }
}

// server startında init
initStomp();

/* ---------------- start ---------------- */

app.listen(PORT, () => { });

