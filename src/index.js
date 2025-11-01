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
  WEBHOOK_SECRET,
  GROUP_A_JID,
  GROUP_A_JID2,                       // ⬅️ yeni
  DEBUG = '1',
  TARGET_API_BASE = 'https://mototaksi.az:9898',
  MULTI_EVENT = '0',
  WS_URL = 'wss://mototaksi.az:9898/ws',
  ONE_SIGNAL_APP_ID,
  ONE_SIGNAL_REST_API_KEY,
  ANDROID_CHANNEL_ID,
} = process.env;

const ALLOWED_GROUPS = new Set(
  [GROUP_A_JID, GROUP_A_JID2].filter(Boolean)
);

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
  // Wasender sürətli 200 istəyir
  res.status(200).json({ received: true });

  try {
    dlog('INCOMING /webhook', {
      headers: {
        'x-webhook-signature': req.get('x-webhook-signature') ? '[present]' : '[absent]',
        'content-type': req.get('content-type'),
      },
      bodyKeys: Object.keys(req.body || {}),
    });

    if (!verifySignature(req)) {
      dlog('Signature invalid, ignoring payload');
      return;
    }

    const { event, data } = req.body || {};
    dlog('Event received:', event);

    const allowed =
      String(MULTI_EVENT) === '1'
        ? ['messages-group.received', 'messages.received', 'messages.upsert']
        : ['messages-group.received'];

    if (!allowed.includes(event)) {
      dlog('Skip: not an allowed message event');
      return;
    }

    const env = normalizeEnvelope(data);

    // Özümüzdən çıxanları at
    if (env.fromMe) {
      dlog('Skip: fromMe=true');
      return;
    }

    if (!env.remoteJid || !ALLOWED_GROUPS.has(env.remoteJid)) {
      dlog('Skip: remoteJid not in allowed set', { got: env.remoteJid, allowed: [...ALLOWED_GROUPS] });
      return;
    }

    // Dedup
    if (seenRecently(env.id)) {
      dlog('Skip: duplicate message id within window', { id: env.id });
      return;
    }

    // Telefonu çıxar: üstünlük BODY-dəki @s.whatsapp.net, sonra participant (@s.whatsapp.net),
    // sonra participant @lid
    const foundSnet = findFirstSnetJidDeep(req.body);
    dlog('findFirstSnetJidDeep:', { foundSnet });

    let phone =
      parsePhoneFromSNetJid(foundSnet) ||
      parsePhoneFromSNetJid(env.participant);

    if (!phone) phone = parseDigitsFromLid(env.participant);

    // 1) ƏVVƏL statik location olub-olmadığını yoxla
    const loc = getStaticLocation(env.msg);

    if (loc) {
      logStaticLocation(env, loc); // (istəsən saxla)

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
        message: "",   // opsional başlıq
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
        } else {
          dlog('No push targets found.');
        }
      } catch (pushErr) {
        console.error('Post-publish push error:', pushErr?.message);
      }
      return; // Location emal olundu, dayandır
    }

    // 2) Sonra mətn mesajlarını emal et
    const textBody = extractText(env.msg);
    if (!textBody) {
      dlog('Skip: no text in message');
      return;
    }

    // 🔒 Filtr: '+' və ya 'tapildi/tapıldı' varsa sifarişi göndərmə
    if (shouldBlockMessage(textBody)) {
      dlog('Skip: blocked by content filter (plus/tapildi)');
      return;
    }

    const timestamp = formatBakuTimestamp();

    // Mesaj olduğu kimi qalsın, nömrəni ayrıca field kimi verək
    const normalizedPhone = phone ? `+${phone}` : '';
    const cleanMessage = String(textBody);

    // 🔁 dublikat varsa dayandır
    if (await isDuplicateChatMessage(cleanMessage)) {
      dlog('Skip: duplicate message text exists in /api/chats');
      return;
    }

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

    dlog('Outgoing POST payload preview:', {
      to: `${TARGET_API_BASE}/api/chat`,
      newChat,
    });

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
      } else {
        dlog('No push targets found.');
      }
    } catch (pushErr) {
      console.error('Post-publish push error:', pushErr?.message);
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
    dlog('Push skipped: no valid subscription ids (input)');
    return;
  }

  // fetch users and keep ONLY those with appVersion === 25
  let v25Ids = [];
  try {
    const usersRes = await axios.get(`${TARGET_API_BASE}/api/v5/user`, { timeout: 15000 });
    const users = Array.isArray(usersRes?.data) ? usersRes.data : [];

    const v25Set = new Set(
      users
        .filter(u => Number(u?.appVersion) === 25 && u?.oneSignal && isValidUUID(String(u.oneSignal)))
        .map(u => String(u.oneSignal).trim())
    );

    // intersect provided ids with v25 set
    v25Ids = validInput.filter(id => v25Set.has(id));
  } catch (err) {
    console.error('sendPushNotification: failed to load users; aborting send. Err =', err?.message);
    return; // hard stop: do NOT send if we can’t verify v25 users
  }

  if (!v25Ids.length) {
    dlog('Push skipped: no recipients with appVersion === 25 (intersection empty)');
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
      dlog('STOMP publish ok:', { destination });
    } catch (e) {
      console.error('STOMP publish error, queueing:', e?.message);
      publishQueue.push({ destination, body });
    }
  } else {
    dlog('STOMP not ready, queueing publish');
    publishQueue.push({ destination, body });
    initStomp();
  }
}

// server startında init
initStomp();

/* ---------------- start ---------------- */

app.listen(PORT, () => {
  console.log(`Webhook server running on :${PORT}`);
  console.log('GROUP_A_JID =>', GROUP_A_JID);
  console.log('TARGET_API_BASE =>', TARGET_API_BASE);
  if (process.env.DRY_RUN) {
    console.log('*** DRY_RUN is ON (no real messages will be sent) ***');
  }
});

