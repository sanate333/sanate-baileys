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
function buildInteractiveNodes(buttons, jid) {
  const buttonTypes = (buttons || []).map(b => b.name);
  const hasUrls = buttonTypes.includes('cta_url');
  const hasQuickReply = buttonTypes.includes('quick_reply');
  const hasSelect = buttonTypes.includes('single_select');

  const flowName = hasSelect ? 'single_select'
    : (hasUrls && hasQuickReply) ? 'mixed'
    : hasUrls ? 'cta_url'
    : 'quick_reply';

  return [
    {
      tag: 'biz',
      attrs: {},
      content: [
        {
          tag: 'interactive',
          attrs: { type: 'native_flow', v: '1' },
          content: [
            { tag: 'native_flow', attrs: { name: flowName, v: '9' } }
          ]
        }
      ]
    }
  ];
}

// === HELPER PRINCIPAL: Enviar mensaje interactivo con proto directo ===
async function sendInteractiveMessageDirect(chatId, { buffer, contentType, mediaType, captionText, footerText, nativeButtons }) {
  const sock = getSocket();
  if (!sock) throw new Error('Socket de WhatsApp no disponible');
  if (!sock.relayMessage) throw new Error('sock.relayMessage no disponible');

  const { generateWAMessageFromContent, prepareWAMessageMedia } = getBaileysFns();
  if (!generateWAMessageFromContent) throw new Error('generateWAMessageFromContent no disponible');

  const jid = chatId.includes('@') ? chatId : chatId + '@s.whatsapp.net';

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

  const senderJid = sock.user?.id || jid;
  const wamsg = generateWAMessageFromContent(jid, msgContent, {
    userJid: senderJid
  });

  console.log('[relay-buttons] senderJid:', senderJid, '| recipient:', jid);
  await sock.relayMessage(jid, wamsg.message, { messageId: wamsg.key.id });
  return wamsg;
}

// === HELPER: Enviar lista interactiva con single_select nativeFlowMessage ===
async function sendListMessageDirect(chatId, { captionText, footerText, headerTitle, buttonText, sections }) {
  const sock = getSocket();
  if (!sock) throw new Error('Socket de WhatsApp no disponible');
  const { generateWAMessageFromContent } = getBaileysFns();
  if (!generateWAMessageFromContent) throw new Error('generateWAMessageFromContent no disponible');

  const jid = chatId.includes('@') ? chatId : chatId + '@s.whatsapp.net';

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

  const senderJid = sock.user?.id || jid;
  const wamsg = generateWAMessageFromContent(jid, msgContent, {
    userJid: senderJid
  });

  console.log('[relay-list] senderJid:', senderJid, '| recipient:', jid);
  await sock.relayMessage(jid, wamsg.message, { messageId: wamsg.key.id });
  return wamsg;
}

// =============================================
// META CLOUD API — Helpers
// Activos cuando META_TOKEN + META_PHONE_NUMBER_ID están configurados
// Phone Number ID: 105951208391723
// WABA ID:        4577824649105640
// =============================================

function metaCloudEnabled() {
  return !!(process.env.META_TOKEN && process.env.META_PHONE_NUMBER_ID);
}

