/**
 * SANATE Auto-Reply Module
 * AI-powered auto-reply using Gemini (primary), Claude (fallback), OpenAI (fallback)
 * Config persisted in Supabase oasis_wa_config table
 */

let supabaseClient = null;
let sock = null;

// --- In-memory config (loaded from Supabase on init) ---
let aiConfig = {
  enabled: false,
  geminiKey: '',
  claudeKey: '',
  openaiKey: '',
  systemPrompt: '',
  contactMap: {},     // { "jid": true/false } ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ true = bot active for that contact
  botDelay: 3,        // seconds before replying
  msgMode: 'all',     // 'all' | 'contacts' (only those in contactMap)
  useEmojis: true,
  partesCount: 3,
  testWhitelist: []
};

// --- Conversation history (in-memory, persists until restart) ---
// Map<chatJid, Array<{ role: 'user'|'model', text: string, ts: number }>>
const chatHistory = new Map();
const MAX_HISTORY = 20; // keep last 20 messages per chat

// --- Dedup & throttle ---
const replyTimers = new Map();       // debounce timers per chat
const lastReplyTime = new Map();     // last reply timestamp per chat
const processedReplies = new Set();  // message IDs we already replied to
const DEBOUNCE_MS = 3000;
const MIN_REPLY_INTERVAL = 5000;     // min 5s between replies to same chat
const MAX_PROCESSED = 2000;

// --- Usage stats ---
let usageStats = { totalReplies: 0, geminiCalls: 0, claudeCalls: 0, openaiCalls: 0, errors: 0, lastReply: null };

// ===================== INIT =====================

async function initAutoReply(supabase, socket) {
  supabaseClient = supabase;
  sock = socket;
  await loadConfigFromSupabase();
  console.log('Auto-reply inicializado. Enabled:', aiConfig.enabled, '| Prompt length:', (aiConfig.systemPrompt || '').length);
}

function updateSocket(socket) {
  sock = socket;
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
      aiConfig.contactMap = data.contact_map || {};
      aiConfig.botDelay = data.bot_delay ?? 3;
      aiConfig.msgMode = data.msg_mode || 'all';
      aiConfig.useEmojis = data.use_emojis ?? true;
      aiConfig.partesCount = data.partes_count ?? 3;
    aiConfig.testWhitelist = data.test_whitelist ?? [];
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
        contact_map: aiConfig.contactMap,
        bot_delay: aiConfig.botDelay,
        msg_mode: aiConfig.msgMode,
        use_emojis: aiConfig.useEmojis,
        partes_count: aiConfig.partesCount,
        test_whitelist: aiConfig.testWhitelist,
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
  if (updates.contactMap !== undefined) aiConfig.contactMap = updates.contactMap;
  if (updates.botDelay !== undefined) aiConfig.botDelay = updates.botDelay;
  if (updates.msgMode !== undefined) aiConfig.msgMode = updates.msgMode;
  if (updates.useEmojis !== undefined) aiConfig.useEmojis = updates.useEmojis;
  if (updates.partesCount !== undefined) aiConfig.partesCount = updates.partesCount;
    if (updates.testWhitelist !== undefined) aiConfig.testWhitelist = updates.testWhitelist;
  // Persist to Supabase asynchronously
  saveConfigToSupabase().catch(() => {});
}

function getUsageStats() {
  return { ...usageStats, configLoaded: !!aiConfig.systemPrompt, enabled: aiConfig.enabled };
}
// ===================== MESSAGE HANDLER =====================

async function handleIncomingMessage(chatJid, messageText, pushName, messageId) {
  // --- Guard checks ---
  if (!aiConfig.enabled) return;

  // Test whitelist: if set, only respond to these numbers
  if (aiConfig.testWhitelist && aiConfig.testWhitelist.length > 0) {
    const phoneNumber = chatJid.split('@')[0];
    if (!aiConfig.testWhitelist.includes(phoneNumber)) return;
  }
  if (!messageText || messageText.trim().length === 0) return;
  if (!sock) return;

  // Check if bot should reply to this contact
  if (aiConfig.msgMode === 'contacts') {
    if (!aiConfig.contactMap[chatJid]) return;
  }
  // Even in 'all' mode, check if contact is explicitly disabled
  if (aiConfig.contactMap[chatJid] === false) return;

  // Dedup: don't reply to same message twice
  if (processedReplies.has(messageId)) return;
  processedReplies.add(messageId);
  if (processedReplies.size > MAX_PROCESSED) {
    const first = processedReplies.values().next().value;
    processedReplies.delete(first);
  }

  // Add to conversation history
  addToHistory(chatJid, 'user', messageText);

  // Debounce: wait for user to finish typing (reset timer on each message)
  if (replyTimers.has(chatJid)) {
    clearTimeout(replyTimers.get(chatJid));
  }

  const delay = (aiConfig.botDelay || 3) * 1000;
  replyTimers.set(chatJid, setTimeout(async () => {
    replyTimers.delete(chatJid);
    await processReply(chatJid, pushName);
  }, delay));
}

