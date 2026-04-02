const express = require('express');
const router = express.Router();
const QRCode = require('qrcode');
const { getConnectionState, getQR, getProfilePhoto, getContactName, sendMessage, disconnect, getSocket, contactCache } = require('./baileys');
const { getChats, getMessages, saveMessage, upsertChat } = require('./supabase');
const { getConfig, setConfig, getUsageStats } = require('./auto-reply');

// === HELPER: Descargar media como Buffer (mas confiable que pasar URL a Baileys) ===
async function downloadMediaBuffer(url) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SanateBot/1.0)' },
    redirect: 'follow'
  });
  if (!resp.ok) throw new Error('No se pudo descargar media: HTTP ' + resp.status);
  const contentType = resp.headers.get('content-type') || '';
  const buffer = Buffer.from(await resp.arrayBuffer());
  return { buffer, contentType };
}

// === HELPER: Detectar tipo de media por URL y content-type ===
function detectMediaType(url, contentType) {
  const urlLower = (url || '').toLowerCase();
  const ctLower = (contentType || '').toLowerCase();
  if (ctLower.includes('video/') || urlLower.match(/\.(mp4|mov|avi|mkv|webm|3gp)(\?|$)/)) return 'video';
  if (ctLower.includes('image/') || urlLower.match(/\.(jpg|jpeg|png|gif|webp|bmp|svg)(\?|$)/)) return 'image';
  if (ctLower.includes('application/pdf') || urlLower.match(/\.(pdf|doc|docx|xls|xlsx)(\?|$)/)) return 'document';
  return 'image'; // default a imagen
}

// === HELPER: Construir payload de media para Baileys ===
async function buildMediaPayload(mediaUrl, captionText, options = {}) {
  const { buffer, contentType } = await downloadMediaBuffer(mediaUrl);
  const mediaType = options.forceType || detectMediaType(mediaUrl, contentType);

  if (mediaType === 'video') {
    return {
      payload: { video: buffer, caption: captionText || '', mimetype: contentType || 'video/mp4', gifPlayback: false },
      mediaType: 'video'
    };
  } else if (mediaType === 'document') {
    const fileName = options.fileName || mediaUrl.split('/').pop().split('?')[0] || 'document';
    return {
      payload: { document: buffer, caption: captionText || '', mimetype: contentType || 'application/octet-stream', fileName },
      mediaType: 'document'
    };
  } else {
    // Imagen (default)
    return {
      payload: { image: buffer, caption: captionText || '', mimetype: contentType || 'image/jpeg' },
      mediaType: 'image'
    };
  }
}

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
  const openPaths = ['/events', '/status', '/qr', '/settings', '/ai-config', '/ai-usage'];
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
  } catch (err) { res.status(500).json({ error: err.message }); }
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

