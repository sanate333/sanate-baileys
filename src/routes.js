const express = require('express');
const router = express.Router();
const QRCode = require('qrcode');
const { getConnectionState, getQR, getProfilePhoto, getContactName, sendMessage, disconnect, getSocket, contactCache } = require('./baileys');
const { getChats, getMessages, saveMessage, upsertChat } = require('./supabase');
const { getConfig, setConfig, getUsageStats } = require('./auto-reply');

// Baileys internals para envio directo de mensajes interactivos (relayMessage)
let _baileys = null;
function getBaileysFns() {
  if (!_baileys) {
    try {
      _baileys = require('@whiskeysockets/baileys');
    } catch (e) {
      console.error('[Baileys] No se pudo importar baileys internals:', e.message);
      _baileys = {};
    }
  }
  return _baileys;
}

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
    return {
      payload: { image: buffer, caption: captionText || '', mimetype: contentType || 'image/jpeg' },
      mediaType: 'image'
    };
  }
}

// === HELPER: Construir additionalNodes requeridos por WhatsApp para renderizar botones ===
// Sin estos nodos binarios (interactive, biz, bot), los botones se envian pero NO se renderizan en el telefono
function buildInteractiveNodes(buttons, jid) {
  const buttonTypes = (buttons || []).map(b => b.name);
  const isPrivate = !jid.endsWith('@g.us');
  const hasUrls = buttonTypes.includes('cta_url');
  const hasQuickReply = buttonTypes.includes('quick_reply');
  const hasSelect = buttonTypes.includes('single_select');

  const flowName = hasSelect ? 'single_select'
    : (hasUrls && hasQuickReply) ? 'mixed'
    : hasUrls ? 'cta_url'
    : 'quick_reply';

  const nodes = [
    {
      tag: 'interactive',
      attrs: { type: 'native_flow', v: '1' },
      content: [{ tag: 'native_flow', attrs: { v: '9', name: flowName } }]
    },
    { tag: 'biz', attrs: {} }
  ];
  if (isPrivate) nodes.push({ tag: 'bot', attrs: { biz_bot: '1' } });
  return nodes;
}

// === HELPER PRINCIPAL: Enviar mensaje interactivo con proto directo ===
// Usa generateWAMessageFromContent + relayMessage + additionalNodes (REQUERIDO para botones reales)
async function sendInteractiveMessageDirect(chatId, { buffer, contentType, mediaType, captionText, footerText, nativeButtons }) {
  const sock = getSocket();
  if (!sock) throw new Error('Socket de WhatsApp no disponible');
  if (!sock.relayMessage) throw new Error('sock.relayMessage no disponible');

  const { generateWAMessageFromContent, prepareWAMessageMedia } = getBaileysFns();
  if (!generateWAMessageFromContent) throw new Error('generateWAMessageFromContent no disponible');

  const jid = chatId.includes('@') ? chatId : chatId + '@s.whatsapp.net';

  // Construir header con media subida a los servidores de WhatsApp
  let header = { hasMediaAttachment: false };
  if (buffer && prepareWAMessageMedia) {
    const isVideo = mediaType === 'video';
    const mediaPayload = isVideo
      ? { video: buffer, mimetype: contentType || 'video/mp4' }
      : { image: buffer, mimetype: contentType || 'image/jpeg' };

    const uploaded = await prepareWAMessageMedia(mediaPayload, { upload: sock.waUploadToServer });
    header = {
      ...(isVideo ? { videoMessage: uploaded.videoMessage } : { imageMessage: uploaded.imageMessage }),
      hasMediaAttachment: true
    };
  }

  const msgContent = {
    interactiveMessage: {
      header,
      body: { text: captionText || '' },
      footer: { text: footerText || '' },
      nativeFlowMessage: {
        buttons: nativeButtons,
        messageParamsJson: '',
        messageVersion: 1
      }
    }
  };

  const wamsg = generateWAMessageFromContent(jid, msgContent, {
    userJid: sock.user?.id || jid
  });

  // CRITICO: additionalNodes son los nodos binarios que WhatsApp requiere para renderizar botones
  const additionalNodes = buildInteractiveNodes(nativeButtons, jid);
  await sock.relayMessage(jid, wamsg.message, { messageId: wamsg.key.id, additionalNodes });
  return wamsg;
}

