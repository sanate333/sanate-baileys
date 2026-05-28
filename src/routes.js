const express = require('express');
const router = express.Router();
const QRCode = require('qrcode');
const { getConnectionState, getQR, getQrAttempts, getProfilePhoto, getContactName, sendMessage, disconnect, startConnection, getSocket, contactCache, getAntiBan, getDebugFlags } = require('./baileys');
const { getChats, getMessages, saveMessage, upsertChat, getSupabase } = require('./supabase');
const { getConfig, setConfig, getUsageStats, handleIncomingMessage, setMetaSendFunction, setAntiBanGetter, antiBanGuard, antiBanAfterSend, isBotWithinSchedule, invalidateScheduleCache } = require('./auto-reply');
const { getAudioSettings, saveAudioSettings, sendAudioTest, generateVoicePreview } = require('./audio-tts');

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

// baileys_helper — inyecta nodos binarios (biz/interactive/native_flow/bot) que WhatsApp requiere
let _baileysHelper = null;
function getBaileysHelper() {
  if (!_baileysHelper) {
    try {
      _baileysHelper = require('baileys_helper');
      console.log('[baileys_helper] Cargado OK — funciones:', Object.keys(_baileysHelper).join(', '));
    } catch (e) {
      console.error('[baileys_helper] No se pudo cargar:', e.message);
      _baileysHelper = {};
    }
  }
  return _baileysHelper;
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

// === ANTI-BAN WRAPPER: Protege CUALQUIER envío interactivo con las 5 capas anti-ban ===
// Si anti-ban bloquea Baileys, intenta Cloud API (sendMetaButtons/sendMetaList).
// Retorna { result, method, antiban } — method puede ser 'baileys', 'meta', 'blocked'.
async function safeSendInteractive(chatId, { sendFn, metaFallbackFn, label }) {
  const jid = chatId.includes('@') ? chatId : chatId + '@s.whatsapp.net';
  const guard = await antiBanGuard(jid, label || 'interactive');

  if (!guard.allowed) {
    console.log('[safeSend] BLOQUEADO por anti-ban:', guard.reason, '—', label);
    return { result: null, method: 'blocked', antiban: guard.reason };
  }

  // Si anti-ban recomienda Cloud API, intentar meta primero
  if (guard.fallbackToMeta && metaFallbackFn && metaCloudEnabled()) {
    try {
      console.log('[safeSend] Anti-ban recomienda Cloud API:', guard.reason, '—', label);
      const metaResult = await metaFallbackFn();
      antiBanAfterSend(jid, label);
      return { result: metaResult, method: 'meta', antiban: guard.reason };
    } catch (metaErr) {
      console.warn('[safeSend] Cloud API fallback falló:', metaErr.message, '— intentando Baileys');
    }
  }

  // Esperar delay recomendado por anti-ban
  if (guard.delayMs > 0) {
    await new Promise(r => setTimeout(r, guard.delayMs));
  }

  // Enviar por Baileys
  try {
    const result = await sendFn();
    antiBanAfterSend(jid, label);
    return { result, method: 'baileys', antiban: null };
  } catch (err) {
    // Si Baileys falla y hay Cloud API disponible, intentar como último recurso
    if (metaFallbackFn && metaCloudEnabled()) {
      try {
        console.log('[safeSend] Baileys falló, último recurso Cloud API —', label);
        const metaResult = await metaFallbackFn();
        antiBanAfterSend(jid, label);
        return { result: metaResult, method: 'meta', antiban: 'baileys-failed' };
      } catch (metaErr2) {
        console.error('[safeSend] Ambos canales fallaron —', label);
      }
    }
    throw err; // Re-throw si todo falla
  }
}

// === HELPER PRINCIPAL: Enviar mensaje interactivo via baileys_helper (inyecta nodos binarios) ===
async function sendInteractiveMessageDirect(chatId, { buffer, contentType, mediaType, captionText, footerText, nativeButtons }) {
  const sock = getSocket();
  if (!sock) throw new Error('Socket de WhatsApp no disponible');

  const jid = chatId.includes('@') ? chatId : chatId + '@s.whatsapp.net';
  const helper = getBaileysHelper();

  // Convertir nativeButtons al formato que espera baileys_helper
  const interactiveButtons = (nativeButtons || []).map(btn => {
    // Si ya tiene name + buttonParamsJson, pasarlo directo
    if (btn.name && btn.buttonParamsJson) return btn;
    // Legacy: { id, text } -> quick_reply
    if (btn.id && btn.text) {
      return { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: btn.text, id: btn.id }) };
    }
    // Legacy: { buttonId, buttonText } -> quick_reply
    if (btn.buttonId || btn.buttonText) {
      const label = btn.buttonText?.displayText || btn.text || 'Opción';
      return { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: label, id: btn.buttonId || btn.id || 'btn' }) };
    }
    return btn;
  });

  // Si baileys_helper está disponible, usar sendInteractiveMessage (inyecta nodos binarios)
  if (helper.sendInteractiveMessage) {
    console.log('[interactive-helper] Enviando via baileys_helper a:', jid, '| botones:', interactiveButtons.length);
    const result = await helper.sendInteractiveMessage(sock, jid, {
      text: captionText || '',
      footer: footerText || '',
      interactiveButtons
    });
    console.log('[interactive-helper] Enviado OK, msgId:', result?.key?.id);
    return result;
  }

  // Fallback: si baileys_helper no cargó, intentar sendButtons
  if (helper.sendButtons) {
    console.log('[interactive-helper] Usando sendButtons fallback');
    return await helper.sendButtons(sock, jid, {
      text: captionText || '',
      footer: footerText || '',
      buttons: interactiveButtons
    });
  }

  // Fallback: relay manual CON additionalNodes (biz + interactive + bot tags requeridos por WhatsApp)
  console.log('[interactive-helper] Usando relay manual con additionalNodes | media:', !!buffer);
  const baileys = require('@whiskeysockets/baileys');
  const { generateWAMessageFromContent: genMsg, normalizeMessageContent, isJidGroup: isGroup, prepareWAMessageMedia } = baileys;
  if (!genMsg) throw new Error('No hay método disponible para enviar botones interactivos');

  // Build interactive message — with optional image header
  const interactiveMsg = {
    body: { text: captionText || '' },
    footer: { text: footerText || '' },
    nativeFlowMessage: {
      buttons: interactiveButtons.map(b => ({ name: b.name || 'quick_reply', buttonParamsJson: b.buttonParamsJson })),
      messageParamsJson: '',
      messageVersion: 1
    }
  };

  // If buffer provided, upload media and attach as header image
  if (buffer) {
    try {
      const mediaMsg = await prepareWAMessageMedia(
        { image: buffer },
        { upload: sock.waUploadToServer }
      );
      if (mediaMsg && mediaMsg.imageMessage) {
        interactiveMsg.header = {
          hasMediaAttachment: true,
          imageMessage: mediaMsg.imageMessage
        };
        console.log('[interactive-helper] Image header attached OK');
      }
    } catch (mediaErr) {
      console.error('[interactive-helper] Error uploading media for header:', mediaErr.message);
      // Continue without image header
    }
  }

  const msgContent = { interactiveMessage: interactiveMsg };
  const senderJid = sock.user?.id || jid;
  const genId = baileys.generateMessageIDV2 || baileys.generateMessageID;
  const wamsg = genMsg(jid, msgContent, { userJid: senderJid, messageId: genId ? genId(senderJid) : undefined });

  // additionalNodes — CRITICAL: sin estos, WhatsApp ignora los botones
  const additionalNodes = [
    { tag: 'biz', attrs: {}, content: [{ tag: 'interactive', attrs: { type: 'native_flow', v: '1' }, content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }] }] }
  ];
  // Para chats privados (no grupos), agregar tag <bot biz_bot='1'>
  if (!isGroup(jid)) {
    additionalNodes.push({ tag: 'bot', attrs: { biz_bot: '1' } });
  }

  await sock.relayMessage(jid, wamsg.message, { messageId: wamsg.key.id, additionalNodes });
  console.log('[interactive-helper] Relay con additionalNodes OK, msgId:', wamsg.key?.id);
  return wamsg;
}

