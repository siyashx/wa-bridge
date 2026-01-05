import axios from "axios";

const EVO_BASE = process.env.EVOLUTION_API_BASE || "http://127.0.0.1:8080";
const EVO_KEY = process.env.EVOLUTION_API_KEY;              // SALAM721721
const INSTANCE = process.env.EVOLUTION_INSTANCE || "default";

// Evolution header adları bəzən "apikey" olur
function evoHeaders() {
  return {
    apikey: EVO_KEY,
    "Content-Type": "application/json",
  };
}

function buildReplyPayload({ chatJid, replyTo, quotedText, quotedMessage }) {
  if (!replyTo) return {};

  const messageObj =
    (quotedMessage && typeof quotedMessage === 'object')
      ? quotedMessage
      : { conversation: quotedText || "" };

  // Variant-1: quoted (sendText-də yaxşı işləyir)
  const v1 = {
    replyTo,
    quotedMsgId: replyTo,
    quotedMessageId: replyTo,
    quoted: {
      key: { remoteJid: chatJid, fromMe: true, id: replyTo },
      message: messageObj,
    },
    contextInfo: {
      stanzaId: replyTo,
      quotedMessage: messageObj, // ✅ əlavə et
    },
  };

  // Variant-2: bəzi build-lərdə media/location üçün yalnız contextInfo işləyir
  const v2 = {
    replyTo,
    contextInfo: {
      stanzaId: replyTo,
      quotedMessage: messageObj,
    },
  };

  return { v1, v2 };
}

function cleanPayload(p) {
  Object.keys(p).forEach(k => p[k] === undefined && delete p[k]);
  if (p.contextInfo) {
    Object.keys(p.contextInfo).forEach(k => p.contextInfo[k] === undefined && delete p.contextInfo[k]);
    if (!Object.keys(p.contextInfo).length) delete p.contextInfo;
  }
  if (p.quoted) {
    // quoted.key/message içində undefined varsa sil
    if (p.quoted?.key) Object.keys(p.quoted.key).forEach(k => p.quoted.key[k] === undefined && delete p.quoted.key[k]);
    if (p.quoted?.message) Object.keys(p.quoted.message).forEach(k => p.quoted.message[k] === undefined && delete p.quoted.message[k]);
  }
  return p;
}

export async function sendText({ to, text, mentions, replyTo, quotedParticipant, quotedText }) {
  if (process.env.DRY_RUN) {
    return { success: true, msgId: "dry_run" };
  }

  const payload = {
    number: to,
    text: text || "",
    mentions,
  };

  if (replyTo) {
    const { v1 } = buildReplyPayload({ chatJid: to, replyTo, quotedText });
    Object.assign(payload, v1);
  }

  Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);

  const res = await axios.post(
    `${EVO_BASE}/message/sendText/${INSTANCE}`,
    payload,
    { headers: evoHeaders(), timeout: 15000 }
  );

  const msgId =
    res?.data?.key?.id ||
    res?.data?.messageId ||
    res?.data?.msgId ||
    null;

  return { ...res.data, msgId };
}

export async function sendLocation({ to, latitude, longitude, name, address, replyTo, quotedText, quotedMessage }) {
  if (process.env.DRY_RUN) return { success: true, msgId: "dry_run" };

  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error(`Invalid lat/lng: ${latitude}, ${longitude}`);
  }

  // ✅ 1) əvvəl title
  const title = (name && String(name).trim()) ? String(name).trim() : "Konum";

  // ✅ 2) sonra replyPack
  const replyPack = replyTo
    ? buildReplyPayload({ chatJid: to, replyTo, quotedText, quotedMessage })
    : null;

  // ✅ 3) sonra payloads
  const payloads = [
    // v1
    { number: to, latitude: lat, longitude: lng, name: title, address, ...(replyPack?.v1 || {}) },
    { number: to, lat, lng, name: title, address, ...(replyPack?.v1 || {}) },
    { to, latitude: lat, longitude: lng, name: title, address, ...(replyPack?.v1 || {}) },
    { chatId: to, latitude: lat, longitude: lng, name: title, address, ...(replyPack?.v1 || {}) },

    // v2
    { number: to, latitude: lat, longitude: lng, name: title, address, ...(replyPack?.v2 || {}) },
    { number: to, lat, lng, name: title, address, ...(replyPack?.v2 || {}) },
    { to, latitude: lat, longitude: lng, name: title, address, ...(replyPack?.v2 || {}) },
    { chatId: to, latitude: lat, longitude: lng, name: title, address, ...(replyPack?.v2 || {}) },
  ].map(cleanPayload);

  let lastErr;

  for (let i = 0; i < payloads.length; i++) {
    const payload = payloads[i];
    try {
      const res = await axios.post(
        `${EVO_BASE}/message/sendLocation/${INSTANCE}`,
        payload,
        { headers: evoHeaders(), timeout: 15000 }
      );

      const msgId = res?.data?.key?.id || res?.data?.messageId || res?.data?.msgId || null;
      return { ...res.data, msgId };
    } catch (e) {
      lastErr = e;
      const status = e?.response?.status;
      if (status && status !== 400) throw e;

      console.error("sendLocation schema failed", { i, status, data: e?.response?.data });
    }
  }

  throw lastErr;
}