async function sendMetaCloudRaw(to, payload) {
  const token = process.env.META_TOKEN;
  const phoneNumberId = process.env.META_PHONE_NUMBER_ID || '105951208391723';
  if (!token) throw new Error('META_TOKEN no configurado');

  const cleanTo = String(to).replace(/[^0-9]/g, '');
  const response = await fetch(`https://graph.facebook.com/v19.0/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: cleanTo,
      ...payload
    })
  });

  const data = await response.json();
  if (!response.ok || data.error) {
    const errMsg = data.error?.message || `HTTP ${response.status}`;
    console.error('[Meta API] Error completo:', JSON.stringify(data));
    console.error('[Meta API] Phone Number ID usado:', phoneNumberId);
    console.error('[Meta API] Destinatario:', cleanTo);
    throw new Error(`Meta API: ${errMsg}`);
  }
  console.log('[Meta API] OK - WAMID:', data.messages?.[0]?.id, '| PhoneID:', phoneNumberId, '| To:', cleanTo);
  return data;
}

// Botones de respuesta rápida (máx 3, títulos máx 20 chars)
async function sendMetaButtons(to, { body, footer, header, buttons }) {
  const cleanBtns = (buttons || []).slice(0, 3).map((b, i) => ({
    type: 'reply',
    reply: {
      id: String(b.id || b.buttonId || b.rowId || `btn_${i}`).substring(0, 256),
      title: String(b.text || b.label || b.title || b.buttonText?.displayText || `Opción ${i + 1}`).substring(0, 20)
    }
  }));

  const interactive = {
    type: 'button',
    body: { text: body || '' },
    action: { buttons: cleanBtns }
  };
  if (footer) interactive.footer = { text: String(footer).substring(0, 60) };
  if (header) interactive.header = { type: 'text', text: String(header).substring(0, 60) };

  return sendMetaCloudRaw(to, { type: 'interactive', interactive });
}

// Lista desplegable (máx 10 filas por sección, títulos máx 24 chars)
async function sendMetaList(to, { body, footer, header, buttonText, sections }) {
  const cleanSections = (sections || []).map(s => ({
    title: String(s.title || '').substring(0, 24),
    rows: (s.rows || []).slice(0, 10).map((r, i) => ({
      id: String(r.rowId || r.id || `row_${i}`).substring(0, 200),
      title: String(r.title || `Opción ${i + 1}`).substring(0, 24),
      description: String(r.description || '').substring(0, 72)
    }))
  }));

  const interactive = {
    type: 'list',
    body: { text: body || '' },
    action: {
      button: String(buttonText || 'Ver opciones').substring(0, 20),
      sections: cleanSections
    }
  };
  if (footer) interactive.footer = { text: String(footer).substring(0, 60) };
  if (header) interactive.header = { type: 'text', text: String(header).substring(0, 60) };

  return sendMetaCloudRaw(to, { type: 'interactive', interactive });
}

// Texto simple por Meta Cloud API
async function sendMetaText(to, text) {
  return sendMetaCloudRaw(to, {
    type: 'text',
    text: { body: String(text), preview_url: false }
  });
}

// Imagen + caption por Meta Cloud API
async function sendMetaImage(to, { imageUrl, caption }) {
  return sendMetaCloudRaw(to, {
    type: 'image',
    image: { link: imageUrl, caption: caption || '' }
  });
}

// === HELPER: Normalizar JID para almacenamiento (evita chats duplicados) ===
function normalizeStorageJid(jid) {
  if (!jid) return jid;
  return jid.replace(/@s\.whatsapp\.net$/, '');
}

// === HELPER: Construir lista de botones nativos desde el array del request ===
function buildNativeButtons(buttons) {
  if (!buttons || !Array.isArray(buttons)) return [];
  return buttons.map((b, i) => {
    if ((b.name === 'quick_reply' || b.name === 'cta_url' || b.name === 'single_select') && b.buttonParamsJson) {
      return { name: b.name, buttonParamsJson: b.buttonParamsJson };
    }
    let label = b.buttonText?.displayText || b.text || b.label || b.title;
    let id = b.id;
    if (!label && b.buttonParamsJson) {
      try { const p = JSON.parse(b.buttonParamsJson); label = p.display_text; if (!id) id = p.id; } catch(e) {}
    }
    label = label || ('Opcion ' + (i + 1));
    const btnUrl = b.url || '';
    if (btnUrl) {
      return { name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: label, url: btnUrl, merchant_url: btnUrl }) };
    } else {
      return { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: label, id: id || label.toLowerCase().replace(/\s+/g, '_') }) };
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
  const openPaths = ['/events', '/status', '/qr', '/settings', '/ai-config', '/ai-usage', '/webhook'];
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
  const RENDER_URL = process.env.RENDER_EXTERNAL_URL || 'https://sanate-wa-bot.onrender.com';
  res.json({
    status: getConnectionState(), connected: getConnectionState() === 'connected',
    hasQR: !!getQR(), uptime: Math.floor(process.uptime()),
    sseClients: req.app.get('sse')?.getStatus()?.clients || 0,
    contactsInCache: contactCache.keys().length,
    server: 'sanate-wa-server', engine: 'baileys-standalone',
    metaCloudEnabled: metaCloudEnabled(),
    timestamp: new Date().toISOString(),
    hotfixes: [
      RENDER_URL + '/hotfixes/waba-connect-ui.js',
      RENDER_URL + '/hotfixes/visual-chat-v2.js'
    ],
    extraScripts: [
      RENDER_URL + '/hotfixes/waba-connect-ui.js',
      RENDER_URL + '/hotfixes/visual-chat-v2.js'
    ]
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
// =============================================
router.post('/chats/:chatId/send', async (req, res) => {
  try {
    const chatId = decodeURIComponent(req.params.chatId);
    const message = req.body.message || req.body.text;
    let type = req.body.type || 'text';
    let { mediaUrl, caption, header, footer, buttons } = req.body;
    if (!chatId || !message) return res.status(400).json({ error: 'chatId y message son requeridos' });

    // type='text' se envía como texto plano — sin conversión a botones/poll

    let content;
    let textForLog = typeof message === 'string' ? message : message.caption || '';

    if (type === 'template_pro') {
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
          try {
            mainResult = await sendInteractiveMessageDirect(chatId, {
              buffer: mediaBuffer, contentType: mediaContentType, mediaType: mType,
              captionText, footerText: footer || '', nativeButtons
            });
            btnMethod = 'relay_interactive';
          } catch (relayErr) {
            console.error('[TemplatePro] relayMessage fallo:', relayErr.message);
            try {
              const payload = mType === 'video'
                ? { video: mediaBuffer, caption: captionText, mimetype: mediaContentType, gifPlayback: false, interactiveButtons: nativeButtons }
                : { image: mediaBuffer, caption: captionText, mimetype: mediaContentType, interactiveButtons: nativeButtons };
              mainResult = await sendMessage(chatId, payload);
              btnMethod = 'sendmsg_interactive';
            } catch (sendErr) {
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
          const payload = mType === 'video'
            ? { video: mediaBuffer, caption: captionText, mimetype: mediaContentType, gifPlayback: false }
            : { image: mediaBuffer, caption: captionText, mimetype: mediaContentType };
          mainResult = await sendMessage(chatId, payload);
        } else {
          mainResult = await sendMessage(chatId, { image: { url: mediaUrl }, caption: captionText });
          textForLog = '[img-url] ' + captionText.substring(0, 50);
        }
      } else if (nativeButtons.length > 0) {
        textForLog = '[btn] ' + captionText.substring(0, 50);
        try {
          mainResult = await sendInteractiveMessageDirect(chatId, {
            buffer: null, captionText, footerText: footer || '', nativeButtons
          });
          btnMethod = 'relay_interactive';
          console.log('[SBI-server] relay_interactive OK:', captionText.substring(0, 40));
        } catch (e) {
          console.warn('[SBI-server] relay_interactive falló:', e.message, '- intentando sendmsg_interactive');
          try {
            mainResult = await sendMessage(chatId, { text: captionText, footer: footer || '', interactiveButtons: nativeButtons });
            btnMethod = 'sendmsg_interactive';
            console.log('[SBI-server] sendmsg_interactive OK');
          } catch (e2) {
            console.warn('[SBI-server] sendmsg_interactive falló:', e2.message, '- intentando legacy buttons');
            const legacyBtnsT = nativeButtons.map((b, i) => {
              let label = b.buttonParamsJson ? (() => { try { return JSON.parse(b.buttonParamsJson).display_text; } catch(x) { return null; } })() : null;
              label = label || ('Opcion ' + (i + 1));
              return { buttonId: b.id || String(i), buttonText: { displayText: label }, type: 1 };
            });
            mainResult = await sendMessage(chatId, { text: captionText, buttons: legacyBtnsT, headerType: 1 });
            btnMethod = 'legacy_buttons';
            console.log('[SBI-server] legacy_buttons OK');
          }
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
      const captionText = caption || (typeof message === 'string' ? message : '');
      const btnLabel = req.body.buttonText || 'Ver opciones';
      // Soporta sections[] directamente O construye desde buttons[]
      let finalSections;
      if (req.body.sections && Array.isArray(req.body.sections) && req.body.sections.length > 0) {
        finalSections = req.body.sections.map(s => ({
          title: s.title || '',
          rows: (s.rows || []).map((r, i) => ({
            rowId: r.rowId || r.id || ('row_' + i),
            title: r.title || '',
            description: r.description || ''
          }))
        }));
      } else {
        const sectionTitle = req.body.sectionTitle || 'Opciones';
        const rows = (buttons || []).map((b, i) => {
          const title = b.buttonText?.displayText || b.text || b.label || b.title || ('Opcion ' + (i + 1));
          const rowId = b.id || title.toLowerCase().replace(/[^a-z0-9]/g, '_').substring(0, 20);
          return { rowId, title, description: b.description || '' };
        });
        finalSections = [{ title: sectionTitle, rows }];
      }

      // Enviar lista como texto formateado (sin poll — polls causan confusión en el cliente)
      const allRows = finalSections.flatMap(s => s.rows || []);
      let listText = (header ? '*' + header + '*\n\n' : '') + captionText;
      if (allRows.length > 0) {
        listText += '\n\n' + allRows.map((r, i) => `${i + 1}. ${r.title}${r.description ? '\n   _' + r.description + '_' : ''}`).join('\n');
      }
      if (footer) listText += '\n\n_' + footer + '_';
      let listResult;
      let listMethod = 'text_list';
      listResult = await sendMessage(chatId, { text: listText });
      console.log('[List] Enviado como texto formateado');
      const listMsgId = listResult.key?.id;
      const storageJidL = normalizeStorageJid(chatId);
      const chatNameL = getContactName(chatId) || storageJidL.split('@')[0];
      const logTextL = '[list] ' + captionText.substring(0, 50);
      saveMessage(storageJidL, chatNameL, { messageId: listMsgId, fromMe: true, text: logTextL, type: 'list', timestamp: Date.now() }).catch(() => {});
      upsertChat(storageJidL, chatNameL, logTextL, Date.now()).catch(() => {});
      return res.json({ ok: true, success: true, messageId: listMsgId, btnMethod: listMethod });

    } else if (type === 'buttons') {
      const captionText = caption || (typeof message === 'string' ? message : '');
      textForLog = '[btn] ' + captionText.substring(0, 50);

      // === buttonsMessage via sendMessage (relay_interactive/nativeFlowMessage falla) ===
      const legacyBtns = (buttons || []).map((b, i) => {
        let label = b.buttonText?.displayText || b.text || b.label || b.title;
        let btnId = b.id;
        if (b.buttonParamsJson) {
          try { const p = JSON.parse(b.buttonParamsJson); if (!label) label = p.display_text; if (!btnId) btnId = p.id; } catch(e) {}
        }
        label = label || ('Opcion ' + (i + 1));
        return { buttonId: btnId || ('btn_' + i), buttonText: { displayText: label }, type: 1 };
      });

      let btnResult;
      let btnMethod = 'text';

      // Enviar como texto con opciones numeradas (sin poll — polls causan confusión)
      let btnText = (header ? '*' + header + '*\n\n' : '') + captionText;
      if (legacyBtns.length > 0) {
        btnText += '\n\n' + legacyBtns.map((b, i) => `${i + 1}. ${b.buttonText?.displayText || 'Opción ' + (i + 1)}`).join('\n');
      }
      if (footer) btnText += '\n\n_' + footer + '_';
      btnResult = await sendMessage(chatId, { text: btnText });
      console.log('[Buttons] Enviado como texto formateado');

      const btnMsgId = btnResult.key?.id;
      const storageJidB = normalizeStorageJid(chatId);
      const chatNameB = getContactName(chatId) || storageJidB.split('@')[0];
      saveMessage(storageJidB, chatNameB, { messageId: btnMsgId, fromMe: true, text: textForLog, type: 'buttons', timestamp: Date.now() }).catch(() => {});
      upsertChat(storageJidB, chatNameB, textForLog, Date.now()).catch(() => {});
      return res.json({ ok: true, success: true, messageId: btnMsgId, btnMethod });

    } else if (type === 'menu') {
      // === MENÚ NUMERADO (compatible con cualquier WhatsApp — estilo BotConversa API no oficial) ===
      // Envía un mensaje de texto formateado con emojis numéricos y negrita.
      // El usuario responde con "1", "2", etc. y el bot enruta según la respuesta.
      const menuTitle = caption || (typeof message === 'string' ? message : '');
      const menuFooter = footer || req.body.footer || '';
      const menuOptions = buttons || [];
      const numEmojis = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];

      let menuText = '';
      if (header) menuText += `*${header}*\n\n`;
      if (menuTitle) menuText += `${menuTitle}\n\n`;

      menuOptions.forEach((b, i) => {
        const label = b.buttonText?.displayText || b.text || b.label || b.title || ('Opción ' + (i + 1));
        const emoji = b.emoji || numEmojis[i] || `${i + 1}.`;
        menuText += `${emoji} ${label}\n`;
      });

      const replyHint = req.body.replyHint !== undefined ? req.body.replyHint : true;
      if (replyHint && menuOptions.length > 0) {
        menuText += `\n_Responde con el número de tu opción_`;
      }
      if (menuFooter) menuText += `\n\n${menuFooter}`;

      const jidMenu = chatId.includes('@') ? chatId : chatId + '@s.whatsapp.net';
      const sockMenu = getSocket();
      if (!sockMenu) return res.status(503).json({ error: 'Bot no conectado' });
      const menuResult = await sockMenu.sendMessage(jidMenu, { text: menuText.trim() });
      const menuMsgId = menuResult?.key?.id;
      const storageJidMn = normalizeStorageJid(chatId);
      const chatNameMn = getContactName(chatId) || storageJidMn.split('@')[0];
      saveMessage(storageJidMn, chatNameMn, { messageId: menuMsgId, fromMe: true, text: '[menu] ' + menuTitle, type: 'menu', timestamp: Date.now() }).catch(() => {});
      upsertChat(storageJidMn, chatNameMn, '[menu] ' + menuTitle, Date.now()).catch(() => {});
      return res.json({ ok: true, success: true, messageId: menuMsgId, btnMethod: 'text_menu' });

    } else if (type === 'poll') {
      // === ENCUESTA NATIVA (funciona en todas las versiones de WA) ===
      const pollQuestion = caption || (typeof message === 'string' ? message : '');
      const pollOptions = (buttons || []).map(b => b.buttonText?.displayText || b.text || b.label || b.title).filter(Boolean);
      const selectableCount = req.body.selectableCount || 1;
      const jidPoll = chatId.includes('@') ? chatId : chatId + '@s.whatsapp.net';
      const sockPoll = getSocket();
      if (!sockPoll) return res.status(503).json({ error: 'Bot no conectado' });
      const pollResult = await sockPoll.sendMessage(jidPoll, {
        poll: { name: pollQuestion, values: pollOptions, selectableCount }
      });
      const pollMsgId = pollResult?.key?.id;
      const storageJidP = normalizeStorageJid(chatId);
      const chatNameP = getContactName(chatId) || storageJidP.split('@')[0];
      saveMessage(storageJidP, chatNameP, { messageId: pollMsgId, fromMe: true, text: '[poll] ' + pollQuestion, type: 'poll', timestamp: Date.now() }).catch(() => {});
      upsertChat(storageJidP, chatNameP, '[poll] ' + pollQuestion, Date.now()).catch(() => {});
      return res.json({ ok: true, success: true, messageId: pollMsgId, btnMethod: 'poll' });

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

    } else if (type === 'menu') {
      // === MENÚ NUMERADO en /send (compatible con cualquier WhatsApp) ===
      const menuTitle2 = caption || (typeof msg === 'string' ? msg : '');
      const menuFooter2 = footer || '';
      const menuHeader2 = req.body.header || '';
      const menuOptions2 = buttons || [];
      const numEmojis2 = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
      let menuText2 = '';
      if (menuHeader2) menuText2 += `*${menuHeader2}*\n\n`;
      if (menuTitle2) menuText2 += `${menuTitle2}\n\n`;
      menuOptions2.forEach((b, i) => {
        const label = b.buttonText?.displayText || b.text || b.label || b.title || ('Opción ' + (i + 1));
        const emoji = b.emoji || numEmojis2[i] || `${i + 1}.`;
        menuText2 += `${emoji} ${label}\n`;
      });
      const replyHint2 = req.body.replyHint !== undefined ? req.body.replyHint : true;
      if (replyHint2 && menuOptions2.length > 0) menuText2 += `\n_Responde con el número de tu opción_`;
      if (menuFooter2) menuText2 += `\n\n${menuFooter2}`;
      const jidMenu2 = chatId.includes('@') ? chatId : chatId + '@s.whatsapp.net';
      const sockMenu2 = getSocket();
      if (!sockMenu2) return res.status(503).json({ error: 'Bot no conectado' });
      const menuResult2 = await sockMenu2.sendMessage(jidMenu2, { text: menuText2.trim() });
      const storageJidMn2 = normalizeStorageJid(chatId);
      const chatNameMn2 = getContactName(chatId) || storageJidMn2.split('@')[0];
      saveMessage(storageJidMn2, chatNameMn2, { messageId: menuResult2?.key?.id, fromMe: true, text: '[menu] ' + menuTitle2, type: 'menu', timestamp: Date.now() }).catch(() => {});
      upsertChat(storageJidMn2, chatNameMn2, '[menu] ' + menuTitle2, Date.now()).catch(() => {});
      return res.json({ success: true, messageId: menuResult2?.key?.id, btnMethod: 'text_menu' });

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

// =============================================
// POST /meta-send — Envío directo por Meta Cloud API
// Requiere env: META_TOKEN, META_PHONE_NUMBER_ID
// Ejemplo: { "to": "573227461878", "type": "buttons", "body": "¿Qué necesitas?",
//            "buttons": [{"id":"p1","text":"Ver productos"},{"id":"p2","text":"Hacer pedido"}] }
// =============================================
router.post('/meta-send', async (req, res) => {
  try {
    if (!metaCloudEnabled()) {
      return res.status(503).json({
        error: 'Meta Cloud API no configurada',
        hint: 'Agrega META_TOKEN y META_PHONE_NUMBER_ID en las variables de entorno de Render'
      });
    }

    const { to, type = 'text', body, message, footer, header, buttons, sections, buttonText } = req.body;
    if (!to) return res.status(400).json({ error: '"to" (número destino) es requerido' });

    const cleanTo = String(to).replace(/[^0-9]/g, '');
    const msgBody = body || message || '';
    let result;

    if (type === 'buttons') {
      result = await sendMetaButtons(cleanTo, { body: msgBody, footer, header, buttons: buttons || [] });
    } else if (type === 'list') {
      result = await sendMetaList(cleanTo, { body: msgBody, footer, header, buttonText, sections: sections || [] });
    } else if (type === 'image') {
      const imgUrl = req.body.imageUrl || req.body.mediaUrl || msgBody;
      result = await sendMetaImage(cleanTo, { imageUrl: imgUrl, caption: footer || '' });
    } else {
      result = await sendMetaText(cleanTo, msgBody);
    }

    const msgId = result.messages?.[0]?.id || 'meta_' + Date.now();
    res.json({ ok: true, meta: true, messageId: msgId, to: cleanTo, type });
  } catch (err) {
    console.error('[/meta-send]', err.message);
    res.status(500).json({ error: err.message, meta: true });
  }
});

// =============================================
// GET /webhook — Verificación de webhook Meta
// Configura en Meta: URL = https://sanate-wa-bot.onrender.com/api/whatsapp/webhook
// Verify Token = valor de META_WEBHOOK_TOKEN (o 'sanate_webhook' por default)
// =============================================
router.get('/webhook', (req, res) => {
  const VERIFY_TOKEN = process.env.META_WEBHOOK_TOKEN || 'sanate_webhook';
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[Webhook Meta] Verificación exitosa');
    return res.send(challenge);
  }
  res.status(403).json({ error: 'Webhook verification failed' });
});

// =============================================
// POST /webhook — Recibir mensajes y clicks desde Meta Cloud API
// =============================================
router.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Responder 200 inmediatamente (requisito de Meta)
  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    const sse = req.app.get('sse');

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue;
        const value = change.value;

        for (const msg of value.messages || []) {
          const from = msg.from;
          let text = '';
          let msgType = msg.type;

          if (msg.type === 'text') {
            text = msg.text?.body || '';
          } else if (msg.type === 'interactive') {
            if (msg.interactive?.type === 'button_reply') {
              text = `[btn:${msg.interactive.button_reply.id}] ${msg.interactive.button_reply.title}`;
              msgType = 'button_reply';
            } else if (msg.interactive?.type === 'list_reply') {
              text = `[list:${msg.interactive.list_reply.id}] ${msg.interactive.list_reply.title}`;
              msgType = 'list_reply';
            }
          } else if (msg.type === 'image') {
            text = '[imagen]';
          } else if (msg.type === 'audio') {
            text = '[audio]';
          } else if (msg.type === 'document') {
            text = '[documento]';
          }

          const contactName = value.contacts?.[0]?.profile?.name || getContactName(from) || from;
          const msgId = msg.id;
          const ts = parseInt(msg.timestamp) * 1000 || Date.now();

          await saveMessage(from, contactName, {
            messageId: msgId, fromMe: false, text, type: msgType, timestamp: ts
          }).catch(() => {});
          await upsertChat(from, contactName, text, ts).catch(() => {});

          if (sse) {
            sse.broadcast({
              type: 'new_message',
              chatId: from, messageId: msgId, text,
              direction: 'incoming', timestamp: ts,
              contactName, source: 'meta_cloud'
            });
          }

          console.log(`[Webhook Meta] Mensaje de ${from} (${msgType}): ${text.substring(0, 60)}`);
        }
      }
    }
  } catch (err) {
    console.error('[Webhook Meta] Error:', err.message);
  }
});

router.post('/disconnect', async (req, res) => {
  try { await disconnect(); res.json({ success: true, message: 'Desconectado' }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/settings', (req, res) => {
  res.json({
    server: 'sanate-wa-server', version: '3.5.0', engine: 'baileys-standalone',
    connection: getConnectionState(), sse: req.app.get('sse')?.getStatus(),
    supabase: !!req.app.get('supabase'), uptime: Math.floor(process.uptime()),
    contacts: contactCache.keys().length,
    metaCloud: metaCloudEnabled()
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

// =============================================
// WABA MULTI-TIENDA — Botones reales por número
// =============================================

// GET /waba/numbers — Listar todos los números WABA conectados
router.get('/waba/numbers', async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    if (!supabase) return res.status(503).json({ error: 'Supabase no disponible' });
    const { data, error } = await supabase
      .from('oasis_waba_connections')
      .select('id, store_id, display_name, phone_number, phone_number_id, waba_id, quality_rating, status, meta_verified, created_at')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ ok: true, numbers: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /waba/connect — Conectar nuevo número WABA (guarda credenciales)
router.post('/waba/connect', async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    if (!supabase) return res.status(503).json({ error: 'Supabase no disponible' });
    const { display_name, phone_number, phone_number_id, access_token, waba_id, store_id } = req.body;
    if (!phone_number_id || !access_token) {
      return res.status(400).json({ error: 'phone_number_id y access_token son requeridos' });
    }
    // Verificar credenciales con Meta antes de guardar
    let metaVerified = false;
    let metaPhone = phone_number;
    let metaName = display_name;
    try {
      const verifyResp = await fetch(`https://graph.facebook.com/v19.0/${phone_number_id}?fields=display_phone_number,verified_name,quality_rating`, {
        headers: { Authorization: `Bearer ${access_token}` }
      });
      const verifyData = await verifyResp.json();
      if (!verifyData.error) {
        metaVerified = true;
        metaPhone = verifyData.display_phone_number || phone_number;
        metaName = verifyData.verified_name || display_name;
      }
    } catch (e) { /* continuar aunque falle la verificación */ }

    const { data, error } = await supabase
      .from('oasis_waba_connections')
      .upsert({
        store_id: store_id || 'default',
        display_name: metaName || phone_number,
        phone_number: metaPhone || phone_number,
        phone_number_id,
        access_token,
        waba_id: waba_id || null,
        status: 'connected',
        meta_verified: metaVerified,
        updated_at: new Date().toISOString()
      }, { onConflict: 'phone_number_id', ignoreDuplicates: false });
    if (error) throw error;
    console.log(`[WABA] Número conectado: ${metaPhone || phone_number} | ID: ${phone_number_id} | Verificado: ${metaVerified}`);
    res.json({ ok: true, success: true, phone_number: metaPhone || phone_number, display_name: metaName, meta_verified: metaVerified });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /waba/disconnect/:phoneNumberId — Desconectar número WABA