// === HELPER: Enviar lista interactiva con single_select nativeFlowMessage ===
// Usa generateWAMessageFromContent + relayMessage + additionalNodes (mismo patron que botones)
async function sendListMessageDirect(chatId, { captionText, footerText, headerTitle, buttonText, sections }) {
  const sock = getSocket();
  if (!sock) throw new Error('Socket de WhatsApp no disponible');
  const { generateWAMessageFromContent } = getBaileysFns();
  if (!generateWAMessageFromContent) throw new Error('generateWAMessageFromContent no disponible');

  const jid = chatId.includes('@') ? chatId : chatId + '@s.whatsapp.net';

  // Convertir secciones al formato que espera single_select
  const selectSections = sections.map(s => ({
    title: s.title || '',
    rows: (s.rows || []).map((r, i) => ({
      id: r.rowId || r.id || ('row_' + i),
      title: r.title || '',
      description: r.description || ''
    }))
  }));

  const singleSelectButton = {
    name: 'single_select',
    buttonParamsJson: JSON.stringify({
      title: buttonText || 'Ver opciones',
      sections: selectSections
    })
  };

  const msgContent = {
    interactiveMessage: {
      header: { hasMediaAttachment: false },
      body: { text: captionText || '' },
      footer: { text: footerText || '' },
      nativeFlowMessage: {
        buttons: [singleSelectButton],
        messageParamsJson: '',
        messageVersion: 1
      }
    }
  };

  const wamsg = generateWAMessageFromContent(jid, msgContent, {
    userJid: sock.user?.id || jid
  });

  const additionalNodes = buildInteractiveNodes([singleSelectButton], jid);
  await sock.relayMessage(jid, wamsg.message, { messageId: wamsg.key.id, additionalNodes });
  return wamsg;
}

// === HELPER: Normalizar JID para almacenamiento (evita chats duplicados) ===
function normalizeStorageJid(jid) {
  if (!jid) return jid;
  // Quitar sufijo @s.whatsapp.net para almacenar siempre el numero limpio
  return jid.replace(/@s\.whatsapp\.net$/, '');
}

