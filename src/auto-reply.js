/**
 * Server-side AI Auto-Reply Module
 * Handles AI responses directly on the server without needing the browser open
 */

// In-memory config (set via /ai-config endpoint)
let aiConfig = {
  enabled: false,
  claudeKey: '',
  openaiKey: '',
  systemPrompt: '',
  botDelay: 3,       // seconds before replying
  msgMode: 'partes', // 'partes' or 'completo'
  useEmojis: true,
  contactMap: {},     // per-contact enable/disable
};

// Track ongoing replies to prevent duplicates
const replyingTo = new Set();
// Store recent messages for context
const chatHistory = new Map();
const MAX_HISTORY = 10;

function getConfig() { return { ...aiConfig }; }

function setConfig(cfg) {
  if (cfg.enabled !== undefined) aiConfig.enabled = cfg.enabled;
  if (cfg.claudeKey) aiConfig.claudeKey = cfg.claudeKey;
  if (cfg.openaiKey) aiConfig.openaiKey = cfg.openaiKey;
  if (cfg.systemPrompt) aiConfig.systemPrompt = cfg.systemPrompt;
  if (cfg.botDelay !== undefined) aiConfig.botDelay = Math.max(0, Math.min(15, Number(cfg.botDelay) || 3));
  if (cfg.msgMode) aiConfig.msgMode = cfg.msgMode;
  if (cfg.useEmojis !== undefined) aiConfig.useEmojis = cfg.useEmojis;
  if (cfg.contactMap) aiConfig.contactMap = cfg.contactMap;
  console.log('[auto-reply] Config updated: enabled=' + aiConfig.enabled + ', key=' + (aiConfig.claudeKey ? 'claude' : aiConfig.openaiKey ? 'openai' : 'none'));
}

function addToHistory(chatId, role, content) {
  if (!chatHistory.has(chatId)) chatHistory.set(chatId, []);
  const h = chatHistory.get(chatId);
  h.push({ role, content });
  if (h.length > MAX_HISTORY) h.splice(0, h.length - MAX_HISTORY);
}

async function callClaude(systemPrompt, messages, apiKey) {
  // Ensure alternating roles
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
  
  const body = {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    messages: clean
  };
  if (systemPrompt) body.system = systemPrompt;
  
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });
  
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error('Claude API ' + resp.status + ': ' + err.substring(0, 200));
  }
  
  const data = await resp.json();
  return data.content && data.content[0] ? data.content[0].text : '';
}

async function callOpenAI(systemPrompt, messages, apiKey) {
  const msgs = [];
  if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
  msgs.push(...messages);
  
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: msgs,
      max_tokens: 1024,
      temperature: 0.7
    })
  });
  
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error('OpenAI API ' + resp.status + ': ' + err.substring(0, 200));
  }
  
  const data = await resp.json();
  return data.choices && data.choices[0] ? data.choices[0].message.content : '';
}

/**
 * Handle incoming message and auto-reply if configured
 * @param {string} chatId - The chat JID
 * @param {string} senderName - Display name of sender
 * @param {string} messageText - The message text
 * @param {string} messageType - Type of message (text, image, etc.)
 * @param {function} sendFn - Function to send a message: sendFn(chatId, text)
 */
async function handleIncomingMessage(chatId, senderName, messageText, messageType, sendFn) {
  // Skip if disabled
  if (!aiConfig.enabled) return;
  
  // Skip groups
  if (chatId.includes('@g.us')) return;
  
  // Skip if no API key
  const useClaude = aiConfig.claudeKey && aiConfig.claudeKey.startsWith('sk-ant-');
  const useOpenai = aiConfig.openaiKey && aiConfig.openaiKey.startsWith('sk-');
  if (!useClaude && !useOpenai) return;
  
  // Check per-contact settings
  if (aiConfig.contactMap && aiConfig.contactMap[chatId] === false) return;
  
  // Skip if already replying to this chat
  if (replyingTo.has(chatId)) {
    console.log('[auto-reply] Already replying to', chatId, '- skip');
    return;
  }
  
  const userMsg = messageText || (messageType !== 'text' ? '[mensaje multimedia: ' + messageType + ']' : '');
  if (!userMsg) return;
  
  console.log('[auto-reply] Processing message from', senderName, '(' + chatId + '):', userMsg.substring(0, 50));
  
  replyingTo.add(chatId);
  
  try {
    // Add user message to history
    addToHistory(chatId, 'user', userMsg);
    
    // Wait bot delay
    const delay = aiConfig.botDelay * 1000 + 400;
    await new Promise(r => setTimeout(r, delay));
    
    // Build messages array from history
    const history = chatHistory.get(chatId) || [];
    const messages = history.map(h => ({ role: h.role, content: h.content }));
    
    // Build system prompt
    let prompt = aiConfig.systemPrompt || '';
    if (senderName) {
      prompt += '\nEl cliente se llama: ' + senderName;
    }
    
    // Add emoji instruction
    const emojiInstruction = aiConfig.useEmojis
      ? '\nEmojis: max 2 por mensaje, usalos como vinetas o enfasis estrategico'
      : '\nPROHIBIDO usar emojis, responde solo con texto plano';
    prompt += emojiInstruction;
    
    // Add message mode instruction
    if (aiConfig.msgMode === 'partes') {
      prompt += '\n\nENVIO POR PARTES (MUY IMPORTANTE):\nDivide tu respuesta en 2 a 5 mensajes cortos separados por ||||\nCada parte debe ser de 1-2 lineas maximo.\nEjemplo: Hola! Como estas? |||| Te cuento sobre nuestro producto... |||| Tiene estos beneficios...';
    }
    
    // Call AI
    let reply;
    if (useClaude) {
      console.log('[auto-reply] Calling Claude for', chatId);
      reply = await callClaude(prompt, messages, aiConfig.claudeKey);
    } else {
      console.log('[auto-reply] Calling OpenAI for', chatId);
      reply = await callOpenAI(prompt, messages, aiConfig.openaiKey);
    }
    
    if (!reply) {
      console.log('[auto-reply] Empty reply for', chatId);
      return;
    }
    
    console.log('[auto-reply] Got reply for', chatId, '- len:', reply.length);
    
    // Add assistant reply to history
    addToHistory(chatId, 'assistant', reply);
    
    // Send reply (split into parts if needed)
    const parts = reply.split('||||').map(p => p.trim()).filter(Boolean);
    
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue;
      
      try {
        await sendFn(chatId, { text: part });
        console.log('[auto-reply] Sent part', (i + 1) + '/' + parts.length, 'to', chatId);
      } catch (sendErr) {
        console.error('[auto-reply] Send error:', sendErr.message);
        break;
      }
      
      // Delay between parts
      if (i < parts.length - 1) {
        const partDelay = Math.max(800, Math.min(10 * part.length, parts.length > 1 ? 1200 : 1800));
        await new Promise(r => setTimeout(r, partDelay));
      }
    }
    
    console.log('[auto-reply] Done for', chatId);
  } catch (err) {
    console.error('[auto-reply] Error for', chatId + ':', err.message);
  } finally {
    replyingTo.delete(chatId);
  }
}

module.exports = { handleIncomingMessage, getConfig, setConfig };