// ===================== PROCESS REPLY =====================

async function processReply(chatJid, pushName) {
  // Throttle: don't reply too fast to same chat
  const now = Date.now();
  const lastTime = lastReplyTime.get(chatJid) || 0;
  if (now - lastTime < MIN_REPLY_INTERVAL) {
    console.log('Throttled reply to', chatJid);
    return;
  }

  try {
    // Build system prompt with rules
    let systemPrompt = aiConfig.systemPrompt || 'Eres un asistente de ventas amable para Sanate, tienda de cosmeticos naturales.';

    // Append critical rules
    systemPrompt += '\n\nREGLA DE EMOJIS: ' + (aiConfig.useEmojis ? 'Usa MAXIMO 1-2 emojis por mensaje, solo cuando sea natural.' : 'NO uses emojis.');
    systemPrompt += '\n\nREGLAS DE CONVERSACION (OBLIGATORIO):';
    systemPrompt += '\n1. Responde en MAXIMO 2-3 oraciones cortas por mensaje. Natural y conversacional.';
    systemPrompt += '\n2. NUNCA repitas el saludo si ya saludaste. Lee el historial y CONTINUA donde quedo.';
    systemPrompt += '\n3. Si el cliente ya dijo su nombre, NO vuelvas a decir "Hola [nombre]" otra vez.';
    systemPrompt += '\n4. Si el cliente pregunta por un producto, responde sobre ESE producto directamente.';
    systemPrompt += '\n5. NO hagas pregunta de cierre de venta en cada mensaje. Solo hazla cuando el cliente ya mostro interes claro (pidio precio, pregunto como comprar, etc). En conversacion normal, fluye natural.';
    systemPrompt += '\n6. NUNCA repitas una pregunta que ya hiciste antes en la conversacion. Varia siempre.';
    systemPrompt += '\n7. Nunca uses listas con vinetas. Habla como en WhatsApp real.';
    systemPrompt += '\n8. Si no tienes info del producto, di que consultas con el equipo y respondes pronto.';
    systemPrompt += '\n9. Manten un tono amigable y cercano, sin ser invasivo ni insistente con la venta.';
    systemPrompt += '\n10. Adapta la LONGITUD de tu respuesta al tipo de pregunta: pregunta simple = respuesta corta, pregunta detallada = respuesta mas completa.';

    // Mode-specific instructions for partes
    if (aiConfig.msgMode === 'partes') {
      const pc = aiConfig.partesCount || 3;
      systemPrompt += '\n\nMODO ENVIO POR PARTES (MUY IMPORTANTE):';
      systemPrompt += '\n- Tu respuesta sera dividida en mensajes separados de WhatsApp.';
      systemPrompt += '\n- Escribe entre 2 y ' + pc + ' parrafos CORTOS separados por doble salto de linea.';
      systemPrompt += '\n- VARIA la cantidad segun el contexto: saludo o pregunta simple = 2 parrafos, consulta de producto o duda detallada = ' + pc + ' parrafos.';
      systemPrompt += '\n- Cada parrafo debe ser 1-2 oraciones maximo, como un mensaje de WhatsApp real.';
      systemPrompt += '\n- Usa 1-2 emojis por parrafo, contextuales (naturaleza/belleza para productos, etc). NO repitas emojis.';
      systemPrompt += '\n- Formato: "Parrafo1\n\nParrafo2" (minimo 2, maximo ' + pc + ' parrafos).';
    } else {
      // Modo completo: maximo 1-2 emojis en todo el mensaje
      systemPrompt += '\n\nUSO DE EMOJIS (modo completo):';
      systemPrompt += '\n- Usa MAXIMO 1 a 2 emojis en TODA tu respuesta, bien elegidos segun el contexto.';
      systemPrompt += '\n- Elige emojis que encajen con el tema: naturaleza para productos naturales, caritas para saludos, etc.';
      systemPrompt += '\n- Si el mensaje es corto o formal, puedes no usar ninguno.';
    }

    if (pushName) {
      systemPrompt += '\n\nEl nombre del cliente es: ' + pushName;
    }

    // Get conversation history for context
    const history = await getHistory(chatJid);

    // Call AI (Gemini primary, Claude fallback, OpenAI fallback)
    let reply = null;
    if (aiConfig.geminiKey) {
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
      return;
    }

    // Clean up reply
    reply = cleanReply(reply);

    // Send the reply
    // Send the reply (single or in parts)
    if (aiConfig.msgMode === 'partes' && reply.length > 80) {
      const parts = splitIntoParts(reply, aiConfig.partesCount || 3);
      for (let i = 0; i < parts.length; i++) {
        await sock.sendMessage(chatJid, { text: parts[i].trim() });
        if (i < parts.length - 1) {
          await new Promise(r => setTimeout(r, 1500 + Math.floor(Math.random() * 1500)));
        }
      }
      console.log('BOT [partes] -> ' + chatJid.split('@')[0] + ': ' + parts.length + ' msgs');
    } else {
      await sock.sendMessage(chatJid, { text: reply });
    }
    lastReplyTime.set(chatJid, Date.now());
    usageStats.totalReplies++;
    usageStats.lastReply = new Date().toISOString();

    // Add bot reply to history
    addToHistory(chatJid, 'model', reply);

    // Save to Supabase
    const { saveMessage, upsertChat } = require('./supabase');
    if (aiConfig.msgMode !== 'partes') {
    await saveMessage(chatJid, 'Sanate Bot', {
      messageId: 'bot_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
      text: reply,
      type: 'text',
      fromMe: true,
      timestamp: Math.floor(Date.now() / 1000),
    });
    }
    await upsertChat(chatJid, null, reply, Math.floor(Date.now() / 1000));

    console.log('BOT -> ' + chatJid.split('@')[0] + ': ' + reply.substring(0, 80));

  } catch (err) {
    console.error('Error en processReply:', err.message);
    usageStats.errors++;
  }
    }
