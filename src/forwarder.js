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
    number: to,              // group jid də ola bilər (xxx@g.us)
    text: text || "",
    // bəzi versiyalarda "mentions" qəbul edir; problem olsa silərik
    mentions,
    // bəzi versiyalarda quoted/reply üçün "quoted" / "quotedMsgId" ola bilər
    // səndəki forwardMap logic üçün replyTo saxlayırıq, alınmasa ignore edəcəyik
    replyTo,
  };

  Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);

  const res = await axios.post(
    `${EVO_BASE}/message/sendText/${INSTANCE}`,
    payload,
    { headers: evoHeaders(), timeout: 15000 }
  );

  // mümkün msgId-lər:
  const msgId =
    res?.data?.key?.id ||
    res?.data?.messageId ||
    res?.data?.msgId ||
    null;

  return { ...res.data, msgId };
}

export async function sendLocation({ to, latitude, longitude, name, address }) {
  const lat = Number(latitude);
  const lng = Number(longitude);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error(`Invalid lat/lng: ${latitude}, ${longitude}`);
  }

  const title = (name && String(name).trim()) ? String(name).trim() : 'Konum';

  const payloads = [
    // ✅ variant 1 (çox API-lərdə belədir)
    { number: to, latitude: lat, longitude: lng, name: title, address: address || undefined },

    // ✅ variant 2 (sənin indiki kimi)
    { to, latitude: lat, longitude: lng, name: title, address: address || undefined },

    // ✅ variant 3 (bəzilərində lat/lng adları fərqlidir)
    { number: to, lat, lng, title, address: address || undefined },

    // ✅ variant 4
    { chatId: to, latitude: lat, longitude: lng, name: title, address: address || undefined },
  ];

  let lastErr;
  for (let i = 0; i < payloads.length; i++) {
    try {
      // burada sənin axios.post(...) çağırışın var
      return await postLocation(payloads[i]); // <- sənin real endpoint çağırışın
    } catch (e) {
      lastErr = e;
      const status = e?.response?.status;
      // 400-də növbəti schema sınayaq, 401/403-də boşuna sınama
      if (status && status !== 400) throw e;
    }
  }
  
  throw lastErr;
}