// =============================================
// POST /chats/:chatId/send  (dashboard sends)
// =============================================
router.post('/chats/:chatId/send', async (req, res) => {
  try {
    const chatId = decodeURIComponent(req.params.chatId);
    const { message, type = 'text', mediaUrl, caption, header, footer, buttons } = req.body;
    if (!chatId || !message) return res.status(400).json({ error: 'chatId y message son requeridos' });

    let content;
    let textForLog = typeof message === 'string' ? message : message.caption || '';

    if (type === 'template_pro') {
      // === PLANTILLA PRO: imagen/video + caption + botones ===
      const results = [];
      if (mediaUrl) {
        const captionText = caption || (typeof message === 'string' ? message : '');
        try {
          const { payload, mediaType } = await buildMediaPayload(mediaUrl, captionText);
          const mediaResult = await sendMessage(chatId, payload);
          results.push(mediaResult);
          textForLog = '[' + mediaType + '] ' + (captionText || '').substring(0, 60);
        } catch (mediaErr) {
          console.error('[TemplatePro] Error descargando media:', mediaErr.message);
          // Fallback: intentar con URL directa
          const fallbackPayload = { image: { url: mediaUrl }, caption: captionText };
          const fallbackResult = await sendMessage(chatId, fallbackPayload);
          results.push(fallbackResult);
          textForLog = '[img-url] ' + (captionText || '').substring(0, 60);
        }
      } else {
        const txtContent = { text: typeof message === 'string' ? message : '' };
        const txtResult = await sendMessage(chatId, txtContent);
        results.push(txtResult);
      }

      // Enviar botones como mensaje separado si existen
      if (buttons && Array.isArray(buttons) && buttons.length > 0) {
        try {
          const btnText = buttons.map((b, i) => {
            const label = b.buttonText?.displayText || b.text || b.label || b.title || ('Opcion ' + (i + 1));
            const url = b.url || '';
            return url ? (label + ': ' + url) : ('> ' + label);
          }).join('\n');
          const footerText = footer ? ('\n\n' + footer) : '';
          await sendMessage(chatId, { text: btnText + footerText });
        } catch (btnErr) {
          console.error('[TemplatePro] Error enviando botones:', btnErr.message);
        }
      }

      const msgId = results[0].key.id || results[0].key;
      const chatName = getContactName(chatId) || chatId.split('@')[0];
      saveMessage(chatId, chatName, { messageId: msgId, fromMe: true, text: textForLog, type: type, timestamp: Date.now() }).catch(() => {});
      upsertChat(chatId, chatName, textForLog, Date.now()).catch(() => {});
      return res.json({ ok: true, success: true, messageId: msgId, sent: results.length });

    } else if (type === 'image') {
      const imgUrl = mediaUrl || (typeof message === 'object' ? message.url : message);
      const imgCaption = caption || (typeof message === 'object' ? message.caption : '');
      try {
        const { payload } = await buildMediaPayload(imgUrl, imgCaption, { forceType: 'image' });
        content = payload;
      } catch {
        content = { image: { url: imgUrl }, caption: imgCaption };
      }
      textForLog = imgCaption || '[imagen]';

    } else if (type === 'video') {
      const vidUrl = mediaUrl || (typeof message === 'object' ? message.url : message);
      const vidCaption = caption || (typeof message === 'object' ? message.caption : '');
      try {
        const { payload } = await buildMediaPayload(vidUrl, vidCaption, { forceType: 'video' });
        content = payload;
      } catch {
        content = { video: { url: vidUrl }, caption: vidCaption };
      }
      textForLog = vidCaption || '[video]';

    } else if (type === 'document') {
      const docUrl = mediaUrl || (typeof message === 'object' ? message.url : message);
      const fileName = (typeof message === 'object' ? message.fileName : '') || 'document';
      try {
        const { payload } = await buildMediaPayload(docUrl, '', { forceType: 'document', fileName });
        content = payload;
      } catch {
        content = { document: { url: docUrl }, fileName };
      }
      textForLog = '[doc] ' + fileName;

    } else {
      content = { text: typeof message === 'string' ? message : JSON.stringify(message) };
    }

    const result = await sendMessage(chatId, content);
    const msgId = result.key.id || result.key;
    const chatName = getContactName(chatId) || chatId.split('@')[0];
    saveMessage(chatId, chatName, { messageId: msgId, fromMe: true, text: textForLog, type: type, timestamp: Date.now() }).catch(() => {});
    upsertChat(chatId, chatName, textForLog, Date.now()).catch(() => {});
    res.json({ ok: true, success: true, messageId: msgId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// POST /send  (API directa)
// =============================================
router.post('/send', async (req, res) => {
  try {
    const { chatId, message, text, type = 'text', mediaUrl, caption, footer, buttons } = req.body;
    const msg = message || text;
    if (!chatId || !msg) return res.status(400).json({ error: 'chatId y message son requeridos' });
    let content;
    let textForLog = typeof msg === 'string' ? msg : msg.caption || '';

    if (type === 'template_pro') {
      // === PLANTILLA PRO: imagen/video + caption + botones ===
      if (mediaUrl) {
        const captionText = caption || (typeof msg === 'string' ? msg : '');
        try {
          const { payload, mediaType } = await buildMediaPayload(mediaUrl, captionText);
          content = payload;
          textForLog = '[' + mediaType + '] ' + (captionText || '').substring(0, 60);
        } catch (mediaErr) {
          console.error('[TemplatePro] Error descargando media:', mediaErr.message);
          content = { image: { url: mediaUrl }, caption: captionText };
          textForLog = '[img-url] ' + (captionText || '').substring(0, 60);
        }
      } else {
        content = { text: typeof msg === 'string' ? msg : '' };
      }

    } else if (type === 'image') {
      const imgUrl = mediaUrl || (typeof msg === 'object' ? msg.url : msg);
      const imgCaption = caption || (typeof msg === 'object' ? msg.caption : '');
      try {
        const { payload } = await buildMediaPayload(imgUrl, imgCaption, { forceType: 'image' });
        content = payload;
      } catch {
        content = { image: { url: imgUrl }, caption: imgCaption };
      }
      textForLog = imgCaption || '[imagen]';

    } else if (type === 'video') {
      const vidUrl = mediaUrl || (typeof msg === 'object' ? msg.url : msg);
      const vidCaption = caption || (typeof msg === 'object' ? msg.caption : '');
      try {
        const { payload } = await buildMediaPayload(vidUrl, vidCaption, { forceType: 'video' });
        content = payload;
      } catch {
        content = { video: { url: vidUrl }, caption: vidCaption };
      }
      textForLog = vidCaption || '[video]';

    } else if (type === 'document') {
      const docUrl = mediaUrl || (typeof msg === 'object' ? msg.url : msg);
      const fileName = (typeof msg === 'object' ? msg.fileName : '') || 'document';
      try {
        const { payload } = await buildMediaPayload(docUrl, '', { forceType: 'document', fileName });
        content = payload;
      } catch {
        content = { document: { url: docUrl }, fileName };
      }
      textForLog = '[doc] ' + fileName;

    } else {
      content = typeof msg === 'string' ? msg : msg;
    }

    const result = await sendMessage(chatId, content);

    // Enviar botones como mensaje aparte si existen
    if (type === 'template_pro' && buttons && Array.isArray(buttons) && buttons.length > 0) {
      try {
        const btnText = buttons.map((b, i) => {
          const label = b.buttonText?.displayText || b.text || b.label || b.title || ('Opcion ' + (i + 1));
          const url = b.url || '';
          return url ? (label + ': ' + url) : ('> ' + label);
        }).join('\n');
        const footerText = footer ? ('\n\n' + footer) : '';
        await sendMessage(chatId, { text: btnText + footerText });
      } catch (btnErr) {
        console.error('[TemplatePro] Error enviando botones:', btnErr.message);
      }
    }

    const chatName = getContactName(chatId) || chatId.split('@')[0];
    saveMessage(chatId, chatName, { messageId: result.key.id, fromMe: true, text: textForLog, type: type, timestamp: Date.now() }).catch(() => {});
    upsertChat(chatId, chatName, textForLog, Date.now()).catch(() => {});
    res.json({ success: true, messageId: result.key.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/disconnect', async (req, res) => {
  try { await disconnect(); res.json({ success: true, message: 'Desconectado' }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/settings', (req, res) => {
  res.json({
    server: 'sanate-wa-server', version: '3.1.0', engine: 'baileys-standalone',
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

router.post('/settings', (req, res) => {
  try {
    const b = req.body || {};
    const cfg = {};
    if (b.botEnabled !== undefined) cfg.enabled = b.botEnabled;
    if (b.openaiKey) cfg.openaiKey = b.openaiKey;
    if (b.systemPrompt) cfg.systemPrompt = b.systemPrompt;
    if (b.companyContext !== undefined) cfg.companyContext = b.companyContext;
    if (b.aiContactMap) cfg.contactMap = b.aiContactMap;
    if (b.msgMode) cfg.msgMode = b.msgMode;
    if (b.useEmojis !== undefined) cfg.useEmojis = b.useEmojis;
    if (b.useStyles !== undefined) cfg.useStyles = b.useStyles;
    if (b.botDelay !== undefined) cfg.botDelay = b.botDelay;
    if (b.geminiKey) cfg.geminiKey = b.geminiKey;
    if (b.claudeKey) cfg.claudeKey = b.claudeKey;
    if (b.enabled !== undefined) cfg.enabled = b.enabled;
    if (b.contactMap) cfg.contactMap = b.contactMap;
    if (b.partesCount !== undefined) cfg.partesCount = b.partesCount;
    if (b.testWhitelist !== undefined) cfg.testWhitelist = b.testWhitelist;
    if (b.comportamiento !== undefined) cfg.comportamiento = b.comportamiento;
    setConfig(cfg);
    res.json({ ok: true, settings: 'synced' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- AI CONFIG ENDPOINTS ---
router.get('/ai-config', (req, res) => {
  const cfg = getConfig();
  res.json({
    enabled: cfg.enabled,
    geminiKey: cfg.geminiKey || '',
    claudeKey: cfg.claudeKey || '',
    openaiKey: cfg.openaiKey || '',
    systemPrompt: cfg.systemPrompt || '',
    companyContext: cfg.companyContext || '',
    contactMap: cfg.contactMap || {},
    botDelay: cfg.botDelay,
    msgMode: cfg.msgMode,
    useEmojis: cfg.useEmojis,
    partesCount: cfg.partesCount,
    testWhitelist: cfg.testWhitelist || [],
    hasGeminiKey: !!cfg.geminiKey,
    hasClaudeKey: !!cfg.claudeKey,
    hasOpenaiKey: !!cfg.openaiKey,
    hasSystemPrompt: !!cfg.systemPrompt,
    comportamiento: cfg.comportamiento || '',
    dailyCount: getUsageStats().dailyCount,
    dailyLimit: 250,
  });
});

router.post('/ai-config', (req, res) => {
  try {
    const cfg = req.body;
    if (!cfg || typeof cfg !== 'object') return res.status(400).json({ error: 'Invalid config' });
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
      partesCount: updated.partesCount,
      testWhitelist: updated.testWhitelist || [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- AI USAGE ---
router.get('/ai-usage', (req, res) => {
  try { res.json(getUsageStats()); }
  catch (err) { res.status(500).json({ error: err.message });
}
});

module.exports = router;
