/**
 * SANATE Auto-Reply Module v3.0
 * AI-powered auto-reply using Gemini (primary), Claude (fallback), OpenAI (fallback)
 * Config persisted in Supabase oasis_wa_config table
 *
 * v3.0 Changes:
 * - Context-dependent partes (smart splitting based on content type)
 * - Fixed duplicate responses when user sends rapid messages
 * - Better debouncing (5s) with reply lock per chat
 * - Improved system prompt with sales strategy
 * - Better message splitting (no breaking prices/numbers)
 * - Higher maxOutputTokens for detailed product explanations
 */

let supabaseClient = null;
const apiTracker = require('./api-tracker');

// ===== COIN TRACKING — WaZap (verde) =====
// Carga el store_id desde env (mismo que session_locked)
const COIN_STORE_ID = process.env.STORE_ID || '00000000-0000-0000-0000-000000000001';
async function trackWaZapCoin(chatJid) {
  if (!supabaseClient || !chatJid) return;
  try {
    const { data, error } = await supabaseClient.rpc('track_wazap_coin', {
      p_store_id: COIN_STORE_ID,
      p_chat_jid: chatJid
    });
    if (error) console.warn('[CoinTrack] track_wazap_coin error:', error.message);
    else if (data && data.charged) console.log('[CoinTrack] 💚 -1 coin — remaining:', data.remaining_coins);
  } catch (e) { console.warn('[CoinTrack] exception:', e.message); }
}


let sock = null;
let sseManager = null;

// --- Cloud API send function (injected from routes.js when Meta Cloud is configured) ---
let metaSendFn = null;
function setMetaSendFunction(fn) { metaSendFn = fn; }

// --- Anti-ban reference (injected from baileys.js) ---
let getAntiBanFn = null;
function setAntiBanGetter(fn) { getAntiBanFn = fn; }

// --- In-memory config (loaded from Supabase on init) ---
let aiConfig = {
  enabled: false,
  geminiKey: '',
  claudeKey: '',
  openaiKey: '',
  systemPrompt: '',
  contactMap: {},
  botDelay: 12,
  msgMode: 'all',
  useEmojis: true,
  partesCount: 3,
  testWhitelist: [],
  companyContext: '',
  comportamiento: '',
};

// --- Conversation history (in-memory, persists until restart) ---
const chatHistory = new Map();
const MAX_HISTORY = 80;

// --- Dedup & throttle ---
const replyTimers = new Map();
const replyLocks = new Map();
const lastReplyTime = new Map();
const processedReplies = new Set();
const DEBOUNCE_MS = 5000;
const MIN_REPLY_INTERVAL = 5000;
const MAX_PROCESSED = 2000;

// --- Usage stats ---
let usageStats = { totalReplies: 0, geminiCalls: 0, claudeCalls: 0, openaiCalls: 0, errors: 0, lastReply: null };

// ===================== SCHEDULE ENFORCEMENT =====================
// Cache schedule in memory — refreshed every 60s or on POST /schedule

let _scheduleCache = null;
let _scheduleCacheTime = 0;
const SCHEDULE_CACHE_TTL = 60000; // 1 minute

const DAY_MAP = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

async function getSchedule() {
  if (_scheduleCache && Date.now() - _scheduleCacheTime < SCHEDULE_CACHE_TTL) return _scheduleCache;
  try {
    if (!supabaseClient) return null;
    const { data, error } = await supabaseClient
      .from('oasis_wa_config')
      .select('system_prompt')
      .eq('id', 'bot_schedule')
      .single();
    if (error || !data || !data.system_prompt) { _scheduleCache = null; return null; }
    _scheduleCache = JSON.parse(data.system_prompt);
    _scheduleCacheTime = Date.now();
    return _scheduleCache;
  } catch (e) {
    console.error('[Schedule] Error loading:', e.message);
    return null;
  }
}

function invalidateScheduleCache() {
  _scheduleCache = null;
  _scheduleCacheTime = 0;
}

function isWithinScheduleSync(schedule) {
  if (!schedule || !schedule.enabled) return true; // No schedule or disabled = always active
  const tz = schedule.timezone || 'America/Bogota';
  const now = new Date();
  let localStr;
  try { localStr = now.toLocaleString('en-US', { timeZone: tz }); } catch (e) { return true; }
  const local = new Date(localStr);
  const dayKey = DAY_MAP[local.getDay()];
  const dayConfig = schedule.days && schedule.days[dayKey];
  if (!dayConfig || !dayConfig.active) return false; // Day disabled
  const hhmm = String(local.getHours()).padStart(2, '0') + ':' + String(local.getMinutes()).padStart(2, '0');
  return hhmm >= dayConfig.start && hhmm < dayConfig.end;
}

async function isBotWithinSchedule() {
  const schedule = await getSchedule();
  return isWithinScheduleSync(schedule);
}

// ===================== INIT =====================

async function initAutoReply(supabase, socket) {
  supabaseClient = supabase;
  apiTracker.init(supabase).catch(()=>{});
  sock = socket;
  await loadConfigFromSupabase();
  await loadKeywordTemplates();
  console.log('Auto-reply v3.1 inicializado. Enabled:', aiConfig.enabled, '| Prompt length:', (aiConfig.systemPrompt || '').length, '| Templates:', (_keywordTemplates || []).length);
}

function updateSocket(socket) {
  sock = socket;
}

function setSseManager(sse) {
  sseManager = sse;
}

/**
 * botSend — Enviar mensaje de respuesta del bot.
 * Intenta Baileys primero, si no está conectado usa Cloud API.
 * @param {string} chatJid - JID destino (e.g. "573001234567@s.whatsapp.net" o solo "573001234567")
 * @param {object|string} content - Payload de mensaje ({text: '...'} o string)
 * @param {object} opts - Opciones: { channel: 'baileys'|'meta'|'auto' }
 */
// ── ANTI-BAN EXTRA: Circadian rhythm + reply-ratio tracking ──
const _circadianPauseStart = 23; // 11 PM (hora Colombia UTC-5)
const _circadianPauseEnd = 6;    // 6 AM
const _replyRatio = new Map();   // phone → { sent: N, received: N }
const _dailySendCount = { count: 0, date: '' };

function _isCircadianPause() {
  // Colombia = UTC-5
  const now = new Date();
  const colombiaHour = (now.getUTCHours() - 5 + 24) % 24;
  return colombiaHour >= _circadianPauseStart || colombiaHour < _circadianPauseEnd;
}

function _trackReplyRatio(phone, direction) {
  if (!_replyRatio.has(phone)) _replyRatio.set(phone, { sent: 0, received: 0 });
  const r = _replyRatio.get(phone);
  if (direction === 'out') r.sent++;
  else r.received++;
  // Limpiar mapa si crece mucho
  if (_replyRatio.size > 5000) {
    const oldest = [..._replyRatio.entries()].slice(0, 2000);
    oldest.forEach(([k]) => _replyRatio.delete(k));
  }
}

function _isReplyRatioSafe(phone) {
  const r = _replyRatio.get(phone);
  if (!r || r.received === 0) return true; // nuevo contacto, permitir primer reply
  // Si hemos enviado 5+ mensajes sin respuesta, es sospechoso
  if (r.sent > 5 && r.received === 0) return false;
  // Ratio > 3:1 (enviamos 3x más de lo que recibimos) = riesgoso
  if (r.sent / Math.max(r.received, 1) > 3) return false;
  return true;
}

async function botSend(chatJid, content, opts = {}) {
  const channel = opts.channel || 'auto';
  const textPayload = typeof content === 'string' ? { text: content } : content;
  const textForLog = textPayload.text || '[media]';
  const phoneNum = chatJid.replace(/@s\.whatsapp\.net$/, '').replace(/[^0-9]/g, '');

  // ── ANTI-BAN CAPA 1: Ritmo circadiano (no enviar 11pm-6am Colombia) ──
  if (_isCircadianPause() && channel !== 'meta') {
    console.log('[botSend] Pausa circadiana (11pm-6am COL) — forzando Cloud API');
    if (metaSendFn && phoneNum) {
      try {
        await metaSendFn(phoneNum, textForLog);
        return { sent: true, channel: 'meta', antiban: 'circadian-pause' };
      } catch (e) {
        console.error('[botSend] Cloud API circadian falló:', e.message);
      }
    }
    // Si no hay Cloud API, enviar de todos modos pero con warning
    console.warn('[botSend] Circadian: sin Cloud API, enviando por Baileys de noche');
  }

  // ── ANTI-BAN CAPA 2: Reply-ratio check ──
  if (!_isReplyRatioSafe(phoneNum) && channel !== 'meta') {
    console.log('[botSend] Reply-ratio alto para', phoneNum, '— forzando Cloud API');
    if (metaSendFn && phoneNum) {
      try {
        await metaSendFn(phoneNum, textForLog);
        _trackReplyRatio(phoneNum, 'out');
        return { sent: true, channel: 'meta', antiban: 'reply-ratio-high' };
      } catch (e) { /* continuar por Baileys */ }
    }
  }

  // ── ANTI-BAN CAPA 3: Daily send counter ──
  const today = new Date().toISOString().slice(0, 10);
  if (_dailySendCount.date !== today) { _dailySendCount.count = 0; _dailySendCount.date = today; }
  _dailySendCount.count++;

  // ── ANTI-BAN CAPA 4: consultar baileys-antiban antes de enviar via Baileys ──
  const antiban = getAntiBanFn ? getAntiBanFn() : null;
  if (antiban && channel !== 'meta') {
    try {
      const decision = await antiban.beforeSend(chatJid, textForLog);
      if (!decision.allowed) {
        console.log('[botSend] AntiBan bloqueó envío:', decision.reason, '— fallback a Cloud API');
        // Si anti-ban bloquea, forzar Cloud API
        if (metaSendFn && phoneNum) {
          try {
            await metaSendFn(phoneNum, textForLog);
            return { sent: true, channel: 'meta', antiban: 'blocked-baileys' };
          } catch (e) {
            console.error('[botSend] Cloud API fallback falló:', e.message);
            return { sent: false, channel: 'none', antiban: decision.reason };
          }
        }
        return { sent: false, channel: 'none', antiban: decision.reason };
      }
      // Anti-ban permite: esperar el delay recomendado
      if (decision.delayMs > 0) {
        await new Promise(r => setTimeout(r, decision.delayMs));
      }
    } catch (e) {
      // Si anti-ban falla, continuar normal
      console.warn('[botSend] AntiBan check error:', e.message);
    }
  }

  // Try Baileys first (if available and not forced to meta)
  if (channel !== 'meta' && sock) {
    try {
      const waJid = chatJid.includes('@') ? chatJid : chatJid + '@s.whatsapp.net';
      await sock.sendMessage(waJid, textPayload);
      // ── ANTI-BAN: registrar envío exitoso ──
      if (antiban) { try { antiban.afterSend(chatJid, textForLog); } catch(e) {} }
      _trackReplyRatio(phoneNum, 'out');
      // ── COIN: track WaZap conversation (regla 24h)
      trackWaZapCoin(chatJid).catch(()=>{});
      return { sent: true, channel: 'baileys' };
    } catch (e) {
      console.log('[botSend] Baileys falló:', e.message, '— intentando Cloud API...');
      // ── ANTI-BAN: registrar fallo ──
      if (antiban) { try { antiban.afterSendFailed(e.message); } catch(e2) {} }
    }
  }

  // Fallback to Meta Cloud API
  if (metaSendFn && phoneNum) {
    try {
      await metaSendFn(phoneNum, textForLog);
      trackWaZapCoin(chatJid).catch(()=>{});
      return { sent: true, channel: 'meta' };
    } catch (e) {
      console.error('[botSend] Cloud API falló:', e.message);
    }
  }

  // Both failed
  if (!sock && !metaSendFn) {
    console.error('[botSend] No hay canal disponible (ni Baileys ni Cloud API)');
    return { sent: false, channel: 'none' };
  }
  return { sent: false, channel: 'none' };
}

