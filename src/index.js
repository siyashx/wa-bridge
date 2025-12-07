// src/index.js
import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import { Client } from '@stomp/stompjs';
import WebSocket from 'ws';
import { sendText, sendLocation } from './forwarder.js';

const app = express();
app.use(express.json({ limit: '2mb' }));


axios.interceptors.request.use((config) => {
  const { method, url, data, headers } = config || {};
  console.log('[HTTP-REQ]', method?.toUpperCase(), url, {
    'content-type': headers?.['Content-Type'] || headers?.['content-type'],
    'authorization-present': !!headers?.Authorization,
    // data çox böyük olmasın deyə ilk 1KB:
    bodyPreview: typeof data === 'string' ? data.slice(0,1024) : JSON.stringify(data || {}).slice(0,1024)
  });
  return config;
});

axios.interceptors.response.use((res) => {
  console.log('[HTTP-RES]', res?.config?.url, res?.status, {
    bodyPreview: JSON.stringify(res?.data || {}).slice(0,1024)
  });
  return res;
}, (err) => {
  const cfg = err?.config || {};
  console.error('[HTTP-ERR]', cfg?.method?.toUpperCase(), cfg?.url, err?.response?.status, {
    errBody: JSON.stringify(err?.response?.data || {}).slice(0,2048),
    message: err?.message
  });
  return Promise.reject(err);
});

const {
  PORT = 4242,
  WEBHOOK_SECRET,
  GROUP_A_JID,
  GROUP_A_JID2,
  GROUP_A_JID3,
  DEBUG = '1',
  TARGET_API_BASE = 'https://mototaksi.az:9898',
  MULTI_EVENT = '0',
  WS_URL = 'wss://mototaksi.az:9898/ws',
  ONE_SIGNAL_APP_ID,
  ONE_SIGNAL_REST_API_KEY,
  ANDROID_CHANNEL_ID,
} = process.env;

const ALLOWED_GROUPS = new Set(
  [GROUP_A_JID, GROUP_A_JID2, GROUP_A_JID3].filter(Boolean)
);

