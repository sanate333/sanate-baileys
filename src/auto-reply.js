/**
 * Server-side AI Auto-Reply Module v4
 * Fixes: message loop, rate limiting, confirmation loop, emoji flood
 */


let _supabaseClient = null;

let aiConfig = {
  enabled: false,
  geminiKey: '',
  claudeKey: '',
  openaiKey: '',
  systemPrompt: '',
  botDelay: 3,
  msgMode: 'partes',
  useEmojis: true,
  contactMap: {},
};

const replyingTo = new Set();
const chatHistory = new Map();
const pausedChats = new Map();
const confirmedChats = new Set(); // Track chats that already got a confirmation
const MAX_HISTORY = 30;

// v4: Anti-loop protection
const recentBotReplies = new Map();
const chatReplyCount = new Map();
const MAX_REPLIES_PER_MINUTE = 3;
const BOT_COOLDOWN_MS = 5000;

const usageData = { daily: {} };

function getTodayKey() {
  return new Date().toISOString().split('T')[0];
}

function recordUsage() {
  const key = getTodayKey();
  usageData.daily[key] = (usageData.daily[key] || 0) + 1;
  const keys = Object.keys(usageData.daily).sort();
  if (keys.length > 30) {
    for (let i = 0; i < keys.length - 30; i++) delete usageData.daily[keys[i]];
  }
}

function getUsageStats() {
  const todayKey = getTodayKey();
  const today = usageData.daily[todayKey] || 0;
  const lastSevenDays = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    lastSevenDays.push(usageData.daily[d.toISOString().split('T')[0]] || 0);
  }
  const dayLabels = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dayLabels.push(['Dom','Lun','Mar','Mie','Jue','Vie','Sab'][d.getDay()]);
  }
  const useGemini = aiConfig.geminiKey && aiConfig.geminiKey.startsWith('AIza');
  const limit = useGemini ? 250 : 999999;
  return {
    today, limit, lastSevenDays, dayLabels,
    provider: useGemini ? 'gemini' : aiConfig.claudeKey ? 'claude' : aiConfig.openaiKey ? 'openai' : 'none',
    totalThisWeek: lastSevenDays.reduce((a, b) => a + b, 0),
  };
}

function getConfig() { return { ...aiConfig }; }

function setConfig(cfg) {
  if (cfg.enabled !== undefined) aiConfig.enabled = cfg.enabled;
  if (cfg.geminiKey) aiConfig.geminiKey = cfg.geminiKey;
  if (cfg.claudeKey) aiConfig.claudeKey = cfg.claudeKey;
  if (cfg.openaiKey) aiConfig.openaiKey = cfg.openaiKey;
  if (cfg.systemPrompt) aiConfig.systemPrompt = cfg.systemPrompt;
  if (cfg.botDelay !== undefined) aiConfig.botDelay = Math.max(0, Math.min(15, Number(cfg.botDelay) || 3));
  if (cfg.msgMode) aiConfig.msgMode = cfg.msgMode;
  if (cfg.useEmojis !== undefined) aiConfig.useEmojis = cfg.useEmojis;
  if (cfg.contactMap) aiConfig.contactMap = cfg.contactMap;
  const provider = aiConfig.geminiKey ? 'gemini(FREE)' : aiConfig.claudeKey ? 'claude' : aiConfig.openaiKey ? 'openai' : 'none';
  console.log('[auto-reply] Config updated: enabled=' + aiConfig.enabled + ', provider=' + provider);

  // Persist to Supabase
  saveConfigToSupabase();
}

// === SUPABASE CONFIG PERSISTENCE ===
function initConfigStore(supabase) {
  _supabaseClient = supabase;
  console.log('[AI Config] Supabase store initialized');
}

async function loadConfigFromSupabase() {
  if (!_supabaseClient) { console.log('[AI Config] No Supabase client'); return false; }
  try {
    const { data, error } = await _supabaseClient
      .from('oasis_wa_config')
      .select('*')
      .eq('id', 'default')
      .single();
    if (error || !data) {
      console.log('[AI Config] No saved config in Supabase:', error?.message || 'no data');
      return false;
    }
    // Map DB columns to aiConfig fields
    if (data.enabled !== undefined && data.enabled !== null) aiConfig.enabled = data.enabled;
    if (data.gemini_key) aiConfig.geminiKey = data.gemini_key;
    if (data.claude_key) aiConfig.claudeKey = data.claude_key;
    if (data.openai_key) aiConfig.openaiKey = data.openai_key;
    if (data.system_prompt) aiConfig.systemPrompt = data.system_prompt;
    if (data.bot_delay !== undefined && data.bot_delay !== null) aiConfig.botDelay = data.bot_delay;
    if (data.msg_mode) aiConfig.msgMode = data.msg_mode;
    if (data.use_emojis !== undefined && data.use_emojis !== null) aiConfig.useEmojis = data.use_emojis;
    if (data.contact_map) aiConfig.contactMap = data.contact_map;
    console.log('[AI Config] Loaded from Supabase - enabled:', aiConfig.enabled, 'provider:', aiConfig.geminiKey ? 'Gemini' : aiConfig.claudeKey ? 'Claude' : aiConfig.openaiKey ? 'OpenAI' : 'none');
    return true;
  } catch (e) {
    console.error('[AI Config] Error loading from Supabase:', e.message);
    return false;
  }
}