// ===================== CONFIG (Supabase persistence) =====================

async function loadConfigFromSupabase() {
  if (!supabaseClient) return;
  try {
    const { data, error } = await supabaseClient
      .from('oasis_wa_config')
      .select('*')
      .eq('id', 'default')
      .single();
    if (error) throw error;
    if (data) {
      aiConfig.enabled = data.enabled ?? false;
      aiConfig.geminiKey = data.gemini_key || '';
      aiConfig.claudeKey = data.claude_key || '';
      aiConfig.openaiKey = data.openai_key || '';
      aiConfig.systemPrompt = data.system_prompt || '';
      aiConfig.companyContext = data.company_context || '';
      aiConfig.contactMap = data.contact_map || {};
      aiConfig.botDelay = data.bot_delay ?? 3;
      const rawMode = data.msg_mode || 'all';
      aiConfig.msgMode = (rawMode === 'parts') ? 'partes' : rawMode;
      aiConfig.useEmojis = data.use_emojis ?? true;
      aiConfig.partesCount = data.partes_count ?? 3;
      aiConfig.testWhitelist = data.test_whitelist ?? [];
        aiConfig.comportamiento = data.comportamiento || '';
    }
    console.log('Config cargada desde Supabase. Contacts:', Object.keys(aiConfig.contactMap).length);
  } catch (err) {
    console.error('Error cargando config:', err.message);
  }
}

async function saveConfigToSupabase() {
  if (!supabaseClient) return;
  try {
    const { error } = await supabaseClient
      .from('oasis_wa_config')
      .upsert({
        id: 'default',
        enabled: aiConfig.enabled,
        gemini_key: aiConfig.geminiKey,
        claude_key: aiConfig.claudeKey,
        openai_key: aiConfig.openaiKey,
        system_prompt: aiConfig.systemPrompt,
        company_context: aiConfig.companyContext,
        contact_map: aiConfig.contactMap,
        bot_delay: aiConfig.botDelay,
        msg_mode: aiConfig.msgMode,
        use_emojis: aiConfig.useEmojis,
        partes_count: aiConfig.partesCount,
        test_whitelist: aiConfig.testWhitelist,
        comportamiento: aiConfig.comportamiento,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'id' });
    if (error) throw error;
    console.log('Config guardada en Supabase');
  } catch (err) {
    console.error('Error guardando config:', err.message);
  }
}

function getConfig() {
  return { ...aiConfig };
}

function setConfig(updates) {
  if (updates.enabled !== undefined) aiConfig.enabled = updates.enabled;
  if (updates.geminiKey !== undefined) aiConfig.geminiKey = updates.geminiKey;
  if (updates.claudeKey !== undefined) aiConfig.claudeKey = updates.claudeKey;
  if (updates.openaiKey !== undefined) aiConfig.openaiKey = updates.openaiKey;
  if (updates.systemPrompt !== undefined) aiConfig.systemPrompt = updates.systemPrompt;
  if (updates.companyContext !== undefined) aiConfig.companyContext = updates.companyContext;
  if (updates.contactMap !== undefined) aiConfig.contactMap = updates.contactMap;
  if (updates.botDelay !== undefined) aiConfig.botDelay = updates.botDelay;
  if (updates.msgMode !== undefined) aiConfig.msgMode = updates.msgMode;
  if (updates.useEmojis !== undefined) aiConfig.useEmojis = updates.useEmojis;
  if (updates.partesCount !== undefined) aiConfig.partesCount = updates.partesCount;
  if (updates.testWhitelist !== undefined) aiConfig.testWhitelist = updates.testWhitelist;
  if (updates.comportamiento !== undefined) aiConfig.comportamiento = updates.comportamiento;
  saveConfigToSupabase().catch(() => {});
}

function getUsageStats() {
  const today = new Date().toISOString().slice(0,10);
  return { ...usageStats, configLoaded: !!aiConfig.systemPrompt, enabled: aiConfig.enabled, dailyCount: usageStats.dailyDate === today ? usageStats.dailyCount : 0, dailyDate: today, dailyLimit: 250 };
}

// ===================== MESSAGE HANDLER =====================

async function handleIncomingMessage(chatJid, messageText, pushName, messageId, options) {
  options = options || {};
  if (!aiConfig.enabled) return;

  // ── SCHEDULE CHECK: don't respond outside business hours ──
  const withinSchedule = await isBotWithinSchedule();
  if (!withinSchedule) {
    // Outside schedule — silently skip (no response, no templates, no dispatchers)
    return;
  }

  // ── PER-CONTACT IA CHECK: don't respond if ia_enabled is false for this contact ──
  if (supabaseClient) {
    try {
      const { data: _iaRow } = await supabaseClient
        .from('oasis_wa_chats')
        .select('ia_enabled')
        .eq('jid', chatJid)
        .maybeSingle();
      if (_iaRow && _iaRow.ia_enabled === false) {
        console.log('[AI] IA disabled for', chatJid.split('@')[0], '— skipping');
        return;
      }
    } catch(_iae) {}
  }

  // ── ANTI-BAN: track incoming message for reply-ratio ──
  const _inPhone = chatJid.replace(/@s\.whatsapp\.net$/, '').replace(/[^0-9]/g, '');
  if (_inPhone.length >= 7) _trackReplyRatio(_inPhone, 'in');

  if (aiConfig.testWhitelist && aiConfig.testWhitelist.length > 0) {
    const phoneNumber = chatJid.split('@')[0];
    if (!aiConfig.testWhitelist.includes(phoneNumber) && !chatJid.endsWith('@lid')) return;
  }
  if (!messageText || messageText.trim().length === 0) return;
  if (!sock && !metaSendFn) return; // Need at least one send channel

  /* Filtro por contacto â independiente de msgMode:
     Si existe contactMap con entradas, solo responder donde el valor es explicitamente true.
     Esto permite usar msgMode='partes' para el formato SIN desactivar el filtro. */
  const contactMap = aiConfig.contactMap || {};
  const hasContactEntries = Object.values(contactMap).some(v => v === true || v === false);
  if (hasContactEntries) {
    // Hay entradas explicitas â solo responder donde value === true
    if (contactMap[chatJid] !== true) {
      // Buscar por numero (sin @) tambien
      const jidNum = chatJid.replace(/[^0-9]/g, '');
      const matchByNum = Object.keys(contactMap).find(k => k.replace(/[^0-9]/g,'') === jidNum && contactMap[k] === true);
      if (!matchByNum && !chatJid.endsWith('@lid')) return;
    }
  }
  if (contactMap[chatJid] === false) return;

  if (processedReplies.has(messageId)) return;
  processedReplies.add(messageId);
  if (processedReplies.size > MAX_PROCESSED) {
    const first = processedReplies.values().next().value;
    processedReplies.delete(first);
  }

  addToHistory(chatJid, 'user', messageText);

  /* ââ AUTO-ETIQUETA: detectar datos de envÃ­o â "Por Facturar" ââ */
  if (detectarDatosEnvio(messageText)) {
    aplicarEtiquetaChat(chatJid, 'lbl_facturar').catch(() => {});
  }
  /* ââ AUTO-LEAD: detectar intenciÃ³n de compra ââ */
  const leadStage = detectarLead(messageText);
  if (leadStage) {
    actualizarLifecycleStage(chatJid, leadStage).catch(() => {});
  }
  /* ── AUTO-ETIQUETA: "Pausado" cuando dice no gracias / para / stop ── */
  if (leadStage === 'lost') {
    aplicarEtiquetaChat(chatJid, 'lbl_pausado').catch(() => {});
    console.log(`[AutoLabel] 🛑 Cliente ${chatJid} marcado como Pausado — se detiene automatización`);
    /* No enviar más mensajes automáticos a este cliente */
    if (replyTimers.has(chatJid)) { clearTimeout(replyTimers.get(chatJid)); replyTimers.delete(chatJid); }
    return;
  }

  if (replyTimers.has(chatJid)) {
    clearTimeout(replyTimers.get(chatJid));
  }

  // Audio messages: debounce ultra-corto (2s) para respuesta rápida
  // Texto: usa el delay configurado en el panel
  const isAudio = !!(options && options.isAudioMessage);
  const delay = isAudio ? 2000 : (aiConfig.botDelay || 3) * 1000;
  const debounceDelay = isAudio ? 2000 : Math.max(delay, DEBOUNCE_MS);

  replyTimers.set(chatJid, setTimeout(async () => {
    replyTimers.delete(chatJid);
    await processReply(chatJid, pushName, options);
  }, debounceDelay));
}

// ===================== KEYWORD TEMPLATES (bypass AI) =====================
// Plantillas activadas por palabras clave — responden al instante sin gastar IA.
// Configurables desde Supabase (oasis_wa_config.templates) o hardcoded defaults.
// Protección anti-ban: mismos delays y debounce que IA, solo se ahorra la llamada a Gemini.

