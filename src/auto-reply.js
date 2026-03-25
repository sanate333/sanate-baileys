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
  contactMap: {},     // { "jid": true/false } â true = bot active for that contact
  botDelay: 3,        // seconds before replying
  msgMode: 'all',     // 'all' | 'contacts' (only those in contactMap)
  useEmojis: true,
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
    systemPrompt += '\n\nREGLAS CRITICAS (OBLIGATORIO):';
    systemPrompt += '\n1. Responde en MAXIMO 2-3 oraciones cortas. Nada de parrafos largos.';
    systemPrompt += '\n2. NUNCA repitas el saludo si ya saludaste antes en la conversacion.';
    systemPrompt += '\n3. Si el cliente ya dijo su nombre o ya lo saludaste, NO vuelvas a decir "Hola [nombre]".';
    systemPrompt += '\n4. Lee el historial de la conversacion y CONTINUA desde donde quedo.';
    systemPrompt += '\n5. Si el cliente pregunta por un producto, responde sobre ESE producto.';
    systemPrompt += '\n6. Siempre termina con UNA pregunta de cierre.';
    systemPrompt += '\n7. Nunca uses listas con viÃ±etas. Habla de forma natural y conversacional.';
    systemPrompt += '\n8. Si no tienes info del producto, di que consultas con el equipo y respondes pronto.';

    if (pushName) {
      systemPrompt += '\n\nEl nombre del cliente es: ' + pushName;
    }

    // Get conversation history for context
    const history = getHistory(chatJid);

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
    await sock.sendMessage(chatJid, { text: reply });
    lastReplyTime.set(chatJid, Date.now());
    usageStats.totalReplies++;
    usageStats.lastReply = new Date().toISOString();

    // Add bot reply to history
    addToHistory(chatJid, 'model', reply);

    // Save to Supabase
    const { saveMessage, upsertChat } = require('./supabase');
    await saveMessage(chatJid, 'Sanate Bot', {
      messageId: 'bot_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
      text: reply,
      type: 'text',
      fromMe: true,
      timestamp: Math.floor(Date.now() / 1000),
    });
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

function getHistory(chatJid) {
  return chatHistory.get(chatJid) || [];
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
