// forwarder.js
import axios from "axios";

const EVO_BASE = process.env.EVOLUTION_API_BASE || "http://127.0.0.1:8080";
const EVO_KEY = process.env.EVOLUTION_API_KEY;
const INSTANCE = process.env.EVOLUTION_INSTANCE || "default";

function evoHeaders() {
  return {
    apikey: EVO_KEY,
    "Content-Type": "application/json",
  };
}

function clean(obj) {
  const o = { ...obj };
  Object.keys(o).forEach(k => o[k] === undefined && delete o[k]);

  if (o.contextInfo) {
    Object.keys(o.contextInfo).forEach(k => o.contextInfo[k] === undefined && delete o.contextInfo[k]);
    if (!Object.keys(o.contextInfo).length) delete o.contextInfo;
  }

  if (o.quoted) {
    if (o.quoted?.key) Object.keys(o.quoted.key).forEach(k => o.quoted.key[k] === undefined && delete o.quoted.key[k]);
    if (o.quoted?.message) Object.keys(o.quoted.message).forEach(k => o.quoted.message[k] === undefined && delete o.quoted.message[k]);
    if (!Object.keys(o.quoted.key || {}).length) delete o.quoted;
  }

  return o;
}

/**
 * ✅ Reply üçün ən stabil: contextInfo + quoted (baileys-vari)
 * QAYDA:
 * - stanzaId = replyTo (dest msg id)
 * - participant göndərmə (çünki dest-də quoted mesaj botundur, mismatch olur)
 * - quoted.key.fromMe = true (çünki dest-də msg botdan gedib)
 */
function buildReplyBits({ chatJid, replyTo, quotedText, quotedMessage }) {
  if (!replyTo) return {};

  const messageObj =
    (quotedMessage && typeof quotedMessage === "object")
      ? quotedMessage
      : { conversation: quotedText || "" };

  return clean({
    contextInfo: {
      stanzaId: replyTo,
      quotedMessage: messageObj,
      // ❌ participant BURDA YOXDUR — mismatch bug-un kökü bu idi
    },
    quoted: {
      key: {
        remoteJid: chatJid,
        fromMe: true,      // ✅ dest-də quoted msg sənin botundur
        id: replyTo,
      },
      message: messageObj,
    },
  });
}

export async function sendText({ to, text, mentions, replyTo, quotedText, quotedMessage }) {
  if (process.env.DRY_RUN) return { success: true, msgId: "dry_run" };

  let payload = clean({
    number: to,
    text: text || "",
    mentions,
    ...buildReplyBits({ chatJid: to, replyTo, quotedText, quotedMessage }),
  });

  const res = await axios.post(
    `${EVO_BASE}/message/sendText/${INSTANCE}`,
    payload,
    { headers: evoHeaders(), timeout: 30000 }
  );

  const msgId = res?.data?.key?.id || res?.data?.messageId || res?.data?.msgId || null;
  return { ...res.data, msgId };
}

export async function sendLocation({
  to,
  latitude,
  longitude,
  name,
  address,
  replyTo,
  quotedText,
  quotedMessage,
}) {
  if (process.env.DRY_RUN) return { success: true, msgId: "dry_run" };

  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error(`Invalid lat/lng: ${latitude}, ${longitude}`);
  }

  const title = (name && String(name).trim()) ? String(name).trim() : "Konum";

  const replyBits = buildReplyBits({ chatJid: to, replyTo, quotedText, quotedMessage });

  // bəzi evolution build-lər latitude/longitude, bəziləri lat/lng istəyir
  const variants = [
    clean({
      number: to,
      latitude: lat,
      longitude: lng,
      name: title,
      address: address || undefined,
      ...replyBits,
    }),
    clean({
      number: to,
      lat,
      lng,
      name: title,
      address: address || undefined,
      ...replyBits,
    }),
  ];

  let lastErr;
  for (let i = 0; i < variants.length; i++) {
    try {
      const res = await axios.post(
        `${EVO_BASE}/message/sendLocation/${INSTANCE}`,
        variants[i],
        { headers: evoHeaders(), timeout: 60000 }
      );

      const msgId = res?.data?.key?.id || res?.data?.messageId || res?.data?.msgId || null;
      return { ...res.data, msgId };
    } catch (e) {
      lastErr = e;
      const status = e?.response?.status;

      console.error("sendLocation failed", {
        i,
        status,
        payload: variants[i],
        data: e?.response?.data,
      });

      if (status && status !== 400) throw e;
    }
  }

  throw lastErr;
}