const _defaultTemplates = [
  {
    id: 'welcome',
    keywords: [/^hola$/i, /^buenas$/i, /^buenos?\s?d[ií]as?$/i, /^buenas?\s?tardes?$/i, /^buenas?\s?noches?$/i, /^hey$/i, /^hi$/i, /^hello$/i, /^saludos$/i],
    onlyFirstMessage: true, // Solo cuando es el PRIMER mensaje del chat (sin historial)
    responses: [
      '¡Hola! 👋 Bienvenido/a a *Sánate* — cosméticos naturales artesanales.\n\n¿En qué te puedo ayudar hoy?\n\n1️⃣ Ver productos y precios\n2️⃣ Conocer nuestros combos\n3️⃣ Consultar sobre envíos\n4️⃣ Hablar con un asesor',
      '¡Hola! 😊 Gracias por escribirnos a *Sánate*.\n\n¿Qué te gustaría saber?\n\n1️⃣ Nuestros productos\n2️⃣ Combos y promociones\n3️⃣ Información de envío\n4️⃣ Asesoría personalizada'
    ]
  },
  {
    id: 'shipping',
    keywords: [/env[ií]o/i, /domicilio/i, /cu[aá]nto.*env[ií]o/i, /hacen\s+env[ií]o/i, /env[ií]an/i, /cuesta.*env[ií]o/i],
    responses: [
      '📦 *Envíos a toda Colombia:*\n\n• Envío estándar: *$12.000 - $15.000* (3-5 días hábiles)\n• Contraentrega disponible en ciudades principales\n• Envío *GRATIS* en compras mayores a $100.000\n\n¿Te gustaría hacer un pedido? 😊'
    ]
  },
  {
    id: 'payment',
    keywords: [/m[eé]todo.*pago/i, /c[oó]mo\s+pag/i, /formas?\s+de\s+pago/i, /nequi/i, /daviplata/i, /transferencia/i, /contra\s*entrega/i],
    responses: [
      '💳 *Métodos de pago:*\n\n• Nequi\n• Daviplata\n• Transferencia bancaria (Bancolombia)\n• Contraentrega (ciudades principales)\n\nTodos nuestros pagos son seguros. ¿Cuál prefieres?'
    ]
  },
  {
    id: 'thanks',
    keywords: [/^gracias$/i, /^muchas\s+gracias$/i, /^grax$/i, /^ty$/i, /^thanks$/i],
    responses: [
      '¡Con mucho gusto! 😊 Si necesitas algo más, aquí estamos. ¡Que tengas un excelente día!',
      '¡De nada! 💚 Cualquier otra pregunta, no dudes en escribirnos.'
    ]
  }
];

// Templates cache (loaded from Supabase or defaults)
let _keywordTemplates = null;

async function loadKeywordTemplates() {
  if (!supabaseClient) { _keywordTemplates = _defaultTemplates; return; }
  try {
    const { data } = await supabaseClient.from('oasis_wa_config')
      .select('templates')
      .eq('id', 'default')
      .single();
    if (data && data.templates && Array.isArray(data.templates) && data.templates.length > 0) {
      // Rebuild regex from stored strings
      _keywordTemplates = data.templates.map(t => ({
        ...t,
        keywords: (t.keywords || []).map(k => typeof k === 'string' ? new RegExp(k, 'i') : k)
      }));
      console.log('[Templates] Loaded', _keywordTemplates.length, 'templates from Supabase');
    } else {
      _keywordTemplates = _defaultTemplates;
      console.log('[Templates] Using', _keywordTemplates.length, 'default templates');
    }
  } catch (e) {
    _keywordTemplates = _defaultTemplates;
    console.log('[Templates] Fallback to defaults:', e.message);
  }
}

function matchKeywordTemplate(messageText, chatJid) {
  if (!_keywordTemplates) _keywordTemplates = _defaultTemplates;
  const text = messageText.trim();
  const history = chatHistory.get(chatJid) || [];
  const isFirstMessage = !history.some(m => (m.role === 'model' || m.role === 'assistant'));

  for (const tpl of _keywordTemplates) {
    // Skip "onlyFirstMessage" templates if bot already replied
    if (tpl.onlyFirstMessage && !isFirstMessage) continue;

    for (const kw of (tpl.keywords || [])) {
      const regex = kw instanceof RegExp ? kw : new RegExp(kw, 'i');
      if (regex.test(text)) {
        // Pick random response for natural variation
        const responses = tpl.responses || [];
        if (responses.length === 0) continue;
        const response = responses[Math.floor(Math.random() * responses.length)];
        console.log('[Template] Matched "' + tpl.id + '" for', chatJid.split('@')[0], '— skipping AI');
        return response;
      }
    }
  }
  return null; // No match — proceed to AI
}

// ===================== GLOBAL SEND QUEUE (anti-ban burst protection) =====================
// Ensures max N concurrent sends across ALL chats to prevent burst patterns
const _globalSendQueue = { active: 0, maxConcurrent: 3, queue: [] };

function _enqueueGlobalSend(fn) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      _globalSendQueue.active++;
      try { resolve(await fn()); } catch (e) { reject(e); }
      finally {
        _globalSendQueue.active--;
        if (_globalSendQueue.queue.length > 0) {
          const next = _globalSendQueue.queue.shift();
          next();
        }
      }
    };
    if (_globalSendQueue.active < _globalSendQueue.maxConcurrent) {
      run();
    } else {
      _globalSendQueue.queue.push(run);
    }
  });
}

// ===================== DAILY SEND LIMIT (hard enforcement) =====================
const DAILY_SEND_LIMIT = 800; // matches baileys-antiban daily cap

function _isDailyLimitReached() {
  const today = new Date().toISOString().slice(0, 10);
  if (_dailySendCount.date !== today) { _dailySendCount.count = 0; _dailySendCount.date = today; }
  return _dailySendCount.count >= DAILY_SEND_LIMIT;
}

// ===================== PROCESS REPLY =====================