// === HELPER: Enviar lista interactiva con single_select via baileys_helper ===
async function sendListMessageDirect(chatId, { captionText, footerText, headerTitle, buttonText, sections }) {
  const sock = getSocket();
  if (!sock) throw new Error('Socket de WhatsApp no disponible');

  const jid = chatId.includes('@') ? chatId : chatId + '@s.whatsapp.net';

  const selectSections = sections.map(s => ({
    title: s.title || '',
    rows: (s.rows || []).map((r, i) => ({
      id: r.rowId || r.id || ('row_' + i),
      title: r.title || '',
      description: r.description || ''
    }))
  }));

  const interactiveButtons = [{
    name: 'single_select',
    buttonParamsJson: JSON.stringify({
      title: buttonText || 'Ver opciones',
      sections: selectSections
    })
  }];

  const helper = getBaileysHelper();
  if (helper.sendInteractiveMessage) {
    console.log('[interactive-list] Enviando lista via baileys_helper a:', jid);
    const result = await helper.sendInteractiveMessage(sock, jid, {
      text: captionText || '',
      footer: footerText || '',
      interactiveButtons
    });
    console.log('[interactive-list] Enviado OK, msgId:', result?.key?.id);
    return result;
  }

  // Fallback relay manual
  console.warn('[interactive-list] baileys_helper no disponible, usando relay manual');
  const { generateWAMessageFromContent } = getBaileysFns();
  if (!generateWAMessageFromContent) throw new Error('No hay método para enviar listas');
  const msgContent = {
    interactiveMessage: {
      header: { hasMediaAttachment: false },
      body: { text: captionText || '' },
      footer: { text: footerText || '' },
      nativeFlowMessage: { buttons: interactiveButtons, messageParamsJson: '', messageVersion: 1 }
    }
  };
  const senderJid = sock.user?.id || jid;
  const wamsg = generateWAMessageFromContent(jid, msgContent, { userJid: senderJid });
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

// Inject Cloud API sender into auto-reply module (enables bot replies via Meta when Baileys is down)
setMetaSendFunction(async (to, text) => {
  if (!metaCloudEnabled()) throw new Error('Meta Cloud API no configurada');
  return sendMetaText(to, text);
});

// Inject anti-ban getter into auto-reply module (enables rate-limiting + warm-up checks in botSend)
setAntiBanGetter(() => getAntiBan());

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
  const openPaths = ['/events', '/status', '/qr', '/settings', '/ai-config', '/ai-usage', '/webhook', '/voice-preview', '/audio-test', '/schedule', '/backup'];
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
  const rawState = getConnectionState();
  // For the frontend panel: treat "reconnecting" as "connected" to prevent UI flicker
  // The panel polls every 3s and brief reconnects (5s) cause visual oscillation
  const state = rawState === 'reconnecting' ? 'connected' : rawState;
  // Determine connection status
  // Panel "Conexion WhatsApp" section is about Baileys (QR link).
  // Cloud API runs independently — don't let it mask a disconnected Baileys.
  const cloudActive = metaCloudEnabled();
  const baileysActive = state === 'connected';
  // Primary status = Baileys state. Cloud API is a separate indicator.
  // Extraer numero de telefono vinculado
  const _sock = getSocket();
  const connectedPhone = _sock?.user?.id?.replace(/:.*$/, '')?.replace(/@s\.whatsapp\.net$/, '') || null;
  res.json({
    status: baileysActive ? 'connected' : state,
    connected: baileysActive,
    baileysConnected: baileysActive,
    cloudApiConnected: cloudActive,
    connectedPhone: connectedPhone,
    rawState: rawState, // expose real state for debugging
    hasQR: !!getQR(),
    qrAttempts: getQrAttempts(),
    uptime: Math.floor(process.uptime()),
    sseClients: req.app.get('sse')?.getStatus()?.clients || 0,
    contactsInCache: contactCache.keys().length,
    server: 'sanate-wa-server', engine: 'dual-channel',
    metaCloudEnabled: cloudActive,
    timestamp: new Date().toISOString(),
    hotfixes: [
      RENDER_URL + '/hotfixes/connection-stabilizer.js',
      RENDER_URL + '/hotfixes/waba-connect-ui.js',
      RENDER_URL + '/hotfixes/visual-chat-v2.js',
      RENDER_URL + '/hotfixes/meta-panel-hotfix.js',
      RENDER_URL + '/hotfixes/qr-rotate.js',
      RENDER_URL + '/hotfixes/interactive-visual.js',
      RENDER_URL + '/hotfixes/plantillas-buttons-hotfix.js',
      RENDER_URL + '/hotfixes/warmup-meter.js',
      RENDER_URL + '/hotfixes/panel-extras.js?v=4'
    ],
    extraScripts: [
      RENDER_URL + '/hotfixes/connection-stabilizer.js',
      RENDER_URL + '/hotfixes/waba-connect-ui.js',
      RENDER_URL + '/hotfixes/visual-chat-v2.js',
      RENDER_URL + '/hotfixes/meta-panel-hotfix.js',
      RENDER_URL + '/hotfixes/qr-rotate.js',
      RENDER_URL + '/hotfixes/interactive-visual.js',
      RENDER_URL + '/hotfixes/plantillas-buttons-hotfix.js',
      RENDER_URL + '/hotfixes/warmup-meter.js',
      RENDER_URL + '/hotfixes/panel-extras.js?v=4'
    ]
  });
});

