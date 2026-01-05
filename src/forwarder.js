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
  if (!obj || typeof obj !== "object") return obj;
  const o = { ...obj };
  Object.keys(o).forEach((k) => o[k] === undefined && delete o[k]);

  if (o.contextInfo) {
    Object.keys(o.contextInfo).forEach((k) => o.contextInfo[k] === undefined && delete o.contextInfo[k]);
    if (!Object.keys(o.contextInfo).length) delete o.contextInfo;
  }

  if (o.quoted) {
    if (o.quoted?.key) Object.keys(o.quoted.key).forEach((k) => o.quoted.key[k] === undefined && delete o.quoted.key[k]);
    if (o.quoted?.message) Object.keys(o.quoted.message).forEach((k) => o.quoted.message[k] === undefined && delete o.quoted.message[k]);
  }

  return o;
}

function buildQuotedMessageObj({ quotedText, quotedMessage }) {
  if (quotedMessage && typeof quotedMessage === "object") return quotedMessage;
  return { conversation: quotedText || "" };
}

/**
 * ✅ Reply builder (stabil):
 * - quoted.key.fromMe: true (çünki dest-də forwarded msg sənin botundur)
 * - participant yalnız fromMe=false olarsa ver (bizdə lazım deyil)
 */
function buildReplyBundle({
  chatJid,
  replyTo,
  quotedText,
  quotedMessage,
  quotedFromMe = true, // ✅ default TRUE
}) {
  if (!replyTo) return {};

  const messageObj = buildQuotedMessageObj({ quotedText, quotedMessage });

  const quotedKey = clean({
    remoteJid: chatJid,
    id: replyTo,
    fromMe: !!quotedFromMe, // ✅ ƏSAS FIX
    // participant: ... (fromMe true olanda göndərmirik)
  });

  const bundle = {
    quoted: {
      key: quotedKey,
      message: messageObj,
    },
    contextInfo: clean({
      stanzaId: replyTo,
      quotedMessage: messageObj,
      // participant: ... (fromMe true olanda göndərmirik)
    }),
  };

  return clean(bundle);
}

export async function sendText({
  to,
  text,
  mentions,
  replyTo,
  quotedText,
  quotedMessage,
  quotedFromMe, // ✅ yeni
}) {
  if (process.env.DRY_RUN) return { success: true, msgId: "dry_run" };

  let payload = {
    number: to,
    text: text || "",
    mentions,
  };

  if (replyTo) {
    payload = {
      ...payload,
      ...buildReplyBundle({
        chatJid: to,
        replyTo,
        quotedText,
        quotedMessage,
        quotedFromMe,
      }),
    };
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
  quotedFromMe,
}) {
  if (process.env.DRY_RUN) return { success: true, msgId: "dry_run" };

  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error(`Invalid lat/lng: ${latitude}, ${longitude}`);
  }

  const title = (name && String(name).trim()) ? String(name).trim() : "Konum";
  const addr = (address && String(address).trim()) ? String(address).trim() : "—";

  const replyBundle = replyTo
    ? buildReplyBundle({
      chatJid: to,
      replyTo,
      quotedText,
      quotedMessage,
      quotedFromMe,
    })
    : {};

  // ✅ 3 variant: fərqli Evolution build-lər fərqli schema istəyir
  const variants = [
    clean({
      number: to,
      latitude: lat,
      longitude: lng,
      name: title,
      address: addr,
      ...replyBundle,
    }),
    clean({
      number: to,
      lat,
      lng,
      name: title,
      address: addr,
      ...replyBundle,
    }),
    // bəzi build-lər nested location qəbul edir:
    clean({
      number: to,
      location: {
        degreesLatitude: lat,
        degreesLongitude: lng,
        name: title,
        address: addr,
      },
      ...replyBundle,
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

      console.error("sendLocation failed", {
        i,
        status: e?.response?.status,
        payload: variants[i],
        // ✅ bunu da çıxart ki, Evolution nə tələb etdiyini görək:
        evoMessage: e?.response?.data?.response?.message || e?.response?.data,
      });

      // 400-dürsə növbəti varianta keçirik
      const status = e?.response?.status;
      if (status && status !== 400) throw e;
    }
  }

  throw lastErr;
}