async function processReply(chatJid, pushName, options) {
  options = options || {};
  if (replyLocks.get(chatJid)) {
    console.log('Reply locked for', chatJid, '- skipping');
    return;
  }
  replyLocks.set(chatJid, true);

  // ── ANTI-BAN: Hard daily limit ──
  if (_isDailyLimitReached()) {
    console.log('[AntiSpam] Daily limit reached (' + DAILY_SEND_LIMIT + ') — blocking reply to', chatJid.split('@')[0]);
    replyLocks.delete(chatJid);
    return;
  }

  const now = Date.now();
  const lastTime = lastReplyTime.get(chatJid) || 0;
  if (now - lastTime < MIN_REPLY_INTERVAL) {
    console.log('Throttled reply to', chatJid);
    replyLocks.delete(chatJid);
    return;
  }

  let keepTypingInterval = null;
  try {
    // Typing indicator: inmediato + mantener vivo cada 10s mientras la IA procesa
    // (WhatsApp auto-cancela el indicador luego de ~25s si no se renueva)
    try { await sock.sendPresenceUpdate('composing', chatJid); } catch (e) {}
    if (sseManager) sseManager.broadcast({ type: 'bot_typing', data: { chatId: chatJid.split('@')[0], typing: true } });
    keepTypingInterval = setInterval(async () => {
      try { await sock.sendPresenceUpdate('composing', chatJid); } catch (e) {}
    }, 10000);

    let systemPrompt = aiConfig.systemPrompt || 'Eres un asistente de ventas amable para Sanate, tienda de cosmeticos naturales.';

    if (aiConfig.comportamiento) {
    systemPrompt += '\n\n=== COMPORTAMIENTO PERSONALIZADO ===\n' + aiConfig.comportamiento;
  }
  systemPrompt += '\n\nREGLA DE EMOJIS: ' + (aiConfig.useEmojis ? 'Usa MAXIMO 1-2 emojis en TODA tu respuesta, distribuidos naturalmente. NO pongas emoji al final de cada parrafo.' : 'NO uses emojis bajo ninguna circunstancia.');

    systemPrompt += '\n\n=== REGLAS DE CONVERSACION (OBLIGATORIO) ===';
    systemPrompt += '\n1. Lee SIEMPRE el historial completo antes de responder. CONTINUA donde quedo la conversacion.';
    systemPrompt += '\n2. NUNCA repitas el saludo si ya saludaste. Si el cliente vuelve a escribir, retoma el tema directamente.';
    systemPrompt += '\n3. Si el cliente ya dijo su nombre, NO vuelvas a decir "Hola [nombre]" en cada mensaje.';
    systemPrompt += '\n4. Si el cliente pregunta por un producto ESPECIFICO, responde sobre ESE producto. No preguntes "que buscas".';
    systemPrompt += '\n5. VARIA tus expresiones de apertura. PROHIBIDO empezar siempre con "Genial!", "Claro que si!", "Que buena pregunta!". Usa variaciones naturales.';
    systemPrompt += '\n6. NO hagas pregunta de cierre de venta en CADA mensaje. Solo cuando el cliente muestre interes claro.';
    systemPrompt += '\n7. NUNCA repitas una pregunta que ya hiciste antes. Lee el historial.';
    systemPrompt += '\n8. NUNCA hagas listas con guiones (-) ni asteriscos (*) como vinetas de lista.';
    systemPrompt += '\n   USA *negrillas* (asterisco simple) para resaltar palabras clave: precios, nombres de productos, beneficios.';
    systemPrompt += '\n   Ejemplos: "El *Jabon de Avena y Arroz* cuesta *$18.000*" o "Ideal para *manchas* y *acne*".';
    systemPrompt += '\n9. Si no tienes info del producto, di que consultas con el equipo y respondes pronto.';
    systemPrompt += '\n10. Adapta la LONGITUD segun la pregunta: pregunta simple = respuesta corta 1-2 oraciones. Pregunta sobre beneficios = respuesta detallada.';

    if (aiConfig.msgMode === 'partes') {
      const pc = aiConfig.partesCount || 3;
      systemPrompt += '\n\n=== MODO PARTES (INTELIGENTE) ===';
      systemPrompt += '\nTu respuesta se enviara como mensajes separados de WhatsApp.';
      systemPrompt += '\nIMPORTANTE: La cantidad de partes depende del CONTEXTO:';
      systemPrompt += '\n- Saludo, "si", "ok", "gracias", respuestas cortas -> 1 solo parrafo (NO dividir)';
      systemPrompt += '\n- Pregunta simple de precio o confirmacion -> 1-2 parrafos maximo';
      systemPrompt += '\n- Explicacion de beneficios, modo de uso, recomendacion detallada -> hasta ' + pc + ' parrafos';
    systemPrompt += '\n- LISTADO DE OPCIONES/COMBOS/PRODUCTOS -> TODAS las opciones completas (minimo 3), puedes usar MAS parrafos si es necesario para no cortar informacion';
      systemPrompt += '\n- Formulario de datos de envio -> 1 solo parrafo con toda la info';
      systemPrompt += '\nFormato: separa parrafos con DOBLE salto de linea.';
      systemPrompt += '\nCada parrafo debe tener 1-3 oraciones como un mensaje de WhatsApp real.';
      systemPrompt += '\nNUNCA envies un emoji solo como parrafo separado.';
      systemPrompt += '\nNUNCA cortes numeros/precios entre parrafos.';
      systemPrompt += '\nNUNCA dejes una respuesta incompleta. Si listas opciones, SIEMPRE incluye TODAS (minimo 3 opciones de combos cuando el cliente pregunte por un producto).';
      systemPrompt += '\n\n=== PATRON DE CIERRE DE VENTA (OBLIGATORIO) ===';
      systemPrompt += '\nCuando el cliente dice "quiero", "me llevo", "si", elige una opcion o pide hacer pedido:';
      systemPrompt += '\n1. Parrafo 1: Confirma producto + cantidad + precio. Menciona bonus/regalo si aplica.';
      systemPrompt += '\n2. Parrafo 2: Pide o confirma direccion de envio (si la tienes guardada, muestrala y pide confirmacion).';
      systemPrompt += '\n3. Parrafo 3: Confirma total con o sin envio.';
      systemPrompt += '\n4. Parrafo 4: Pregunta metodo de pago: "contra entrega o transferencia?".';
      systemPrompt += '\nNO sigas vendiendo despues de que el cliente eligio. Pasa DIRECTAMENTE a recoger datos.';
      systemPrompt += '\n\n=== COMO PRESENTAR COMBOS/PRECIOS ===';
      systemPrompt += '\nCuando el cliente pregunte por precios o combos:';
      systemPrompt += '\n- Parrafo 1: Pregunta diagnostico (para que zona? manchas o acne? etc)';
      systemPrompt += '\n- Solo si YA tienes contexto: muestra 2-3 combos relevantes, uno por parrafo';
      systemPrompt += '\n- NO listes todos los combos de una sola vez';
      systemPrompt += '\n- Termina con una pregunta de seleccion especifica';
    } else {
      systemPrompt += '\n\nUSO DE EMOJIS (modo completo):';
      systemPrompt += '\n- Usa MAXIMO 1-2 emojis en TODA tu respuesta.';
      systemPrompt += '\n- Si el mensaje es corto o formal, puedes no usar ninguno.';
    }

    systemPrompt += '\n\n=== DIAGNOSTICO OBLIGATORIO ANTES DE RECOMENDAR ===';
    systemPrompt += '\nCuando el cliente pregunta por CUALQUIER producto (jabon, serum, crema, etc):';
    systemPrompt += '\n1. Tu PRIMER mensaje SIEMPRE debe ser una PREGUNTA DIAGNOSTICA sobre:';
    systemPrompt += '\n   - ¿Para qué ZONA del cuerpo? (rostro, axilas, cuerpo, zona íntima, cuero cabelludo)';
    systemPrompt += '\n   - ¿Qué PROBLEMA quiere tratar? (manchas, acné, resequedad, grasa, irritación, oscurecimiento)';
    systemPrompt += '\n   Ejemplo: "¿En qué zona te gustaría usarlo — rostro, axilas, o cuerpo? ¿Y qué te gustaría mejorar: manchas, textura, o hidratación?"';
    systemPrompt += '\n2. NUNCA des opciones genéricas tipo "¿cuál te gustaría más?" sin antes preguntar la zona y el problema.';
    systemPrompt += '\n3. DESPUÉS del diagnóstico, da el MODO DE USO específico para esa zona y problema.';
    systemPrompt += '\n4. Solo ENTONCES ofrece complementos o combos relevantes a su caso.';
    systemPrompt += '\nSi el cliente YA dijo la zona o el problema (en este mensaje o en el historial), sáltate la pregunta y ve directo a la recomendación personalizada con modo de uso.';

    systemPrompt += '\n\n=== ESTRATEGIA DE VENTA CONSULTIVA ===';
    systemPrompt += '\n- FASE 1 (mensajes 1-3): Descubrir necesidad real. Hacer preguntas que revelen el problema/deseo del cliente.';
    systemPrompt += '\n- FASE 2 (mensajes 4-6): Presentar solucion personalizada con beneficios especificos para SU caso.';
    systemPrompt += '\n- FASE 3 (mensaje 7+): Resolver objeciones + ofrecer cierre SUAVE con alternativas.';
    systemPrompt += '\n- Usa la TECNICA ESPEJO: repite las palabras del cliente para validar.';
    systemPrompt += '\n- CIERRE POR ALTERNATIVA: "Te gustaria el individual o el combo con mas ahorro?" (no ultimatums).';
    systemPrompt += '\n- Si el cliente dice "si" o muestra interes, pasa DIRECTO a pedir datos de envio. No sigas vendiendo.';
    systemPrompt += '\n- Si el cliente pregunta precios de mas unidades, CALCULA el precio real. Si no lo sabes, di que consultas.';

    systemPrompt += '\n\n=== FORMATO DE OPCIONES NUMERADAS (OBLIGATORIO) ===';
    systemPrompt += '\nCuando presentes opciones numeradas:';
    systemPrompt += '\n- USA el formato: 1️⃣ Nombre del producto — $precio';
    systemPrompt += '\n- NUNCA repitas el emoji del numero dentro del texto. MAL: "1️⃣ El combo 1️⃣". BIEN: "1️⃣ El combo"';
    systemPrompt += '\n- NUNCA pongas el numero de nuevo después del emoji. MAL: "1️⃣ 1. Combo". BIEN: "1️⃣ Combo"';
    systemPrompt += '\n- Cada opcion va en su PROPIO parrafo separado por doble salto de linea.';

    systemPrompt += '\n\n=== SELECCION NUMERICA (CRITICO — LEE CON CUIDADO) ===';
    systemPrompt += '\nCuando el cliente envie CUALQUIERA de estas respuestas: "1", "2", "3", "4", "5", "el 1", "el 2", "la 1", "la primera", "la segunda", "opcion 1", "opcion 2", "combo 1", "combo 2", o SOLO un numero:';
    systemPrompt += '\n1. BUSCA en el historial TU ULTIMO mensaje donde presentaste opciones numeradas (1️⃣, 2️⃣, 3️⃣ o "1.", "2.", "3.").';
    systemPrompt += '\n2. IDENTIFICA exactamente que producto/combo corresponde al numero que el cliente eligio.';
    systemPrompt += '\n3. CONFIRMA el producto CORRECTO con su nombre y precio EXACTO del historial.';
    systemPrompt += '\n4. NUNCA asumas que "el 2" es el primer combo o el mas popular. ES LITERALMENTE la opcion numero 2 de TU lista.';
    systemPrompt += '\n5. NUNCA digas "no entendi" o "cual opcion?" cuando el cliente envia un numero. Si envio "1", "2" o "3", ES una seleccion.';
    systemPrompt += '\n6. Si el cliente envia SOLO un numero (ejemplo: "1"), eso SIEMPRE significa que eligio esa opcion de tu lista anterior.';
    systemPrompt += '\nEjemplo: Si presentaste 1️⃣ Secreto Japones $89.900, 2️⃣ Duo Curcuma $66.000, 3️⃣ Tripack $66.000';
    systemPrompt += '\nY el cliente dice "2" o "el 2" -> DEBES confirmar el Duo Curcuma a $66.000, NO el Secreto Japones.';
    systemPrompt += '\nSi el cliente dice "1" -> confirmar Secreto Japones $89.900.';
    systemPrompt += '\nSi no encuentras opciones numeradas en el historial reciente, pregunta: "¿Cual de las opciones que te mostre?"';

    if (pushName) {
      systemPrompt += '\n\nEl nombre del cliente es: ' + pushName + '. Usalo con moderacion (no en cada mensaje).';
    }

    const history = await getHistory(chatJid);

    // ── NUMERIC SELECTION HELPER ──
    // When user sends just a number, find the last bot message with options and inject explicit context
    {
      const userText = (history.filter(m => m.role === 'user').slice(-1)[0]?.text || '').trim();
      const numMatch = userText.match(/^(?:el\s+|la\s+|opci[oó]n\s+|combo\s+)?(\d)$/i);
      if (numMatch) {
        const selectedNum = parseInt(numMatch[1]);
        // Find last bot message that had numbered options
        const botMsgs = history.filter(m => m.role === 'model' || m.role === 'assistant');
        for (let bi = botMsgs.length - 1; bi >= 0; bi--) {
          const botText = botMsgs[bi].text || botMsgs[bi].content || '';
          if (/[1-5]️⃣|opci[oó]n\s*\d|\d\.\s/i.test(botText)) {
            systemPrompt += '\n\n=== ALERTA: EL CLIENTE ACABA DE SELECCIONAR LA OPCION ' + selectedNum + ' ===';
            systemPrompt += '\nEl cliente envio "' + userText + '". Esto es una SELECCION NUMERICA.';
            systemPrompt += '\nBusca en tu ultimo mensaje las opciones numeradas y confirma la opcion ' + selectedNum + ' con nombre y precio.';
            systemPrompt += '\nNO digas "no entendi". NO vuelvas a saludar. CONFIRMA el producto elegido y pide datos de envio.';
            break;
          }
        }
      }
    }

    // Anti-saludo repetido: si el bot ya respondio, prohibir nuevo saludo
    {
      const botHasReplied = history.some(m => m.role === 'model' || m.role === 'assistant');
      const lastUserMsg = (history.filter(m => m.role === 'user').slice(-1)[0]?.text || '').toLowerCase().trim();
      const isGreetingMsg = /^(hola|buenas|hey|buenos? dias?|buenas? noches?|buenas? tardes?|saludos|hi|hello)[.!,? ]*$/.test(lastUserMsg);
      if (botHasReplied) {
        systemPrompt += '\n\n=== CONTEXTO CRITICO ===';
        systemPrompt += '\nYA SALUDASTE a este cliente antes. El historial lo confirma.';
        systemPrompt += '\nPROHIBIDO: NO empieces con Hola, Buenos dias, Buenas, Hey ni ninguna variacion de saludo.';
        systemPrompt += '\nRETOMA el tema directamente donde quedo la conversacion.';
        if (isGreetingMsg) {
          systemPrompt += '\nEl cliente escribio un saludo. Responde algo como "Aqui estoy! [retoma el tema]" SIN saludar.';
        }
      }
    }

        if (aiConfig.companyContext) {
      systemPrompt += '\n\n[CONTEXTO DEL NEGOCIO]\n' + aiConfig.companyContext;
    }

    // ── MODO AUDIO: instrucciones para lenguaje hablado ──────────────
    if (options.isAudioMessage) {
      systemPrompt += '\n\n=== MODO AUDIO (NOTA DE VOZ) ===';
      systemPrompt += '\nEl cliente te envió un AUDIO. Tu respuesta se enviará como NOTA DE VOZ + mensajes de texto.';
      systemPrompt += '\nINSTRUCCIONES MODO AUDIO:';
      systemPrompt += '\n- Responde COMPLETO como siempre: producto, beneficios, modo de uso, pregunta de cierre.';
      systemPrompt += '\n- Sigue usando el formato normal: *negritas*, emojis, mensajes separados por \\n\\n.';
      systemPrompt += '\n- EMPIEZA tu respuesta con lo más importante: respuesta directa al cliente + beneficios clave.';
      systemPrompt += '\n- La parte inicial (primeras 5-8 oraciones) se convertirá en nota de voz (~20-30 segundos).';
      systemPrompt += '\n- Los mensajes siguientes se enviarán como texto con formato (negritas, emojis, precios, etc).';
      systemPrompt += '\n- La PREGUNTA DE CIERRE debe ser sobre el síntoma o necesidad específica del cliente.';
      systemPrompt += '\n- NUNCA respondas solo con una pregunta genérica — da información REAL y luego pregunta.';
      systemPrompt += '\n- Ejemplo de inicio bueno: "¡Claro que sí! Tenemos el jabón de avena y es de los más vendidos. Te cuento, este jabón tiene avena coloidal y manteca de karité que nutren la piel en profundidad. Es súper bueno para pieles sensibles con manchas porque la avena calma la irritación y aclara de forma natural. Se usa mañana y noche, lo aplicas en círculos suaves y lo dejas actuar dos minuticos antes de enjuagar."';
    }

    // ââ MEMORIA DEL CLIENTE (desde Supabase) ââ
    // Inyectar contexto previo: direcciÃ³n, sÃ­ntomas, productos de interÃ©s, pedidos
    try {
      const { data: clienteData } = await supabaseClient.from('oasis_wa_chats')
        .select('memoria_ia, historial_pedidos, ciudad, sintomas_piel, productos_interes, push_name')
        .eq('jid', chatJid)
        .single();
      
      if (clienteData) {
        const memParts = [];
        if (clienteData.ciudad) memParts.push(`ð Ciudad: ${clienteData.ciudad}`);
        if (clienteData.sintomas_piel?.length) memParts.push(`ð§´ Problemas de piel: ${clienteData.sintomas_piel.join(', ')}`);
        if (clienteData.productos_interes?.length) memParts.push(`ð Interesado en: ${clienteData.productos_interes.join(', ')}`);
        if (clienteData.historial_pedidos?.length) {
          const ultimo = clienteData.historial_pedidos.slice(-1)[0];
          if (ultimo) memParts.push(`â
 Ãltimo pedido: $${ultimo.precio} el ${ultimo.fecha}`);
        }
        if (clienteData.memoria_ia) memParts.push(clienteData.memoria_ia);
        
        if (memParts.length > 0) {
          systemPrompt += '\n\n[MEMORIA DE ESTE CLIENTE â USA ESTA INFO PARA PERSONALIZAR]\n' + memParts.join('\n');
          systemPrompt += '\nUSA esta informaciÃ³n para personalizar tu respuesta. Si ya conoces su ciudad/direcciÃ³n, NO la vuelvas a pedir.';
        }
      }
    } catch (memErr) {
      // Silenciosamente ignorar si falla la consulta de memoria
    }

    // ── KEYWORD TEMPLATE CHECK (bypass AI to save tokens) ──
    const lastUserMsg = (history.filter(m => m.role === 'user').slice(-1)[0]?.text || '').trim();
    const templateReply = matchKeywordTemplate(lastUserMsg, chatJid);

    let reply = null;
    if (templateReply) {
      reply = templateReply;
      usageStats.templateHits = (usageStats.templateHits || 0) + 1;
      console.log('[Template] Using template reply for', chatJid.split('@')[0], '— AI call skipped');
    }

    if (!reply && aiConfig.geminiKey) {
      reply = await callGemini(systemPrompt, history);
      if (reply) usageStats.geminiCalls++;
    }
    if (!reply && aiConfig.claudeKey) {
      reply = await callClaude(systemPrompt, history);
      if (reply) usageStats.claudeCalls++;
    }
    if (!reply && aiConfig.openaiKey) {
      reply = await callOpenAI(systemPrompt, history);
      if (reply) usageStats.openaiCalls++;
    }

    if (!reply) {
      console.error('No AI provider returned a reply for', chatJid);
      usageStats.errors++;
      replyLocks.delete(chatJid);
      return;
    }

    reply = cleanReply(reply);

    // Strip invisible characters (zero-width spaces, soft hyphens, etc.) and re-check
    reply = reply.replace(/[\u200b\u200c\u200d\u200e\u200f\ufeff\u00ad\u2060\u180e]/g, '').trim();
    if (!reply) {
      console.error('Reply was empty/invisible-only after cleaning for', chatJid);
      usageStats.errors++;
      replyLocks.delete(chatJid);
      return;
    }

    // Si modo audio activo: no enviar texto, solo la nota de voz
    const _audioMod = (() => { try { return require('./audio-tts'); } catch(e) { return null; } })();
    // CRÍTICO: recargar settings ANTES de decidir si saltar texto, para evitar usar cache obsoleto
    if (_audioMod && options.isAudioMessage) {
      await _audioMod.loadAudioSettings().catch(() => {});
    }
    const _aset = _audioMod ? _audioMod.getAudioSettings() : {};
    // FIX: eliminar &&_aset.hasGeminiKey — sendAudioReply verifica la clave internamente (env vars también).
    // Si respondWithAudio=true y el mensaje entrante era audio → SOLO nota de voz, sin duplicar texto.
    const skipTextReply = !!(options.isAudioMessage && _aset.respondWithAudio);

    if (!skipTextReply) {
      // All sends go through global queue to prevent burst patterns
      await _enqueueGlobalSend(async () => {
        if (aiConfig.msgMode === 'partes') {
          const parts = smartSplit(reply, aiConfig.partesCount || 3);

          // Helper: strip invisible chars from a part
          const stripInvisible = (t) => {
            t = t.replace(/[​‌‍‎‏﻿­⁠᠎]/g, '').trim();
            const ac = (t.match(/\*/g) || []).length;
            if (ac % 2 !== 0) {
              if (t.startsWith('*') && !t.startsWith('**')) t = t.slice(1).trim();
              else if (t.endsWith('*') && !t.endsWith('**')) t = t.slice(0, -1).trim();
            }
            return t;
          };
          const sendChannel = options.channel || 'auto';
          if (parts.length === 1) {
            const clean1 = stripInvisible(parts[0]);
            if (clean1.length > 0) {
              const r1 = await botSend(chatJid, { text: clean1 }, { channel: sendChannel });
              console.log('BOT [1 msg] -> ' + chatJid.split('@')[0] + ' via ' + r1.channel + ': ' + clean1.substring(0, 60));
            } else {
              console.log('BOT [1 msg] SKIPPED — empty/invisible reply for ' + chatJid.split('@')[0]);
            }
          } else {
            for (let i = 0; i < parts.length; i++) {
              const partText = stripInvisible(parts[i]);
              if (partText.length === 0) continue;
              try { if (sock) await sock.sendPresenceUpdate('composing', chatJid); } catch(e) {}
              await botSend(chatJid, { text: partText }, { channel: sendChannel });
              if (i < parts.length - 1) {
                const words = partText.split(/\s+/).length;
                const typingDelay = Math.max(1200, Math.min(4000, (words / 180) * 60000));
                await new Promise(r => setTimeout(r, typingDelay));
              }
            }
            console.log('BOT [' + parts.length + ' partes] -> ' + chatJid.split('@')[0]);
          }
        } else {
          try { if (sock) await sock.sendPresenceUpdate('composing', chatJid); } catch(e) {}
          const rp = await botSend(chatJid, { text: reply }, { channel: options.channel || 'auto' });
          console.log('BOT -> ' + chatJid.split('@')[0] + ' via ' + rp.channel + ': ' + reply.substring(0, 80));
        }
      });
    }

    lastReplyTime.set(chatJid, Date.now());
    usageStats.totalReplies++;

    // Audio TTS reply cuando el mensaje entrante era audio
    if (options.isAudioMessage) {
      try {
        const audioTTS = require('./audio-tts');
        // Recargar settings frescos antes de enviar
        await audioTTS.loadAudioSettings().catch(() => {});
        // Limpiar markdown de WhatsApp antes del TTS (asteriscos se leen literalmente)
        let ttsText = reply
          .replace(/\*([^*]+)\*/g, '$1')
          .replace(/_([^_]+)_/g, '$1')
          .replace(/~([^~]+)~/g, '$1')
          .replace(/```[\s\S]*?```/g, '')
          .replace(/\n{3,}/g, '\n\n')
          .trim();

        // ── DURACIÓN AUDIO: 10-30 segundos para respuesta completa ────────────
        // 2.5 palabras/segundo ≈ 150 wpm (ritmo natural hablado)
        // Target: 60-75 palabras = 25-30s de audio con información real
        // El audio debe tener: respuesta + beneficios + modo de uso + cierre
        const clientAudioSecs = options.audioDuration || 0;
        let targetWords;
        if (clientAudioSecs > 0) {
          // Proporcional: audio más largo del cliente = respuesta más larga
          const targetSecs = Math.min(30, Math.max(12, Math.round(clientAudioSecs * 1.5)));
          targetWords = Math.round(targetSecs * 2.5);
          console.log('[AudioTTS] Cliente ' + clientAudioSecs + 's → target ' + targetSecs + 's (' + targetWords + ' palabras)');
        } else {
          targetWords = 75; // ~30s audio con info real de producto
        }

        const _ttsWords = ttsText.split(/\s+/);
        if (_ttsWords.length > targetWords) {
          let _trunc = _ttsWords.slice(0, targetWords).join(' ');
          const _lp = Math.max(_trunc.lastIndexOf('.'), _trunc.lastIndexOf('?'), _trunc.lastIndexOf('!'));
          ttsText = (_lp > _trunc.length * 0.6) ? _trunc.slice(0, _lp + 1) : _trunc + '.';
          console.log('[AudioTTS] Truncado:', _ttsWords.length, '→', ttsText.split(/\s+/).length, 'palabras');
        }

        // Capturar sock en closure para el callback async
        const _sockRef = sock;
        const _replyFull = reply;

        console.log('[AudioTTS] Iniciando TTS para', chatJid.split('@')[0], '| texto:', ttsText.substring(0, 60));
        audioTTS.sendAudioReply(chatJid, ttsText).then(async (sent) => {
          if (sent) {
            console.log('[AudioTTS] ✅ Audio enviado a', chatJid.split('@')[0]);

            // ── TEXTOS DE SEGUIMIENTO DESPUÉS DEL AUDIO (POR PARTES) ────────
            // Enviar el contenido restante (lo que no se habló) como mensajes
            // de texto formateados: beneficios, precios, modo de uso, pregunta
            try {
              const followUps = buildAudioFollowUp(_replyFull, ttsText);
              if (followUps.length > 0) {
                await new Promise(r => setTimeout(r, 2000)); // pausa natural post-audio
                for (let fi = 0; fi < followUps.length; fi++) {
                  let fMsg = followUps[fi];
                  // Fix broken bold markers from split
                  const fc = (fMsg.match(/\*/g) || []).length;
                  if (fc % 2 !== 0) {
                    if (fMsg.startsWith('*') && !fMsg.startsWith('**')) fMsg = fMsg.slice(1).trim();
                    else if (fMsg.endsWith('*') && !fMsg.endsWith('**')) fMsg = fMsg.slice(0, -1).trim();
                  }
                  try { if (_sockRef) await _sockRef.sendPresenceUpdate('composing', chatJid); } catch(e) {}
                  const wc = fMsg.split(/\s+/).length;
                  await new Promise(r => setTimeout(r, Math.max(1000, Math.min(3500, wc * 200))));
                  await botSend(chatJid, { text: fMsg });
                }
                console.log('[AudioTTS] Follow-up:', followUps.length, 'mensaje(s) por partes a', chatJid.split('@')[0]);
              }
            } catch(fe) { console.error('[AudioTTS] Follow-up error:', fe.message); }
            // Botones después de audio + follow-ups
            await sendSmartButtons(_replyFull, chatJid, _sockRef);
          } else {
            console.warn('[AudioTTS] FAIL - no se envio audio a', chatJid.split('@')[0], '(respondWithAudio?', _aset.respondWithAudio, ')');
          }
        }).catch(e => {
          console.error('[AudioTTS] Error enviando audio:', e.message);
        });
      } catch(e) {
        console.error('[AudioTTS] Module error:', e.message);
      }
    }

    // ââ ACTUALIZAR MEMORIA del cliente despuÃ©s de cada respuesta ââ
    // Extraer contexto nuevo de la conversaciÃ³n reciente
    try {
      const historyRaw = await getHistory(chatJid);
      const mensajesParaMem = historyRaw.slice(-20).map(m => ({
        fromMe: m.role === 'assistant',
        text: m.content
      }));
      
      const textoCliente = mensajesParaMem
        .filter(m => !m.fromMe).map(m => m.text).join(' ').toLowerCase();
      
      const updates = {};
      
      // Ciudad
      const ciudadRe = /\b(bogot[aÃ¡]|medell[iÃ­]n|cali|barranquilla|cartagena|armenia|pereira|manizales|bucaramanga|c[uÃº]cuta|ibagu[eÃ©]|neiva|villavicencio|palmira|bello|envigado|soledad|floridablanca)\b/i;
      const ciudadMatch = textoCliente.match(ciudadRe);
      if (ciudadMatch) updates.ciudad = ciudadMatch[1];
      
      // SÃ­ntomas
      const sintomasDetectados = ['acnÃ©','manchas','poros','resequedad','grasa','granitos','cicatriz','sensible','brillo']
        .filter(s => textoCliente.includes(s));
      if (sintomasDetectados.length) updates.sintomas_piel = sintomasDetectados;
      
      // Productos mencionados
      const productosDetectados = ['cÃºrcuma','calÃ©ndula','avena','sebo','melena','polen']
        .filter(p => textoCliente.includes(p));
      if (productosDetectados.length) updates.productos_interes = productosDetectados;
      
      // Pedido confirmado en esta respuesta
      if (reply.toLowerCase().includes('confirmado') && reply.toLowerCase().includes('pedido')) {
        const precioM = reply.match(/\$([\d\.]+)/);
        if (precioM) {
          const { data: cd } = await supabaseClient.from('oasis_wa_chats')
            .select('historial_pedidos').eq('jid', chatJid).single();
          const hist = cd?.historial_pedidos || [];
          hist.push({ fecha: new Date().toISOString().slice(0,10), precio: precioM[1], estado: 'confirmado' });
          updates.historial_pedidos = hist;
        }
      }
      
      // Resumen narrativo
      const partesMem = [];
      if (updates.ciudad) partesMem.push(`Ciudad: ${updates.ciudad}`);
      if (updates.sintomas_piel?.length) partesMem.push(`SÃ­ntomas: ${updates.sintomas_piel.join(', ')}`);
      if (updates.productos_interes?.length) partesMem.push(`InterÃ©s: ${updates.productos_interes.join(', ')}`);
      if (partesMem.length > 0) updates.memoria_ia = '[CONTEXTO]\n' + partesMem.join('\n');
      
      if (Object.keys(updates).length > 0) {
        updates.ultima_interaccion = new Date().toISOString();
        await supabaseClient.from('oasis_wa_chats').update(updates).eq('jid', chatJid);
      }
    } catch (memErr) { /* ignorar errores de memoria */ }
    // Daily counter
    const todayDate = new Date().toISOString().slice(0,10);
    if (usageStats.dailyDate !== todayDate) { usageStats.dailyCount = 0; usageStats.dailyDate = todayDate; }
    usageStats.dailyCount++;
    usageStats.lastReply = new Date().toISOString();

    addToHistory(chatJid, 'model', reply);

    // ── TRANSFERENCIA: detectar método de pago y activar modo pantallazo ──
    try {
      const transferMod = require('./transfer-handler');
      const tCfg = transferMod.getConfig();
      if (tCfg.transfer_enabled) {
        // Check if client mentioned payment method in their message
        const clientTexts = history.filter(h => h.role === 'user').map(h => h.parts ? h.parts[0].text : h.content).join(' ');
        const payMethod = transferMod.detectPaymentMethod(clientTexts);
        // Check if the bot's reply confirms a total/pedido
        const replyLower = reply.toLowerCase();
        const totalMatch = reply.match(/\$([\d\.,]+)/);
        const isConfirmation = (replyLower.includes('total') || replyLower.includes('pedido')) && totalMatch;
        if (payMethod && isConfirmation) {
          const total = parseFloat(totalMatch[1].replace(/\./g, '').replace(',', '.'));
          const orderSummary = reply.substring(0, 300);
          transferMod.activateScreenshotMode(chatJid, pushName, orderSummary, total, payMethod).catch(e => console.error('[Transfer] Activate error:', e.message));
        }
      }
    } catch (tErr) { /* transfer module not critical */ }

    // ── BOTONES INTELIGENTES ──
    // Solo enviar aquí si NO es audio (en audio se envían después del follow-up)
    if (!skipTextReply) {
      await sendSmartButtons(reply, chatJid, sock);
    }
    
    // ── FOLLOW-UP: schedule if conversation didn't close a sale ──
    // (placeholder — full follow-up system pending implementation)

    // NO guardar en Supabase aquÃ­ â Baileys ya guarda cada mensaje saliente
    // automÃ¡ticamente via messages.upsert con fromMe=true (baileys.js lÃ­nea ~279).
    // El saveMessage duplicado con ID inventado (bot_TIMESTAMP) causaba N+1 burbujas.

  } catch (err) {
    console.error('Error en processReply:', err.message);
    usageStats.errors++;
  } finally {
    clearInterval(keepTypingInterval);
    try { await sock.sendPresenceUpdate('paused', chatJid); } catch (e) {}
    if (sseManager) sseManager.broadcast({ type: 'bot_typing', data: { chatId: chatJid.split('@')[0], typing: false } });
    replyLocks.delete(chatJid);
  }
}

