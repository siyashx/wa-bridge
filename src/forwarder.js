import axios from 'axios';

const WAS_BASE = process.env.WASENDER_API_BASE || 'https://www.wasenderapi.com';
const API_KEY = process.env.WASENDER_API_KEY;

export async function sendText({ to, text, imageUrl, videoUrl, documentUrl, audioUrl, mentions }) {
  if (process.env.DRY_RUN) {
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

export async function sendLocation({ to, latitude, longitude, name, address }) {
  if (process.env.DRY_RUN) {
    return { success: true, data: { status: 'in_progress' } };
  }

  // 1) Sənədləşməyə uyğun: nested "location"
  try {
    const res = await axios.post(`${WAS_BASE}/api/send-message`, {
      to,
      text: name || address || 'Location',
      location: {
        latitude,
        longitude,
        name,
        address,
      },
    }, {
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 15000
    });
    return res.data;
  } catch (e) {
    // 2) Ayrı endpoint
    try {
      const res2 = await axios.post(`${WAS_BASE}/api/send-location`, {
        to,
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
      // 3) type: 'location'
      try {
        const res3 = await axios.post(`${WAS_BASE}/api/send-message`, {
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
        return res3.data;
      } catch (e3) {
        // 4) Link fallback
        const url = `https://maps.google.com/?q=${latitude},${longitude}`;
        const fallbackText = `${name || address || 'Location'}\n${url}`;
        return sendText({ to, text: fallbackText });
      }
    }
  }
}