async function saveConfigToSupabase() {
  if (!_supabaseClient) return;
  try {
    const row = {
      id: 'default',
      enabled: aiConfig.enabled,
      gemini_key: aiConfig.geminiKey || '',
      claude_key: aiConfig.claudeKey || '',
      openai_key: aiConfig.openaiKey || '',
      system_prompt: aiConfig.systemPrompt || '',
      bot_delay: aiConfig.botDelay,
      msg_mode: aiConfig.msgMode || 'all',
      use_emojis: aiConfig.useEmojis,
      contact_map: aiConfig.contactMap || {},
      updated_at: new Date().toISOString()
    };
    const { error } = await _supabaseClient
      .from('oasis_wa_config')
      .upsert(row, { onConflict: 'id' });
    if (error) console.error('[AI Config] Save to Supabase failed:', error.message);
    else console.log('[AI Config] Saved to Supabase');
  } catch (e) {
    console.error('[AI Config] Error saving to Supabase:', e.message);
  }
}



function pauseChat(chatId, reason) {
  pausedChats.set(chatId, { reason: reason || 'order_confirmed', timestamp: Date.now() });
  confirmedChats.add(chatId);
  console.log('[auto-reply] PAUSED chat', chatId, 'reason:', reason);
}
function unpauseChat(chatId) {
  pausedChats.delete(chatId);
  confirmedChats.delete(chatId);
  console.log('[auto-reply] UNPAUSED chat', chatId);
}
function isChatPaused(chatId) { return pausedChats.has(chatId); }
function getPausedChats() {
  const r = {};
  pausedChats.forEach((v, k) => { r[k] = v; });
  return r;
}

function addToHistory(chatId, role, content) {
  if (!chatHistory.has(chatId)) chatHistory.set(chatId, []);
  const h = chatHistory.get(chatId);
  h.push({ role, content, ts: Date.now() });
  if (h.length > MAX_HISTORY) h.splice(0, h.length - MAX_HISTORY);
}
function clearHistory(chatId) {
  chatHistory.delete(chatId);
  confirmedChats.delete(chatId);
}

// Check if order was already confirmed in chat history
function wasAlreadyConfirmed(chatId) {
  if (confirmedChats.has(chatId)) return true;
  const history = chatHistory.get(chatId) || [];
  for (var i = 0; i < history.length; i++) {
    if (history[i].role === 'assistant' && detectOrderConfirmed(history[i].content)) {
      confirmedChats.add(chatId);
      return true;
    }
  }
  return false;
}

function detectOrderConfirmed(text) {
  if (!text) return false;
  var lower = text.toLowerCase();
  var phrases = [
    'pedido confirmado', 'pedido esta confirmado', '100% confirmado',
    'orden confirmada', 'venta cerrada', 'datos registrados',
    'datos ya estan registrados', 'pedido registrado', 'pedido en proceso',
    'tu pedido sera enviado', 'tu pedido saldra',
    'confirmo que tus datos', 'datos confirmados',
    'pedido ha sido registrado', 'gracias por tu compra',
    'gracias por elegir sanate', 'gracias por tu confianza',
    'recibiras la guia', 'recibiras tu guia', 'pronto recibiras',
    'todo listo', 'confirmado y en proceso',
    'pedido esta en proceso', 'datos estan registrados',
  ];
  return phrases.some(function(p) { return lower.includes(p); });
}

// v4: Rate limit and cooldown
function isRateLimited(chatId) {
  const now = Date.now();
  const entry = chatReplyCount.get(chatId);
  if (!entry || (now - entry.windowStart) > 60000) {
    chatReplyCount.set(chatId, { count: 0, windowStart: now });
    return false;
  }
  return entry.count >= MAX_REPLIES_PER_MINUTE;
}