router.delete('/waba/disconnect/:phoneNumberId', async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    if (!supabase) return res.status(503).json({ error: 'Supabase no disponible' });
    const { phoneNumberId } = req.params;
    const { error } = await supabase
      .from('oasis_waba_connections')
      .delete()
      .eq('phone_number_id', phoneNumberId);
    if (error) throw error;
    console.log(`[WABA] Número desconectado: ${phoneNumberId}`);
    res.json({ ok: true, success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /waba/test/:phoneNumberId — Enviar mensaje de prueba desde número WABA
router.post('/waba/test/:phoneNumberId', async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    if (!supabase) return res.status(503).json({ error: 'Supabase no disponible' });
    const { phoneNumberId } = req.params;
    const { to } = req.body;
    if (!to) return res.status(400).json({ error: 'Número destinatario (to) requerido' });
    // Get token for this phone number
    const { data, error } = await supabase
      .from('oasis_waba_connections')
      .select('access_token, phone_number')
      .eq('phone_number_id', phoneNumberId)
      .single();
    if (error || !data) return res.status(404).json({ error: 'Número WABA no encontrado' });
    const cleanTo = String(to).replace(/[^0-9]/g, '');
    const testPayload = {
      messaging_product: 'whatsapp',
      to: cleanTo,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: '✅ Prueba de botones WABA desde *' + (data.phone_number || phoneNumberId) + '*\n¿Todo funcionando?' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'test_si', title: '✅ Sí, funciona' } },
            { type: 'reply', reply: { id: 'test_info', title: '📞 Más info' } }
          ]
        }
      }
    };
    const resp = await fetch(`https://graph.facebook.com/v19.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${data.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(testPayload)
    });
    const result = await resp.json();
    if (result.error) return res.status(400).json({ error: result.error.message, details: result.error });
    const wamid = result.messages?.[0]?.id;
    console.log(`[WABA Test] OK desde ${phoneNumberId} → ${cleanTo} | WAMID: ${wamid}`);
    res.json({ ok: true, success: true, wamid, to: cleanTo });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /waba/verify — Verificar token Meta y obtener info del número
router.post('/waba/verify', async (req, res) => {
  try {
    const { phone_number_id, access_token } = req.body;
    if (!phone_number_id || !access_token) {
      return res.status(400).json({ error: 'phone_number_id y access_token requeridos' });
    }
    const resp = await fetch(
      `https://graph.facebook.com/v19.0/${phone_number_id}?fields=display_phone_number,verified_name,quality_rating,platform_type,code_verification_status`,
      { headers: { Authorization: `Bearer ${access_token}` } }
    );
    const data = await resp.json();
    if (data.error) return res.status(400).json({ ok: false, error: data.error.message, code: data.error.code });
    res.json({
      ok: true,
      phone_number: data.display_phone_number,
      verified_name: data.verified_name,
      quality_rating: data.quality_rating,
      platform: data.platform_type,
      verified: data.code_verification_status === 'VERIFIED'
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// =============================================
// POST /test-all — Dispara 8+ formatos visuales en paralelo para pruebas
// Body: { "to": "573227461878" }
// =============================================
router.post('/test-all', async (req, res) => {
  const chatId = (req.body.to || '573227461878').replace(/[^0-9]/g, '');
  const jid = chatId + '@s.whatsapp.net';
  const sock = getSocket();
  const { generateWAMessageFromContent } = getBaileysFns();
  const results = [];
  const delay = ms => new Promise(r => setTimeout(r, ms));

  // TEST-A: sendMessage con sections (listMessage proto antiguo)
  try {
    const r = await sendMessage(chatId, {
      text: '📋 TEST-A: Lista desplegable antigua\n(toca el botón "Ver opciones" que debería aparecer abajo)',
      footer: 'Sánate Bot • Test A',
      title: 'Menú Sánate',
      buttonText: 'Ver opciones',
      sections: [{ title: 'Categorías', rows: [
        { rowId: 'cremas', title: '🧴 Cremas faciales', description: 'Hidratantes y más' },
        { rowId: 'vitaminas', title: '💊 Vitaminas', description: 'Suplementos' },
        { rowId: 'naturales', title: '🌿 Naturales', description: 'Productos orgánicos' },
        { rowId: 'combos', title: '🎁 Combos', description: 'Paquetes especiales' }
      ]}]
    });
    results.push({ test: 'A', method: 'sendMessage_sections', msgId: r.key?.id, ok: true });
  } catch(e) { results.push({ test: 'A', error: e.message }); }
  await delay(700);

  // TEST-B: sendMessage con buttons (buttonsMessage proto antiguo)
  try {
    const r = await sendMessage(chatId, {
      text: '🔘 TEST-B: Botones antiguos\n(deben aparecer como pastillas grises tapeables)',
      footer: 'Sánate Bot • Test B',
      buttons: [
        { buttonId: 'pedidos', buttonText: { displayText: '📦 Ver pedidos' }, type: 1 },
        { buttonId: 'asesor', buttonText: { displayText: '💬 Hablar asesor' }, type: 1 },
        { buttonId: 'no', buttonText: { displayText: '❌ No gracias' }, type: 1 }
      ],
      headerType: 1
    });
    results.push({ test: 'B', method: 'sendMessage_buttons', msgId: r.key?.id, ok: true });
  } catch(e) { results.push({ test: 'B', error: e.message }); }
  await delay(700);

  // TEST-C: buttons con imagen (buttonsMessage + imageHeader)
  try {
    const r = await sendMessage(chatId, {
      image: { url: 'https://www.gstatic.com/webp/gallery/1.jpg' },
      caption: '🖼️ TEST-C: Botones con imagen de cabecera\n(foto + botones abajo)',
      footer: 'Sánate Bot • Test C',
      buttons: [
        { buttonId: 'comprar', buttonText: { displayText: '🛍️ Comprar ahora' }, type: 1 },
        { buttonId: 'info', buttonText: { displayText: '📞 Más info' }, type: 1 }
      ],
      headerType: 4
    });
    results.push({ test: 'C', method: 'sendMessage_img_buttons', msgId: r.key?.id, ok: true });
  } catch(e) { results.push({ test: 'C', error: e.message }); }
  await delay(700);

  // TEST-D: interactiveMessage + nativeFlowMessage quick_reply via relay (sin additionalNodes)
  if (sock && generateWAMessageFromContent) {
    try {
      const nativeBtns = [
        { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: '📦 Ver pedidos', id: 'pedidos' }) },
        { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: '💬 Hablar asesor', id: 'asesor' }) },
        { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: '❌ No gracias', id: 'no' }) }
      ];
      const msgD = { interactiveMessage: { header: { hasMediaAttachment: false }, body: { text: '⚡ TEST-D: nativeFlow quick_reply sin nodos\n(relay directo, sin additionalNodes)' }, footer: { text: 'Sánate Bot • Test D' }, nativeFlowMessage: { buttons: nativeBtns, messageParamsJson: '', messageVersion: 1 } } };
      const wD = generateWAMessageFromContent(jid, msgD, { userJid: sock.user?.id || jid });
      await sock.relayMessage(jid, wD.message, { messageId: wD.key.id });
      results.push({ test: 'D', method: 'relay_quickReply_noNodes', msgId: wD.key.id, ok: true });
    } catch(e) { results.push({ test: 'D', error: e.message }); }
    await delay(700);

    // TEST-E: interactiveMessage + nativeFlowMessage single_select (menú desplegable)
    try {
      const singleBtn = { name: 'single_select', buttonParamsJson: JSON.stringify({ title: 'Ver categorías', sections: [{ title: 'Sánate Productos', rows: [{ id: 'cremas', title: '🧴 Cremas' }, { id: 'vitaminas', title: '💊 Vitaminas' }, { id: 'naturales', title: '🌿 Naturales' }] }] }) };
      const msgE = { interactiveMessage: { header: { hasMediaAttachment: false }, body: { text: '📂 TEST-E: nativeFlow single_select\n(botón que abre lista desplegable)' }, footer: { text: 'Sánate Bot • Test E' }, nativeFlowMessage: { buttons: [singleBtn], messageParamsJson: '', messageVersion: 1 } } };
      const wE = generateWAMessageFromContent(jid, msgE, { userJid: sock.user?.id || jid });
      await sock.relayMessage(jid, wE.message, { messageId: wE.key.id });
      results.push({ test: 'E', method: 'relay_singleSelect', msgId: wE.key.id, ok: true });
    } catch(e) { results.push({ test: 'E', error: e.message }); }
    await delay(700);

    // TEST-F: nativeFlow + additionalNodes biz/interactive
    try {
      const nativeBtnsF = [
        { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: '✅ Opción 1', id: 'op1' }) },
        { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: '📞 Opción 2', id: 'op2' }) }
      ];
      const msgF = { interactiveMessage: { header: { hasMediaAttachment: false }, body: { text: '🔧 TEST-F: nativeFlow + additionalNodes biz\n(con nodos XML adicionales)' }, footer: { text: 'Sánate Bot • Test F' }, nativeFlowMessage: { buttons: nativeBtnsF, messageParamsJson: '', messageVersion: 1 } } };
      const wF = generateWAMessageFromContent(jid, msgF, { userJid: sock.user?.id || jid });
      const addNodes = [{ tag: 'biz', attrs: {}, content: [{ tag: 'interactive', attrs: { type: 'native_flow', v: '1' }, content: [{ tag: 'native_flow', attrs: { name: 'quick_reply', v: '9' } }] }] }];
      await sock.relayMessage(jid, wF.message, { messageId: wF.key.id, additionalNodes: addNodes });
      results.push({ test: 'F', method: 'relay_quickReply_withNodes', msgId: wF.key.id, ok: true });
    } catch(e) { results.push({ test: 'F', error: e.message }); }
    await delay(700);

    // TEST-G: CTA URL button (nativeFlow)
    try {
      const ctaBtn = { name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: '🌐 Ver catálogo web', url: 'https://sanate.store', merchant_url: 'https://sanate.store' }) };
      const msgG = { interactiveMessage: { header: { hasMediaAttachment: false }, body: { text: '🔗 TEST-G: CTA URL button\n(botón enlace externo)' }, footer: { text: 'Sánate Bot • Test G' }, nativeFlowMessage: { buttons: [ctaBtn], messageParamsJson: '', messageVersion: 1 } } };
      const wG = generateWAMessageFromContent(jid, msgG, { userJid: sock.user?.id || jid });
      await sock.relayMessage(jid, wG.message, { messageId: wG.key.id });
      results.push({ test: 'G', method: 'relay_ctaUrl', msgId: wG.key.id, ok: true });
    } catch(e) { results.push({ test: 'G', error: e.message }); }
    await delay(700);
  }

  // TEST-H: templateMessage hydratedTemplate (formato legacy de templates)
  try {
    const r = await sendMessage(chatId, {
      text: '📝 TEST-H: Template hydrated con botones\n(formato antiguo de templates WA)',
      footer: 'Sánate Bot • Test H',
      templateButtons: [
        { index: 1, quickReplyButton: { displayText: '✅ Sí me interesa', id: 'si' } },
        { index: 2, quickReplyButton: { displayText: '❌ No gracias', id: 'no' } },
        { index: 3, urlButton: { displayText: '🌐 Ver web', url: 'https://sanate.store' } }
      ]
    });
    results.push({ test: 'H', method: 'templateButtons', msgId: r.key?.id, ok: true });
  } catch(e) { results.push({ test: 'H', error: e.message }); }

  res.json({ ok: true, sent: results.filter(r => r.ok).length, total: results.length, results });
});

