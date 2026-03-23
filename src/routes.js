const express = require('express');
const router = express.Router();
const QRCode = require('qrcode');
const { getConnectionState, getQR, getProfilePhoto, getContactName, sendMessage, disconnect, getSocket, contactCache } = require('./baileys');
const { getChats, getMessages } = require('./supabase');

function auth(req, res, next) {
  const openPaths = ['/events', '/status', '/qr', '/settings'];
  if (openPaths.some(p => req.path === p || req.path.startsWith(p))) return next();
  if (process.env.API_SECRET) {
    const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token || req.headers['x-api-key'];
    if (token !== process.env.API_SECRET) {
      const origin = req.headers.origin || req.headers.referer || '';
      if (!origin.includes('sanate.store')) return res.status(401).json({ error: 'No autorizado' });
    }
  }
  next();
}
router.use(auth);

router.get('/status', (req, res) => {
  res.json({
    status: getConnectionState(), connected: getConnectionState() === 'connected',
    hasQR: !!getQR(), uptime: Math.floor(process.uptime()),
    sseClients: req.app.get('sse')?.getStatus()?.clients || 0,
    contactsInCache: contactCache.keys().length,
    server: 'sanate-wa-server', engine: 'baileys-standalone',
    timestamp: new Date().toISOString()
  });
});

router.get('/qr', async (req, res) => {
  const qr = getQR();
  const state = getConnectionState();
  if (state === 'connected') return res.json({ status: 'connected', message: 'Ya conectado' });
  if (!qr) return res.json({ status: 'waiting', message: 'Esperando QR...' });
  try {
    const qrImage = await QRCode.toDataURL(qr, { width: 300 });
    res.json({ status: 'qr_ready', qr: qrImage, raw: qr });
  } catch (err) { res.json({ status: 'qr_ready', qr: null, raw: qr }); }
});

router.get('/chats', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const chats = await getChats(limit);
    const enriched = chats.map(chat => ({
      ...chat,
      // Campos que el frontend espera (normChat)
      chatId: chat.jid,
      id: chat.jid,
      name: getContactName(chat.jid) || chat.name || chat.phone,
      pushName: chat.push_name || getContactName(chat.jid) || chat.name,
      phone: chat.phone,
      lastMessageAt: chat.last_timestamp,
      updatedAt: chat.updated_at || chat.last_timestamp,
      lastMessagePreview: chat.last_message || '',
      preview: chat.last_message || '',
      unreadCount: chat.unread || 0,
      photoUrl: chat.profile_photo_url || '',
    }));
    res.json({ chats: enriched, total: enriched.length, source: 'supabase' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/chats/:chatId/messages', async (req, res) => {
  try {
    const chatId = decodeURIComponent(req.params.chatId);
    const limit = parseInt(req.query.limit) || 50;
    const before = req.query.before || null;
    const messages = await getMessages(chatId, limit, before);
    // Transformar campos para el frontend (normMsg espera text, direction, type)
    const mapped = messages.map(m => ({
      ...m,
      id: m.message_id || m.id,
      providerMessageId: m.message_id,
      text: m.content || '',
      txt: m.content || '',
      direction: m.direction === 's' ? 'outgoing' : 'incoming',
      dir: m.direction,
      type: m.media_type || 'text',
      timestamp: m.timestamp,
      mediaUrl: m.media_url || '',
    }));
    res.json({ ok: true, messages: mapped, chatId, total: mapped.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/chats/:chatId/photo', async (req, res) => {
  try {
    const chatId = decodeURIComponent(req.params.chatId);
    const url = await getProfilePhoto(chatId);
    res.json({ photo: url, source: url ? 'whatsapp' : 'unavailable' });
  } catch { res.json({ photo: null, source: 'error' }); }
});

router.get('/events', (req, res) => {
  const sse = req.app.get('sse');
  if (!sse) return res.status(500).json({ error: 'SSE no disponible' });
  sse.addClient(req, res);
});

// Route alias: frontend sends to /chats/:chatId/send
router.post('/chats/:chatId/send', async (req, res) => {
  try {
    const chatId = decodeURIComponent(req.params.chatId);
    const { message, type = 'text' } = req.body;
    if (!chatId || !message) return res.status(400).json({ error: 'chatId y message son requeridos' });

    let content;
    if (type === 'text') content = { text: message };
    else if (type === 'image') content = { image: { url: message.url }, caption: message.caption };
    else if (type === 'document') content = { document: { url: message.url }, fileName: message.fileName };
    else content = { text: message };

    const result = await sendMessage(chatId, content);
    res.json({ ok: true, success: true, messageId: result.key.id || result.key });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/send', async (req, res) => {
  try {
    const { chatId, message, type = 'text' } = req.body;
    if (!chatId || !message) return res.status(400).json({ error: 'chatId y message son requeridos' });
    let content;
    if (type === 'text') content = message;
    else if (type === 'image') content = { image: { url: message.url }, caption: message.caption };
    else if (type === 'document') content = { document: { url: message.url }, fileName: message.fileName };
    else content = message;
    const result = await sendMessage(chatId, content);
    res.json({ success: true, messageId: result.key.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/disconnect', async (req, res) => {
  try { await disconnect(); res.json({ success: true, message: 'Desconectado' }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/settings', (req, res) => {
  res.json({
    server: 'sanate-wa-server', version: '2.0.0', engine: 'baileys-standalone',
    connection: getConnectionState(), sse: req.app.get('sse')?.getStatus(),
    supabase: !!req.app.get('supabase'), uptime: Math.floor(process.uptime()),
    contacts: contactCache.keys().length
  });
});

router.get('/contacts', async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    if (!supabase) return res.json({ clients: [] });
    const { data, error } = await supabase.from('oasis_wa_chats').select('*').order('last_timestamp', { ascending: false });
    if (error) throw error;
    const enriched = (data || []).map(c => ({ ...c, live_name: getContactName(c.jid) || c.name || c.phone }));
    res.json({ clients: enriched, total: enriched.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