function recordReply(chatId) {
  const now = Date.now();
  const entry = chatReplyCount.get(chatId);
  if (!entry || (now - entry.windowStart) > 60000) {
    chatReplyCount.set(chatId, { count: 1, windowStart: now });
  } else {
    entry.count++;
  }
  recentBotReplies.set(chatId, now);
}

function isBotCooldown(chatId) {
  const lastReply = recentBotReplies.get(chatId);
  if (!lastReply) return false;
  return (Date.now() - lastReply) < BOT_COOLDOWN_MS;
}

function limitEmojis(text, maxEmojis) {
  if (maxEmojis === undefined) maxEmojis = 1;
  var emojiRegex = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2702}-\u{27B0}\u{FE0F}\u{200D}\u{20E3}\u{2328}\u{23CF}\u{23E9}-\u{23F3}\u{23F8}-\u{23FA}\u{25AA}\u{25AB}\u{25B6}\u{25C0}\u{25FB}-\u{25FE}\u{2934}\u{2935}\u{2B05}-\u{2B07}\u{2B1B}\u{2B1C}\u{2B50}\u{2B55}\u{3030}\u{303D}\u{3297}\u{3299}\u{2705}\u{2714}\u{2716}\u{274C}\u{274E}\u{2733}\u{2734}\u{2747}\u{2753}-\u{2755}\u{2757}\u{2763}\u{2764}\u{1F004}\u{1F0CF}\u{1F170}-\u{1F171}\u{1F17E}-\u{1F17F}\u{1F18E}\u{1F191}-\u{1F19A}\u{1F1E0}-\u{1F1FF}\u{1F201}-\u{1F202}\u{1F21A}\u{1F22F}\u{1F232}-\u{1F23A}\u{1F250}-\u{1F251}]/gu;
  var count = 0;
  return text.replace(emojiRegex, function(match) {
    count++;
    return count <= maxEmojis ? match : '';
  }).replace(/  +/g, ' ').trim();
}

// Strip ALL emojis
function stripAllEmojis(text) {
  return limitEmojis(text, 0);
}

async function callGemini(systemPrompt, messages, apiKey) {
  messages = messages.filter(m => m.text && m.text.trim());

  var contents = [];
  for (var i = 0; i < messages.length; i++) {
    var m = messages[i];
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    });
  }
  if (contents.length > 0 && contents[0].role === 'model') {
    contents.unshift({ role: 'user', parts: [{ text: '(inicio)' }] });
  }
  var body = {
    contents: contents,
    systemInstruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined,
    generationConfig: { maxOutputTokens: 400, temperature: 0.3 }
  };
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=' + apiKey;
  var resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    var err = await resp.text();
    throw new Error('Gemini ' + resp.status + ': ' + err.substring(0, 200));
  }
  var data = await resp.json();
  if (data.candidates && data.candidates[0] && data.candidates[0].content) {
    return data.candidates[0].content.parts.map(function(p) { return p.text || ''; }).join('');
  }
  return '';
}

async function callClaude(systemPrompt, messages, apiKey) {
  messages = messages.filter(m => m.text && m.text.trim());

  var clean = [];
  var lastRole = null;
  for (var i = 0; i < messages.length; i++) {
    var m = messages[i];
    if (m.role === lastRole && clean.length > 0) {
      clean[clean.length - 1].content += '\n' + m.content;
    } else {
      clean.push({ role: m.role, content: m.content });
      lastRole = m.role;
    }
  }
  var body = { model: 'claude-sonnet-4-20250514', max_tokens: 400, messages: clean };
  if (systemPrompt) body.system = systemPrompt;
  var resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    var err = await resp.text();
    throw new Error('Claude ' + resp.status + ': ' + err.substring(0, 200));
  }
  var data = await resp.json();
  return data.content && data.content[0] ? data.content[0].text : '';
}

async function callOpenAI(systemPrompt, messages, apiKey) {
  messages = messages.filter(m => m.text && m.text.trim());

  var msgs = [];
  if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
  msgs.push.apply(msgs, messages);
  var resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini', messages: msgs,
      max_tokens: 400, temperature: 0.3
    })
  });
  if (!resp.ok) {
    var err = await resp.text();
    throw new Error('OpenAI ' + resp.status + ': ' + err.substring(0, 200));
  }
  var data = await resp.json();
  return data.choices && data.choices[0] ? data.choices[0].message.content : '';
}

// Debounce: combine rapid sequential messages before replying
var pendingMessages = new Map();
var DEBOUNCE_MS = 3000;

