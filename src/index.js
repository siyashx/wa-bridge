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
  DEBUG = '1',
  // Hədəf backend (məs: https://mototaksi.az:9898)
  TARGET_API_BASE = 'https://mototaksi.az:9898',
  // Bir neçə event-i parallel qəbul etmək istəyirsənsə:
  MULTI_EVENT = '0',
  WS_URL = 'wss://mototaksi.az:9898/ws',
  ONE_SIGNAL_APP_ID,
  ONE_SIGNAL_REST_API_KEY,
  ANDROID_CHANNEL_ID,
} = process.env;

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

    // yalnız A qrupu
    if (!env.remoteJid || env.remoteJid !== GROUP_A_JID) {
      dlog('Skip: remoteJid mismatch', { got: env.remoteJid, want: GROUP_A_JID });
      return;
    }

    // Dedup
    if (seenRecently(env.id)) {
      dlog('Skip: duplicate message id within window', { id: env.id });
      return;
    }

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

    // Telefonu çıxar: üstünlük BODY-dəki @s.whatsapp.net, sonra participant (@s.whatsapp.net),
    // sonra participant @lid
    const foundSnet = findFirstSnetJidDeep(req.body);
    dlog('findFirstSnetJidDeep:', { foundSnet });

    let phone =
      parsePhoneFromSNetJid(foundSnet) ||
      parsePhoneFromSNetJid(env.participant);

    if (!phone) phone = parseDigitsFromLid(env.participant);

    const timestamp = formatBakuTimestamp();

    // Mesaj olduğu kimi qalsın, nömrəni ayrıca field kimi verək
    const normalizedPhone = phone ? `+${phone}` : '';
    const cleanMessage = String(textBody);

    // newChat obyektində message sahəsini buradakı kimi dəyiş:
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
      message: cleanMessage,     // <-- burada artıq nömrə əlavə olunub
      timestamp: timestamp,
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
  // 1) daxil olan ID-ləri uniq & valid et
  const subsRaw = (Array.isArray(ids) ? ids : [ids]).map(x => String(x || '').trim());
  const subsValid = subsRaw.filter(isValidUUID);
  const unique = [...new Set(subsValid)];

  if (!unique.length) {
    dlog('Push skipped: no valid subscription ids (input)');
    return;
  }

  // 2) Yalnız appVersion === 25 olan istifadəçilərin OneSignal ID-lərini saxla
  let allowedSubs = [];
  try {
    const usersRes = await axios.get(`${TARGET_API_BASE}/api/v5/user`, { timeout: 15000 });
    const users = Array.isArray(usersRes?.data) ? usersRes.data : [];

    // appVersion 25 olanların OneSignal ID-lərini topla
    const v25Set = new Set(
      users
        .filter(u => Number(u?.appVersion) === 25 && u?.oneSignal && isValidUUID(String(u.oneSignal)))
        .map(u => String(u.oneSignal).trim())
    );

    // daxil olan ID-lərlə kəsişmə
    allowedSubs = unique.filter(id => v25Set.has(id));

    if (!allowedSubs.length) {
      dlog('Push skipped: no recipients with appVersion === 25');
      return;
    }
  } catch (err) {
    console.error('sendPushNotification: getUsers/appVersion filter error:', err?.response?.data || err?.message);
    return; // təhlükəsiz tərəf: filter uğursuzdursa göndərmə
  }

  // 3) göndər
  try {
    const res = await axios.post(
      'https://onesignal.com/api/v1/notifications',
      {
        app_id: ONE_SIGNAL_APP_ID,
        include_subscription_ids: allowedSubs,
        headings: { en: title },
        contents: { en: body },
        android_channel_id: ANDROID_CHANNEL_ID,
        data: { screen: 'OrderGroup', groupId: 1 },
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${ONE_SIGNAL_REST_API_KEY}`,
        },
        timeout: 15000,
      }
    );
    dlog('OneSignal push sent:', { id: res.data?.id, recipients: res.data?.recipients, count: allowedSubs.length });
  } catch (e) {
    console.error('OneSignal push error:', e?.response?.data || e.message);
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
  // unicode-normalize + lower — az dilində “ı/İ” variasiyaları da tutulsun
  const text = String(raw).normalize('NFKC').toLowerCase();
  // + işarəsi varsa dərhal blokla
  if (text.includes('+')) return true;
  // “tapildi / tapıldı” variasiyaları (diakritik fərqləri də tutur)
  // həm “tapildi”, həm də “tapıldı” sözünü axtarırıq (hər yerdə çıxsa belə)
  if (/(^|\s)(tapildi|tapıldı)(?=$|\s|[.,!?;:])/i.test(raw)) return true;
  return false;
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

