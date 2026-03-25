/**
 * Server-side AI Auto-Reply Module v2
 * Fixes: context loss, confirmation loop, emoji flood, auto-pause on sale
 */

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
const MAX_HISTORY = 30;

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
}

function pauseChat(chatId, reason) {
  pausedChats.set(chatId, { reason: reason || 'order_confirmed', timestamp: Date.now() });
  console.log('[auto-reply] PAUSED chat', chatId, 'reason:', reason);
}
function unpauseChat(chatId) {
  pausedChats.delete(chatId);
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
function clearHistory(chatId) { chatHistory.delete(chatId); }

function detectOrderConfirmed(aiReply) {
  const lower = aiReply.toLowerCase();
  const phrases = [
    'pedido confirmado', 'pedido esta confirmado', '100% confirmado',
    'orden confirmada', 'venta cerrada', 'datos registrados',
    'datos ya estan registrados', 'pedido registrado', 'pedido en proceso',
    'tu pedido sera enviado', 'tu pedido saldra',
    'confirmo que tus datos', 'datos confirmados',
    'pedido ha sido registrado', 'gracias por tu compra',
    'gracias por elegir sanate', 'gracias por tu confianza',
    'recibiras la guia', 'recibiras tu guia', 'pronto recibiras',
  ];
  return phrases.some(function(p) { return lower.includes(p); });
}

function limitEmojis(text, maxEmojis) {
  if (maxEmojis === undefined) maxEmojis = 1;
  var emojiRegex = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2702}-\u{27B0}\u{FE0F}]/gu;
  var count = 0;
  return text.replace(emojiRegex, function(match) {
    count++;
    return count <= maxEmojis ? match : '';
  }).replace(/  +/g, ' ').trim();
}

async function callGemini(systemPrompt, messages, apiKey) {
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
    generationConfig: { maxOutputTokens: 600, temperature: 0.5 }
  };
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=' + apiKey;
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
  var body = { model: 'claude-sonnet-4-20250514', max_tokens: 600, messages: clean };
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
      max_tokens: 600, temperature: 0.5
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
var DEBOUNCE_MS = 2500;

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

async function handleIncomingMessage(chatId, senderName, messageText, messageType, sendFn) {
  if (!aiConfig.enabled) return;
  if (chatId.includes('@g.us')) return;

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

  var useGemini = aiConfig.geminiKey && aiConfig.geminiKey.startsWith('AIza');
  var useClaude = aiConfig.claudeKey && aiConfig.claudeKey.startsWith('sk-ant-');
  var provider = useGemini ? 'Gemini(FREE)' : useClaude ? 'Claude' : 'OpenAI';

  console.log('[auto-reply] Processing', senderName, '(' + chatId + ') via', provider);
  replyingTo.add(chatId);

  try {
    addToHistory(chatId, 'user', combinedText);

    var delay = aiConfig.botDelay * 1000 + 400;
    await new Promise(function(r) { setTimeout(r, delay); });

    var history = chatHistory.get(chatId) || [];
    var messages = history.map(function(h) { return { role: h.role, content: h.content }; });

    var prompt = aiConfig.systemPrompt || '';
    if (senderName) prompt += '\nEl cliente se llama: ' + senderName;

    if (aiConfig.useEmojis) {
      prompt += '\n\nEMOJIS: Usa MAXIMO 1 emoji por mensaje. Nunca 2 emojis juntos. Si no es necesario, no uses emoji.';
    } else {
      prompt += '\nPROHIBIDO usar emojis.';
    }

    prompt += '\n\nREGLAS DE VENTA (OBLIGATORIO):';
    prompt += '\n1. RECUERDA todo el historial. NUNCA pierdas el hilo.';
    prompt += '\n2. Si el cliente ya eligio un combo, NO cambies el nombre ni numero.';
    prompt += '\n3. Cuando el cliente da nombre + telefono + ciudad = DATOS COMPLETOS.';
    prompt += '\n4. Con datos completos, confirma UNA SOLA VEZ: "Pedido confirmado [producto]. Nombre: [X], Tel: [X], Ciudad: [X]. Pronto recibiras tu guia. Gracias por elegir Sanate"';
    prompt += '\n5. NUNCA confirmes mas de una vez. NUNCA repitas confirmacion.';
    prompt += '\n6. NUNCA pidas datos ya proporcionados.';
    prompt += '\n7. Post-confirmacion solo responde breve: "Con gusto! Cualquier duda me escribes"';
    prompt += '\n8. Si ya confirmaste en el historial, NO vuelvas a confirmar.';

    if (aiConfig.msgMode === 'partes') {
      prompt += '\n\nFORMATO: Divide en 2-3 partes con ||||. Max 3 partes. Confirmacion = 1 sola parte sin dividir.';
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
    console.log('[auto-reply] Reply via', provider, 'len:', reply.length, 'usage:', getUsageStats().today);

    addToHistory(chatId, 'assistant', reply);

    var parts = reply.split('||||').map(function(p) { return p.trim(); }).filter(Boolean);
    if (parts.length > 3) parts = parts.slice(0, 3);

    var maxEmoji = aiConfig.useEmojis ? 1 : 0;
    parts = parts.map(function(p) { return limitEmojis(p, maxEmoji); });

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

    if (detectOrderConfirmed(reply)) {
      pauseChat(chatId, 'order_confirmed');
      console.log('[auto-reply] ORDER CONFIRMED -', chatId, '- AI PAUSED');
    }

  } catch (err) {
    console.error('[auto-reply] Error:', chatId, err.message);
  } finally {
    replyingTo.delete(chatId);
  }
}

module.exports = {
  handleIncomingMessage: handleIncomingMessage,
  getConfig: getConfig,
  setConfig: setConfig,
  getUsageStats: getUsageStats,
  pauseChat: pauseChat,
  unpauseChat: unpauseChat,
  isChatPaused: isChatPaused,
  getPausedChats: getPausedChats,
  clearHistory: clearHistory,
};