// ===================== CONVERSATION HISTORY =====================

function addToHistory(chatJid, role, text) {
  if (!chatHistory.has(chatJid)) chatHistory.set(chatJid, []);
  const hist = chatHistory.get(chatJid);
  hist.push({ role, text, ts: Date.now() });
  // Keep only last MAX_HISTORY messages
  if (hist.length > MAX_HISTORY) hist.splice(0, hist.length - MAX_HISTORY);
}

async function getHistory(chatJid) {
  // If history exists in memory, return it
  if (chatHistory.has(chatJid) && chatHistory.get(chatJid).length > 0) {
    return chatHistory.get(chatJid);
  }
  // Cold start: load last messages from Supabase
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
          role: m.direction === 'out' ? 'model' : 'user',
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
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=' + aiConfig.geminiKey;

    // Build Gemini conversation format
    const contents = [];
    for (const msg of history) {
      contents.push({
        role: msg.role === 'user' ? 'user' : 'model',
        parts: [{ text: msg.text }]
      });
    }

    // If no messages or last message is not from user, skip
    if (contents.length === 0 || contents[contents.length - 1].role !== 'user') return null;

    const body = {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: contents,
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 300,
        topP: 0.9,
      }
    };

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

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
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 300,
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
        max_tokens: 300,
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

// ===================== UTILS =====================


// ===================== SPLIT INTO PARTS (msgMode partes) =====================
function splitIntoParts(text, maxParts) {
  maxParts = maxParts || 3;
  if (!text || text.length < 80) return [text];
  
  // Try splitting by double newline first
  let parts = text.split(/\n\n+/).filter(p => p.trim().length > 0);
  if (parts.length >= 2 && parts.length <= maxParts) return parts.slice(0, maxParts);
  
  // Try splitting by sentence endings (. ? !)
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  if (sentences.length <= 1) return [text];
  
  // Group sentences into targetParts (based on maxParts)
  const targetParts = Math.min(maxParts, Math.max(2, sentences.length));
  const perPart = Math.ceil(sentences.length / targetParts);
  parts = [];
  for (let i = 0; i < sentences.length; i += perPart) {
    const chunk = sentences.slice(i, i + perPart).join('').trim();
    if (chunk) parts.push(chunk);
  }
  return parts.slice(0, maxParts);
}

function cleanReply(text) {
  if (!text) return '';
  // Remove markdown bold/italic
  text = text.replace(/\*\*/g, '').replace(/__/g, '');
  // Remove excessive newlines
  text = text.replace(/\n{3,}/g, '\n\n');
  // Trim
  text = text.trim();
  // Limit length (WhatsApp friendly)
  if (text.length > 500) text = text.substring(0, 497) + '...';
  return text;
}

module.exports = {
  initAutoReply,
  updateSocket,
  handleIncomingMessage,
  getConfig,
  setConfig,
  getUsageStats,
  loadConfigFromSupabase,
};