// ✅ Hədəf (forward) qrupların siyahısı
const DEST_GROUPS = String(process.env.DEST_GROUP_JIDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

/* ---------------- mini logger ---------------- */
const dlog = (...args) => {
  if (String(DEBUG) === '1') console.log(new Date().toISOString(), ...args);
};

/* ---------------- dedup (LRU-vari) ---------------- */
const processedIds = new Map(); // id -> ts
const DEDUP_WINDOW_MS = 5 * 60 * 1000;

function seenRecently(id) {
  if (!id) return false;
  const now = Date.now();
  const ts = processedIds.get(id);
  if (ts && now - ts < DEDUP_WINDOW_MS) return true;
  processedIds.set(id, now);

  if (processedIds.size > 5000) {
    const cutoff = now - DEDUP_WINDOW_MS;
    for (const [mid, t] of processedIds) {
      if (t < cutoff) processedIds.delete(mid);
    }
  }
  return false;
}

/* ---------------- helpers ---------------- */

// İmza
function verifySignature(req) {
  const sig =
    req.get('x-webhook-signature') ||
    req.get('x-signature') ||
    req.get('x-wasender-signature') ||
    req.get('x-was-signature');

  const ok = !!sig && !!WEBHOOK_SECRET && sig === WEBHOOK_SECRET;
  dlog('verifySignature:', { ok, hasSig: !!sig });
  return ok;
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
  dlog('extractText:', { hasMsg: !!msg, textPreview: txt?.slice?.(0, 120) });
  return txt;
}

// "994556165535:50@s.whatsapp.net" -> "994556165535"
function parsePhoneFromSNetJid(jid) {
  if (!jid) return null;
  const m = String(jid).match(/^(\d+)(?::\d+)?@s\.whatsapp\.net$/);
  const out = m ? m[1] : null;
  dlog('parsePhoneFromSNetJid:', { jid, out });
  return out;
}

// "279241862209772@lid" -> "279241862209772"
function parseDigitsFromLid(jid) {
  if (!jid) return null;
  const m = String(jid).match(/^(\d+)@lid$/);
  const out = m ? m[1] : String(jid).replace(/@.*/, '');
  dlog('parseDigitsFromLid:', { jid, out });
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
  dlog('normalizeEnvelope:', {
    remoteJid: out.remoteJid,
    participant: out.participant,
    hasMsg: !!out.msg,
    id: out.id,
    fromMe: out.fromMe,
  });
  return out;
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

function logStaticLocation(env, loc) {
  dlog('--- STATIC LOCATION DETECTED ---');
  dlog('from:', {
    remoteJid: env.remoteJid,
    participant: env.participant,
    id: env.id,
  });

  // Konsola “oxunaqlı” JSON veririk
  try {
    console.log('locationMessage RAW =', JSON.stringify(loc._raw, null, 2));
  } catch { /* no-op */ }

  // TL;DR görünüş
  dlog('loc.short:', {
    lat: loc.lat, lng: loc.lng,
    name: loc.name, address: loc.address,
    caption: loc.caption, url: loc.url,
  });
  dlog('--------------------------------');
}

/* ---------------- routes ---------------- */

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/webhook', async (req, res) => {
  // ---- helper: request-scoped logger ----
  const reqId = Math.random().toString(36).slice(2, 8).toUpperCase();
  const t0 = Date.now();
  const L = (...args) => console.log(`[WH:${reqId}]`, ...args);
  const LE = (...args) => console.error(`[WH:${reqId}][ERR]`, ...args);

  // small pretty JSON
  const j = (v) => {
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      return String(v);
    }
  };
  const previewBody = (() => {
    const raw = req.body || {};
    // body preview çox böyüməsin deyə bəzi sahələri qısaldırıq
    const copy = JSON.parse(JSON.stringify(raw, (k, v) => {
      if (k === 'jpegThumbnail' && typeof v === 'string') return `[${v.length}B thumbnail]`;
      return v;
    }));
    return j(copy).slice(0, 1200); // 1.2KB limit
  })();

  // Wasender sürətli 200 istəyir
  res.status(200).json({ received: true });

  try {
    L('INCOMING /webhook');
    L('Headers:', {
      'x-webhook-signature': req.get('x-webhook-signature') ? '[present]' : '[absent]',
      'content-type': req.get('content-type'),
      'content-length': req.get('content-length'),
    });
    L('Body preview:', previewBody);

    if (!verifySignature(req)) {
      L('Signature invalid → ignore');
      return;
    }
    L('Signature OK');

    const { event, data } = req.body || {};
    L('Event received:', event);

    const allowed =
      String(MULTI_EVENT) === '1'
        ? ['messages-group.received', 'messages.received', 'messages.upsert']
        : ['messages-group.received'];

    if (!allowed.includes(event)) {
      L('Skip: not an allowed event', { allowed });
      return;
    }

    const env = normalizeEnvelope(data);
    L('Envelope:', {
      remoteJid: env.remoteJid,
      participant: env.participant,
      id: env.id,
      fromMe: env.fromMe,
      hasMsg: !!env.msg,
    });

    if (env.fromMe) {
      L('Skip: fromMe=true');
      return;
    }

    if (!env.remoteJid || !ALLOWED_GROUPS.has(env.remoteJid)) {
      L('Skip: remoteJid not allowed', { got: env.remoteJid, allowed: [...ALLOWED_GROUPS] });
      return;
    }
    L('remoteJid allowed');

    if (seenRecently(env.id)) {
      L('Skip: duplicate within window', { id: env.id });
      return;
    }
    L('Dedup OK');

    // Phone parse
    const foundSnet = findFirstSnetJidDeep(req.body);
    let phone =
      parsePhoneFromSNetJid(foundSnet) ||
      parsePhoneFromSNetJid(env.participant) ||
      parseDigitsFromLid(env.participant) ||
      null;
    const normalizedPhone = phone ? `+${phone}` : '';
    L('Phone parsed:', { foundSnet, phone: normalizedPhone || '(none)' });

    // LOCATION?
    const loc = getStaticLocation(env.msg);
    if (loc) {
      L('Location detected:', {
        lat: loc.lat, lng: loc.lng,
        name: loc.name, address: loc.address, caption: loc.caption,
      });

      const timestamp = formatBakuTimestamp();
      const phonePrefixed = normalizedPhone || '';
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
        locationLat: loc.lat,
        locationLng: loc.lng,
        thumbnail: loc._raw?.jpegThumbnail || null
      };

      L('STOMP publish (location) → /app/sendChatMessage');
      publishStomp('/app/sendChatMessage', newChat);

      const preview = (newChat.message && newChat.message.trim())
        ? newChat.message.slice(0, 140)
        : `${loc.lat.toFixed(6)}, ${loc.lng.toFixed(6)}`;

      try {
        const oneSignalIds = await fetchPushTargets(0);
        L('Push targets (after location publish):', { count: oneSignalIds.length });
        if (oneSignalIds.length) {
          await sendPushNotification(oneSignalIds, '🪄🪄 Yeni Sifariş!!', `📍 ${preview}`);
          L('OneSignal push (location) sent');
        } else {
          L('No push targets for location');
        }
      } catch (pushErr) {
        LE('Post-publish push error (location):', pushErr?.response?.data || pushErr.message);
      }

      // Forward REAL pin + contact text
      try {
        if (DEST_GROUPS.length) {
          L('Forward location to DEST_GROUPS:', DEST_GROUPS);
          for (const jid of DEST_GROUPS) {
            L(' → sendLocation', { to: jid });
            await sendLocation({
              to: jid,
              latitude: loc.lat,
              longitude: loc.lng,
              name: loc.name || (newChat.message?.trim() || 'Location'),
              address: loc.address || undefined,
            });
            L('   sendLocation OK');

            const tail = `Sifarişi qəbul etmək üçün əlaqə: ${phonePrefixed || '—'}`;
            L(' → sendText (contact)', { to: jid, text: tail });
            await sendText({ to: jid, text: tail });
            L('   sendText OK');
          }
          L('Forward (location) finished');
        } else {
          L('Forward (location) skipped: empty DEST_GROUPS');
        }
      } catch (e) {
        LE('Forward (location) error:', e?.response?.data || e.message);
      }

      L('DONE (location). Duration(ms)=', Date.now() - t0);
      return;
    }

    // TEXT?
    const textBody = extractText(env.msg);
    if (!textBody) {
      L('Skip: no text in message');
      L('DONE (no-op). Duration(ms)=', Date.now() - t0);
      return;
    }

    if (shouldBlockMessage(textBody)) {
      L('Skip: blocked by content filter', { textPreview: textBody.slice(0, 120) });
      L('DONE (blocked). Duration(ms)=', Date.now() - t0);
      return;
    }

    const cleanMessage = String(textBody);
    if (await isDuplicateChatMessage(cleanMessage)) {
      L('Skip: duplicate text (DB exists)');
      L('DONE (dup). Duration(ms)=', Date.now() - t0);
      return;
    }

    const timestamp = formatBakuTimestamp();
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

    L('STOMP publish (text) → /app/sendChatMessage');
    publishStomp('/app/sendChatMessage', newChat);

    try {
      const oneSignalIds = await fetchPushTargets(0);
      L('Push targets (after text publish):', { count: oneSignalIds.length });
      if (oneSignalIds.length) {
        await sendPushNotification(oneSignalIds, '🪄🪄 Yeni Sifariş!!', `📩 ${cleanMessage.slice(0, 140)}`);
        L('OneSignal push (text) sent');
      } else {
        L('No push targets for text');
      }
    } catch (pushErr) {
      LE('Post-publish push error (text):', pushErr?.response?.data || pushErr.message);
    }

    // Forward text + phone
    try {
      if (DEST_GROUPS.length) {
        L('Forward text to DEST_GROUPS:', DEST_GROUPS);
        const phoneForTail = normalizedPhone || '—';
        const bridged = `${cleanMessage}\n\nSifarişi qəbul etmək üçün əlaqə: ${phoneForTail}`;
        for (const jid of DEST_GROUPS) {
          L(' → sendText', { to: jid, len: bridged.length });
          await sendText({ to: jid, text: bridged });
          L('   sendText OK');
        }
        L('Forward (text) finished');
      } else {
        L('Forward (text) skipped: empty DEST_GROUPS');
      }
    } catch (e) {
      LE('Forward (text) error:', e?.response?.data || e.message);
    }

    L('DONE (text). Duration(ms)=', Date.now() - t0);
  } catch (e) {
    LE('Webhook handler fatal error:', e?.response?.data || e.message);
    LE('Stack:', e?.stack);
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
    dlog('Push skipped: no valid subscription ids (input)');
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
    dlog('Push skipped: no recipients with appVersion >= 25 (intersection empty)');
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
      dlog(`OneSignal push sent (${tag})`, {
        id: res.data?.id,
        recipients: res.data?.recipients,
        count: v25Ids.length,
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

  // — normalize (diakritik və böyük/kiçik hərflər)
  const text = String(raw).normalize('NFKC');
  const lower = text.toLowerCase();

  // 2.1) LƏĞV / STOP sinonimləri → blokla
  // (ləğv, ləgv, legv, stop – böyük/kiçik fərq etmir)
  const cancelRe = /\b(l[əe]ğ?v|stop)\b/i;
  if (cancelRe.test(text)) return true;

  // 2.2) "tapildi/tapıldı" → blokla
  if (/\btap(i|ı)ld(i|ı)\b/i.test(text)) return true;

  // 2.3) Yalnız "+" (və ya yalnız + işarələrindən ibarət) → blokla
  if (/^\s*\++\s*$/.test(text)) return true;

  // 2.4) "+994..." kimi telefon nömrəsi daşıyırsa → blokla
  if (/\+994[\d\s-]{7,}/.test(lower)) return true;

  // 2.5) Əks halda (məs: "… + wolt …") → İCAZƏ VER
  // yəni mesajın içində + işarəsi olsa da, əgər yanında rəqəm başlamırsa bloklamırıq
  return false;
}

async function isDuplicateChatMessage(messageText) {
  try {
    // son mesajları götür (sürətli olsun deyə limit kiçik saxlayırıq)
    const res = await axios.get(`${TARGET_API_BASE}/api/chats`, { timeout: 15000 });
    const list = Array.isArray(res?.data) ? res.data : [];

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
      dlog('STOMP connected');
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
      dlog('STOMP socket closed, will auto-reconnect…');
    },
    debug: (str) => {
      if (String(DEBUG) === '1') console.log('[STOMP]', str);
    },
  });

  stompClient.activate();
}