// =============================================
// GET /catalogo — Mini-app web con botones reales para WhatsApp
// El bot envía este link → cliente lo toca → ve botones → WhatsApp se abre con opción lista
// =============================================
router.get('/catalogo', (req, res) => {
  const botNumber = process.env.BOT_NUMBER || '573215777341';
  const storeName = process.env.STORE_NAME || 'Sánate Colombia';

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
<title>${storeName} - Menú</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: linear-gradient(135deg, #25D366 0%, #128C7E 100%);
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 20px;
  }
  .logo-area {
    text-align: center;
    margin: 20px 0 30px;
    color: white;
  }
  .logo-area h1 {
    font-size: 26px;
    font-weight: 700;
    text-shadow: 0 2px 4px rgba(0,0,0,0.3);
  }
  .logo-area p {
    font-size: 15px;
    opacity: 0.9;
    margin-top: 6px;
  }
  .card {
    background: white;
    border-radius: 20px;
    padding: 24px 20px;
    width: 100%;
    max-width: 420px;
    box-shadow: 0 10px 40px rgba(0,0,0,0.2);
  }
  .card h2 {
    font-size: 18px;
    color: #333;
    margin-bottom: 20px;
    text-align: center;
  }
  .btn-menu {
    display: flex;
    align-items: center;
    width: 100%;
    padding: 16px 20px;
    margin-bottom: 12px;
    border-radius: 14px;
    text-decoration: none;
    font-size: 16px;
    font-weight: 600;
    color: white;
    transition: transform 0.1s, box-shadow 0.1s;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    cursor: pointer;
    border: none;
    background: none;
  }
  .btn-menu:active { transform: scale(0.97); }
  .btn-menu .icon { font-size: 28px; margin-right: 14px; }
  .btn-menu .label { flex: 1; }
  .btn-menu .label span { display: block; font-size: 12px; font-weight: 400; opacity: 0.85; margin-top: 2px; }
  .btn-menu .arrow { font-size: 20px; opacity: 0.7; }
  .btn1 { background: linear-gradient(135deg, #FF6B6B, #ee5a24); }
  .btn2 { background: linear-gradient(135deg, #a29bfe, #6c5ce7); }
  .btn3 { background: linear-gradient(135deg, #fd79a8, #e84393); }
  .btn4 { background: linear-gradient(135deg, #55efc4, #00b894); }
  .btn5 { background: linear-gradient(135deg, #ffeaa7, #fdcb6e); color: #333; }
  .btn6 { background: linear-gradient(135deg, #74b9ff, #0984e3); }
  .footer {
    margin-top: 20px;
    text-align: center;
    color: rgba(255,255,255,0.8);
    font-size: 13px;
  }
  .wa-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: rgba(255,255,255,0.2);
    padding: 6px 14px;
    border-radius: 20px;
    margin-top: 8px;
    color: white;
    font-size: 13px;
  }
</style>
</head>
<body>
<div class="logo-area">
  <h1>🌿 ${storeName}</h1>
  <p>¿Qué te interesa hoy?</p>
</div>
<div class="card">
  <h2>Toca la opción que quieras 👇</h2>
  <a class="btn-menu btn1" href="https://wa.me/${botNumber}?text=Quiero+ver+los+Combos">
    <span class="icon">🎁</span>
    <span class="label">Ver Combos<span>Kits y paquetes especiales</span></span>
    <span class="arrow">›</span>
  </a>
  <a class="btn-menu btn2" href="https://wa.me/${botNumber}?text=Quiero+ver+las+Cremas">
    <span class="icon">✨</span>
    <span class="label">Ver Cremas<span>Cuidado facial y corporal</span></span>
    <span class="arrow">›</span>
  </a>
  <a class="btn-menu btn3" href="https://wa.me/${botNumber}?text=Quiero+ver+las+Ofertas">
    <span class="icon">🔥</span>
    <span class="label">Ofertas del día<span>Descuentos y promociones</span></span>
    <span class="arrow">›</span>
  </a>
  <a class="btn-menu btn4" href="https://wa.me/${botNumber}?text=Quiero+informacion+de+envios">
    <span class="icon">🚚</span>
    <span class="label">Envíos<span>Tiempos y costos de entrega</span></span>
    <span class="arrow">›</span>
  </a>
  <a class="btn-menu btn5" href="https://wa.me/${botNumber}?text=Quiero+ver+el+catalogo+completo">
    <span class="icon">📋</span>
    <span class="label">Catálogo completo<span>Todos nuestros productos</span></span>
    <span class="arrow">›</span>
  </a>
  <a class="btn-menu btn6" href="https://wa.me/${botNumber}?text=Quiero+hablar+con+un+asesor">
    <span class="icon">💬</span>
    <span class="label">Hablar con asesor<span>Atención personalizada</span></span>
    <span class="arrow">›</span>
  </a>
</div>
<div class="footer">
  <div class="wa-badge">📱 Abre WhatsApp automáticamente</div>
</div>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// POST /send-catalogo — El bot envía el link del catálogo a un número
router.post('/send-catalogo', async (req, res) => {
  try {
    const { to } = req.body;
    if (!to) return res.status(400).json({ error: 'Falta to' });
    const cleanTo = to.replace(/[^0-9]/g, '');
    const jid = cleanTo + '@s.whatsapp.net';
    const sock = getSocket();
    if (!sock) return res.status(503).json({ error: 'Socket no disponible' });

    const catalogUrl = `https://sanate-wa-bot.onrender.com/api/whatsapp/catalogo`;
    const msg = `🌿 *Catálogo Sánate Colombia*\n\nToca el botón aquí abajo para ver nuestro menú completo con opciones tapeables 👇\n\n${catalogUrl}\n\n_Abre el link y selecciona lo que te interesa_ ✨`;

    await sock.sendMessage(jid, { text: msg });
    res.json({ ok: true, to: cleanTo, url: catalogUrl });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