function scheduleReply(chatId, senderName, messageText, messageType, sendFn) {
  if (!pendingMessages.has(chatId)) {
    pendingMessages.set(chatId, { messages: [], timer: null, senderName: senderName, sendFn: sendFn });
  }
  var pending = pendingMessages.get(chatId);
  var txt = messageText || (messageType !== 'text' ? '[multimedia: ' + messageType + ']' : '');
  if (txt) pending.messages.push(txt);
  pending.senderName = senderName;
  pending.sendFn = sendFn;
  if (pending.timer) clearTimeout(pending.timer);
  pending.timer = setTimeout(function() {
    var combined = pending.messages.filter(Boolean).join('\n');
    pendingMessages.delete(chatId);
    if (combined) processReply(chatId, pending.senderName, combined, sendFn);
  }, DEBOUNCE_MS);
}

async function handleIncomingMessage(chatId, senderName, messageText, messageType, sendFn, fromMe) {
  if (!aiConfig.enabled) return;
  if (chatId.includes('@g.us')) return;

  // v4: Skip own messages
  if (fromMe === true) {
    console.log('[auto-reply] Skipping own message (fromMe) -', chatId);
    return;
  }

  // v4: Cooldown check
  if (isBotCooldown(chatId)) {
    console.log('[auto-reply] Cooldown active, skipping -', chatId);
    return;
  }

  // v4: Rate limit check
  if (isRateLimited(chatId)) {
    console.log('[auto-reply] Rate limited, skipping -', chatId);
    return;
  }

  var useGemini = aiConfig.geminiKey && aiConfig.geminiKey.startsWith('AIza');
  var useClaude = aiConfig.claudeKey && aiConfig.claudeKey.startsWith('sk-ant-');
  var useOpenai = aiConfig.openaiKey && aiConfig.openaiKey.startsWith('sk-');
  if (!useGemini && !useClaude && !useOpenai) return;

  var map = aiConfig.contactMap || {};
  var hasMap = Object.keys(map).length > 0;
  if (hasMap) {
    if (map[chatId] !== true) {
      var phoneOnly = chatId.replace(/@s\.whatsapp\.net|@lid/g, '');
      if (map[phoneOnly] !== true && map[phoneOnly + '@s.whatsapp.net'] !== true && map[phoneOnly + '@lid'] !== true) {
        return;
      }
    }
  }

  if (isChatPaused(chatId)) {
    console.log('[auto-reply] Chat PAUSED (sale) -', chatId);
    return;
  }

  scheduleReply(chatId, senderName, messageText, messageType, sendFn);
}