// === HELPER: Construir lista de botones nativos desde el array del request ===
function buildNativeButtons(buttons) {
  if (!buttons || !Array.isArray(buttons)) return [];
  return buttons.map(b => {
    const label = b.buttonText?.displayText || b.text || b.label || b.title || 'Opcion';
    const btnUrl = b.url || '';
    if (btnUrl) {
      return {
        name: 'cta_url',
        buttonParamsJson: JSON.stringify({ display_text: label, url: btnUrl, merchant_url: btnUrl })
      };
    } else {
      return {
        name: 'quick_reply',
        buttonParamsJson: JSON.stringify({
          display_text: label,
          id: b.id || label.toLowerCase().replace(/\s+/g, '_')
        })
      };
    }
  });
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
    // Normalizar: quitar @s.whatsapp.net para coincidir con como se guardan los mensajes
    const rawChatId = decodeURIComponent(req.params.chatId);
    const chatId = rawChatId.replace(/@s\.whatsapp\.net$/, '').replace(/@c\.us$/, '');
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
// Acepta tanto JSON como FormData (el dashboard envia FormData con campo "text")
// =============================================
router.post('/chats/:chatId/send', async (req, res) => {
  try {
    const chatId = decodeURIComponent(req.params.chatId);
    // Soporta: JSON { message } o FormData { text }
    const message = req.body.message || req.body.text;
    const type = req.body.type || 'text';
    const { mediaUrl, caption, header, footer, buttons } = req.body;
    if (!chatId || !message) return res.status(400).json({ error: 'chatId y message son requeridos' });

    let content;
    let textForLog = typeof message === 'string' ? message : message.caption || '';

    if (type === 'template_pro') {
      // === PLANTILLA PRO: imagen/video + caption + BOTONES INTERACTIVOS REALES ===
      const captionText = caption || (typeof message === 'string' ? message : '');
      const nativeButtons = buildNativeButtons(buttons);

      let mainResult;
      let btnMethod = 'none';
      let mType = 'image';

      if (mediaUrl) {
        let mediaBuffer = null;
        let mediaContentType = 'image/jpeg';
        try {
          const dl = await downloadMediaBuffer(mediaUrl);
          mediaBuffer = dl.buffer;
          mediaContentType = dl.contentType;
          mType = detectMediaType(mediaUrl, mediaContentType);
        } catch (dlErr) {
          console.error('[TemplatePro] Error descargando media:', dlErr.message);
        }

        textForLog = '[' + mType + '+btn] ' + captionText.substring(0, 50);

        if (nativeButtons.length > 0 && mediaBuffer) {
          // === METODO 1: relayMessage + proto directo (botones reales) ===
          try {
            mainResult = await sendInteractiveMessageDirect(chatId, {
              buffer: mediaBuffer,
              contentType: mediaContentType,
              mediaType: mType,
              captionText,
              footerText: footer || '',
              nativeButtons
            });
            btnMethod = 'relay_interactive';
            console.log('[TemplatePro] relayMessage OK, botones:', nativeButtons.length);
          } catch (relayErr) {
            console.error('[TemplatePro] relayMessage fallo:', relayErr.message, '- intentando sendMessage interactiveButtons');
            // === METODO 2: sendMessage con interactiveButtons ===
            try {
              const payload = mType === 'video'
                ? { video: mediaBuffer, caption: captionText, mimetype: mediaContentType, gifPlayback: false, interactiveButtons: nativeButtons }
                : { image: mediaBuffer, caption: captionText, mimetype: mediaContentType, interactiveButtons: nativeButtons };
              mainResult = await sendMessage(chatId, payload);
              btnMethod = 'sendmsg_interactive';
            } catch (sendErr) {
              console.error('[TemplatePro] sendMessage interactiveButtons fallo:', sendErr.message, '- fallback a media+texto');
              // === FALLBACK: media normal + botones como texto ===
              const plainPayload = mType === 'video'
                ? { video: mediaBuffer, caption: captionText, mimetype: mediaContentType, gifPlayback: false }
                : { image: mediaBuffer, caption: captionText, mimetype: mediaContentType };
              mainResult = await sendMessage(chatId, plainPayload);
              btnMethod = 'text_fallback';
              if (buttons && buttons.length > 0) {
                const btnText = buttons.map((b, i) => {
                  const label = b.buttonText?.displayText || b.text || b.label || b.title || ('Opcion ' + (i + 1));
                  const url = b.url || '';
                  return url ? ('🔗 ' + label + ': ' + url) : ('▶ ' + label);
                }).join('\n');
                await sendMessage(chatId, { text: btnText + (footer ? '\n\n' + footer : '') }).catch(() => {});
              }
            }
          }
        } else if (mediaBuffer) {
          // Solo media sin botones
          const payload = mType === 'video'
            ? { video: mediaBuffer, caption: captionText, mimetype: mediaContentType, gifPlayback: false }
            : { image: mediaBuffer, caption: captionText, mimetype: mediaContentType };
          mainResult = await sendMessage(chatId, payload);
        } else {
          // Media fallo descarga, intentar con URL directa
          mainResult = await sendMessage(chatId, { image: { url: mediaUrl }, caption: captionText });
          textForLog = '[img-url] ' + captionText.substring(0, 50);
        }
      } else if (nativeButtons.length > 0) {
        // Solo texto + botones
        textForLog = '[btn] ' + captionText.substring(0, 50);
        try {
          mainResult = await sendInteractiveMessageDirect(chatId, {
            buffer: null,
            captionText,
            footerText: footer || '',
            nativeButtons
          });
          btnMethod = 'relay_interactive';
        } catch (e) {
          mainResult = await sendMessage(chatId, { text: captionText, footer: footer || '', interactiveButtons: nativeButtons });
          btnMethod = 'sendmsg_interactive';
        }
      } else {
        mainResult = await sendMessage(chatId, { text: typeof message === 'string' ? message : '' });
      }

      const msgId = mainResult.key?.id || mainResult.key;
      const chatName = getContactName(chatId) || chatId.split('@')[0];
      saveMessage(chatId, chatName, { messageId: msgId, fromMe: true, text: textForLog, type: type, timestamp: Date.now() }).catch(() => {});
      upsertChat(chatId, chatName, textForLog, Date.now()).catch(() => {});
      return res.json({ ok: true, success: true, messageId: msgId, btnMethod });

    } else if (type === 'list') {
      // === LISTA INTERACTIVA: proto directo (generateWAMessageFromContent + relayMessage) ===
      const captionText = caption || (typeof message === 'string' ? message : '');
      const btnLabel = req.body.buttonText || 'Ver opciones';
      const sectionTitle = req.body.sectionTitle || 'Opciones';
      const rows = (buttons || []).map((b, i) => {
        const title = b.buttonText?.displayText || b.text || b.label || b.title || ('Opcion ' + (i + 1));
        const rowId = b.id || title.toLowerCase().replace(/[^a-z0-9]/g, '_').substring(0, 20);
        return { rowId, title, description: b.description || '' };
      });
      let listResult;
      try {
        listResult = await sendListMessageDirect(chatId, {
          captionText, footerText: footer || '',
          headerTitle: req.body.listTitle || req.body.title || header || '',
          buttonText: btnLabel,
          sections: [{ title: sectionTitle, rows }]
        });
      } catch (listProtoErr) {
        console.error('[List] proto fallo, fallback:', listProtoErr.message);
        listResult = await sendMessage(chatId, {
          text: captionText, footer: footer || '',
          title: req.body.listTitle || req.body.title || header || '',
          buttonText: btnLabel,
          sections: [{ title: sectionTitle, rows }]
        });
      }
      const listMsgId = listResult.key?.id;
      const storageJidL = normalizeStorageJid(chatId);
      const chatNameL = getContactName(chatId) || storageJidL.split('@')[0];
      const logTextL = '[list] ' + captionText.substring(0, 50);
      saveMessage(storageJidL, chatNameL, { messageId: listMsgId, fromMe: true, text: logTextL, type: 'list', timestamp: Date.now() }).catch(() => {});
      upsertChat(storageJidL, chatNameL, logTextL, Date.now()).catch(() => {});
      return res.json({ ok: true, success: true, messageId: listMsgId, btnMethod: 'list_message' });

    } else if (type === 'buttons') {
      // === BOTONES INTERACTIVOS (solo texto, sin media) ===
      const captionText = caption || (typeof message === 'string' ? message : '');
      const nativeButtons = buildNativeButtons(buttons);
      textForLog = '[btn] ' + captionText.substring(0, 50);
      let btnResult;
      let btnMethod = 'none';
      try {
        btnResult = await sendInteractiveMessageDirect(chatId, {
          buffer: null,
          captionText,
          footerText: footer || '',
          nativeButtons
        });
        btnMethod = 'relay_interactive';
        console.log('[Buttons] relayMessage OK, botones:', nativeButtons.length);
      } catch (e) {
        console.error('[Buttons] relay fallo:', e.message, '- fallback texto');
        btnResult = await sendMessage(chatId, { text: captionText });
        btnMethod = 'text_fallback';
      }
      const btnMsgId = btnResult.key?.id;
      const storageJidB = normalizeStorageJid(chatId);
      const chatNameB = getContactName(chatId) || storageJidB.split('@')[0];
      saveMessage(storageJidB, chatNameB, { messageId: btnMsgId, fromMe: true, text: textForLog, type: 'buttons', timestamp: Date.now() }).catch(() => {});
      upsertChat(storageJidB, chatNameB, textForLog, Date.now()).catch(() => {});
      return res.json({ ok: true, success: true, messageId: btnMsgId, btnMethod });

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
    const msgId = result.key?.id || result.key;
    const storageJid = normalizeStorageJid(chatId);
    const chatName = getContactName(chatId) || storageJid.split('@')[0];
    saveMessage(storageJid, chatName, { messageId: msgId, fromMe: true, text: textForLog, type: type, timestamp: Date.now() }).catch(() => {});
    upsertChat(storageJid, chatName, textForLog, Date.now()).catch(() => {});
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
      const captionText = caption || (typeof msg === 'string' ? msg : '');
      const nativeButtons = buildNativeButtons(buttons);
      let result;
      let btnMethod = 'none';
      let mType = 'image';
      if (mediaUrl) {
        let mediaBuffer = null;
        let mediaContentType = 'image/jpeg';
        try {
          const dl = await downloadMediaBuffer(mediaUrl);
          mediaBuffer = dl.buffer;
          mediaContentType = dl.contentType;
          mType = detectMediaType(mediaUrl, mediaContentType);
        } catch (dlErr) {
          console.error('[TemplatePro/send] Error descargando media:', dlErr.message);
        }
        textForLog = '[' + mType + '+btn] ' + captionText.substring(0, 50);
        if (nativeButtons.length > 0 && mediaBuffer) {
          try {
            result = await sendInteractiveMessageDirect(chatId, { buffer: mediaBuffer, contentType: mediaContentType, mediaType: mType, captionText, footerText: footer || '', nativeButtons });
            btnMethod = 'relay_interactive';
          } catch (relayErr) {
            console.error('[TemplatePro/send] relayMessage fallo:', relayErr.message);
            try {
              const payload = mType === 'video'
                ? { video: mediaBuffer, caption: captionText, mimetype: mediaContentType, gifPlayback: false, interactiveButtons: nativeButtons }
                : { image: mediaBuffer, caption: captionText, mimetype: mediaContentType, interactiveButtons: nativeButtons };
              result = await sendMessage(chatId, payload);
              btnMethod = 'sendmsg_interactive';
            } catch (sendErr) {
              const plainPayload = mType === 'video'
                ? { video: mediaBuffer, caption: captionText, mimetype: mediaContentType, gifPlayback: false }
                : { image: mediaBuffer, caption: captionText, mimetype: mediaContentType };
              result = await sendMessage(chatId, plainPayload);
              btnMethod = 'text_fallback';
              if (buttons && buttons.length > 0) {
                const btnText = buttons.map((b, i) => { const label = b.buttonText?.displayText || b.text || b.label || b.title || ('Opcion ' + (i+1)); const url = b.url || ''; return url ? ('🔗 ' + label + ': ' + url) : ('▶ ' + label); }).join('\n');
                await sendMessage(chatId, { text: btnText + (footer ? '\n\n' + footer : '') }).catch(() => {});
              }
            }
          }
        } else if (mediaBuffer) {
          const payload = mType === 'video' ? { video: mediaBuffer, caption: captionText, mimetype: mediaContentType, gifPlayback: false } : { image: mediaBuffer, caption: captionText, mimetype: mediaContentType };
          result = await sendMessage(chatId, payload);
        } else {
          result = await sendMessage(chatId, { image: { url: mediaUrl }, caption: captionText });
          textForLog = '[img-url] ' + captionText.substring(0, 50);
        }
      } else if (nativeButtons.length > 0) {
        textForLog = '[btn] ' + captionText.substring(0, 50);
        try {
          result = await sendInteractiveMessageDirect(chatId, { buffer: null, captionText, footerText: footer || '', nativeButtons });
          btnMethod = 'relay_interactive';
        } catch (e) {
          content = { text: captionText, footer: footer || '', interactiveButtons: nativeButtons };
          result = await sendMessage(chatId, content);
          btnMethod = 'sendmsg_interactive';
        }
      } else {
        content = { text: typeof msg === 'string' ? msg : '' };
        result = await sendMessage(chatId, content);
      }
      const storageJidTP = normalizeStorageJid(chatId);
      const chatNameTP = getContactName(chatId) || storageJidTP.split('@')[0];
      saveMessage(storageJidTP, chatNameTP, { messageId: result.key?.id, fromMe: true, text: textForLog, type: type, timestamp: Date.now() }).catch(() => {});
      upsertChat(storageJidTP, chatNameTP, textForLog, Date.now()).catch(() => {});
      return res.json({ success: true, messageId: result.key?.id, btnMethod });

    } else if (type === 'list') {
      const captionText = caption || (typeof msg === 'string' ? msg : '');
      const btnLabel = req.body.buttonText || 'Ver opciones';
      const sectionTitle = req.body.sectionTitle || 'Opciones';
      const rows = (buttons || []).map((b, i) => { const title = b.buttonText?.displayText || b.text || b.label || b.title || ('Opcion ' + (i + 1)); const id = b.id || title.toLowerCase().replace(/[^a-z0-9]/g, '_').substring(0, 20); return { title, id, description: b.description || '' }; });
      const listContent = { text: captionText, footer: footer || '', title: req.body.listTitle || req.body.title || '', buttonText: btnLabel, sections: [{ title: sectionTitle, rows }] };
      const listResult = await sendMessage(chatId, listContent);
      const storageJidList = normalizeStorageJid(chatId);
      const chatNameList = getContactName(chatId) || storageJidList.split('@')[0];
      const logTextList = '[list] ' + captionText.substring(0, 50);
      saveMessage(storageJidList, chatNameList, { messageId: listResult.key?.id, fromMe: true, text: logTextList, type: 'list', timestamp: Date.now() }).catch(() => {});
      upsertChat(storageJidList, chatNameList, logTextList, Date.now()).catch(() => {});
      return res.json({ success: true, messageId: listResult.key?.id, btnMethod: 'list_message' });

    } else if (type === 'image') {
      const imgUrl = mediaUrl || (typeof msg === 'object' ? msg.url : msg);
      const imgCaption = caption || (typeof msg === 'object' ? msg.caption : '');
      try { const { payload } = await buildMediaPayload(imgUrl, imgCaption, { forceType: 'image' }); content = payload; } catch { content = { image: { url: imgUrl }, caption: imgCaption }; }
      textForLog = imgCaption || '[imagen]';
    } else if (type === 'video') {
      const vidUrl = mediaUrl || (typeof msg === 'object' ? msg.url : msg);
      const vidCaption = caption || (typeof msg === 'object' ? msg.caption : '');
      try { const { payload } = await buildMediaPayload(vidUrl, vidCaption, { forceType: 'video' }); content = payload; } catch { content = { video: { url: vidUrl }, caption: vidCaption }; }
      textForLog = vidCaption || '[video]';
    } else if (type === 'document') {
      const docUrl = mediaUrl || (typeof msg === 'object' ? msg.url : msg);
      const fileName = (typeof msg === 'object' ? msg.fileName : '') || 'document';
      try { const { payload } = await buildMediaPayload(docUrl, '', { forceType: 'document', fileName }); content = payload; } catch { content = { document: { url: docUrl }, fileName }; }
      textForLog = '[doc] ' + fileName;
    } else {
      content = typeof msg === 'string' ? msg : msg;
    }

    const result = await sendMessage(chatId, content);
    const storageJidFinal = normalizeStorageJid(chatId);
    const chatName = getContactName(chatId) || storageJidFinal.split('@')[0];
    saveMessage(storageJidFinal, chatName, { messageId: result.key?.id, fromMe: true, text: textForLog, type: type, timestamp: Date.now() }).catch(() => {});
    upsertChat(storageJidFinal, chatName, textForLog, Date.now()).catch(() => {});
    res.json({ success: true, messageId: result.key?.id, btnMethod: 'none' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/disconnect', async (req, res) => {
  try { await disconnect(); res.json({ success: true, message: 'Desconectado' }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/settings', (req, res) => {
  res.json({
    server: 'sanate-wa-server', version: '3.4.0', engine: 'baileys-standalone',
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

router.get('/ai-usage', (req, res) => {
  try { res.json(getUsageStats()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
