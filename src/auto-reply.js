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
let sock = null;

// --- In-memory config (loaded from Supabase on init) ---
let aiConfig = {
  enabled: false,
  geminiKey: '',
  claudeKey: '',
  openaiKey: '',
  systemPrompt: '',
  contactMap: {},
  botDelay: 3,
  msgMode: 'all',
  useEmojis: true,
  partesCount: 3,
  testWhitelist: [],
  companyContext: '',
};

// --- Conversation history (in-memory, persists until restart) ---
const chatHistory = new Map();
const MAX_HISTORY = 20;

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

// ===================== INIT =====================

async function initAutoReply(supabase, socket) {
  supabaseClient = supabase;
  sock = socket;
  await loadConfigFromSupabase();
  console.log('Auto-reply v3.0 inicializado. Enabled:', aiConfig.enabled, '| Prompt length:', (aiConfig.systemPrompt || '').length);
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
      aiConfig.companyContext = data.company_context || '';
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
        company_context: aiConfig.companyContext,
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
  if (updates.companyContext !== undefined) aiConfig.companyContext = updates.companyContext;
  if (updates.contactMap !== undefined) aiConfig.contactMap = updates.contactMap;
  if (updates.botDelay !== undefined) aiConfig.botDelay = updates.botDelay;
  if (updates.msgMode !== undefined) aiConfig.msgMode = updates.msgMode;
  if (updates.useEmojis !== undefined) aiConfig.useEmojis = updates.useEmojis;
  if (updates.partesCount !== undefined) aiConfig.partesCount = updates.partesCount;
  if (updates.testWhitelist !== undefined) aiConfig.testWhitelist = updates.testWhitelist;
  saveConfigToSupabase().catch(() => {});
}

function getUsageStats() {
  return { ...usageStats, configLoaded: !!aiConfig.systemPrompt, enabled: aiConfig.enabled };
}

// ===================== MESSAGE HANDLER =====================

async function handleIncomingMessage(chatJid, messageText, pushName, messageId) {
  if (!aiConfig.enabled) return;

  if (aiConfig.testWhitelist && aiConfig.testWhitelist.length > 0) {
    const phoneNumber = chatJid.split('@')[0];
    if (!aiConfig.testWhitelist.includes(phoneNumber)) return;
  }
  if (!messageText || messageText.trim().length === 0) return;
  if (!sock) return;

  if (aiConfig.msgMode === 'contacts') {
    if (!aiConfig.contactMap[chatJid]) return;
  }
  if (aiConfig.contactMap[chatJid] === false) return;

  if (processedReplies.has(messageId)) return;
  processedReplies.add(messageId);
  if (processedReplies.size > MAX_PROCESSED) {
    const first = processedReplies.values().next().value;
    processedReplies.delete(first);
  }

  addToHistory(chatJid, 'user', messageText);

  if (replyTimers.has(chatJid)) {
    clearTimeout(replyTimers.get(chatJid));
  }

  const delay = (aiConfig.botDelay || 3) * 1000;
  const debounceDelay = Math.max(delay, DEBOUNCE_MS);

  replyTimers.set(chatJid, setTimeout(async () => {
    replyTimers.delete(chatJid);
    await processReply(chatJid, pushName);
  }, debounceDelay));
}

// ===================== PROCESS REPLY =====================

