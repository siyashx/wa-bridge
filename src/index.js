// src/index.js
import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import { Client } from '@stomp/stompjs';
import WebSocket from 'ws';

const app = express();
app.use(express.json({ limit: '2mb' }));

const {
  PORT = 4242,
  EVOLUTION_API_KEY,
  GROUP_A_JID,
  GROUP_B_JID,
  GROUP_C_JID,
  GROUP_D_JID,
  GROUP_G_JID,
  TARGET_API_BASE = 'https://mototaksi.az:9898',
  WS_URL = 'wss://mototaksi.az:9898/ws',
  ONE_SIGNAL_APP_ID,
  ONE_SIGNAL_REST_API_KEY,
  ANDROID_CHANNEL_ID,
} = process.env;

const ALLOWED_GROUPS = new Set(
  [GROUP_A_JID, GROUP_B_JID, GROUP_C_JID, GROUP_D_JID, GROUP_G_JID]
    .map(s => String(s || '').trim())
    .filter(Boolean)
);

/* ---------------- dedup (LRU-vari) ---------------- */
const processedIds = new Map(); // id -> ts
const DEDUP_WINDOW_MS = Number(process.env.DEDUP_WINDOW_MS || 5 * 60 * 1000);

const PUBLISH_QUEUE_MAX = Number(process.env.PUBLISH_QUEUE_MAX || 5000);

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

function dbgLoc(...args) {
  if (process.env.DEBUG_LOCATION === '1') {
    console.log('[LOC]', ...args);
  }
}

// İmza
function verifySignature(req) {
  const apikey = req.get('apikey') || req.body?.apikey;
  return !!apikey && !!EVOLUTION_API_KEY && apikey === EVOLUTION_API_KEY;
}

