const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const fs2 = require('fs');
const pino = require('pino');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const SECRET = process.env.SECRET || process.env.BAILEYS_SECRET || 'sanate_secret_2025';
const PORT = process.env.PORT || 3000;
const AUTH_DIR = './auth_info';
const WA_HISTORY_DAYS = 15;

let sock = null, currentQR = null, waStatus = 'disconnected', reconnectTimer = null;
const waChats = new Map();
const waMessages = new Map();

function storeMsg(msg) {
  try {
    const cutoff = Date.now() - WA_HISTORY_DAYS * 86400000;
    const ts = (msg.messageTimestamp || 0) * 1000;
    if (ts && ts < cutoff) return;
    const jid = msg.key && msg.key.remoteJid;
    if (!jid || jid === 'status@broadcast') return;
    const m = msg.message || {};
    const body = m.conversation || (m.extendedTextMessage && m.extendedTextMessage.text) || (m.imageMessage && (m.imageMessage.caption || '[Imagen]')) || (m.videoMessage && (m.videoMessage.caption || '[Video]')) || (m.audioMessage && '[Audio]') || (m.documentMessage && '[Documento]') || (m.stickerMessage && '[Sticker]') || '[Mensaje]';
    const name = msg.pushName || (waChats.get(jid) && waChats.get(jid).name) || jid.split('@')[0];
    const prev = waChats.get(jid) || {};
    waChats.set(jid, { id: jid, name, unread: (prev.unread || 0) + (msg.key && msg.key.fromMe ? 0 : 1), lastMsg: body, ts: ts || prev.ts || Date.now() });
    const arr = waMessages.get(jid) || [];
    arr.push({ id: msg.key && msg.key.id, fromMe: !!(msg.key && msg.key.fromMe), body, ts, type: Object.keys(m)[0] || 'unknown' });
    if (arr.length > 200) arr.splice(0, arr.length - 200);
    waMessages.set(jid, arr);
  } catch (e) { console.error('storeMsg error:', e.message); }
}

async function connectToWhatsApp() {
  try {
    if (!fs2.existsSync(AUTH_DIR)) fs2.mkdirSync(AUTH_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({ version, auth: state, printQRInTerminal: true, logger: pino({ level: 'silent' }), browser: ['Sanate Bot', 'Chrome', '1.0'], connectTimeoutMs: 60000, defaultQueryTimeoutMs: 60000, keepAliveIntervalMs: 25000, syncFullHistory: true });
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) { currentQR = qr; waStatus = 'qr'; console.log('QR listo'); }
      if (connection === 'close') {
        waStatus = 'disconnected'; currentQR = null;
        const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode;
        if (code !== DisconnectReason.loggedOut) { if (reconnectTimer) clearTimeout(reconnectTimer); reconnectTimer = setTimeout(connectToWhatsApp, 5000); }
      }
      if (connection === 'open') { waStatus = 'connected'; currentQR = null; console.log('Conectado! Chats:', waChats.size); }
    });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify' && type !== 'append') return;
      for (const msg of messages) storeMsg(msg);
      console.log('messages.upsert type=' + type + ' count=' + messages.length + ' chats=' + waChats.size);
    });
    sock.ev.on('messaging-history.set', ({ chats, messages, isLatest }) => {
      console.log('history.set: ' + chats.length + ' chats ' + messages.length + ' msgs isLatest=' + isLatest);
      const cutoff = Date.now() - WA_HISTORY_DAYS * 86400000;
      for (const chat of chats) {
        if (!chat.id || chat.id === 'status@broadcast') continue;
        if (!waChats.has(chat.id)) waChats.set(chat.id, { id: chat.id, name: chat.name || chat.id.split('@')[0], unread: chat.unreadCount || 0, lastMsg: '', ts: Date.now() });
      }
      for (const msg of messages) { const ts = (msg.messageTimestamp || 0) * 1000; if (ts && ts < cutoff) continue; storeMsg(msg); }
      console.log('After history: chats=' + waChats.size + ' jids=' + waMessages.size);
    });
    sock.ev.on('chats.upsert', (chats) => {
      for (const chat of chats) {
        if (!chat.id || chat.id === 'status@broadcast') continue;
        const prev = waChats.get(chat.id) || {};
        waChats.set(chat.id, { ...prev, id: chat.id, name: chat.name || prev.name || chat.id.split('@')[0], unread: chat.unreadCount !== undefined ? chat.unreadCount : (prev.unread || 0), ts: prev.ts || Date.now() });
      }
    });
  } catch (err) { console.error('connectToWhatsApp error:', err.message); if (reconnectTimer) clearTimeout(reconnectTimer); reconnectTimer = setTimeout(connectToWhatsApp, 8000); }
}

