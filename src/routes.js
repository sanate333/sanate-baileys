const express = require('express');
const router = express.Router();
const QRCode = require('qrcode');
const { getConnectionState, getQR, getProfilePhoto, getContactName, sendMessage, disconnect, getSocket, contactCache } = require('./baileys');
const { getConfig, setConfig } = require('./auto-reply');
const { getChats, getMessages, saveMessage, upsertChat } = require('./supabase');

// Middleware: parse multipart/form-data text fields (no external deps)
function parseMultipart(req, res, next) {
  const ct = req.headers['content-type'] || '';
  if (!ct.includes('multipart/form-data')) return next();
  const boundary = ct.split('boundary=')[1];
  if (!boundary) return next();
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    try {
      const raw = Buffer.concat(chunks).toString();
      const parts = raw.split('--' + boundary).filter(p => p.includes('name='));
      const body = {};
      for (const part of parts) {
        const nameMatch = part.match(/name="([^"]+)"/);
        if (!nameMatch) continue;
        const val = part.split('\r\n\r\n')[1];
        if (val) body[nameMatch[1]] = val.replace(/\r\n--$/, '').trim();
      }
      req.body = { ...req.body, ...body };
    } catch (e) { /* ignore parse errors */ }
    next();
  });
}
router.use(parseMultipart);

function auth(req, res, next) {
  const openPaths = ['/events', '/status', '/qr', '/settings', '/ai-config'];
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
    status: getConnectionState(),
    connected: getConnectionState() === 'connected',
    hasQR: !!getQR(),
    uptime: Math.floor(process.uptime()),
    sseClients: req.app.get('sse')?.getStatus()?.clients || 0,
    contactsInCache: contactCache.keys().length,
    server: 'sanate-wa-server',
    engine: 'baileys-standalone',
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
  } catch (err) {
    res.json({ status: 'qr_ready', qr: null, raw: qr });
  }
});

