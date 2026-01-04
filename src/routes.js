import express from 'express';
import { sendText } from './forwarder.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

// Health
app.get('/health', (req, res) => res.json({ ok: true }));

// Webhook
app.post('/webhook', async (req, res) => {
  try {
    // 1) API KEY yoxla (Evolution)
    const apikey = req.headers['apikey'];
    if (!apikey || apikey !== process.env.EVOLUTION_API_KEY) {
      return res.status(401).json({ error: 'Invalid apikey' });
    }

    // 2) Tez 200 qaytar
    res.status(200).json({ received: true });

    const { event, data } = req.body || {};
    if (event !== 'MESSAGES_UPSERT') return;

    const messages = data?.messages || [];
    for (const m of messages) {
      if (m.key?.fromMe) continue;

      const remoteJid = m.key?.remoteJid;
      const senderJid = m.key?.participant || '';

      // yalnız A qrupu
      if (remoteJid !== process.env.GROUP_A_JID) continue;

      const msg = m.message || {};

      const text =
        msg.conversation ||
        msg?.extendedTextMessage?.text ||
        msg?.imageMessage?.caption ||
        msg?.videoMessage?.caption ||
        '';

      if (!text) continue;

      const phone = senderJid.replace('@s.whatsapp.net', '');
      const bridged = `${text}\n\n— ${phone}`;

      // B qrupuna ötür
      await sendText({
        to: process.env.GROUP_B_JID,
        text: bridged,
      });
    }
  } catch (e) {
    console.error('Webhook error:', e?.response?.data || e.message);
  }
});

export default app;

