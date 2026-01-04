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
  if (process.env.DRY_RUN) {
    return { success: true, msgId: "dry_run" };
  }

  const payload = {
    number: to,
    // Evolution-də adətən bu struktur işləyir:
    location: {
      degreesLatitude: Number(latitude),
      degreesLongitude: Number(longitude),
      name: name || undefined,
      address: address || undefined,
    },
  };

  // bəzən caption/text də istəyir
  if (name || address) payload.text = name || address;

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
}