router.get('/chats', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const chats = await getChats(limit);
    const enriched = chats.map(chat => {
      const jidNum = (chat.jid || '').replace(/@s\.whatsapp\.net|@g\.us|@c\.us|@lid/g, '');
      const phone = chat.phone || (/^\d{7,}$/.test(jidNum) ? '+' + jidNum : '');
      const contactName = getContactName(chat.jid);
      const displayName = contactName || chat.push_name || chat.name || '';
      return {
        ...chat,
        chatId: chat.jid,
        id: chat.jid,
        name: displayName || phone || jidNum,
        pushName: displayName,
        phone,
        platform: 'whatsapp',
        lastMessageAt: chat.last_timestamp,
        updatedAt: chat.updated_at || chat.last_timestamp,
        lastMessagePreview: chat.last_message || '',
        preview: chat.last_message || '',
        unreadCount: chat.unread || 0,
        photoUrl: chat.profile_photo_url || '',
      };
    });
    res.json({ chats: enriched, total: enriched.length, source: 'supabase' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/chats/:chatId/messages', async (req, res) => {
  try {
    const chatId = decodeURIComponent(req.params.chatId);
    const limit = parseInt(req.query.limit) || 50;
    const before = req.query.before || null;
    const messages = await getMessages(chatId, limit, before);
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/chats/:chatId/photo', async (req, res) => {
  try {
    const chatId = decodeURIComponent(req.params.chatId);
    const url = await getProfilePhoto(chatId);
    res.json({ photo: url, source: url ? 'whatsapp' : 'unavailable' });
  } catch {
    res.json({ photo: null, source: 'error' });
  }
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
    const { message, text, type = 'text' } = req.body;
    const msg = message || text;
    if (!chatId || !msg) return res.status(400).json({ error: 'chatId y message son requeridos' });

    let content;
    if (type === 'text') content = { text: msg };
    else if (type === 'image') content = { image: { url: msg.url }, caption: msg.caption };
    else if (type === 'document') content = { document: { url: msg.url }, fileName: msg.fileName };
    else content = { text: msg };

    const result = await sendMessage(chatId, content);
    const msgId = result.key.id || result.key;

    // Persist sent message to Supabase
    const chatName = getContactName(chatId) || chatId.split('@')[0];
    saveMessage(chatId, chatName, {
      messageId: msgId,
      fromMe: true,
      text: typeof msg === 'string' ? msg : msg.caption || '',
      type: type,
      timestamp: Date.now()
    }).catch(() => {});
    upsertChat(chatId, chatName, typeof msg === 'string' ? msg : msg.caption || '', Date.now()).catch(() => {});

    res.json({ ok: true, success: true, messageId: msgId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/send', async (req, res) => {
  try {
    const { chatId, message, text, type = 'text' } = req.body;
    const msg = message || text;
    if (!chatId || !msg) return res.status(400).json({ error: 'chatId y message son requeridos' });

    let content;
    if (type === 'text') content = msg;
    else if (type === 'image') content = { image: { url: msg.url }, caption: msg.caption };
    else if (type === 'document') content = { document: { url: msg.url }, fileName: msg.fileName };
    else content = msg;

    const result = await sendMessage(chatId, content);

    // Persist sent message to Supabase
    const chatName = getContactName(chatId) || chatId.split('@')[0];
    saveMessage(chatId, chatName, {
      messageId: result.key.id,
      fromMe: true,
      text: typeof msg === 'string' ? msg : msg.caption || '',
      type: type,
      timestamp: Date.now()
    }).catch(() => {});
    upsertChat(chatId, chatName, typeof msg === 'string' ? msg : msg.caption || '', Date.now()).catch(() => {});

    res.json({ success: true, messageId: result.key.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/disconnect', async (req, res) => {
  try {
    await disconnect();
    res.json({ success: true, message: 'Desconectado' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/settings', (req, res) => {
  res.json({
    server: 'sanate-wa-server',
    version: '2.0.0',
    engine: 'baileys-standalone',
    connection: getConnectionState(),
    sse: req.app.get('sse')?.getStatus(),
    supabase: !!req.app.get('supabase'),
    uptime: Math.floor(process.uptime()),
    contacts: contactCache.keys().length
  });
});

router.get('/contacts', async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    if (!supabase) return res.json({ clients: [] });
    const { data, error } = await supabase.from('oasis_wa_chats').select('*').order('last_timestamp', { ascending: false });
    if (error) throw error;
    const enriched = (data || []).map(c => ({
      ...c,
      live_name: getContactName(c.jid) || c.name || c.phone
    }));
    res.json({ clients: enriched, total: enriched.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// --- AI CONFIG ENDPOINT (server-side auto-reply settings) ---
router.get('/ai-config', (req, res) => {
  const cfg = getConfig();
  // Don't expose full API keys
  res.json({
    enabled: cfg.enabled,
    hasGeminiKey: !!cfg.geminiKey,
      hasClaudeKey: !!cfg.claudeKey,
    hasOpenaiKey: !!cfg.openaiKey,
    botDelay: cfg.botDelay,
    msgMode: cfg.msgMode,
    useEmojis: cfg.useEmojis,
    hasSystemPrompt: !!cfg.systemPrompt,
  });
});

router.post('/ai-config', (req, res) => {
  try {
    const cfg = req.body;
    if (!cfg || typeof cfg !== 'object') {
      return res.status(400).json({ error: 'Invalid config' });
    }
    setConfig(cfg);
    const updated = getConfig();
    res.json({
      ok: true,
      enabled: updated.enabled,
      hasGeminiKey: !!updated.geminiKey,
        hasClaudeKey: !!updated.claudeKey,
      hasOpenaiKey: !!updated.openaiKey,
      botDelay: updated.botDelay,
      msgMode: updated.msgMode,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- AI REPLY ENDPOINT (supports OpenAI + Claude) ---
router.post('/ai-reply', async (req, res) => {
  try {
    const { chatId, messageType, text, clientName, systemPrompt, openaiKey, claudeKey, history } = req.body;
    
    const useClaude = claudeKey && claudeKey.startsWith('sk-ant-');
    const useOpenai = openaiKey && openaiKey.startsWith('sk-');
    
    if (!useClaude && !useOpenai) {
      return res.status(400).json({ error: 'No valid API key provided (need openaiKey or claudeKey)' });
    }
    if (!text && messageType === 'text') {
      return res.status(400).json({ error: 'No text provided' });
    }

    const userMsg = text || '[mensaje multimedia]';

    // --- CLAUDE (Anthropic) ---
    if (useClaude) {
      console.log('[ai-reply] Using Claude for', chatId);
      const claudeMsgs = [];
      if (history && Array.isArray(history)) {
        history.forEach(h => {
          if (h.role && h.content && h.role !== 'system') {
            claudeMsgs.push({ role: h.role, content: h.content });
          }
        });
      }
      claudeMsgs.push({ role: 'user', content: userMsg });
      
      // Ensure alternating roles
      const clean = [];
      let lastRole = null;
      for (const m of claudeMsgs) {
        if (m.role === lastRole && clean.length > 0) {
          clean[clean.length - 1].content += '\n' + m.content;
        } else {
          clean.push({ ...m });
          lastRole = m.role;
        }
      }

      const body = { model: 'claude-sonnet-4-20250514', max_tokens: 1024, messages: clean };
      if (systemPrompt) body.system = systemPrompt;

      const cRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': claudeKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body),
      });

      if (!cRes.ok) {
        const err = await cRes.text();
        console.error('[ai-reply] Claude error:', cRes.status, err);
        return res.status(502).json({ error: 'Claude API error', status: cRes.status, detail: err });
      }

      const cData = await cRes.json();
      const reply = cData.content && cData.content[0] ? cData.content[0].text : '';
      console.log('[ai-reply] Claude OK for', chatId, '- len:', reply.length);
      return res.json({ reply, model: cData.model || 'claude-sonnet', usage: cData.usage });
    }

    // --- OPENAI ---
    console.log('[ai-reply] Using OpenAI for', chatId);
    const msgs = [];
    if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
    if (history && Array.isArray(history)) {
      history.forEach(h => { if (h.role && h.content) msgs.push({ role: h.role, content: h.content }); });
    }
    msgs.push({ role: 'user', content: userMsg });

    const oRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + openaiKey },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: msgs, max_tokens: 1024, temperature: 0.7 }),
    });

    if (!oRes.ok) {
      const err = await oRes.text();
      console.error('[ai-reply] OpenAI error:', oRes.status, err);
      return res.status(502).json({ error: 'OpenAI API error', status: oRes.status, detail: err });
    }

    const oData = await oRes.json();
    const reply = oData.choices && oData.choices[0] ? oData.choices[0].message.content : '';
    console.log('[ai-reply] OpenAI OK for', chatId, '- len:', reply.length);
    res.json({ reply, model: 'gpt-4o-mini', usage: oData.usage });
  } catch (err) {
    console.error('[ai-reply] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