function publishStomp(destination, payloadObj) {
  const body = JSON.stringify(payloadObj);
  if (stompClient && stompReady) {
    try {
      stompClient.publish({ destination, body });
      dlog('[STOMP] publish OK', { destination, bytes: body.length });
    } catch (e) {
      console.error('[STOMP] publish error, queueing:', e?.message);
      publishQueue.push({ destination, body });
    }
  } else {
    dlog('[STOMP] not ready, queueing publish', { destination, bytes: body.length });
    publishQueue.push({ destination, body });
    initStomp();
  }
}

// server startında init
initStomp();

/* ---------------- start ---------------- */

app.listen(PORT, () => {
  console.log(`Webhook server running on :${PORT}`);
  console.log('ALLOWED_GROUPS =>', [...ALLOWED_GROUPS]);
  console.log('DEST_GROUPS    =>', DEST_GROUPS);
  console.log('TARGET_API_BASE=>', TARGET_API_BASE);
  console.log('WS_URL         =>', process.env.WS_URL);
  console.log('DRY_RUN        =>', process.env.DRY_RUN ? 'ON' : 'OFF');
  if (!process.env.WEBHOOK_SECRET) console.warn('!! WEBHOOK_SECRET is EMPTY');
  if (!process.env.WASENDER_API_KEY) console.warn('!! WASENDER_API_KEY is EMPTY');
  if (process.env.DRY_RUN) console.log('*** DRY_RUN is ON (no real messages will be sent) ***');
});

// global error hooks
process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));

