// src/index.js
import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import { Client } from '@stomp/stompjs';
import WebSocket from 'ws';
import { sendText, sendLocation } from './forwarder.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

const {
  PORT = 4242,
  EVOLUTION_API_KEY,
  GROUP_A_JID,
  TARGET_API_BASE = 'https://mototaksi.az:9898',
  WS_URL = 'wss://mototaksi.az:9898/ws',
  ONE_SIGNAL_APP_ID,
  ONE_SIGNAL_REST_API_KEY,
  ANDROID_CHANNEL_ID,
} = process.env;

const ALLOWED_GROUPS = new Set(
  [GROUP_A_JID].filter(Boolean)
);

// ✅ Hədəf (forward) qrupların siyahısı
const DEST_GROUPS = String(process.env.DEST_GROUP_JIDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// xüsusi abonə mesajı olan qrup
const SUB_ONLY_DEST_JID = '120363424109826549@g.us';
const SUB_ONLY_TAIL = 'Sifarişi qəbul etmək üçün aylıq abunə haqqı ödəməlisiniz ✅ 5 AZN';

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
  const status = e?.response?.status;
  if (!status) return true;              // network/timeout
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

function forwardMapPut(sourceGroupJid, sourceMsgId, destJid, msgId) {
  if (!sourceMsgId || !destJid || !msgId) return;
  const key = fmKey(sourceGroupJid, sourceMsgId);
  const now = Date.now();
  const cur = forwardMap.get(key) || { ts: now, dest: {} };
  cur.ts = now;
  cur.dest[destJid] = msgId;
  forwardMap.set(key, cur);

  // sadə cleanup
  if (forwardMap.size > 20000) {
    const cutoff = now - FORWARDMAP_TTL;
    for (const [k, v] of forwardMap) {
      if (!v?.ts || v.ts < cutoff) forwardMap.delete(k);
    }
  }
}

function forwardMapGet(sourceGroupJid, sourceMsgId, destJid) {
  const key = fmKey(sourceGroupJid, sourceMsgId);
  const rec = forwardMap.get(key);
  if (!rec) return null;
  if (Date.now() - rec.ts > FORWARDMAP_TTL) {
    forwardMap.delete(key);
    return null;
  }
  return rec.dest?.[destJid] || null;
}

/* ---------------- helpers ---------------- */

// İmza
function verifySignature(req) {
  const apikey = req.get('apikey'); // Evolution header
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
  if (sourceJid === GROUP_A_JID) {
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
  const env = data?.messages || data?.message || data || {};
  const key = env.key || {};
  const msg = env.message || {};
  const out = {
    key,
    msg,
    remoteJid: key.remoteJid || env.remoteJid,
    participant: key.participant || env.participant,
    id: key.id || env.id,
    fromMe: !!key.fromMe || !!env.fromMe,
    raw: env,
  };
  return out;
}

// Webhook payload-dan mesaj vaxtını çıxar (ms)
function getMsgTsMs(env) {
  const raw =
    env?.raw?.messageTimestampMs ??
    env?.raw?.messageTimestamp ??
    env?.raw?.timestamp ??
    env?.msg?.messageTimestamp ??
    env?.msg?.timestamp ??
    null;

  if (raw == null) return null;

  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;

  // saniyə / millisecond normalize
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

  console.log('WEBHOOK HIT', {
    path: req.originalUrl,
    hasApikey: !!req.get('apikey'),
    event: req.body?.event,
  });

  try {

    if (!verifySignature(req)) {
      return;
    }

    const { event, data } = req.body || {};

    const allowed = new Set(['MESSAGES_UPSERT']);
    if (!allowed.has(event)) return;

    const env = normalizeEnvelope(data);

    // Özümüzdən çıxanları at
    if (env.fromMe) return;

    if (!env.remoteJid || !ALLOWED_GROUPS.has(env.remoteJid)) return;

    // ✅ əvvəl freshness (text + location üçün)
    const MAX_AGE_MS = Number(process.env.MAX_AGE_MS || 5 * 60 * 1000);

    // reply mesajları istisna (text üçün lazımdır)
    const quoted = extractQuoted(env.msg);
    const isReply = !!quoted;

    // Köhnədirsə və reply deyilsə, ignore et (location da bura düşür)
    if (!isReply && isTooOld(env, MAX_AGE_MS)) return;

    // Dedup (freshness-dən sonra daha məntiqlidir)
    if (seenRecently(env.id)) return;

    // Telefonu çıxar: üstünlük BODY-dəki @s.whatsapp.net, sonra participant (@s.whatsapp.net),
    // sonra participant @lid
    const foundSnet = findFirstSnetJidDeep(req.body);

    let phone =
      parsePhoneFromSNetJid(foundSnet) ||
      parsePhoneFromSNetJid(env.participant);

    if (!phone) phone = parseDigitsFromLid(env.participant);

    // 1) ƏVVƏL statik location olub-olmadığını yoxla
    const loc = getStaticLocation(env.msg);

    if (loc) {

      const timestamp = formatBakuTimestamp();
      const normalizedPhone = (parsePhoneFromSNetJid(findFirstSnetJidDeep(req.body)) ||
        parsePhoneFromSNetJid(env.participant) ||
        parseDigitsFromLid(env.participant) ||
        '');
      const phonePrefixed = normalizedPhone ? `+${normalizedPhone}`.replace('++', '+') : '';

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
        message: loc.caption || loc.name || "",
        timestamp,
        isCompleted: false,
        // yalnız backend üçün:
        locationLat: loc.lat,
        locationLng: loc.lng,
        thumbnail: loc._raw?.jpegThumbnail || null
      };

      publishStomp('/app/sendChatMessage', newChat);

      // push preview: caption/name varsa onu, yoxdursa koordinatı göstər
      const preview = (newChat.message && newChat.message.trim())
        ? newChat.message.slice(0, 140)
        : `${loc.lat.toFixed(6)}, ${loc.lng.toFixed(6)}`;

      try {
        const oneSignalIds = await fetchPushTargets(0);
        if (oneSignalIds.length) {
          await sendPushNotification(
            oneSignalIds,
            '🪄🪄 Yeni Sifariş!!',
            `📍 ${preview}`
          );
        }
      } catch (pushErr) {
        console.error('Post-publish push error:', pushErr?.message);
      }

      // ✅ STOMP-dan SONRA — WhatsApp qruplarına REAL LOCATION pin forward
      try {
        const targets = getDestGroupsFor(env.remoteJid);
        if (targets.length) {
          for (const jid of targets) {
            const respLoc = await enqueueSend(jid, () => sendLocation({
              to: jid,
              latitude: loc.lat,
              longitude: loc.lng,
              name: loc.name || (newChat.message?.trim() || 'Konum'),
              address: loc.address || undefined,
            }));

            const msgIdLoc = respLoc?.msgId || respLoc?.data?.msgId;
            if (msgIdLoc) {
              forwardMapPut(env.remoteJid, env.id, jid, msgIdLoc);
            }

            // ✅ sonra tail mesajını da göndər
            await enqueueSend(jid, () => sendText({
              to: jid,
              text: (jid === SUB_ONLY_DEST_JID)
                ? SUB_ONLY_TAIL
                : `Sifarişi qəbul etmək üçün əlaqə: ${phonePrefixed}`
            }));
          }

        }
      } catch (e) {
        console.error('Forward (location) error:', e?.response?.data || e.message);
      }

      return; // Location emal olundu, dayandır
    }

    const textBody = extractText(env.msg);
    if (!textBody) return;

    const timestamp = formatBakuTimestamp();

    // Mesaj olduğu kimi qalsın, nömrəni ayrıca field kimi verək
    const normalizedPhone = phone ? `+${phone}` : '';
    const cleanMessage = String(textBody);

    // 🔁 dublikat varsa dayandır
    if (!isReply && await isDuplicateChatMessage(cleanMessage)) return;

    // newChat obyektində message sahəsini buradakı kimi dəyiş:
    const newChat = {
      id: Date.now(),
      groupId: "0",
      userId: 2,
      username: 'Sifariş Qrupu İstifadəçisi',
      phone: normalizedPhone,           // +994… varsa burada
      isSeenIds: [],
      messageType: "text",
      isReply: "false",
      userType: "customer",
      message: cleanMessage,            // yalnız sifariş mətni
      timestamp,
      isCompleted: false,
    };

    // ✅ Mobil “sendMessageToSocket” ilə eyni hərəkət: WebSocket (STOMP) publish
    // Backend-də /app/sendChatMessage bu obyekti qəbul edib DB-yə yazır və /topic/sifarisqrupu'na yayır
    publishStomp('/app/sendChatMessage', newChat);

    // 🔔 Publish-dən sonra push bildirişi (mobil loqika ilə eyni filtr)
    try {
      const oneSignalIds = await fetchPushTargets(0); // sender DB user deyil, 0 veririk
      if (oneSignalIds.length) {
        const preview = (cleanMessage || '').slice(0, 140);
        await sendPushNotification(
          oneSignalIds,
          '🪄🪄 Yeni Sifariş!!',
          `📩 ${preview}`
        );
      }
    } catch (pushErr) {
      console.error('Post-publish push error:', pushErr?.message);
    }

    // ✅ STOMP-dan SONRA — WhatsApp qruplarına forward (text üçün)
    try {
      const phoneForTail = normalizedPhone || '—';

      let bridgedBase = cleanMessage; // əsas mesaj

      const targets = getDestGroupsFor(env.remoteJid);
      if (targets.length) {
        for (const jid of targets) {
          let replyTo = undefined;

          if (isReply && quoted?.stanzaId) {
            replyTo = forwardMapGet(env.remoteJid, quoted.stanzaId, jid) || undefined;
          }

          // ✅ dest-ə görə tail
          let bridged = bridgedBase;

          if (!isReply) {
            if (jid === SUB_ONLY_DEST_JID) {
              // ✅ burada nömrə GÖRÜNMƏSİN, yalnız abonə yazısı olsun
              bridged = `${bridged}\n\n${SUB_ONLY_TAIL}`;
            } else {
              // digər dest-lərdə köhnə qayda (nömrə)
              bridged = `${bridged}\n\nSifarişi qəbul etmək üçün əlaqə: ${phoneForTail}`;
            }
          }

          const resp = await enqueueSend(jid, () => sendText({
            to: jid,
            text: bridged,
            replyTo,
          }));

          if (!isReply) {
            const msgId = resp?.msgId || resp?.data?.msgId;
            forwardMapPut(env.remoteJid, env.id, jid, msgId);
          }
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

function shouldBlockMessage(raw) {
  if (!raw) return false;

  const text = String(raw).normalize('NFKC');   // diakritik normallaşdırma
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // 1) Tam olaraq bu cavablar gəlsə → blokla
  const exactBlockSet = new Set([
    'tapıldı',
    'tapildi',
    'verildi',
    'verdim',
    'hazır',
    'hazir',
    'hazirdi',
    'hazırdır',
    'hazirdir',
    '✅',
    '➕',
  ]);

  if (exactBlockSet.has(lower)) return true;

  // 2) Yalnız + işarələrindən ibarət mesajlar → blokla
  if (/^\s*\++\s*$/.test(text)) return true;

  // 3) Ləğv / Legv / stop → blokla
  const cancelRe = /\b(l[əe]ğ?v|legv|stop)\b/i;
  if (cancelRe.test(text)) return true;

  // 4) "tapildi/tapıldı" içində keçirsə (məsələn cümlə kimi)
  if (/\btap(i|ı)ld(i|ı)\b/i.test(text)) return true;

  // 5) +994 ilə başlayan telefon nömrəsi varsa → blokla
  if (/\+994[\d\s-]{7,}/.test(lower)) return true;

  // qalan hər şeyə icazə ver
  return false;
}

async function isDuplicateChatMessage(messageText) {
  try {
    // son mesajları götür (sürətli olsun deyə limit kiçik saxlayırıq)
    const res = await axios.get(`${TARGET_API_BASE}/api/chats`, { timeout: 15000 });
    const list = Array.isArray(data?.messages) ? data.messages : [data?.message || data].filter(Boolean);

    const needle = String(messageText || '').trim();
    if (!needle) return false;

    // eyni “message” olan varsa dublikat say
    return list.some(c => String(c?.message || '').trim() === needle);
  } catch (e) {
    console.error('isDuplicateChatMessage error:', e?.response?.status, e?.response?.data || e.message);
    // təhlükəsizlik üçün (servis çatmasa) dublikat saymayaq
    return false;
  }
}

// Reply/Quoted message çıxar
function extractQuoted(msg) {
  if (!msg) return null;

  const core = msg.viewOnceMessageV2?.message || msg;

  // reply adətən extendedTextMessage.contextInfo içində olur
  const ctx =
    core.extendedTextMessage?.contextInfo ||
    core.imageMessage?.contextInfo ||
    core.videoMessage?.contextInfo ||
    core.documentMessage?.contextInfo ||
    core.audioMessage?.contextInfo ||
    null;

  const q = ctx?.quotedMessage;
  if (!q) return null;

  // quoted mətni tapmağa çalış
  const qt =
    q.conversation ||
    q.extendedTextMessage?.text ||
    q.imageMessage?.caption ||
    q.videoMessage?.caption ||
    q.documentMessage?.caption ||
    q.documentMessage?.fileName ||
    q.audioMessage?.ptt && '[voice]' ||
    null;

  // quoted göndərənin jid-i (bəzən ctx.participant)
  const quotedParticipant = ctx?.participant || null;

  return {
    text: qt,
    participant: quotedParticipant,
    stanzaId: ctx?.stanzaId || null,
    _raw: q,
  };
}

function isReplyMessage(msg) {
  return !!extractQuoted(msg);
}

// UI/forward üçün quote formatı
function formatQuoteBlock(q) {
  if (!q?.text) return null;
  // WhatsApp üslubu kimi ">" ilə
  const lines = String(q.text).split('\n').map(l => `> ${l}`).join('\n');
  return lines;
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