// Mətni çıxar
function extractText(msg) {
  const core = unwrapMessage(msg);
  if (!core) return null;
  return (
    core.conversation ||
    core.extendedTextMessage?.text ||
    core.imageMessage?.caption ||
    core.videoMessage?.caption ||
    null
  );
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

function unwrapMessage(msg) {
  let m = msg;
  for (let i = 0; i < 8 && m && typeof m === 'object'; i++) {
    const next =
      m.viewOnceMessageV2?.message ||
      m.viewOnceMessage?.message ||
      m.ephemeralMessage?.message ||
      m.ephemeralMessageV2?.message ||
      m.documentWithCaptionMessage?.message ||
      m.editedMessage?.message ||
      m.protocolMessage?.editedMessage?.message ||  // ✅ əlavə
      null;

    if (!next) break;
    m = next;
  }
  return m;
}

// Yalnız STATIK lokasiya (locationMessage). liveLocationMessage nəzərə alınmır.
function getStaticLocation(msg) {
  const core = unwrapMessage(msg);
  if (!core) {
    dbgLoc('unwrapMessage -> null');
    return null;
  }

  // core hansı növdür? (locationMessage yoxdursa da görək nə gəlib)
  const keys = Object.keys(core || {});
  dbgLoc('core keys=', keys.slice(0, 30));

  const lm = core.locationMessage;
  if (!lm) {
    // bəzən liveLocationMessage gəlir (sən ignore edirsən)
    if (core.liveLocationMessage) dbgLoc('has liveLocationMessage (ignored)');
    // bəzən başqa payload olur
    dbgLoc('no locationMessage');
    return null;
  }

  const lat = Number(lm.degreesLatitude);
  const lng = Number(lm.degreesLongitude);

  dbgLoc('locationMessage raw=', {
    degreesLatitude: lm.degreesLatitude,
    degreesLongitude: lm.degreesLongitude,
    name: lm.name,
    address: lm.address,
    caption: lm.caption,
    hasThumb: !!lm.jpegThumbnail,
    url: lm.url,
  });

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    dbgLoc('invalid lat/lng', { lat: lm.degreesLatitude, lng: lm.degreesLongitude });
    return null;
  }

  return {
    kind: 'location',
    lat, lng,
    name: lm.name || null,
    address: lm.address || null,
    caption: lm.caption || null,
    url: lm.url || `https://maps.google.com/?q=${lat},${lng}`,
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

    // ---- DEBUG SNAP (location/structure) ----
    if (process.env.DEBUG_LOCATION === '1') {
      console.log('[ENV]', {
        remoteJid: env?.remoteJid,
        id: env?.id,
        fromMe: !!env?.fromMe,
        participant: env?.participant,
        hasMsg: !!env?.msg,
        msgKeys: env?.msg ? Object.keys(env.msg).slice(0, 30) : [],
        hasContextInfo: !!env?.contextInfo,
        ts: getMsgTsMs(env),
      });
    }

    // ✅ group routing (BURDA OLMALIDIR)
    const isAllowedForwardGroup = ALLOWED_GROUPS.has(env.remoteJid);

    if (!isAllowedForwardGroup) {
      console.log('SKIP: not allowed group',
        { remoteJid: env.remoteJid, allowForward: [...ALLOWED_GROUPS] });
      return;
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
    const selfLoc = getStaticLocation(env.msg);

    dbgLoc('selfLoc=', selfLoc ? {
      lat: selfLoc.lat,
      lng: selfLoc.lng,
      name: selfLoc.name,
      address: selfLoc.address,
      caption: selfLoc.caption,
    } : null);

    const MAX_AGE_MS = Number(process.env.MAX_AGE_MS || 5 * 60 * 1000);

    if (!isReply && !selfLoc && isTooOld(env, MAX_AGE_MS)) {
      dbgLoc('DROP: too old because selfLoc is null', { ts: getMsgTsMs(env), MAX_AGE_MS });
      console.log('SKIP: too old (non-location)');
      return;
    }

    // Dedup (ID based)
    // Dedup (yalnız reply DEYİLSƏ)
    if (!isReply && seenRecently(env.id)) {
      dbgLoc('DROP: dedup by id', { id: env.id });
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

    const quotedLoc = getQuotedLocationFromEnv(env);

    dbgLoc('ENTER location handler', {
      isReply,
      msgTs: getMsgTsMs(env),
      maxAgeMs: Number(process.env.MAX_AGE_MS || 5 * 60 * 1000),
    });

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
            (effectiveLoc.address && effectiveLoc.address.trim()) ? effectiveLoc.address :
              'Yer paylaşımı';

      const locNeedle = locationTitle
        ? `${locationTitle} @ ${effectiveLoc.lat.toFixed(6)},${effectiveLoc.lng.toFixed(6)}`
        : `${effectiveLoc.lat.toFixed(6)},${effectiveLoc.lng.toFixed(6)}`;

      if (!isReply) {

        const dupLoc = await isDuplicateByLastChats(locNeedle, "location", phonePrefixed);

        if (dupLoc) {
          dbgLoc('DROP location: duplicate by last chats', { locNeedle });
          console.log("SKIP: duplicate by last chats (location)");
          return;
        }
      }

      // ✅ Reply mesajlar BACKEND/STOMP-ə getməsin
      if (isReply) {
        dbgLoc('DROP location: isReply');
        console.log('SKIP BACKEND/STOMP (location): reply message');
      } else {
        dbgLoc('SEND location: publishStomp + maybe push', { phone: phonePrefixed });
        // ✅ BACKEND/STOMP üçün newChat (location)
        const lat = Number(effectiveLoc.lat);
        const lng = Number(effectiveLoc.lng);
        const b64Thumb = toBase64Thumb(effectiveLoc._raw?.jpegThumbnail);

        const newChat = {
          id: Date.now(),
          groupId: "0",
          userId: 2,
          username: "Sifariş Qrupu İstifadəçisi",
          phone: phonePrefixed,
          isSeenIds: [],
          userType: "customer",

          // ✅ type aliases (backend bəzən messageType yox, type saxlayır)
          messageType: "location",
          type: "location",

          // ✅ text
          message: locationTitle,
          text: locationTitle,

          // ✅ coords - bir neçə formatda
          locationLat: lat,
          locationLng: lng,
          latitude: lat,
          longitude: lng,
          lat,
          lng,
          location: { lat, lng },

          // ✅ thumbnail (RN səninki kimi data:image base64 gözləyir)
          thumbnail: b64Thumb,
          timestamp,           // "YYYY-MM-DD HH:mm:ss"
          createdAt: timestamp // ✅ bəzən app createdAt oxuyur
        };

        console.log("STOMP NEWCHAT (location) =", {
          messageType: newChat.messageType,
          type: newChat.type,
          locationLat: newChat.locationLat,
          locationLng: newChat.locationLng
        });

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

  } catch (e) {
    console.error('Webhook handler error:', e?.response?.data || e.message);
  }
});

function isValidUUID(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(String(s || '').trim());
}

function toBase64Thumb(jpegThumbnail) {
  if (!jpegThumbnail) return null;

  // Əgər artıq Buffer-dirsə
  if (Buffer.isBuffer(jpegThumbnail)) {
    return jpegThumbnail.toString('base64');
  }

  // Əgər {0:255,1:216,...} formatındadırsa
  if (typeof jpegThumbnail === 'object') {
    try {
      const arr = Object.values(jpegThumbnail);
      return Buffer.from(arr).toString('base64');
    } catch {
      return null;
    }
  }

  return null;
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
        .filter(u =>
          Number(u?.appVersion) >= 25 &&
          u?.hasActiveApp !== 'mototaxi' &&      // ✅ YENİ ŞƏRT
          u?.oneSignal &&
          isValidUUID(String(u.oneSignal))
        )
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

    return list.some((c) => {
      const m = normMsg(c?.message);
      if (!m) return false;

      const t = String(c?.messageType || c?.type || "").toLowerCase();
      const looksLikeLoc = Number.isFinite(Number(c?.locationLat ?? c?.lat ?? c?.latitude))
        && Number.isFinite(Number(c?.locationLng ?? c?.lng ?? c?.longitude));
      const normT = looksLikeLoc ? "location" : t;
      const sameType = !messageType ? true : (normT === String(messageType).toLowerCase());
      return sameType && (m === needle);
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
      return;
    } catch (e) {
      stompReady = false;
    }
  }

  if (publishQueue.length >= PUBLISH_QUEUE_MAX) publishQueue.shift(); // oldest drop
  publishQueue.push({ destination, body });
  initStomp();
}

// server startında init
initStomp();

/* ---------------- start ---------------- */

app.listen(PORT, () => { });