// ===================== AUTO-ETIQUETAS =====================

/** Detecta si el mensaje del cliente contiene datos de envÃ­o (nombre + direcciÃ³n/ciudad) */
function detectarDatosEnvio(text) {
  if (!text || text.length < 15) return false;
  const lower = text.toLowerCase();
  let hits = 0;

  /* Nombre del destinatario */
  if (/\b(me llamo|soy\s+\w+|nombre[:\s]+|a nombre de|llamar[se]*\s+\w+)\b/i.test(lower)) hits++;
  /* DirecciÃ³n fÃ­sica */
  if (/\b(direcci[oÃ³]n|calle\s+\d|carrera\s+\d|cra\.?\s+\d|avenida|barrio\s+\w|diagonal|transversal|manzana|lote)\b/i.test(lower)) hits++;
  /* Ciudad colombiana */
  if (/\b(bogot[aÃ¡]|medell[iÃ­]n|cali|barranquilla|bucaramanga|cartagena|c[uÃº]cuta|pereira|manizales|armenia|ibagu[eÃ©]|ciudad[:\s]+|municipio[:\s]+)\b/i.test(lower)) hits++;
  /* TelÃ©fono de contacto */
  if (/\b(cel[u]?lar[:\s]*|tel[eÃ©]fono[:\s]*|whats[a]?pp[:\s]*|contacto[:\s]*|3\d{9})\b/i.test(lower)) hits++;
  /* Palabras clave de pedido/envÃ­o */
  if (/\b(env[iÃ­]o|domicilio|entrega|pedido|direcci[oÃ³]n de entrega|contra entrega|para envi[ao]r)\b/i.test(lower)) hits++;

  return hits >= 2; /* Al menos 2 seÃ±ales = datos de envÃ­o */
}