async function processReply(chatJid, pushName) {
  if (replyLocks.get(chatJid)) {
    console.log('Reply locked for', chatJid, '- skipping');
    return;
  }
  replyLocks.set(chatJid, true);

  const now = Date.now();
  const lastTime = lastReplyTime.get(chatJid) || 0;
  if (now - lastTime < MIN_REPLY_INTERVAL) {
    console.log('Throttled reply to', chatJid);
    replyLocks.delete(chatJid);
    return;
  }

  try {
    let systemPrompt = aiConfig.systemPrompt || 'Eres un asistente de ventas amable para Sanate, tienda de cosmeticos naturales.';

    systemPrompt += '\n\nREGLA DE EMOJIS: ' + (aiConfig.useEmojis ? 'Usa MAXIMO 1-2 emojis en TODA tu respuesta, distribuidos naturalmente. NO pongas emoji al final de cada parrafo.' : 'NO uses emojis bajo ninguna circunstancia.');

    systemPrompt += '\n\n=== REGLAS DE CONVERSACION (OBLIGATORIO) ===';
    systemPrompt += '\n1. Lee SIEMPRE el historial completo antes de responder. CONTINUA donde quedo la conversacion.';
    systemPrompt += '\n2. NUNCA repitas el saludo si ya saludaste. Si el cliente vuelve a escribir, retoma el tema directamente.';
    systemPrompt += '\n3. Si el cliente ya dijo su nombre, NO vuelvas a decir "Hola [nombre]" en cada mensaje.';
    systemPrompt += '\n4. Si el cliente pregunta por un producto ESPECIFICO, responde sobre ESE producto. No preguntes "que buscas".';
    systemPrompt += '\n5. VARIA tus expresiones de apertura. PROHIBIDO empezar siempre con "Genial!", "Claro que si!", "Que buena pregunta!". Usa variaciones naturales.';
    systemPrompt += '\n6. NO hagas pregunta de cierre de venta en CADA mensaje. Solo cuando el cliente muestre interes claro.';
    systemPrompt += '\n7. NUNCA repitas una pregunta que ya hiciste antes. Lee el historial.';
    systemPrompt += '\n8. Nunca uses listas con vinetas (*) a menos que estes listando productos/precios.';
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
      systemPrompt += '\n- Formulario de datos de envio -> 1 solo parrafo con toda la info';
      systemPrompt += '\nFormato: separa parrafos con DOBLE salto de linea.';
      systemPrompt += '\nCada parrafo debe tener 1-3 oraciones como un mensaje de WhatsApp real.';
      systemPrompt += '\nNUNCA envies un emoji solo como parrafo separado.';
      systemPrompt += '\nNUNCA cortes numeros/precios entre parrafos.';
    } else {
      systemPrompt += '\n\nUSO DE EMOJIS (modo completo):';
      systemPrompt += '\n- Usa MAXIMO 1-2 emojis en TODA tu respuesta.';
      systemPrompt += '\n- Si el mensaje es corto o formal, puedes no usar ninguno.';
    }

    systemPrompt += '\n\n=== ESTRATEGIA DE VENTA CONSULTIVA ===';
    systemPrompt += '\n- FASE 1 (mensajes 1-3): Descubrir necesidad real. Hacer preguntas que revelen el problema/deseo del cliente.';
    systemPrompt += '\n- FASE 2 (mensajes 4-6): Presentar solucion personalizada con beneficios especificos para SU caso.';
    systemPrompt += '\n- FASE 3 (mensaje 7+): Resolver objeciones + ofrecer cierre SUAVE con alternativas.';
    systemPrompt += '\n- Usa la TECNICA ESPEJO: repite las palabras del cliente para validar.';
    systemPrompt += '\n- CIERRE POR ALTERNATIVA: "Te gustaria el individual o el combo con mas ahorro?" (no ultimatums).';
    systemPrompt += '\n- Si el cliente dice "si" o muestra interes, pasa DIRECTO a pedir datos de envio. No sigas vendiendo.';
    systemPrompt += '\n- Si el cliente pregunta precios de mas unidades, CALCULA el precio real. Si no lo sabes, di que consultas.';

    if (pushName) {
      systemPrompt += '\n\nEl nombre del cliente es: ' + pushName + '. Usalo con moderacion (no en cada mensaje).';
    }

    const history = await getHistory(chatJid);

        if (aiConfig.companyContext) {
      systemPrompt += '\n\n[CONTEXTO DEL NEGOCIO]\n' + aiConfig.companyContext;
    }

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
      replyLocks.delete(chatJid);
      return;
    }

    reply = cleanReply(reply);

    if (aiConfig.msgMode === 'partes') {
      const parts = smartSplit(reply, aiConfig.partesCount || 3);

      if (parts.length === 1) {
        await sock.sendMessage(chatJid, { text: parts[0].trim() });
        console.log('BOT [1 msg] -> ' + chatJid.split('@')[0] + ': ' + parts[0].substring(0, 60));
      } else {
        for (let i = 0; i < parts.length; i++) {
          const partText = parts[i].trim();
          if (partText.length === 0) continue;
          await sock.sendMessage(chatJid, { text: partText });
          if (i < parts.length - 1) {
            const typingDelay = Math.min(3000, 800 + partText.length * 15);
            await new Promise(r => setTimeout(r, typingDelay));
          }
        }
        console.log('BOT [' + parts.length + ' partes] -> ' + chatJid.split('@')[0]);
      }
    } else {
      await sock.sendMessage(chatJid, { text: reply });
      console.log('BOT -> ' + chatJid.split('@')[0] + ': ' + reply.substring(0, 80));
    }

    lastReplyTime.set(chatJid, Date.now());
    usageStats.totalReplies++;
    usageStats.lastReply = new Date().toISOString();

    addToHistory(chatJid, 'model', reply);

    if (aiConfig.msgMode !== 'partes') {
      const { saveMessage, upsertChat } = require('./supabase');
      await saveMessage(chatJid, 'Sanate Bot', {
        messageId: 'bot_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
        text: reply,
        type: 'text',
        fromMe: true,
        timestamp: Math.floor(Date.now() / 1000),
      });
      await upsertChat(chatJid, null, reply, Math.floor(Date.now() / 1000));
    }

  } catch (err) {
    console.error('Error en processReply:', err.message);
    usageStats.errors++;
  } finally {
    replyLocks.delete(chatJid);
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

    const contents = [];
    for (const msg of history) {
      contents.push({
        role: msg.role === 'user' ? 'user' : 'model',
        parts: [{ text: msg.text }]
      });
    }

    if (contents.length === 0 || contents[contents.length - 1].role !== 'user') return null;

    const body = {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: contents,
      generationConfig: {
        temperature: 0.7,
        
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
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        maxOutputTokens: 2000,
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
        maxOutputTokens: 2000,
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
  if (!text) return [text];

  if (text.length < 100) return [text];

  const isShortReply = text.length < 150;
  const hasProductList = /\$[\d.,]+/.test(text) && (/combo|opci[oÃ³]n|precio/i.test(text));
  const hasBenefits = /(beneficio|sirve para|ayuda a|mejora|reduce|promueve)/i.test(text);
  const hasFormData = /(nombre|direcci[oÃ³]n|ciudad|m[eÃ©]todo de pago|nequi|bancolombia)/i.test(text);
  const isGreeting = /^[Â¡!]?(hola|hey|buenos|buenas)/i.test(text.trim());

  let targetParts;
  if (isGreeting || isShortReply) {
    targetParts = 1;
  } else if (hasFormData) {
    targetParts = 1;
  } else if (hasProductList) {
    targetParts = Math.min(2, maxParts);
  } else if (hasBenefits) {
    targetParts = maxParts;
  } else {
    const naturalParts = text.split(/\n\n+/).filter(p => p.trim().length > 0);
    targetParts = Math.min(naturalParts.length, maxParts);
    if (targetParts <= 1) targetParts = text.length > 250 ? 2 : 1;
  }

  if (targetParts <= 1) return [text];

  let parts = text.split(/\n\n+/).filter(p => p.trim().length > 0);

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
  text = text.trim();
  if (text.length > 800) text = text.substring(0, 797) + '...';
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
