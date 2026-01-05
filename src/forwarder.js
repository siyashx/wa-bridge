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

export async function sendText({ to, text, mentions, replyTo }) {
  if (process.env.DRY_RUN) {
    return { success: true, msgId: "dry_run" };
  }

  const payload = {
    number: to,
    text: text || "",
    mentions,

    // ✅ Evolution variantları (hansı işləsə API özü götürəcək)
    replyTo,
    quoted: replyTo,
    quotedMsgId: replyTo,
    quotedMessageId: replyTo,
  };

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


export async function sendLocation({ to, latitude, longitude, name, address }) {
  if (process.env.DRY_RUN) {
    return { success: true, msgId: "dry_run" };
  }

  const lat = Number(latitude);
  const lng = Number(longitude);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error(`Invalid lat/lng: ${latitude}, ${longitude}`);
  }

  const title = (name && String(name).trim()) ? String(name).trim() : "Konum";

  // ✅ müxtəlif schema-ları bir-bir sınayırıq
  const payloads = [
    { number: to, latitude: lat, longitude: lng, name: title, address },  // 1
    { number: to, lat, lng, name: title, address },                       // 2
    { to, latitude: lat, longitude: lng, name: title, address },          // 3
    { chatId: to, latitude: lat, longitude: lng, name: title, address },  // 4
  ].map(p => {
    Object.keys(p).forEach(k => p[k] === undefined && delete p[k]);
    return p;
  });

  let lastErr;

  for (let i = 0; i < payloads.length; i++) {
    const payload = payloads[i];
    try {
      const res = await axios.post(
        `${EVO_BASE}/message/sendLocation/${INSTANCE}`,
        payload,
        { headers: evoHeaders(), timeout: 15000 }
      );

      const msgId =
        res?.data?.key?.id ||
        res?.data?.messageId ||
        res?.data?.msgId ||
        null;

      return { ...res.data, msgId };
    } catch (e) {
      lastErr = e;

      // ✅ 400 olsa növbəti payload sınayırıq
      const status = e?.response?.status;
      if (status && status !== 400) throw e;

      // debug üçün qısa log
      console.error("sendLocation schema failed", {
        i,
        status,
        data: e?.response?.data,
      });
    }
  }

  // hamısı fail olsa
  throw lastErr;
}

