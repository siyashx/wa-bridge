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

/** Location/media üçün ən stabil reply forması: contextInfo */
function buildReplyContext({ replyTo, quotedText, quotedMessage, participant }) {
  if (!replyTo) return undefined;

  const messageObj =
    (quotedMessage && typeof quotedMessage === "object")
      ? quotedMessage
      : { conversation: quotedText || "" };

  return clean({
    stanzaId: replyTo,
    participant: participant || undefined, // ✅ əlavə et
    quotedMessage: messageObj,
  });
}

/** Text üçün sənin əvvəlki reply variantın (qalsın) */
function buildReplyPayload({ chatJid, replyTo, quotedText, quotedMessage }) {
  if (!replyTo) return {};

  const messageObj =
    (quotedMessage && typeof quotedMessage === "object")
      ? quotedMessage
      : { conversation: quotedText || "" };

  const v1 = {
    replyTo,
    quotedMsgId: replyTo,
    quotedMessageId: replyTo,
    quoted: {
      key: { remoteJid: chatJid, fromMe: false, id: replyTo }, // ✅ false daha uyğundur
      message: messageObj,
    },

    contextInfo: {
      stanzaId: replyTo,
      quotedMessage: messageObj,
    },
  };

  return { v1 };
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
  }
  return o;
}

export async function sendText({ to, text, mentions, replyTo, quotedText, quotedMessage }) {
  if (process.env.DRY_RUN) return { success: true, msgId: "dry_run" };

  let payload = {
    number: to,
    text: text || "",
    mentions,
  };

  if (replyTo) {
    const { v1 } = buildReplyPayload({ chatJid: to, replyTo, quotedText, quotedMessage });
    payload = { ...payload, ...v1 };
  }

  payload = clean(payload);

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
  participant       // ✅ BURANI ƏLAVƏ ET
}) {

  if (process.env.DRY_RUN) return { success: true, msgId: "dry_run" };

  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error(`Invalid lat/lng: ${latitude}, ${longitude}`);
  }

  const title = (name && String(name).trim()) ? String(name).trim() : "Konum";
  const contextInfo = replyTo
    ? buildReplyContext({ replyTo, quotedText, quotedMessage, participant })
    : undefined;

  // ✅ 2 variant: bəzi evolution build-lər latitude/longitude istəyir, bəziləri lat/lng
  const variants = [
    clean({
      number: to,
      latitude: lat,
      longitude: lng,
      name: title,
      address: address || undefined,
      contextInfo,
    }),
    clean({
      number: to,
      lat,
      lng,
      name: title,
      address: address || undefined,
      contextInfo,
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

      // 400 olarsa digər variantı yoxla; 400 deyilsə dərhal at
      if (status && status !== 400) throw e;
    }
  }

  throw lastErr;
}

