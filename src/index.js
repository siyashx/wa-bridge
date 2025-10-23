// src/index.js
import 'dotenv/config';
import express from 'express';
import axios from 'axios';

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
  const key  = env.key || {};
  const msg  = env.message || {};
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

    // Telefonu çıxar: üstünlük BODY-dəki @s.whatsapp.net, sonra participant (@s.whatsapp.net),
    // sonra participant @lid
    const foundSnet = findFirstSnetJidDeep(req.body);
    dlog('findFirstSnetJidDeep:', { foundSnet });

    let phone =
      parsePhoneFromSNetJid(foundSnet) ||
      parsePhoneFromSNetJid(env.participant);

    if (!phone) phone = parseDigitsFromLid(env.participant);

    const username = phone || 'Unknown';
    const timestamp = formatBakuTimestamp();

    const newChat = {
      id: Date.now(),          // Benzersiz ID
      groupId: "0",
      userId: 2,
      username,                // yalnız rəqəmlər (s.whatsapp.net-dən filtr)
      isSeenIds: [],
      messageType: "text",
      isReply: "false",
      userType: "customer",
      message: textBody,       // yönləndirilən mətn
      timestamp,               // "YYYY-MM-DD HH:mm:ss" (Asia/Baku)
      isCompleted: false,
    };

    dlog('Outgoing POST payload preview:', {
      to: `${TARGET_API_BASE}/api/chat`,
      newChat,
    });

    try {
      const apiRes = await axios.post(`${TARGET_API_BASE}/api/chat`, newChat, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000,
      });
      dlog('POST /api/chat result:', {
        status: apiRes.status,
        dataType: typeof apiRes.data,
      });
    } catch (e) {
      console.error('POST /api/chat failed:', e?.response?.status, e?.response?.data || e.message);
    }
  } catch (e) {
    console.error('Webhook handler error:', e?.response?.data || e.message);
  }
});

/* ---------------- start ---------------- */

app.listen(PORT, () => {
  console.log(`Webhook server running on :${PORT}`);
  console.log('GROUP_A_JID =>', GROUP_A_JID);
  console.log('TARGET_API_BASE =>', TARGET_API_BASE);
  if (process.env.DRY_RUN) {
    console.log('*** DRY_RUN is ON (no real messages will be sent) ***');
  }
});