/** Detecta la intenciÃ³n del cliente para actualizar el lead stage */
function detectarLead(text) {
  if (!text || text.length < 5) return null;
  const lower = text.toLowerCase();

  /* Cliente confirmÃ³ compra / pagÃ³ / enviÃ³ datos â cliente */
  if (/\b(ya pagu[eÃ©]|hice el pago|transf[ei]r[eÃ­]|consign[eÃ©]|ya compr[eÃ©]|confirm[oa] el pedido|quiero comprarlo|me lo llevo|lo quiero)\b/i.test(lower)) return 'client';

  /* Cliente enviÃ³ datos de envÃ­o â tambiÃ©n es cliente */
  if (detectarDatosEnvio(text)) return 'client';

  /* Cliente interesado pero no ha comprado */
  if (/\b(cu[aÃ¡]nto cuesta|cu[aÃ¡]nto vale|precio|cu[aÃ¡]nto es|tiene[n]?\s+(el|la|los)|qu[eÃ©]\s+productos|me interesa|info|m[aÃ¡]s informaci[oÃ³]n|d[eÃ©]jame pensar|lo consulto|luego te escribo|m[aÃ¡]s adelante|cuando tenga|si me funciona)\b/i.test(lower)) return 'interested';

  /* Cliente descartado */
  if (/\b(no gracias|no me interesa|est[aÃ¡] muy caro|no tengo plata|no puedo|ya compr[eÃ©] en otro|no lo necesito|no quiero|bl[oÃ³]queame)\b/i.test(lower)) return 'lost';

  return null;
}

/** Actualiza el lifecycle_stage del chat en Supabase */
async function actualizarLifecycleStage(chatJid, stage) {
  try {
    const { getSupabase } = require('./supabase');
    const sb = getSupabase();
    const jid = chatJid.includes('@') ? chatJid.split('@')[0] : chatJid;

    const { data: chat } = await sb.from('oasis_wa_chats').select('jid,lifecycle_stage,lead_status').or(`jid.eq.${jid},jid.eq.${jid}@s.whatsapp.net,jid.eq.${jid}@lid`).limit(1).single();
    if (!chat) return;

    /* Solo subir de categorÃ­a (newâinterestedâclient), nunca bajar */
    const rank = {new:0, interested:1, client:2, lost:1};
    const currentRank = rank[chat.lifecycle_stage] || 0;
    const newRank     = rank[stage] || 0;
    if (newRank <= currentRank && chat.lifecycle_stage !== 'new') return; /* no bajar */

    /* Mapeo lifecycle_stage (EN) -> lead_status (ES) para el panel */
    const leadMap = {new:'nuevo', interested:'potencial', client:'cliente', lost:'perdido'};
    const leadStatus = leadMap[stage] || 'nuevo';

    await sb.from('oasis_wa_chats').update({
      lifecycle_stage: stage,
      lead_status: leadStatus
    }).eq('jid', chat.jid);
    console.log(`[AutoLead] ${jid} â lifecycle_stage="${stage}", lead_status="${leadStatus}"`);
  } catch (e) {
    console.error('[AutoLead] Error:', e.message);
  }
}

