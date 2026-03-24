/**
 * Server-side AI Auto-Reply Module
 * Supports: Gemini (FREE), Claude, OpenAI
 * Priority: Gemini > Claude > OpenAI (Gemini is free!)
 */

let aiConfig = {
  enabled: false,
  geminiKey: '',     // FREE - Google AI Studio key (AIza...)
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
const MAX_HISTORY = 10;

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
  const mapKeys = Object.keys(aiConfig.contactMap || {});
  console.log('[auto-reply] contactMap has ' + mapKeys.length + ' entries, policy=' + (aiConfig.contactMap._defaultPolicy || 'deny'));
}

function addToHistory(chatId, role, content) {
  if (!chatHistory.has(chatId)) chatHistory.set(chatId, []);
  const h = chatHistory.get(chatId);
  h.push({ role, content });
  if (h.length > MAX_HISTORY) h.splice(0, h.length - MAX_HISTORY);
}

// ── GEMINI (FREE) ──────────────────────────────────────────
async function callGemini(systemPrompt, messages, apiKey) {
  // Build Gemini format: contents array with role user/model
  const contents = [];
  for (const m of messages) {
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    });
  }
  // Ensure first message is from user
  if (contents.length > 0 && contents[0].role === 'model') {
    contents.unshift({ role: 'user', parts: [{ text: '(inicio de conversacion)' }] });
  }
  const body = {
    contents: contents,
    systemInstruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined,
    generationConfig: {
      maxOutputTokens: 1024,
      temperature: 0.7
    }
  };
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=' + apiKey;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error('Gemini API ' + resp.status + ': ' + err.substring(0, 200));
  }
  const data = await resp.json();
  if (data.candidates && data.candidates[0] && data.candidates[0].content) {
    return data.candidates[0].content.parts.map(p => p.text || '').join('');
  }
  return '';
}

// ── CLAUDE ──────────────────────────────────────────
async function callClaude(systemPrompt, messages, apiKey) {
  const clean = [];
  let lastRole = null;
  for (const m of messages) {
    if (m.role === lastRole && clean.length > 0) {
      clean[clean.length - 1].content += '\n' + m.content;
    } else {
      clean.push({ ...m });
      lastRole = m.role;
    }
  }
  const body = { model: 'claude-sonnet-4-20250514', max_tokens: 1024, messages: clean };
  if (systemPrompt) body.system = systemPrompt;
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body)
  });
  if (!resp.ok) { const err = await resp.text(); throw new Error('Claude API ' + resp.status + ': ' + err.substring(0, 200)); }
  const data = await resp.json();
  return data.content && data.content[0] ? data.content[0].text : '';
}

// ── OPENAI ──────────────────────────────────────────
async function callOpenAI(systemPrompt, messages, apiKey) {
  const msgs = [];
  if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
  msgs.push(...messages);
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
    body: JSON.stringify({ model: 'gpt-4o-mini', messages: msgs, max_tokens: 1024, temperature: 0.7 })
  });
  if (!resp.ok) { const err = await resp.text(); throw new Error('OpenAI API ' + resp.status + ': ' + err.substring(0, 200)); }
  const data = await resp.json();
  return data.choices && data.choices[0] ? data.choices[0].message.content : '';
}

// ── MAIN HANDLER ──────────────────────────────────────────
async function handleIncomingMessage(chatId, senderName, messageText, messageType, sendFn) {
  if (!aiConfig.enabled) return;
  if (chatId.includes('@g.us')) return;

  // Check which provider is available (priority: Gemini FREE > Claude > OpenAI)
  const useGemini = aiConfig.geminiKey && aiConfig.geminiKey.startsWith('AIza');
  const useClaude = aiConfig.claudeKey && aiConfig.claudeKey.startsWith('sk-ant-');
  const useOpenai = aiConfig.openaiKey && aiConfig.openaiKey.startsWith('sk-');
  if (!useGemini && !useClaude && !useOpenai) return;

  // DENY-BY-DEFAULT contact policy
  const map = aiConfig.contactMap || {};
  const hasMap = Object.keys(map).length > 0;
  if (hasMap) {
    if (map[chatId] !== true) {
      const phoneOnly = chatId.replace('@s.whatsapp.net', '');
      if (map[phoneOnly] !== true && map[phoneOnly + '@s.whatsapp.net'] !== true) {
        console.log('[auto-reply] Contact ' + chatId + ' not in allowed list - skip');
        return;
      }
    }
  }

  if (replyingTo.has(chatId)) { console.log('[auto-reply] Already replying to', chatId, '- skip'); return; }

  const userMsg = messageText || (messageType !== 'text' ? '[mensaje multimedia: ' + messageType + ']' : '');
  if (!userMsg) return;

  const provider = useGemini ? 'Gemini(FREE)' : useClaude ? 'Claude' : 'OpenAI';
  console.log('[auto-reply] Processing from', senderName, '(' + chatId + ') via', provider, ':', userMsg.substring(0, 50));
  replyingTo.add(chatId);

  try {
    addToHistory(chatId, 'user', userMsg);
    const delay = aiConfig.botDelay * 1000 + 400;
    await new Promise(r => setTimeout(r, delay));

    const history = chatHistory.get(chatId) || [];
    const messages = history.map(h => ({ role: h.role, content: h.content }));

    let prompt = aiConfig.systemPrompt || '';
    if (senderName) prompt += '\nEl cliente se llama: ' + senderName;
    const emojiInstruction = aiConfig.useEmojis
      ? '\nEmojis: max 2 por mensaje, usalos como vinetas o enfasis estrategico'
      : '\nPROHIBIDO usar emojis, responde solo con texto plano';
    prompt += emojiInstruction;

    if (aiConfig.msgMode === 'partes') {
      prompt += '\n\nENVIO POR PARTES (MUY IMPORTANTE):\nDivide tu respuesta en 2 a 5 mensajes cortos separados por ||||\nCada parte debe ser de 1-2 lineas maximo.\nEjemplo: Hola! Como estas? |||| Te cuento sobre nuestro producto... |||| Tiene estos beneficios...';
    }

    let reply;
    if (useGemini) {
      console.log('[auto-reply] Calling Gemini (FREE) for', chatId);
      reply = await callGemini(prompt, messages, aiConfig.geminiKey);
    } else if (useClaude) {
      console.log('[auto-reply] Calling Claude for', chatId);
      reply = await callClaude(prompt, messages, aiConfig.claudeKey);
    } else {
      console.log('[auto-reply] Calling OpenAI for', chatId);
      reply = await callOpenAI(prompt, messages, aiConfig.openaiKey);
    }

    if (!reply) { console.log('[auto-reply] Empty reply for', chatId); return; }
    console.log('[auto-reply] Got reply via', provider, 'for', chatId, '- len:', reply.length);
    addToHistory(chatId, 'assistant', reply);

    const parts = reply.split('||||').map(p => p.trim()).filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue;
      try {
        await sendFn(chatId, { text: part });
        console.log('[auto-reply] Sent part', (i + 1) + '/' + parts.length, 'to', chatId);
      } catch (sendErr) { console.error('[auto-reply] Send error:', sendErr.message); break; }
      if (i < parts.length - 1) {
        const partDelay = Math.max(800, Math.min(10 * part.length, parts.length > 1 ? 1200 : 1800));
        await new Promise(r => setTimeout(r, partDelay));
      }
    }
    console.log('[auto-reply] Done for', chatId, 'via', provider);
  } catch (err) { console.error('[auto-reply] Error for', chatId + ':', err.message); }
  finally { replyingTo.delete(chatId); }
}

module.exports = { handleIncomingMessage, getConfig, setConfig };
