import express from 'express';
import { sendText } from './forwarder.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

// Health
app.get('/health', (req, res) => res.json({ ok: true }));

// Webhook
app.post('/webhook', async (req, res) => {
  try {
    // 1) Signature yoxlaması
    const sig = req.headers['x-webhook-signature'];
    if (!sig || sig !== process.env.WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // 2) Tez cavab ver (Wasender sürətli 200 istəyir)
    res.status(200).json({ received: true });

    // 3) Event-i emal et
    const { event, data } = req.body || {};

    // A qrupundan gələn qrup mesajlarını tuturuq
    if (event === 'messages-group.received' && data?.key?.remoteJid === process.env.GROUP_A_JID) {
      const groupJid = data.key.remoteJid;                // A qrupu
      const senderJid = data.key.participant || '';       // 5511999...@s.whatsapp.net
      const msg = data.message || {};

      // Mətni çıxar (sadə nümunə: conversation və ya extendedTextMessage)
      let text = msg.conversation
        || msg?.extendedTextMessage?.text
        || msg?.imageMessage?.caption
        || msg?.videoMessage?.caption
        || '';

      if (!text) return;

      // Göndərənin nömrəsini sonda əlavə et
      const phone = senderJid.replace('@s.whatsapp.net', '');
      const bridged = `${text}\n\n— ${phone}`;

      // B qrupuna göndər
      await sendText({ to: process.env.GROUP_B_JID, text: bridged });
      return;
    }

    // Şəxsi mesajlar (istəsən aktiv et)
    // if (event === 'messages-personal.received') { ... }

  } catch (e) {
    // burda sırf log
    console.error('Webhook handler error:', e?.response?.data || e.message);
    // cavab artıq göndərilib
  }
});

export default app;