/** Aplica una etiqueta al chat en Supabase */
async function aplicarEtiquetaChat(chatJid, labelId) {
  try {
    const { getSupabase } = require('./supabase');
    const sb = getSupabase();
    const jid = chatJid.includes('@') ? chatJid.split('@')[0] : chatJid;

    /* Buscar el chat por JID */
    const { data: chat } = await sb.from('oasis_wa_chats').select('jid,tags').or(`jid.eq.${jid},jid.eq.${jid}@s.whatsapp.net,jid.eq.${jid}@lid`).limit(1).single();
    if (!chat) return;

    const currentTags = Array.isArray(chat.tags) ? chat.tags : (JSON.parse(chat.tags || '[]'));
    if (currentTags.includes(labelId)) return; /* Ya tiene la etiqueta */

    const newTags = [...currentTags, labelId];
    await sb.from('oasis_wa_chats').update({ tags: JSON.stringify(newTags) }).eq('jid', chat.jid);
    console.log(`[AutoLabel] â­ Etiqueta "${labelId}" aplicada a ${jid}`);
  } catch (e) {
    console.error('[AutoLabel] Error:', e.message);
  }
}

// ===================== CONVERSATION HISTORY =====================

function addToHistory(chatJid, role, text) {
  if (!chatHistory.has(chatJid)) chatHistory.set(chatJid, []);
  const hist = chatHistory.get(chatJid);
  hist.push({ role, text, ts: Date.now() });
  if (hist.length > MAX_HISTORY) hist.splice(0, hist.length - MAX_HISTORY);
}

async function getHistory(chatJid) {
  if (chatHistory.has(chatJid) && chatHistory.get(chatJid).length > 0) {
    const hist = chatHistory.get(chatJid);
    const lastTs = hist[hist.length - 1]?.ts || 0;
    if (Date.now() - lastTs < 30 * 60 * 1000) {
      return hist;
    }
    console.log('[history] Stale history for', chatJid, '- reloading from Supabase');
  }

  if (supabaseClient) {
    try {
      const { data } = await supabaseClient
        .from('oasis_wa_messages')
        .select('direction, content, timestamp')
        .eq('chat_jid', chatJid)
        .order('timestamp', { ascending: false })
        .limit(MAX_HISTORY);
      if (data && data.length > 0) {
        const hist = data.reverse().map(m => ({
          role: m.direction === 's' ? 'model' : 'user',
          text: m.content || '',
          ts: new Date(m.timestamp).getTime()
        })).filter(m => m.text.length > 0);
        chatHistory.set(chatJid, hist);
        console.log('[history] Loaded', hist.length, 'msgs from Supabase for', chatJid);
        return hist;
      }
    } catch (e) {
      console.log('[history] Supabase load error:', e.message);
    }
  }
  return [];
}

// ===================== AI PROVIDERS =====================

async function callGemini(systemPrompt, history) {
  try {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + aiConfig.geminiKey;
    const _trackKey = aiConfig.geminiKey;
    const _trackUrl = url;

    /* Consolidate consecutive model/user messages to avoid Gemini confusion */
    const contents = [];
    for (const msg of history) {
      const role = msg.role === 'user' ? 'user' : 'model';
      if (contents.length > 0 && contents[contents.length - 1].role === role) {
        /* Merge with previous message of same role */
        contents[contents.length - 1].parts[0].text += '\n\n' + msg.text;
      } else {
        contents.push({
          role: role,
          parts: [{ text: msg.text }]
        });
      }
    }

    if (contents.length === 0 || contents[contents.length - 1].role !== 'user') return null;

    const body = {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: contents,
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 4000,
        topP: 0.9,
      }
    };

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    try { apiTracker.track(_trackKey, resp.ok, resp.status).catch(()=>{}); } catch(e) {}

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Gemini error ' + resp.status + ':', errText.substring(0, 200));
      return null;
    }

    const data = await resp.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return text || null;
  } catch (err) {
    console.error('Gemini exception:', err.message);
    return null;
  }
}

async function callClaude(systemPrompt, history) {
  try {
    const messages = history.map(msg => ({
      role: msg.role === 'user' ? 'user' : 'assistant',
      content: msg.text,
    }));

    if (messages.length === 0 || messages[messages.length - 1].role !== 'user') return null;

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': aiConfig.claudeKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        system: systemPrompt,
        messages: messages,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Claude error ' + resp.status + ':', errText.substring(0, 200));
      return null;
    }

    const data = await resp.json();
    return data?.content?.[0]?.text || null;
  } catch (err) {
    console.error('Claude exception:', err.message);
    return null;
  }
}

async function callOpenAI(systemPrompt, history) {
  try {
    const messages = [{ role: 'system', content: systemPrompt }];
    for (const msg of history) {
      messages.push({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.text,
      });
    }

    if (history.length === 0) return null;

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + aiConfig.openaiKey,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: messages,
        max_tokens: 4000,
        temperature: 0.7,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('OpenAI error ' + resp.status + ':', errText.substring(0, 200));
      return null;
    }

    const data = await resp.json();
    return data?.choices?.[0]?.message?.content || null;
  } catch (err) {
    console.error('OpenAI exception:', err.message);
    return null;
  }
}

// ===================== SMART SPLIT (Context-Dependent Partes) =====================

function smartSplit(text, maxParts) {
  maxParts = maxParts || 3;
  // Allow more parts for listings with multiple options
  const hasMultipleOptions = /[1-3]|opci[oó]n\s*[1-3]|combo\s*[1-3]|\d+\./i.test(text);
  if (hasMultipleOptions) maxParts = Math.max(maxParts, 8);
  if (!text) return [text];

  if (text.length < 100) return [text];

  // --- Separar pregunta final como mensaje aparte ---
  const lastQuestion = text.match(/[^.!?\n]*\?[^?\n]*$/);
  if (lastQuestion && lastQuestion[0].trim().length > 15 && lastQuestion[0].trim().length < 150) {
    const questionText = lastQuestion[0].trim();
    const withoutQuestion = text.slice(0, text.lastIndexOf(lastQuestion[0])).trim();
    if (withoutQuestion.length > 50) {
      const bodyParts = smartSplit(withoutQuestion, Math.max(1, maxParts - 1));
      return [...bodyParts, questionText];
    }
  }

  const isShortReply = text.length < 150;
  const hasProductList = /\$[\d.,]+/.test(text) && (/combo|opci[oó]n|precio/i.test(text));
  const hasBenefits = /(beneficio|sirve para|ayuda a|mejora|reduce|promueve)/i.test(text);
  const hasFormData = /(nombre|direcci[oó]n|ciudad|m[eé]todo de pago|nequi|bancolombia)/i.test(text);
  const isGreeting = /^[¡!]?(hola|hey|buenos|buenas)/i.test(text.trim());

  let targetParts;
  if (isShortReply) {
    targetParts = 1;
  } else if (isGreeting && text.length < 300) {
    targetParts = 1;
  } else if (hasFormData) {
    targetParts = 1;
  } else if (hasProductList) {
    // Allow product listings to use ALL available parts (not capped at 2)
    const naturalParts = text.split(/\n\n+/).filter(p => p.trim().length > 0);
    targetParts = Math.min(Math.max(naturalParts.length, 3), maxParts);
  } else if (hasBenefits) {
    targetParts = maxParts;
  } else {
    const naturalParts = text.split(/\n\n+/).filter(p => p.trim().length > 0);
    targetParts = Math.min(naturalParts.length, maxParts);
    if (targetParts <= 1) targetParts = text.length > 250 ? 2 : 1;
  }

  // Force split long single-paragraph messages (>300 chars with no \n\n)
  if (targetParts <= 1 && text.length > 300) {
    const naturalParts = text.split(/\n\n+/).filter(p => p.trim().length > 0);
    if (naturalParts.length <= 1) {
      // Split by single newlines as fallback
      const nlParts = text.split(/\n+/).filter(p => p.trim().length > 0);
      if (nlParts.length >= 2) {
        targetParts = Math.min(nlParts.length, maxParts);
      } else {
        // No newlines at all — force sentence-based split
        targetParts = Math.min(3, maxParts);
      }
    }
  }

  if (targetParts <= 1) return [text];

  let parts = text.split(/\n\n+/).filter(p => p.trim().length > 0);

  // If no double-newline splits, try single newlines
  if (parts.length <= 1) {
    parts = text.split(/\n+/).filter(p => p.trim().length > 0);
  }

  if (parts.length >= 2 && parts.length <= targetParts) {
    parts = mergeShortParts(parts);
    return parts.slice(0, targetParts);
  }

  if (parts.length > targetParts) {
    return mergeParts(parts, targetParts);
  }

  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  if (sentences.length <= 1) return [text];

  const perPart = Math.ceil(sentences.length / targetParts);
  parts = [];
  for (let i = 0; i < sentences.length; i += perPart) {
    const chunk = sentences.slice(i, i + perPart).join('').trim();
    if (chunk) parts.push(chunk);
  }

  parts = fixBrokenPrices(parts);
  parts = mergeShortParts(parts);

  return parts.slice(0, targetParts);
}

function mergeShortParts(parts) {
  if (parts.length <= 1) return parts;
  const merged = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i].trim();
    if (p.length < 15) {
      if (merged.length > 0) {
        merged[merged.length - 1] += ' ' + p;
      } else if (i + 1 < parts.length) {
        parts[i + 1] = p + ' ' + parts[i + 1];
      } else {
        merged.push(p);
      }
    } else {
      merged.push(p);
    }
  }
  return merged;
}

function mergeParts(parts, targetCount) {
  if (parts.length <= targetCount) return parts;
  const result = [];
  const perGroup = Math.ceil(parts.length / targetCount);
  for (let i = 0; i < parts.length; i += perGroup) {
    const group = parts.slice(i, i + perGroup).join('\n\n');
    result.push(group);
  }
  return result;
}

function fixBrokenPrices(parts) {
  for (let i = 0; i < parts.length - 1; i++) {
    if (/\$[\d,.]*$/.test(parts[i].trim()) && /^\d/.test(parts[i + 1].trim())) {
      parts[i] = parts[i] + parts[i + 1];
      parts.splice(i + 1, 1);
      i--;
    }
  }
  return parts;
}

function cleanReply(text) {
  if (!text) return '';
  text = text.replace(/\*\*/g, '*');
  text = text.replace(/__/g, '');
  text = text.replace(/\n{3,}/g, '\n\n');
  // Fix duplicate number emojis: "1️⃣ El combo 1️⃣" → "1️⃣ El combo"
  // Also fix "1️⃣ 1. Combo" → "1️⃣ Combo"
  text = text.replace(/([\d]️⃣)\s*(.*?)\s*\1/g, '$1 $2');
  text = text.replace(/([\d]️⃣)\s*\d+[\.\)]\s*/g, '$1 ');
  text = text.trim();
  return text;
}

