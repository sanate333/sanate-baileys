const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const fs = require('fs');
const pino = require('pino');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const SECRET = process.env.SECRET || process.env.BAILEYS_SECRET || 'sanate_secret_2025';
const PORT = process.env.PORT || 3000;
const AUTH_DIR = './auth_info';

let sock = null, currentQR = null, status = 'disconnected', reconnectTimer = null;

async function connectToWhatsApp() {
  try {
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: true,
      logger: pino({ level: 'silent' }),
      browser: ['Chrome', 'Chrome', '120.0.0'],
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
    });
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) { currentQR = qr; status = 'qr'; console.log('QR listo'); }
      if (connection === 'close') {
        status = 'disconnected'; currentQR = null;
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code !== DisconnectReason.loggedOut) {
          if (reconnectTimer) clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(connectToWhatsApp, 5000);
        }
      }
      if (connection === 'open') { status = 'connected'; currentQR = null; console.log('Conectado!'); }
    });
    sock.ev.on('creds.update', saveCreds);
  } catch (err) {
    console.error('Error:', err.message);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectToWhatsApp, 8000);
  }
}

const auth = (req, res, next) => {
  const s = req.headers['x-secret'] || req.query.secret;
  if (s !== SECRET) return res.status(401).json({ error: 'No autorizado' });
  next();
};

app.get('/health', (req, res) => res.json({ ok: true, status, hasQR: !!currentQR }));
app.get('/status', auth, (req, res) => res.json({ status, hasQR: !!currentQR }));
app.get('/qr', auth, async (req, res) => {
  if (!currentQR) return res.json({ qr: null, status });
  try {
    const qrDataUrl = await qrcode.toDataURL(currentQR, { width: 500, margin: 2, errorCorrectionLevel: 'M' });
    res.json({ qr: qrDataUrl, status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/chats', auth, (req, res) => res.json({ chats: [] }));
app.get('/messages/:id', auth, (req, res) => res.json({ messages: [] }));
app.post('/send', auth, async (req, res) => {
  const { to, message } = req.body;
  if (!sock || status !== 'connected') return res.status(400).json({ error: 'No conectado' });
  try {
    const jid = to.includes('@') ? to : to + '@s.whatsapp.net';
    await sock.sendMessage(jid, { text: message });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/logout', auth, async (req, res) => {
  if (sock) { try { await sock.logout(); } catch(e){} }
  status = 'disconnected'; currentQR = null;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true });
  res.json({ ok: true });
  reconnectTimer = setTimeout(connectToWhatsApp, 2000);
});

app.listen(PORT, () => {
  console.log('Puerto:', PORT);
  connectToWhatsApp();
});