router.get('/qr', async (req, res) => {
  const qr = getQR();
  const state = getConnectionState();
  if (state === 'connected') return res.json({ status: 'connected', message: 'Ya conectado' });
  if (state === 'qr_timeout') return res.json({ status: 'qr_timeout', message: 'QR expirado. Presiona Conectar para generar nuevo QR.', attempts: getQrAttempts() });
  if (state === 'reconnecting') return res.json({ status: 'reconnecting', message: 'Reconectando...' });
  if (state === 'connecting') return res.json({ status: 'connecting', message: 'Generando QR...' });
  if (!qr) return res.json({ status: 'waiting', message: 'Esperando QR...', connectionState: state });
  try {
    const qrImage = await QRCode.toDataURL(qr, { width: 300 });
    res.json({ status: 'qr_ready', qr: qrImage, raw: qr, attempt: getQrAttempts() });
  } catch (err) { res.json({ status: 'qr_ready', qr: null, raw: qr, attempt: getQrAttempts() }); }
});

router.get('/chats', async (req, res) => {
  try {
    // Si NINGUN canal esta conectado (ni Baileys ni Cloud API), devolver lista vacia
    const chatState = getConnectionState();
    const hasCloudApi = metaCloudEnabled();
    if (chatState !== 'connected' && chatState !== 'reconnecting' && !hasCloudApi) {
      return res.json({ chats: [], total: 0, source: 'supabase', disconnected: true });
    }
    const limit = parseInt(req.query.limit) || 100;

    // ── Phone number filtering: if an active phone is set, filter by it ──
    const supabaseChats = req.app.get('supabase');
    let activePhone = null;
    if (supabaseChats) {
      try {
        const { data: phoneConfig } = await supabaseChats
          .from('oasis_wa_config')
          .select('system_prompt')
          .eq('id', 'active_phone')
          .single();
        if (phoneConfig?.system_prompt) {
          const parsed = JSON.parse(phoneConfig.system_prompt);
          if (parsed.phone && !parsed.hidden) activePhone = parsed.phone;
        }
      } catch (e) { /* no active phone filter */ }
    }

    let chats;
    if (activePhone && supabaseChats) {
      // Filter chats by phone_number
      const { data, error } = await supabaseChats
        .from('oasis_wa_chats')
        .select('*')
        .eq('phone_number', activePhone)
        .order('last_timestamp', { ascending: false })
        .limit(limit);
      chats = error ? await getChats(limit) : (data || []);
    } else {
      chats = await getChats(limit);
    }
    const enriched = chats.map(chat => {
      const jidNum = (chat.jid || '').replace(/@s\.whatsapp\.net|@g\.us|@c\.us|@lid/g, '');
      const phone = chat.phone || (/^\d{7,}$/.test(jidNum) ? '+' + jidNum : '');
      const contactName = getContactName(chat.jid);
      /* Multi-layer name resolution: prefer real names over phone numbers */
      const isPhoneLike = (s) => s && /^\+?\d[\d\s\-().]{6,}$/.test(s.trim()) && s.replace(/[\s+\-().]/g, '').length >= 7;
      const candidates = [chat.name, chat.push_name, contactName].filter(n => n && !isPhoneLike(n) && !/^s[aá]nate$/i.test(n));
      const displayName = candidates[0] || chat.push_name || contactName || chat.name || '';
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
    /* ── ANTI-FLASH: filtro estable de @lid (no depende de contactCache mutable) ──
     * Reglas:
     * 1. Chats NO-@lid siempre pasan
     * 2. @lid con nombre "Sánate" (self-ref) → siempre oculto
     * 3. @lid con actividad reciente (último mensaje < 7 días) → siempre visible
     * 4. @lid sin nombre Y sin actividad reciente → oculto
     * Esto evita el flash causado por contactCache cargando asíncronamente.
     */
    const _7daysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    const cleaned = enriched.filter(chat => {
      const jid = chat.chatId || '';
      if (!jid.includes('@lid')) return true;

      // Siempre ocultar self-references
      const nm = (chat.pushName || '').trim();
      if (/^s[aá]nate$/i.test(nm)) return false;

      // Si tiene actividad reciente, SIEMPRE mostrar (independiente del nombre)
      const lastTs = chat.lastMessageAt || chat.updatedAt || 0;
      const lastMs = typeof lastTs === 'string' ? new Date(lastTs).getTime() : (lastTs > 1e12 ? lastTs : lastTs * 1000);
      if (lastMs > _7daysAgo) return true;

      // Sin actividad reciente Y sin nombre real → ocultar
      if (!nm || /^\d+$/.test(nm)) return false;
      return true;
    });
    res.json({ chats: cleaned, total: cleaned.length, source: 'supabase' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* Expose in-memory contact names from Baileys (WhatsApp profile names) */
router.get('/contacts/names', (req, res) => {
  const names = {};
  const keys = contactCache.keys();
  keys.forEach(k => {
    const phone = k.replace(/@s\.whatsapp\.net$|@c\.us$/g, '');
    const name = contactCache.get(k);
    if (name && name !== phone && !/^\+?\d[\d\s\-().]{6,}$/.test(name)) {
      names[phone] = name;
    }
  });
  res.json({ names, count: Object.keys(names).length, source: 'baileys-cache' });
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
          // ── ANTI-BAN: proteger envío interactivo con media ──
          const phoneForMeta = chatId.replace(/@s\.whatsapp\.net$/, '').replace(/[^0-9]/g, '');
          const metaBtnLabels = nativeButtons.map(b => {
            try { return JSON.parse(b.buttonParamsJson).display_text; } catch(x) { return 'Opción'; }
          });
          const safeResult = await safeSendInteractive(chatId, {
            label: '[template_pro+media] ' + captionText.substring(0, 30),
            sendFn: async () => {
              try {
                return await sendInteractiveMessageDirect(chatId, {
                  buffer: mediaBuffer, contentType: mediaContentType, mediaType: mType,
                  captionText, footerText: footer || '', nativeButtons
                });
              } catch (relayErr) {
                console.error('[TemplatePro] relayMessage fallo:', relayErr.message);
                const payload = mType === 'video'
                  ? { video: mediaBuffer, caption: captionText, mimetype: mediaContentType, gifPlayback: false, interactiveButtons: nativeButtons }
                  : { image: mediaBuffer, caption: captionText, mimetype: mediaContentType, interactiveButtons: nativeButtons };
                return await sendMessage(chatId, payload);
              }
            },
            metaFallbackFn: metaCloudEnabled() ? async () => {
              // Cloud API: enviar imagen + botones separados
              if (mediaUrl) await sendMetaImage(phoneForMeta, { imageUrl: mediaUrl, caption: captionText });
              return await sendMetaButtons(phoneForMeta, {
                body: mediaUrl ? '↑ Ver imagen' : captionText,
                footer: footer || '',
                buttons: metaBtnLabels.map((l, i) => ({ id: 'btn_' + i, text: l }))
              });
            } : null
          });
          mainResult = safeResult.result;
          btnMethod = safeResult.method === 'meta' ? 'meta_cloud_antiban' : 'relay_interactive';
          if (safeResult.method === 'blocked') {
            // Fallback a texto plano si todo está bloqueado
            const plainPayload = mType === 'video'
              ? { video: mediaBuffer, caption: captionText, mimetype: mediaContentType, gifPlayback: false }
              : { image: mediaBuffer, caption: captionText, mimetype: mediaContentType };
            mainResult = await sendMessage(chatId, plainPayload);
            btnMethod = 'text_fallback_antiban';
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
        // ── ANTI-BAN: proteger envío de solo botones ──
        const phoneForMetaBtn = chatId.replace(/@s\.whatsapp\.net$/, '').replace(/[^0-9]/g, '');
        const metaBtnLabels2 = nativeButtons.map(b => {
          try { return JSON.parse(b.buttonParamsJson).display_text; } catch(x) { return 'Opción'; }
        });
        const safeResult2 = await safeSendInteractive(chatId, {
          label: '[template_pro+btn] ' + captionText.substring(0, 30),
          sendFn: async () => {
            try {
              const r = await sendInteractiveMessageDirect(chatId, {
                buffer: null, captionText, footerText: footer || '', nativeButtons
              });
              console.log('[SBI-server] relay_interactive OK:', captionText.substring(0, 40));
              return r;
            } catch (e) {
              console.warn('[SBI-server] relay falló:', e.message, '— sendmsg_interactive');
              try {
                return await sendMessage(chatId, { text: captionText, footer: footer || '', interactiveButtons: nativeButtons });
              } catch (e2) {
                console.warn('[SBI-server] sendmsg falló:', e2.message, '— legacy buttons');
                const legacyBtnsT = nativeButtons.map((b, i) => {
                  let label = b.buttonParamsJson ? (() => { try { return JSON.parse(b.buttonParamsJson).display_text; } catch(x) { return null; } })() : null;
                  label = label || ('Opcion ' + (i + 1));
                  return { buttonId: b.id || String(i), buttonText: { displayText: label }, type: 1 };
                });
                return await sendMessage(chatId, { text: captionText, buttons: legacyBtnsT, headerType: 1 });
              }
            }
          },
          metaFallbackFn: metaCloudEnabled() ? async () => {
            return await sendMetaButtons(phoneForMetaBtn, {
              body: captionText, footer: footer || '',
              buttons: metaBtnLabels2.map((l, i) => ({ id: 'btn_' + i, text: l }))
            });
          } : null
        });
        mainResult = safeResult2.result;
        btnMethod = safeResult2.method === 'meta' ? 'meta_cloud_antiban' : 'relay_interactive';
        if (safeResult2.method === 'blocked') {
          // Texto plano como último recurso
          mainResult = await sendMessage(chatId, { text: captionText });
          btnMethod = 'text_fallback_antiban';
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

      // ── ANTI-BAN: menú pasa por sendMessage (rate-limited) en vez de sock.sendMessage directo ──
      const menuResult = await sendMessage(chatId, { text: menuText.trim() });
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
      // ── ANTI-BAN: poll pasa por sendMessage (rate-limited) en vez de sock.sendMessage directo ──
      const pollResult = await sendMessage(chatId, {
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
// =============================================
// POST /chats/:chatId/send-media  (enviar media por URL o base64)
// =============================================
router.post('/chats/:chatId/send-media', async (req, res) => {
  try {
    const chatId = decodeURIComponent(req.params.chatId);
    const { mediaUrl, mediaBase64, mimeType, fileName, caption } = req.body;
    const sock = getSocket();
    if (!sock) return res.status(503).json({ error: 'WhatsApp no conectado' });
    const jid = chatId.includes('@') ? chatId : chatId + '@s.whatsapp.net';
    
    let mediaBuffer;
    if (mediaBase64) {
      mediaBuffer = Buffer.from(mediaBase64, 'base64');
    } else if (mediaUrl) {
      const resp = await fetch(mediaUrl);
      if (!resp.ok) return res.status(400).json({ error: 'No se pudo descargar la media' });
      const ab = await resp.arrayBuffer();
      mediaBuffer = Buffer.from(ab);
    } else {
      return res.status(400).json({ error: 'Se requiere mediaUrl o mediaBase64' });
    }
    
    const mime = mimeType || 'image/jpeg';
    const isVideo = mime.startsWith('video/');
    const isAudio = mime.startsWith('audio/');
    const isGif   = mime === 'image/gif';
    
    let msgContent;
    if (isVideo) {
      msgContent = { video: mediaBuffer, mimetype: mime, caption: caption || '', fileName: fileName || 'video.mp4' };
    } else if (isAudio) {
      msgContent = { audio: mediaBuffer, mimetype: mime, ptt: false };
    } else {
      msgContent = { image: mediaBuffer, mimetype: mime, caption: caption || '', fileName: fileName || 'imagen.jpg' };
    }
    
    await sock.sendMessage(jid, msgContent);
    res.json({ ok: true, type: isVideo ? 'video' : isAudio ? 'audio' : 'image' });
  } catch (err) {
    console.error('[send-media]', err.message);
    res.status(500).json({ error: err.message });
  }
});

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
              type: 'message',
              data: { chatId: from, messageId: msgId, pushName: contactName, senderName: contactName, text, messageType: msgType, fromMe: false, isGroup: false, timestamp: ts, source: 'meta_cloud' }
            });
          }

          console.log(`[Webhook Meta] Mensaje de ${from} (${msgType}): ${text.substring(0, 60)}`);

          // Trigger auto-reply via Cloud API channel
          if (text && msg.type !== 'reaction') {
            handleIncomingMessage(from, text, contactName, msgId, { channel: 'meta', messageType: msgType })
              .catch(err => console.error('[Webhook Meta] Auto-reply error:', err.message));
          }
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

router.get('/debug-flags', (req, res) => {
  try { res.json(getDebugFlags()); }
  catch (err) { res.json({ error: err.message }); }
});

router.post('/connect', async (req, res) => {
  try {
    // force=true permite reconectar después de desvinculación intencional
    // Solo el click explícito del botón "Conectar" del panel debe enviar force=true
    const force = req.body?.force === true || req.query?.force === 'true';
    const result = await startConnection({ force });
    if (result && result.blocked) {
      return res.json({ success: false, blocked: true, reason: result.reason, message: 'Conexion bloqueada: ' + result.reason });
    }
    res.json({ success: true, message: 'Conexion iniciada - esperando QR' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── FIX 100: Block / Unblock contact ─────────────────────── */
router.post('/block', async (req, res) => {
  try {
    const { phone, action } = req.body; // action = 'block' | 'unblock'
    if (!phone) return res.status(400).json({ error: 'phone requerido' });
    const jid = phone.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
    const sock = getSocket();
    if (!sock) return res.status(503).json({ error: 'WhatsApp no conectado' });
    const blockAction = action === 'unblock' ? 'unblock' : 'block';
    await sock.updateBlockStatus(jid, blockAction);
    // Also update Supabase if available
    const supabase = req.app.get('supabase');
    if (supabase) {
      await supabase.from('oasis_wa_chats')
        .update({ blocked: blockAction === 'block', archived: true })
        .eq('phone', phone.replace(/[^0-9]/g, ''));
    }
    res.json({ success: true, jid, action: blockAction });
  } catch (err) {
    console.error('[BLOCK]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── FIX 100: Archive chat via API ─────────────────────────── */
router.post('/archive', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone requerido' });
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    const supabase = req.app.get('supabase');
    if (!supabase) return res.status(503).json({ error: 'Supabase no configurado' });
    const { error } = await supabase.from('oasis_wa_chats')
      .update({ archived: true })
      .eq('phone', cleanPhone);
    if (error) throw error;
    res.json({ success: true, phone: cleanPhone, action: 'archived' });
  } catch (err) {
    console.error('[ARCHIVE]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── FIX 100: Delete chat from Supabase ───────────────────── */
router.post('/delete-chat', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone requerido' });
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    const supabase = req.app.get('supabase');
    if (!supabase) return res.status(503).json({ error: 'Supabase no configurado' });
    // Delete messages first, then chat
    await supabase.from('oasis_wa_messages').delete().eq('chat_phone', cleanPhone);
    const { error } = await supabase.from('oasis_wa_chats').delete().eq('phone', cleanPhone);
    if (error) throw error;
    res.json({ success: true, phone: cleanPhone, action: 'deleted' });
  } catch (err) {
    console.error('[DELETE-CHAT]', err.message);
    res.status(500).json({ error: err.message });
  }
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
// GET /warmup-stats — Estadísticas de calentamiento del número
// =============================================
router.get('/warmup-stats', async (req, res) => {
  try {
    const antiban = getAntiBan();
    let warmupData = { day: 0, score: 0, risk: 'unknown', dailySent: 0, dailyLimit: 800 };

    if (antiban && antiban.getStats) {
      const stats = antiban.getStats();
      warmupData.day = stats.warmUp?.day || 0;
      warmupData.score = stats.health?.score || 0;
      warmupData.risk = stats.health?.risk || 'unknown';
      warmupData.dailySent = stats.counters?.today || 0;
      warmupData.dailyLimit = stats.warmUp?.currentDayLimit || 800;
      warmupData.perMinute = stats.counters?.perMinute || 0;
      warmupData.perHour = stats.counters?.perHour || 0;
    }

    // Calcular score de calentamiento (0-100%)
    // Factores: días activos (max 14), mensajes enviados, ratio respuestas
    const dayScore = Math.min(warmupData.day / 14, 1) * 40; // 40% del score
    const usageScore = warmupData.dailySent > 0 ? Math.min(warmupData.dailySent / 100, 1) * 30 : 0; // 30%
    const healthScore = warmupData.risk === 'low' ? 30 : warmupData.risk === 'medium' ? 15 : warmupData.risk === 'high' ? 0 : 10; // 30%
    warmupData.warmthPercent = Math.round(dayScore + usageScore + healthScore);

    // Recomendaciones basadas en el estado
    if (warmupData.day < 3) {
      warmupData.recommendation = 'Número muy nuevo. Solo responder mensajes entrantes. NO hacer difusiones.';
      warmupData.canBroadcast = false;
    } else if (warmupData.day < 7) {
      warmupData.recommendation = 'Período de calentamiento. Máximo 20-50 mensajes/día. Difusiones pequeñas (<10 contactos).';
      warmupData.canBroadcast = false;
    } else if (warmupData.day < 14) {
      warmupData.recommendation = 'Número calentando bien. Puedes hacer difusiones pequeñas (10-30 contactos) con intervalos de 30+ min.';
      warmupData.canBroadcast = true;
      warmupData.maxBroadcast = 30;
    } else {
      warmupData.recommendation = 'Número maduro. Difusiones normales permitidas. Respetar límites anti-ban.';
      warmupData.canBroadcast = true;
      warmupData.maxBroadcast = Math.min(200, warmupData.dailyLimit - warmupData.dailySent);
    }

    // Estado de conexión
    warmupData.connected = getConnectionState() === 'connected';
    warmupData.uptime = Math.floor(process.uptime());

    res.json(warmupData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// =============================================
// GET /templates — Lee plantillas desde Supabase
// =============================================
router.get('/templates', async (req, res) => {
  try {
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
    );
    const { data, error } = await supabase
      .from('oasis_wa_config')
      .select('system_prompt')
      .eq('id', 'wa_templates')
      .single();
    if (error || !data) return res.json([]);
    const templates = JSON.parse(data.system_prompt || '[]');
    res.json(templates);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// POST /templates — Guarda/actualiza plantillas
// =============================================
router.post('/templates', async (req, res) => {
  try {
    const templates = req.body;
    if (!Array.isArray(templates)) return res.status(400).json({ error: 'Se esperaba un array' });
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
    );
    const { error } = await supabase
      .from('oasis_wa_config')
      .upsert({ id: 'wa_templates', system_prompt: JSON.stringify(templates) });
    if (error) throw error;
    res.json({ ok: true, count: templates.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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


// POST /send-interactive — Enviar mensaje interactivo con botones/listas via baileys_helper
router.post('/send-interactive', async (req, res) => {
  try {
    const { to, text, footer, buttons, type } = req.body;
    if (!to) return res.status(400).json({ error: 'Falta "to" (número de teléfono)' });
    const cleanTo = to.replace(/[^0-9]/g, '');
    const jid = cleanTo + '@s.whatsapp.net';
    const sock = getSocket();
    if (!sock) return res.status(503).json({ error: 'Socket no disponible' });

    const helper = getBaileysHelper();
    if (!helper.sendInteractiveMessage) {
      return res.status(503).json({ error: 'baileys_helper no disponible — instalar baileys_helpers' });
    }

    let interactiveButtons = [];

    if (type === 'list' && req.body.sections) {
      // Lista tipo single_select
      interactiveButtons = [{
        name: 'single_select',
        buttonParamsJson: JSON.stringify({
          title: req.body.buttonText || 'Ver opciones',
          sections: req.body.sections
        })
      }];
    } else if (buttons && Array.isArray(buttons)) {
      // Botones: soporta formato simple {id, text} y avanzado {name, buttonParamsJson}
      interactiveButtons = buttons.map(btn => {
        if (btn.name && btn.buttonParamsJson) return btn;
        if (btn.id && btn.text) {
          return { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: btn.text, id: btn.id }) };
        }
        if (btn.url) {
          return { name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: btn.text || btn.label || 'Abrir', url: btn.url }) };
        }
        if (btn.call || btn.phone) {
          return { name: 'cta_call', buttonParamsJson: JSON.stringify({ display_text: btn.text || 'Llamar', phone_number: btn.call || btn.phone }) };
        }
        if (btn.copy) {
          return { name: 'cta_copy', buttonParamsJson: JSON.stringify({ display_text: btn.text || 'Copiar', copy_code: btn.copy }) };
        }
        return { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: btn.text || btn.label || 'Opción', id: btn.id || 'btn_' + Math.random().toString(36).slice(2,6) }) };
      });
    }

    if (interactiveButtons.length === 0) {
      return res.status(400).json({ error: 'No se encontraron botones válidos' });
    }

    console.log('[send-interactive] Enviando a:', jid, '| botones:', interactiveButtons.length, '| texto:', (text || '').substring(0, 50));

    // ── ANTI-BAN: proteger envío interactivo directo con todas las capas ──
    const btnLabelsForMeta = interactiveButtons.filter(b => b.name === 'quick_reply').map(b => {
      try { return JSON.parse(b.buttonParamsJson).display_text; } catch(x) { return 'Opción'; }
    });
    const safeInteractive = await safeSendInteractive(jid, {
      label: '[send-interactive] ' + (text || '').substring(0, 30),
      sendFn: async () => {
        return await helper.sendInteractiveMessage(sock, jid, {
          text: text || '', footer: footer || '', interactiveButtons
        });
      },
      metaFallbackFn: (metaCloudEnabled() && btnLabelsForMeta.length > 0) ? async () => {
        return await sendMetaButtons(cleanTo, {
          body: text || '', footer: footer || '',
          buttons: btnLabelsForMeta.map((l, i) => ({ id: 'btn_' + i, text: l }))
        });
      } : null
    });

    const result = safeInteractive.result;
    const msgId = result?.key?.id;
    console.log('[send-interactive] OK msgId:', msgId, '| method:', safeInteractive.method);

    // Guardar en historial
    const chatName = getContactName(cleanTo) || cleanTo;
    saveMessage(cleanTo, chatName, { messageId: msgId, fromMe: true, text: '[interactive] ' + (text || '').substring(0, 50), type: 'interactive', timestamp: Date.now() }).catch(() => {});
    upsertChat(cleanTo, chatName, '[interactive] ' + (text || '').substring(0, 50), Date.now()).catch(() => {});

    res.json({ ok: true, messageId: msgId, method: safeInteractive.method, buttonsCount: interactiveButtons.length, antiban: safeInteractive.antiban });
  } catch (e) {
    console.error('[send-interactive] Error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /trigger-reply — Bot forzado a responder al último mensaje del cliente
router.post('/trigger-reply', async (req, res) => {
  try {
    const { jid, messageText, pushName, isAudioMessage } = req.body;
    if (!jid || !messageText) return res.status(400).json({ error: 'jid y messageText requeridos' });
    const msgId = 'trigger-' + Date.now();
    handleIncomingMessage(jid, messageText, pushName || 'Cliente', msgId, { isAudioMessage: !!isAudioMessage })
      .catch(e => console.error('[trigger-reply] error:', e.message));
    res.json({ ok: true, jid, msgId });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /subscribe-presence — Suscribirse a presencia de un contacto para typing indicators
router.post('/subscribe-presence', async (req, res) => {
  try {
    const { jid } = req.body || {};
    if (!jid) return res.status(400).json({ error: 'jid requerido' });
    const sock = getSocket();
    if (!sock) return res.status(503).json({ error: 'WhatsApp no conectado' });
    await sock.presenceSubscribe(jid);
    // Also subscribe to @lid variant if applicable
    const num = jid.replace(/[^0-9]/g, '');
    if (jid.endsWith('@s.whatsapp.net')) {
      try { await sock.presenceSubscribe(num + '@lid'); } catch(e) {}
    }
    res.json({ success: true, subscribed: jid });
  } catch (err) {
    console.error('[subscribe-presence]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// AUDIO TTS SETTINGS
// =============================================

// GET /audio-settings — Devuelve configuración de audio + estadísticas de uso
router.get('/audio-settings', (req, res) => {
  try {
    res.json(getAudioSettings());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /audio-settings — Guarda configuración de audio en Supabase
router.post('/audio-settings', async (req, res) => {
  try {
    const { voice, maxAudiosPerConvo, respondWithAudio } = req.body;
    const settings = {};
    if (voice !== undefined) settings.voice = voice;
    if (maxAudiosPerConvo !== undefined) settings.maxAudiosPerConvo = Math.max(1, parseInt(maxAudiosPerConvo) || 1);
    if (respondWithAudio !== undefined) settings.respondWithAudio = !!respondWithAudio;

    await saveAudioSettings(settings);
    res.json({ ok: true, settings: getAudioSettings() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /voice-preview — Generate a TTS preview (returns base64 audio, does NOT send via WhatsApp)
router.post('/voice-preview', async (req, res) => {
  try {
    const { voice } = req.body;
    if (!voice) return res.status(400).json({ ok: false, error: 'voice parameter required' });
    const result = await generateVoicePreview(voice);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[voice-preview] Error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /audio-test — Envía un audio de prueba al número configurado via WhatsApp
router.post('/audio-test', async (req, res) => {
  try {
    const { text, to } = req.body;
    // Send to configured test number or provided target
    const targetJid = to
      ? to.replace(/[^0-9]/g, '') + '@s.whatsapp.net'
      : (process.env.TEST_PHONE || '573227461878') + '@s.whatsapp.net';

    const result = await sendAudioTest(targetJid, text);
    res.json({ ok: true, ...result, target: targetJid });
  } catch (err) {
    console.error('[audio-test] Error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /test-transfer — Envía una transferencia de prueba al receptor configurado
router.post('/test-transfer', async (req, res) => {
  try {
    const sock = getSocket();
    if (!sock) return res.status(503).json({ ok: false, error: 'WhatsApp no conectado' });

    const sb = getSupabase();
    if (!sb) return res.status(503).json({ ok: false, error: 'Supabase no inicializado' });
    const { data: cfgRows, error: cfgErr } = await sb
      .from('oasis_wa_config')
      .select('transfer_wa_receptor, transfer_enabled')
      .eq('id', 'default')
      .limit(1);
    if (cfgErr) throw new Error('Error leyendo config: ' + cfgErr.message);
    const cfg = cfgRows && cfgRows[0];
    if (!cfg || !cfg.transfer_wa_receptor) return res.status(400).json({ ok: false, error: 'No hay receptor configurado' });

    const receptorNum = cfg.transfer_wa_receptor.replace(/\D/g, '');
    const rJid = receptorNum + '@s.whatsapp.net';

    // 1. INSERT test transfer into DB so buttons can find it
    const testOrder = '1x Combo Sánate Premium + 2x Jabón Cúrcuma';
    const testTotal = 185000;
    const { data: inserted, error: insertErr } = await sb
      .from('oasis_wa_transfers')
      .insert({
        chat_jid: rJid,
        phone: '3001234567',
        push_name: 'Cliente Test',
        image_url: 'https://sanate.store/logo.png',
        order_summary: testOrder,
        total: testTotal,
        payment_method: 'Bancolombia',
        status: 'pending'
      })
      .select('id')
      .single();
    if (insertErr) throw new Error('Error insertando test transfer: ' + insertErr.message);
    const transferId = inserted.id;
    console.log('[test-transfer] DB record created, id:', transferId);

    // 2. Download test image
    let imgBuffer = null;
    const testImageUrl = 'https://sanate.store/logo.png';
    try {
      const dl = await downloadMediaBuffer(testImageUrl);
      imgBuffer = dl.buffer;
    } catch (imgErr) {
      console.error('[test-transfer] Error descargando imagen:', imgErr.message);
    }

    // 3. Build review text + buttons
    const reviewText =
      '🔔 NUEVO PANTALLAZO DE PAGO\n\n' +
      '👤 Cliente: Cliente Test (3001234567)\n' +
      '📋 Pedido: ' + testOrder + '\n' +
      '💰 Total: $' + testTotal.toLocaleString('es-CO') + '\n' +
      '🏦 Método: Bancolombia\n\n' +
      '⚠️ ESTO ES UNA PRUEBA desde el panel';

    const nativeButtons = [
      { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: '✅ Confirmado', id: 'transfer_approve_' + transferId }) },
      { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: '⚠️ Posible estafa', id: 'transfer_fraud_' + transferId }) },
      { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: '🚫 Bloquear', id: 'transfer_block_' + transferId }) }
    ];

    // 4. Send SINGLE message: image header + text + buttons
    let buttonsSent = false;
    try {
      await sendInteractiveMessageDirect(rJid, {
        buffer: imgBuffer,
        contentType: 'image/png',
        mediaType: 'image',
        captionText: reviewText,
        footerText: 'Sánate Bot • Verificación de pago',
        nativeButtons: nativeButtons
      });
      buttonsSent = true;
      console.log('[test-transfer] Mensaje con imagen+botones enviado OK');
    } catch (btnErr) {
      console.error('[test-transfer] Error enviando imagen+botones:', btnErr.message);
      // Fallback: try buttons without image
      try {
        await sendInteractiveMessageDirect(rJid, {
          captionText: reviewText,
          footerText: 'Sánate Bot • Verificación de pago',
          nativeButtons: nativeButtons
        });
        buttonsSent = true;
        console.log('[test-transfer] Botones sin imagen enviados OK');
      } catch (btnErr2) {
        console.error('[test-transfer] Error enviando botones:', btnErr2.message);
      }
    }

    // Fallback texto si botones fallan
    if (!buttonsSent) {
      if (imgBuffer) {
        await sock.sendMessage(rJid, { image: imgBuffer, caption: 'Comprobante de Cliente Test (3001234567)', mimetype: 'image/png' });
      }
      const fallback = reviewText + '\n\nResponde con el número:\n1️⃣ Confirmado\n2️⃣ Posible estafa\n3️⃣ Bloquear';
      await sock.sendMessage(rJid, { text: fallback });
    }

    res.json({ ok: true, buttonsSent, receptor: receptorNum, transferId });
  } catch (err) {
    console.error('[test-transfer] Error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// =============================================
// SCHEDULE / HORARIOS — Horario de operación del bot
// =============================================

const DEFAULT_SCHEDULE = {
  enabled: false,
  timezone: 'America/Bogota',
  days: {
    mon: { active: true, start: '08:00', end: '18:00' },
    tue: { active: true, start: '08:00', end: '18:00' },
    wed: { active: true, start: '08:00', end: '18:00' },
    thu: { active: true, start: '08:00', end: '18:00' },
    fri: { active: true, start: '08:00', end: '18:00' },
    sat: { active: true, start: '09:00', end: '14:00' },
    sun: { active: false, start: '00:00', end: '00:00' }
  }
};

// GET /schedule — Returns current bot schedule
router.get('/schedule', async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    if (!supabase) return res.json(DEFAULT_SCHEDULE);
    const { data, error } = await supabase
      .from('oasis_wa_config')
      .select('system_prompt')
      .eq('id', 'bot_schedule')
      .single();
    if (error || !data || !data.system_prompt) return res.json(DEFAULT_SCHEDULE);
    const schedule = JSON.parse(data.system_prompt);
    res.json(schedule);
  } catch (err) {
    console.error('[schedule GET]', err.message);
    res.json(DEFAULT_SCHEDULE);
  }
});

// POST /schedule — Saves schedule config
router.post('/schedule', async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    if (!supabase) return res.status(503).json({ error: 'Supabase no disponible' });
    const schedule = req.body;
    if (!schedule || typeof schedule !== 'object') {
      return res.status(400).json({ error: 'Se esperaba un objeto de horario válido' });
    }
    const { error } = await supabase
      .from('oasis_wa_config')
      .upsert({ id: 'bot_schedule', system_prompt: JSON.stringify(schedule) });
    if (error) throw error;
    invalidateScheduleCache(); // Force reload on next message check
    console.log('[schedule POST] Horario guardado:', schedule.enabled ? 'ACTIVO' : 'DESACTIVADO');
    res.json({ ok: true, schedule });
  } catch (err) {
    console.error('[schedule POST]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// BACKUP — Snapshots de datos al cambiar de número
// =============================================

// POST /backup/create — Create backup snapshot when WhatsApp disconnects
router.post('/backup/create', async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    if (!supabase) return res.status(503).json({ error: 'Supabase no disponible' });

    // Get connected phone number
    const sock = getSocket();
    const rawPhoneId = sock?.user?.id || '';
    const phoneNumber = rawPhoneId.replace(/:.*$/, '').replace(/@s\.whatsapp\.net$/, '').replace(/[^0-9]/g, '');
    if (!phoneNumber) return res.status(400).json({ error: 'No hay número de teléfono conectado' });

    // Count chats
    const { count: chatsCount, error: chatsErr } = await supabase
      .from('oasis_wa_chats')
      .select('*', { count: 'exact', head: true });
    if (chatsErr) throw chatsErr;

    // Count messages
    const { count: messagesCount, error: msgsErr } = await supabase
      .from('oasis_wa_messages')
      .select('*', { count: 'exact', head: true });
    if (msgsErr) throw msgsErr;

    // Create backup record
    const { data: backup, error: backupErr } = await supabase
      .from('oasis_wa_backups')
      .insert({
        phone_number: phoneNumber,
        backup_date: new Date().toISOString(),
        chats_count: chatsCount || 0,
        messages_count: messagesCount || 0,
        status: 'active'
      })
      .select()
      .single();
    if (backupErr) throw backupErr;

    // Tag all existing chats with this phone number
    const { error: tagChatsErr } = await supabase
      .from('oasis_wa_chats')
      .update({ phone_number: phoneNumber })
      .is('phone_number', null);
    if (tagChatsErr) console.error('[backup] Error tagging chats:', tagChatsErr.message);

    // Tag all existing messages with this phone number
    const { error: tagMsgsErr } = await supabase
      .from('oasis_wa_messages')
      .update({ phone_number: phoneNumber })
      .is('phone_number', null);
    if (tagMsgsErr) console.error('[backup] Error tagging messages:', tagMsgsErr.message);

    console.log(`[backup] Created backup for ${phoneNumber}: ${chatsCount} chats, ${messagesCount} messages`);
    res.json({
      ok: true,
      backup: {
        id: backup.id,
        phone_number: phoneNumber,
        chats_count: chatsCount || 0,
        messages_count: messagesCount || 0,
        backup_date: backup.backup_date
      }
    });
  } catch (err) {
    console.error('[backup/create]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /backup/list — Returns all backups
router.get('/backup/list', async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    if (!supabase) return res.status(503).json({ error: 'Supabase no disponible' });
    const { data, error } = await supabase
      .from('oasis_wa_backups')
      .select('*')
      .order('backup_date', { ascending: false });
    if (error) throw error;
    res.json({ ok: true, backups: data || [] });
  } catch (err) {
    console.error('[backup/list]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /backup/restore/:phone — Restores data filter for a specific phone number
router.post('/backup/restore/:phone', async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    if (!supabase) return res.status(503).json({ error: 'Supabase no disponible' });
    const phone = req.params.phone.replace(/[^0-9]/g, '');
    if (!phone) return res.status(400).json({ error: 'Número de teléfono inválido' });

    // Set active phone filter in config
    const { error } = await supabase
      .from('oasis_wa_config')
      .upsert({
        id: 'active_phone',
        system_prompt: JSON.stringify({ phone, hidden: false, restored_at: new Date().toISOString() })
      });
    if (error) throw error;

    console.log(`[backup/restore] Active phone set to: ${phone}`);
    res.json({ ok: true, activePhone: phone });
  } catch (err) {
    console.error('[backup/restore]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /backup/hide — Hides all data (for switching numbers)
router.post('/backup/hide', async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    if (!supabase) return res.status(503).json({ error: 'Supabase no disponible' });

    // Set hidden flag — panels will show empty state
    const { error } = await supabase
      .from('oasis_wa_config')
      .upsert({
        id: 'active_phone',
        system_prompt: JSON.stringify({ phone: null, hidden: true, hidden_at: new Date().toISOString() })
      });
    if (error) throw error;

    console.log('[backup/hide] All data hidden');
    res.json({ ok: true, hidden: true });
  } catch (err) {
    console.error('[backup/hide]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /backup/active-phone — Returns the currently active phone number for filtering
router.get('/backup/active-phone', async (req, res) => {
  try {
    const supabase = req.app.get('supabase');
    if (!supabase) return res.json({ activePhone: null, hidden: false });
    const { data, error } = await supabase
      .from('oasis_wa_config')
      .select('system_prompt')
      .eq('id', 'active_phone')
      .single();
    if (error || !data || !data.system_prompt) return res.json({ activePhone: null, hidden: false });
    const config = JSON.parse(data.system_prompt);
    res.json({
      activePhone: config.phone || null,
      hidden: !!config.hidden,
      restoredAt: config.restored_at || null,
      hiddenAt: config.hidden_at || null
    });
  } catch (err) {
    console.error('[backup/active-phone]', err.message);
    res.json({ activePhone: null, hidden: false });
  }
});

module.exports = router;