/* ── Audio follow-up: split remaining text into "por partes" messages ── */
function buildAudioFollowUp(fullReply, ttsText) {
  if (!fullReply || !ttsText) return [];
  const remaining = fullReply.slice(ttsText.length).trim();
  if (!remaining) return [];

  let parts = remaining.split(/\n\n+/).map(p => p.trim()).filter(p => p.length > 0);

  if (parts.length <= 1 && remaining.includes('\n')) {
    parts = remaining.split(/\n+/).map(p => p.trim()).filter(p => p.length > 0);
  }

  if (parts.length <= 1 && remaining.length > 120) {
    const sentences = remaining.match(/[^.!?]+[.!?]+/g) || [remaining];
    parts = [];
    let chunk = '';
    for (const s of sentences) {
      if (chunk.length + s.length > 150 && chunk.length > 0) {
        parts.push(chunk.trim());
        chunk = s;
      } else {
        chunk += s;
      }
    }
    if (chunk.trim()) parts.push(chunk.trim());
  }

  if (parts.length > 5) parts = parts.slice(0, 5);

  console.log('[AudioFollowUp] ' + parts.length + ' mensajes de seguimiento');
  return parts;
}

/* ── sendSmartButtons: envía opciones rápidas después de la respuesta ── */
async function sendSmartButtons(reply, chatJid, sock) {
  try {
    const smartBtns = generateSmartButtons(reply, chatJid);
    if (!smartBtns || !smartBtns.buttons.length || !sock) {
      console.log('[SmartBtns] No buttons generated for', chatJid.split('@')[0]);
      return;
    }
    await new Promise(r => setTimeout(r, 1200));
    
    // Enviar como texto con emojis — funciona siempre en WhatsApp
    const emojis = ['1️⃣', '2️⃣', '3️⃣'];
    const btnText = smartBtns.text + '\n\n' + 
      smartBtns.buttons.map((b, i) => emojis[i] + ' ' + b.label).join('\n');
    
    await botSend(chatJid, { text: btnText });
    console.log('[SmartBtns]', smartBtns.buttons.length, 'opciones ->', chatJid.split('@')[0]);
  } catch (be) { console.log('[SmartBtns] ERROR:', be.message); }
}

/* ── Smart Buttons: genera botones contextuales para avanzar la conversación ── */
function generateSmartButtons(reply, chatJid) {
  if (!reply) return null;
  const lower = reply.toLowerCase();

  // Si el bot presentó combos → botones para elegir
  if ((lower.includes('combo') || lower.includes('1️⃣')) && lower.includes('2️⃣')) {
    return {
      text: '¿Cuál te interesa más?',
      buttons: [
        { label: 'El combo 1️⃣', id: 'combo_1' },
        { label: 'El combo 2️⃣', id: 'combo_2' },
        { label: 'Cuéntame más', id: 'mas_info' }
      ]
    };
  }

  // Si pidió datos de envío → no interrumpir
  if (lower.includes('nombre completo') && lower.includes('dirección')) {
    return null;
  }

  // Si preguntó método de pago → botones de pago
  if (lower.includes('nequi') && lower.includes('contraentrega')) {
    return {
      text: '¿Cómo prefieres pagar?',
      buttons: [
        { label: 'Nequi (8% dto)', id: 'pago_nequi' },
        { label: 'Bancolombia', id: 'pago_banco' },
        { label: 'Contraentrega', id: 'pago_contra' }
      ]
    };
  }

  // Si hizo pregunta diagnóstica de zona
  if (lower.includes('zona') && (lower.includes('rostro') || lower.includes('cuerpo') || lower.includes('axilas'))) {
    return {
      text: '¿Para qué zona es?',
      buttons: [
        { label: 'Rostro', id: 'zona_rostro' },
        { label: 'Cuerpo', id: 'zona_cuerpo' },
        { label: 'Axilas', id: 'zona_axilas' }
      ]
    };
  }

  // Si preguntó qué problema quiere tratar
  if (lower.includes('manchas') && lower.includes('acné') && lower.includes('?')) {
    return {
      text: '¿Qué quieres mejorar?',
      buttons: [
        { label: 'Manchas', id: 'prob_manchas' },
        { label: 'Acné', id: 'prob_acne' },
        { label: 'Otra cosa', id: 'prob_otro' }
      ]
    };
  }

  // Si es saludo inicial → botones de inicio
  if (lower.includes('ayudarte') && lower.includes('?') && lower.length < 200) {
    return {
      text: '¿En qué te ayudo?',
      buttons: [
        { label: 'Busco un producto', id: 'buscar_producto' },
        { label: 'Ver combos', id: 'ver_combos' },
        { label: 'Tengo una duda', id: 'tengo_duda' }
      ]
    };
  }


  // FALLBACK: si presentó opciones con precios → botones genéricos
  if (lower.includes('1️⃣') && lower.includes('$') && lower.includes('?')) {
    return {
      text: '¿Cuál te interesa?',
      buttons: [
        { label: 'La opción 1️⃣', id: 'opcion_1' },
        { label: 'La opción 2️⃣', id: 'opcion_2' },
        { label: 'Necesito más info', id: 'mas_info' }
      ]
    };
  }

  // FALLBACK: si preguntó sobre envío/ciudad
  if (lower.includes('env') && lower.includes('?') && (lower.includes('ciudad') || lower.includes('direcci'))) {
    return {
      text: '¿Cómo deseas recibirlo?',
      buttons: [
        { label: 'Envío a domicilio', id: 'envio_domicilio' },
        { label: 'Más información', id: 'envio_info' },
        { label: 'Ver combos', id: 'ver_combos' }
      ]
    };
  }

  // CATCH-ALL: si la respuesta termina con pregunta → botones contextuales dinámicos
  if (lower.includes('?') && reply.length > 50) {
    // Detectar si hay mención de productos/combos
    if (lower.includes('combo') || lower.includes('jabón') || lower.includes('sebo')) {
      return {
        text: '¿Qué te gustaría?',
        buttons: [
          { label: 'Sí, me interesa', id: 'interes_si' },
          { label: 'Ver más opciones', id: 'mas_opciones' },
          { label: 'Tengo una duda', id: 'duda' }
        ]
      };
    }
    // Si la respuesta es de cierre (datos, confirmación)
    if (lower.includes('confirma') || lower.includes('datos') || lower.includes('pedido')) {
      return {
        text: '¿Listo para confirmar?',
        buttons: [
          { label: 'Sí, confirmo', id: 'confirmo' },
          { label: 'Tengo una duda', id: 'duda_cierre' },
          { label: 'Después te escribo', id: 'despues' }
        ]
      };
    }
    // Genérico para cualquier otra pregunta
    return {
      text: '¿Cómo seguimos?',
      buttons: [
        { label: 'Sí, dale', id: 'si_dale' },
        { label: 'Cuéntame más', id: 'mas_info_gen' },
        { label: 'Otra pregunta', id: 'otra_pregunta' }
      ]
    };
  }

  return null;
}

/* Follow-up trigger for non-buyers */
async function scheduleFollowUp(chatJid) {
  // Placeholder for future implementation
}

// ── ANTI-BAN GUARD: wrapper para que routes.js proteja envíos interactivos ──
// Ejecuta las mismas 4 capas de protección que botSend pero retorna { allowed, reason, fallbackToMeta }
async function antiBanGuard(chatJid, label) {
  const phoneNum = (chatJid || '').replace(/@s\.whatsapp\.net$/, '').replace(/[^0-9]/g, '');
  const result = { allowed: true, reason: null, fallbackToMeta: false, delayMs: 0 };

  // CAPA 1: Circadian
  if (_isCircadianPause()) {
    console.log('[antiBanGuard] Pausa circadiana — recomendando Cloud API para:', label);
    result.fallbackToMeta = true;
    result.reason = 'circadian-pause';
  }

  // CAPA 2: Reply-ratio
  if (!_isReplyRatioSafe(phoneNum)) {
    console.log('[antiBanGuard] Reply-ratio alto para', phoneNum, '—', label);
    result.fallbackToMeta = true;
    result.reason = result.reason || 'reply-ratio-high';
  }

  // CAPA 3: Daily limit
  const today = new Date().toISOString().slice(0, 10);
  if (_dailySendCount.date !== today) { _dailySendCount.count = 0; _dailySendCount.date = today; }
  _dailySendCount.count++;
  if (_dailySendCount.count > DAILY_SEND_LIMIT) {
    console.log('[antiBanGuard] Límite diario alcanzado (' + DAILY_SEND_LIMIT + ') —', label);
    result.allowed = false;
    result.reason = 'daily-limit-reached';
    return result;
  }

  // CAPA 4: baileys-antiban module
  const antiban = getAntiBanFn ? getAntiBanFn() : null;
  if (antiban && !result.fallbackToMeta) {
    try {
      const decision = await antiban.beforeSend(chatJid, label || 'interactive');
      if (!decision.allowed) {
        console.log('[antiBanGuard] AntiBan bloqueó:', decision.reason, '—', label);
        result.fallbackToMeta = true;
        result.reason = result.reason || decision.reason;
      } else if (decision.delayMs > 0) {
        result.delayMs = decision.delayMs;
      }
    } catch (e) {
      console.warn('[antiBanGuard] AntiBan check error:', e.message);
    }
  }

  // CAPA 5: Rate-limit específico para mensajes interactivos (max 3/min por chat)
  const _interactiveKey = 'interactive_' + phoneNum;
  if (!_replyRatio.has(_interactiveKey)) _replyRatio.set(_interactiveKey, { sent: 0, received: 0, lastSent: 0 });
  const ir = _replyRatio.get(_interactiveKey);
  const now = Date.now();
  // Reset counter cada minuto
  if (now - ir.lastSent > 60000) { ir.sent = 0; }
  ir.sent++;
  ir.lastSent = now;
  if (ir.sent > 3) {
    console.log('[antiBanGuard] Rate-limit interactivo (>3/min) para', phoneNum);
    result.fallbackToMeta = true;
    result.reason = result.reason || 'interactive-rate-limit';
  }

  return result;
}

// Registrar envío exitoso en anti-ban (para routes.js)
function antiBanAfterSend(chatJid, label) {
  const antiban = getAntiBanFn ? getAntiBanFn() : null;
  if (antiban) { try { antiban.afterSend(chatJid, label || 'interactive'); } catch(e) {} }
  const phoneNum = (chatJid || '').replace(/@s\.whatsapp\.net$/, '').replace(/[^0-9]/g, '');
  _trackReplyRatio(phoneNum, 'out');
}

module.exports = {
  initAutoReply,
  updateSocket,
  handleIncomingMessage,
  getConfig,
  setConfig,
  getUsageStats,
  loadConfigFromSupabase,
  setSseManager,
  setMetaSendFunction,
  setAntiBanGetter,
  antiBanGuard,
  antiBanAfterSend,
  isBotWithinSchedule,
  invalidateScheduleCache,
};