async function processReply(chatId, senderName, combinedText, sendFn) {
  if (replyingTo.has(chatId)) {
    console.log('[auto-reply] Already replying to', chatId);
    return;
  }

  // v4: Double check cooldown and rate limit
  if (isBotCooldown(chatId)) {
    console.log('[auto-reply] Cooldown at process time -', chatId);
    return;
  }
  if (isRateLimited(chatId)) {
    console.log('[auto-reply] Rate limited at process time -', chatId);
    return;
  }

  // CHECK: if this chat was already confirmed, pause it now and don't reply
  if (wasAlreadyConfirmed(chatId)) {
    console.log('[auto-reply] Chat already confirmed, pausing -', chatId);
    pauseChat(chatId, 'order_confirmed');
    return;
  }

  var useGemini = aiConfig.geminiKey && aiConfig.geminiKey.startsWith('AIza');
  var useClaude = aiConfig.claudeKey && aiConfig.claudeKey.startsWith('sk-ant-');
  var provider = useGemini ? 'Gemini(FREE)' : useClaude ? 'Claude' : 'OpenAI';

  console.log('[auto-reply] Processing', senderName, '(' + chatId + ') via', provider);
  replyingTo.add(chatId);

  try {
    addToHistory(chatId, 'user', combinedText);

    var delay = aiConfig.botDelay * 1000 + 400;
    await new Promise(function(r) { setTimeout(r, delay); });

    // v4: Check rate limit after delay
    if (isRateLimited(chatId)) {
      console.log('[auto-reply] Rate limited after delay -', chatId);
      return;
    }

    // Double-check pause after delay (might have been paused while waiting)
    if (isChatPaused(chatId)) {
      console.log('[auto-reply] Chat paused during delay -', chatId);
      return;
    }

    var history = chatHistory.get(chatId) || [];
    var messages = history.map(function(h) { return { role: h.role, content: h.content }; });

    // Build system prompt
    var prompt = aiConfig.systemPrompt || '';
    if (senderName) prompt += '\nEl cliente se llama: ' + senderName;

    // STRICT emoji rules
    prompt += '\n\nREGLA DE EMOJIS: Usa MAXIMO 1 solo emoji en toda tu respuesta. Preferible 0. NUNCA pongas 2 o mas emojis.';

    // STRICT sale rules
    prompt += '\n\nREGLAS CRITICAS (OBLIGATORIO, NO VIOLAR NINGUNA):';
    prompt += '\n1. Lee TODO el historial antes de responder. No pierdas el hilo.';
    prompt += '\n2. Si el cliente ya eligio producto, NO cambies ni repitas la seleccion.';
    prompt += '\n3. Para confirmar pedido necesitas: nombre + telefono + ciudad/direccion.';
    prompt += '\n4. Cuando tengas los 3 datos, confirma UNA SOLA VEZ con este formato exacto:';
    prompt += '\n   "Pedido confirmado: [producto]. Nombre: [X], Tel: [X], Ciudad: [X]. Pronto recibiras tu guia."';
    prompt += '\n5. PROHIBIDO confirmar mas de 1 vez. Si ya confirmaste antes en el historial, NO vuelvas a confirmar.';
    prompt += '\n6. PROHIBIDO pedir datos que el cliente ya dio.';
    prompt += '\n7. Despues de confirmar, si el cliente escribe algo mas, responde SOLO: "Con gusto! Cualquier duda me escribes."';
    prompt += '\n8. PROHIBIDO enviar mensajes largos despues de la confirmacion.';
    prompt += '\n9. Responde corto y directo. Maximo 2-3 oraciones por mensaje.';
    prompt += '\n10. NO uses asteriscos para negritas.';
    prompt += '\n11. NO repitas informacion que ya enviaste. Si ya dijiste la ubicacion, precios, o datos de envio, NO los repitas.';
    prompt += '\n12. Si el cliente no hizo una nueva pregunta, NO envies mas informacion. Solo responde cuando hay algo nuevo que decir.';

    if (aiConfig.msgMode === 'partes') {
      prompt += '\n\nFORMATO: Puedes dividir en 2 partes con ||||. Maximo 2 partes. Confirmacion = 1 sola parte.';
    }

    var reply;
    if (useGemini) {
      reply = await callGemini(prompt, messages, aiConfig.geminiKey);
    } else if (useClaude) {
      reply = await callClaude(prompt, messages, aiConfig.claudeKey);
    } else {
      reply = await callOpenAI(prompt, messages, aiConfig.openaiKey);
    }

    if (!reply) return;

    recordUsage();
    recordReply(chatId);

    // POST-PROCESS: remove asterisks used for bold
    reply = reply.replace(/\*+/g, '');

    // POST-PROCESS: limit emojis across entire reply (max 1 total)
    var maxEmoji = aiConfig.useEmojis ? 1 : 0;
    reply = limitEmojis(reply, maxEmoji);

    console.log('[auto-reply] Reply via', provider, 'len:', reply.length);

    // CHECK: does this reply contain a confirmation?
    var isConfirmation = detectOrderConfirmed(reply);

    addToHistory(chatId, 'assistant', reply);

    // Split into parts (max 2)
    var parts = reply.split('||||').map(function(p) { return p.trim(); }).filter(Boolean);
    if (parts.length > 2) parts = parts.slice(0, 2);
    // If confirmation, force single message
    if (isConfirmation) parts = [parts.join(' ')];

    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      try {
        await sendFn(chatId, { text: parts[i] });
        console.log('[auto-reply] Sent', (i + 1) + '/' + parts.length, 'to', chatId);
      } catch (e) {
        console.error('[auto-reply] Send error:', e.message);
        break;
      }
      if (i < parts.length - 1) {
        await new Promise(function(r) { setTimeout(r, Math.min(1200, 800 + parts[i].length * 5)); });
      }
    }

    // If confirmation detected, pause IMMEDIATELY
    if (isConfirmation) {
      pauseChat(chatId, 'order_confirmed');
      console.log('[auto-reply] ORDER CONFIRMED -', chatId, '- AI PAUSED IMMEDIATELY');
    }

  } catch (err) {
    console.error('[auto-reply] Error:', chatId, err.message);
  } finally {
    replyingTo.delete(chatId);
  }
}

module.exports = {
  handleIncomingMessage,
  getConfig,
  setConfig,
  getUsageStats,
  pauseChat,
  unpauseChat,
  isChatPaused,
  getPausedChats,
  clearHistory,
  initConfigStore,
  loadConfigFromSupabase,
  callGemini,
  callClaude,
  callOpenAI
};