const auth = (req, res, next) => { const s = req.headers['x-secret'] || req.query.secret; if (s !== SECRET) return res.status(401).json({ error: 'No autorizado' }); next(); };

app.get('/health', (req, res) => res.json({ ok: true, status: waStatus, hasQR: !!currentQR }));
app.get('/ping',   (req, res) => res.json({ v: '2.2', chats: waChats.size, msgs: waMessages.size, status: waStatus, ts: Date.now() }));
app.get('/status', auth, (req, res) => res.json({ status: waStatus, hasQR: !!currentQR }));
app.get('/qr', auth, async (req, res) => {
  if (!currentQR) return res.json({ qr: null, status: waStatus });
  try { const qrDataUrl = await qrcode.toDataURL(currentQR, { width: 500, margin: 2, errorCorrectionLevel: 'M' }); res.json({ qr: qrDataUrl, status: waStatus }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/chats', auth, (req, res) => {
  const all = Array.from(waChats.values());
  const withMsgs = all.filter(c => waMessages.has(c.id));
  const withoutMsgs = all.filter(c => !waMessages.has(c.id));
  const sortTs = (a, b) => (b.ts || 0) - (a.ts || 0);
  const sorted = [...withMsgs.sort(sortTs), ...withoutMsgs.sort(sortTs)].slice(0, 100);
  const list = sorted.map(chat => ({
    id: chat.id,
    name: chat.name || chat.id.split('@')[0],
    phone: chat.id.split('@')[0],
    preview: chat.lastMsg || '',
    time: chat.ts ? new Date(chat.ts).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) : '',
    unread: chat.unread || 0,
  }));
  res.json({ chats: list });
});
app.get('/messages/:id', auth, (req, res) => {
  const jid = decodeURIComponent(req.params.id);
  let msgs = waMessages.get(jid) || [];
  if (!msgs.length && !jid.includes('@')) msgs = waMessages.get(jid + '@s.whatsapp.net') || [];
  if (waChats.has(jid)) { const c = waChats.get(jid); waChats.set(jid, { ...c, unread: 0 }); }
  const formatted = msgs.slice(-50).map(msg => ({
    id: msg.id,
    dir: msg.fromMe ? 's' : 'r',
    txt: msg.body || '',
    time: msg.ts ? new Date(msg.ts).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) : '',
    ts: msg.ts,
  }));
  res.json({ messages: formatted });
});
app.post('/send', auth, async (req, res) => {
  const { to, message } = req.body;
  if (!sock || waStatus !== 'connected') return res.status(400).json({ error: 'No conectado' });
  try { const jid = to.includes('@') ? to : to + '@s.whatsapp.net'; await sock.sendMessage(jid, { text: message }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/logout', auth, async (req, res) => {
  if (sock) { try { await sock.logout(); } catch (e) {} }
  waStatus = 'disconnected'; currentQR = null; waChats.clear(); waMessages.clear();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (fs2.existsSync(AUTH_DIR)) fs2.rmSync(AUTH_DIR, { recursive: true });
  res.json({ ok: true });
  reconnectTimer = setTimeout(connectToWhatsApp, 2000);
});
app.listen(PORT, () => { console.log('Puerto:', PORT); connectToWhatsApp(); });
