const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const SECRET = process.env.BAILEYS_SECRET || 'sanate_secret_2025';
const PORT = process.env.PORT || 3001;
const AUTH_DIR = './auth_info';

let sock = null, currentQR = null, status = 'disconnected';

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  sock = makeWASocket({ auth: state, printQRInTerminal: false });
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) { currentQR = qr; status = 'qr'; }
    if (connection === 'close') {
      status = 'disconnected'; currentQR = null;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) setTimeout(connectToWhatsApp, 3000);
    }
    if (connection === 'open') { status = 'connected'; currentQR = null; console.log('Conectado WhatsApp!'); }
  });
  sock.ev.on('creds.update', saveCreds);
}

const auth = (req, res, next) => {
  const s = req.headers['x-secret'] || req.query.secret;
  if (s !== SECRET) return res.status(401).json({ error: 'No autorizado' });
  next();
};

app.get('/health', (req, res) => res.json({ ok: true, status }));
app.get('/status', auth, (req, res) => res.json({ status, hasQR: !!currentQR }));
app.get('/qr', auth, async (req, res) => {
  if (!currentQR) return res.json({ qr: null, status });
  const qrDataUrl = await qrcode.toDataURL(currentQR);
  res.json({ qr: qrDataUrl, status });
});
app.get('/chats', auth, (req, res) => res.json({ chats: [] }));
app.get('/messages/:id', auth, (req, res) => res.json({ messages: [] }));
app.post('/send', auth, async (req, res) => {
  const { to, message } = req.body;
  if (!sock || status !== 'connected') return res.status(400).json({ error: 'No conectado' });
  try { await sock.sendMessage(to, { text: message }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/logout', auth, async (req, res) => {
  if (sock) { try { await sock.logout(); } catch(e){} }
  status = 'disconnected'; currentQR = null;
  if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true });
  res.json({ ok: true });
  setTimeout(connectToWhatsApp, 2000);
});

app.listen(PORT, () => { console.log('Servidor Baileys en puerto', PORT); connectToWhatsApp(); });
