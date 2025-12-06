import axios from 'axios';

const WAS_BASE = process.env.WASENDER_API_BASE || 'https://www.wasenderapi.com';
const API_KEY = process.env.WASENDER_API_KEY;

export async function sendText({ to, text, imageUrl, videoUrl, documentUrl, audioUrl, mentions }) {
  if (process.env.DRY_RUN) {
    console.log('[DRY_RUN] would send =>', { to, text, imageUrl, videoUrl, documentUrl, audioUrl, mentions });
    return { success: true, data: { status: 'in_progress' } };
  }

  const payload = { to, text, imageUrl, videoUrl, documentUrl, audioUrl, mentions };
  Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k]);

  const res = await axios.post(`${WAS_BASE}/api/send-message`, payload, {
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    timeout: 15000
  });
  return res.data;
}

// ✅ REAL pin (WhatsApp location) göndərişi
export async function sendLocation({ to, latitude, longitude, name, address }) {
  if (process.env.DRY_RUN) {
    console.log('[DRY_RUN] would send location =>', { to, latitude, longitude, name, address });
    return { success: true, data: { status: 'in_progress' } };
  }

  // 1) Birbaşa location endpoint (əgər WASender bunu dəstəkləyirsə)
  try {
    const res = await axios.post(`${WAS_BASE}/api/send-location`, {
      to,
      latitude,
      longitude,
      name,
      address,
    }, {
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 15000
    });
    return res.data;
  } catch (e) {
    // 2) Fallback — bəzi hostlar location-ı /api/send-message ilə `type:"location"` kimi qəbul edir
    try {
      const res2 = await axios.post(`${WAS_BASE}/api/send-message`, {
        to,
        type: 'location',
        latitude,
        longitude,
        name,
        address,
      }, {
        headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
        timeout: 15000
      });
      return res2.data;
    } catch (e2) {
      // 3) Son çarə — xəritə linkini mətn kimi at (pin yox, amma boş qalmasın)
      const url = `https://maps.google.com/?q=${latitude},${longitude}`;
      const fallbackText = `${name || address || 'Location'}\n${url}`;
      return sendText({ to, text: fallbackText });
    }
  }
}

