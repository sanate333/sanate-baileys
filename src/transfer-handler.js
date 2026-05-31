/*  transfer-handler.js  —  Bank transfer verification for Sánate WhatsApp Bot
 *  Handles screenshot flow, reviewer approval/fraud/block via WA receptor.
 */

let supabase = null;
let sock = null;
let config = { transfer_wa_receptor: null, transfer_enabled: false };

// baileys_helper — inyecta nodos binarios requeridos para botones interactivos
let _baileysHelper = null;
function getBaileysHelper() {
  if (!_baileysHelper) {
    try {
      _baileysHelper = require('baileys_helper');
      log('baileys_helper cargado OK');
    } catch (e) {
      log('baileys_helper no disponible:', e.message);
      _baileysHelper = {};
    }
  }
  return _baileysHelper;
}

// Baileys internals para fallback relay
function getBaileysFns() {
  try {
    const baileys = require('@whiskeysockets/baileys');
    return { generateWAMessageFromContent: baileys.generateWAMessageFromContent || baileys.default?.generateWAMessageFromContent };
  } catch (e) { return {}; }
}

// In-memory map: transferId -> { clientJid, phone, pushName, orderSummary, total, paymentMethod }
const pendingTransfers = new Map();

// Track last order context per chat so handleScreenshot can reference it
const lastOrderContext = new Map();

// ── ANTI-SPAM/BAN HARDENING (30 may 2026) ──
const MAX_TRANSFERS_PER_CHAT_PER_DAY = parseInt(process.env.TRANSFER_CAP_PER_CHAT_PER_DAY) || 3;
const RECEPTOR_COOLDOWN_MS = 8000;  // 8s entre mensajes al receptor (anti-spam)
let _receptorLastSent = 0;

async function waitForReceptorCooldown() {
  const elapsed = Date.now() - _receptorLastSent;
  if (elapsed < RECEPTOR_COOLDOWN_MS) {
    const waitMs = RECEPTOR_COOLDOWN_MS - elapsed + Math.floor(Math.random() * 2000); // jitter ±2s
    log('Receptor cooldown — esperando', waitMs, 'ms');
    await new Promise(r => setTimeout(r, waitMs));
  }
}

async function countTransfersToday(chatJid) {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count, error } = await supabase
      .from('oasis_wa_transfers')
      .select('id', { count: 'exact', head: true })
      .eq('chat_jid', chatJid)
      .gte('created_at', since);
    if (error) { logErr('countTransfersToday:', error.message); return 0; }
    return count || 0;
  } catch (e) { logErr('countTransfersToday exception:', e.message); return 0; }
}

// Image validation: ask Gemini if it looks like a payment screenshot
async function validatePaymentScreenshot(imageBuffer, hintMethod) {
  try {
    const autoReply = require('./auto-reply');
    const cfg = autoReply.getConfig ? autoReply.getConfig() : {};
    const key = cfg.geminiKey || process.env.GEMINI_API_KEY;
    if (!key || !imageBuffer || imageBuffer.length < 200) return { ok: true, reason: 'no-validation-available' };
    const b64 = imageBuffer.toString('base64');
    const prompt = `Mira esta imagen. ¿Parece un pantallazo de transferencia bancaria, Nequi, Bancolombia, Daviplata o similar de pago en Colombia? Responde EXACTAMENTE una palabra: SI / NO / DUDA. Considera que el cliente dijo que pagó por: ${hintMethod || 'transferencia'}.`;
    const resp = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + key, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: 'image/jpeg', data: b64 } }] }],
        generationConfig: { temperature: 0.0, maxOutputTokens: 5 }
      })
    });
    try { apiTracker.track(key, resp.ok, resp.status).catch(()=>{}); } catch(e) {}
    if (!resp.ok) return { ok: true, reason: 'gemini-error-allow' };
    const data = await resp.json();
    const verdict = (data?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim().toUpperCase();
    log('Image validation verdict:', verdict);
    if (verdict.startsWith('NO')) return { ok: false, reason: 'not-payment-screenshot' };
    return { ok: true, reason: verdict };
  } catch (e) { logErr('validatePaymentScreenshot:', e.message); return { ok: true, reason: 'exception-allow' }; }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function log(...args) { console.log('[Transfer]', ...args); }
function logErr(...args) { console.error('[Transfer]', ...args); }

function receptorJid() {
  if (!config.transfer_wa_receptor) return null;
  const num = config.transfer_wa_receptor.replace(/\D/g, '');
  return num + '@s.whatsapp.net';
}

// ── exported functions ───────────────────────────────────────────────────────

async function initTransferHandler(sb, socket) {
  try {
    supabase = sb;
    sock = socket;
    const { data: rows, error } = await supabase
      .from('oasis_wa_config')
      .select('transfer_wa_receptor, transfer_enabled')
      .eq('id', 'default')
      .limit(1);
    if (error) throw error;
    const data = rows && rows[0];
    if (data) {
      config.transfer_wa_receptor = data.transfer_wa_receptor || null;
      config.transfer_enabled = !!data.transfer_enabled;
    }
    log('Initialized — receptor:', config.transfer_wa_receptor, '| enabled:', config.transfer_enabled);
  } catch (err) {
    logErr('initTransferHandler error:', err.message || err);
  }
}

function updateSocket(socket) {
  sock = socket;
  log('Socket updated');
}

function getConfig() {
  return { ...config };
}

/**
 * Detect payment method keywords in Spanish text.
 * @returns {'bancolombia'|'nequi'|'transferencia'|null}
 */
function detectPaymentMethod(text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  if (/bancolombia/i.test(lower)) return 'bancolombia';
  if (/nequi/i.test(lower)) return 'nequi';
  if (/transferencia|consignaci[oó]n/i.test(lower)) return 'transferencia';
  return null;
}

/**
 * Activate screenshot-wait mode for a chat.
 */
async function activateScreenshotMode(chatJid, pushName, orderSummary, total, paymentMethod) {
  try {
    // 1. Flag the chat
    const { error } = await supabase
      .from('oasis_wa_chats')
      .update({ awaiting_screenshot: true, awaiting_screenshot_since: new Date().toISOString() })
      .eq('jid', chatJid);
    if (error) logErr('activateScreenshotMode update error:', error.message);

    // Store order context for later use in handleScreenshot
    lastOrderContext.set(chatJid, { orderSummary, total, paymentMethod });

    // 2. Send confirmation message to client
    const msg = `Perfecto ${pushName}! Tu pedido:\n\n${orderSummary}\n\n💰 Total: $${total}\n\nPor favor envía el pantallazo de la transferencia por ${paymentMethod} y quedamos atentos para procesarlo 🙌`;
    await sock.sendMessage(chatJid, { text: msg });
    log('Screenshot mode activated for', chatJid);

    // 3. Schedule 15-minute reminder
    setTimeout(() => {
      checkScreenshotReminder(chatJid, pushName).catch(e => logErr('Reminder error:', e.message || e));
    }, 15 * 60 * 1000);
  } catch (err) {
    logErr('activateScreenshotMode error:', err.message || err);
  }
}

/**
 * Check if a chat is awaiting a screenshot.
 * @returns {Promise<boolean>}
 */
async function isAwaitingScreenshot(chatJid) {
  try {
    const { data, error } = await supabase
      .from('oasis_wa_chats')
      .select('awaiting_screenshot')
      .eq('jid', chatJid)
      .single();
    if (error) { logErr('isAwaitingScreenshot error:', error.message); return false; }
    return !!(data && data.awaiting_screenshot);
  } catch (err) {
    logErr('isAwaitingScreenshot error:', err.message || err);
    return false;
  }
}

/**
 * Process an incoming screenshot image from a client awaiting verification.
 */
async function handleScreenshot(chatJid, phone, pushName, mediaUrl, _imageAnalysis) {
  try {
    // Retrieve stored order context
    const ctx = lastOrderContext.get(chatJid) || {};
    const orderSummary = ctx.orderSummary || '(sin resumen)';
    const total = ctx.total || 0;
    const paymentMethod = ctx.paymentMethod || 'transferencia';

    // 0. ANTI-SPAM CAP — máx 3 transfers por chat por día
    const todayCount = await countTransfersToday(chatJid);
    if (todayCount >= MAX_TRANSFERS_PER_CHAT_PER_DAY) {
      log('Cliente excedió cap diario:', chatJid, todayCount);
      try {
        await sock.sendMessage(chatJid, { text: '⚠️ Ya recibimos varios pantallazos tuyos hoy. Por favor espera la revisión de los anteriores o contáctanos por DM si tienes dudas. Gracias!' });
      } catch (e) {}
      return;
    }

    // 1. Insert transfer record
    const { data: inserted, error: insertErr } = await supabase
      .from('oasis_wa_transfers')
      .insert({
        chat_jid: chatJid,
        phone,
        push_name: pushName,
        image_url: mediaUrl,
        order_summary: orderSummary,
        total,
        payment_method: paymentMethod,
        status: 'pending'
      })
      .select('id')
      .single();

    if (insertErr) throw insertErr;
    const transferId = inserted.id;

    // Store in-memory for reviewer lookup
    pendingTransfers.set(transferId, { clientJid: chatJid, phone, pushName, orderSummary, total, paymentMethod });

    // 2. Confirm to client
    await sock.sendMessage(chatJid, { text: '📸 ¡Recibimos tu pantallazo!\n\nEn este momento lo estamos validando con nuestro equipo. Te confirmamos en 2-5 minutos aproximadamente. Por favor, espera un momento 🙏⏳' });

    // ── REMINDER al cliente si pending > 20 min (escalación de espera) ──
    setTimeout(async () => {
      try {
        const { data: t } = await supabase.from('oasis_wa_transfers').select('status').eq('id', transferId).single();
        if (t && t.status === 'pending') {
          await sock.sendMessage(chatJid, { text: '⏳ Hola de nuevo! Seguimos validando tu pantallazo. Gracias por tu paciencia, en breve te confirmamos 🙏' });
          log('Cliente reminder pending >20min:', chatJid);
        }
      } catch (e) { logErr('Client reminder error:', e.message); }
    }, 20 * 60 * 1000);

    // ── REMINDER al RECEPTOR si pending > 10 min (anti-olvido) ──
    setTimeout(async () => {
      try {
        const { data: t } = await supabase.from('oasis_wa_transfers').select('status').eq('id', transferId).single();
        if (t && t.status === 'pending' && rJid) {
          await waitForReceptorCooldown();
          await sock.sendMessage(rJid, { text: `🔔 Recordatorio: transferencia de *${pushName}* (${phone}) sigue pendiente hace 10 min. Por favor revísala y aprueba o rechaza para que el cliente reciba respuesta.` });
          _receptorLastSent = Date.now();
          log('Receptor reminder pending >10min for transfer:', transferId);
        }
      } catch (e) { logErr('Receptor reminder error:', e.message); }
    }, 10 * 60 * 1000);

    // 3. Clear awaiting_screenshot flag
    await supabase
      .from('oasis_wa_chats')
      .update({ awaiting_screenshot: false })
      .eq('jid', chatJid);

    // 4. Forward to receptor as SINGLE message (image + text + buttons)
    const rJid = receptorJid();
    if (!rJid) { logErr('No receptor JID configured'); return; }

    const reviewText =
      `🔔 NUEVO PANTALLAZO DE PAGO\n\n` +
      `👤 Cliente: ${pushName} (${phone})\n` +
      `📋 Pedido: ${orderSummary}\n` +
      `💰 Total: $${total}\n` +
      `🏦 Método: ${paymentMethod}`;

    const nativeButtons = [
      { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: '✅ Confirmado', id: 'transfer_approve_' + transferId }) },
      { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: '⚠️ Posible estafa', id: 'transfer_fraud_' + transferId }) },
      { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: '🚫 Bloquear', id: 'transfer_block_' + transferId }) }
    ];

    // Download image for header
    let imgBuffer = null;
    try {
      const https = require('https');
      const http = require('http');
      imgBuffer = await new Promise((resolve, reject) => {
        const mod = mediaUrl.startsWith('https') ? https : http;
        mod.get(mediaUrl, (resp) => {
          const chunks = [];
          resp.on('data', c => chunks.push(c));
          resp.on('end', () => resolve(Buffer.concat(chunks)));
          resp.on('error', reject);
        }).on('error', reject);
      });
      log('Image downloaded for header, size:', imgBuffer.length);
    } catch (dlErr) {
      logErr('Error downloading image for header:', dlErr.message);
    }

    // ANTI-SPAM: validate image is actually a payment screenshot before forwarding
    if (imgBuffer) {
      const validation = await validatePaymentScreenshot(imgBuffer, paymentMethod);
      if (!validation.ok) {
        log('Image validation REJECTED:', validation.reason);
        try {
          await sock.sendMessage(chatJid, { text: '🤔 La imagen que enviaste no parece un pantallazo de transferencia. Por favor envía la captura clara de tu pago bancario.' });
        } catch (e) {}
        // Mark this transfer as invalid in DB
        try { await supabase.from('oasis_wa_transfers').update({ status: 'invalid_image' }).eq('id', transferId); } catch (e) {}
        return;
      }
    }

    // Anti-spam: wait for receptor cooldown + typing indicator (humanize)
    await waitForReceptorCooldown();
    try { await sock.sendPresenceUpdate('composing', rJid); } catch (e) {}
    await new Promise(r => setTimeout(r, 1500 + Math.floor(Math.random() * 1500)));
    try { await sock.sendPresenceUpdate('paused', rJid); } catch (e) {}

    let buttonsSent = false;

    // Try sending SINGLE message: image header + text + buttons via relay
    try {
      const baileys = require('@whiskeysockets/baileys');
      const { generateWAMessageFromContent: genMsg, prepareWAMessageMedia, isJidGroup: isGroup } = baileys;
      if (!genMsg) throw new Error('generateWAMessageFromContent not available');

      const interactiveMsg = {
        body: { text: reviewText },
        footer: { text: 'Sánate Bot • Verificación de pago' },
        nativeFlowMessage: {
          buttons: nativeButtons.map(b => ({ name: b.name, buttonParamsJson: b.buttonParamsJson })),
          messageParamsJson: '',
          messageVersion: 1
        }
      };

      // Attach image header if available
      if (imgBuffer && prepareWAMessageMedia) {
        try {
          const mediaMsg = await prepareWAMessageMedia({ image: imgBuffer }, { upload: sock.waUploadToServer });
          if (mediaMsg && mediaMsg.imageMessage) {
            interactiveMsg.header = { hasMediaAttachment: true, imageMessage: mediaMsg.imageMessage };
            log('Image header attached to interactive message');
          }
        } catch (mediaErr) {
          logErr('Error preparing media for header:', mediaErr.message);
        }
      }

      const msgContent = { interactiveMessage: interactiveMsg };
      const senderJid = sock.user?.id || rJid;
      const genId = baileys.generateMessageIDV2 || baileys.generateMessageID;
      const wamsg = genMsg(rJid, msgContent, { userJid: senderJid, messageId: genId ? genId(senderJid) : undefined });
      const additionalNodes = [
        { tag: 'biz', attrs: {}, content: [{ tag: 'interactive', attrs: { type: 'native_flow', v: '1' }, content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }] }] }
      ];
      if (!isGroup(rJid)) additionalNodes.push({ tag: 'bot', attrs: { biz_bot: '1' } });
      await sock.relayMessage(rJid, wamsg.message, { messageId: wamsg.key.id, additionalNodes });
      _receptorLastSent = Date.now();
      buttonsSent = true;
      log('Single message (image+text+buttons) sent OK');
    } catch (btnErr) {
      logErr('Error sending combined message:', btnErr.message);
    }

    // Fallback: send ONE message — image with caption containing all info + instructions
    if (!buttonsSent) {
      log('Fallback: sending consolidated image+caption');
      const fallbackCaption = reviewText + '\n\nResponde con el número:\n1️⃣ Confirmado · 2️⃣ Posible estafa · 3️⃣ Bloquear';
      if (imgBuffer) {
        await sock.sendMessage(rJid, { image: imgBuffer, caption: fallbackCaption });
      } else {
        await sock.sendMessage(rJid, { text: fallbackCaption });
      }
      _receptorLastSent = Date.now();
    }

    log('Screenshot forwarded to receptor, transferId:', transferId);
  } catch (err) {
    logErr('handleScreenshot error:', err.message || err);
  }
}

/**
 * Handle a text/button response from the WA receptor (reviewer).
 */
async function handleReviewerResponse(chatJid, messageText) {
  try {
    const text = (messageText || '').trim().toLowerCase();

    // Determine action from text or button id
    let action = null;
    let transferIdFromButton = null;

    if (/^transfer_approve_/.test(text)) {
      action = 'approve';
      transferIdFromButton = text.replace('transfer_approve_', '');
    } else if (/^transfer_fraud_/.test(text)) {
      action = 'fraud';
      transferIdFromButton = text.replace('transfer_fraud_', '');
    } else if (/^transfer_block_/.test(text)) {
      action = 'block';
      transferIdFromButton = text.replace('transfer_block_', '');
    } else if (text === '1' || /confirmado/i.test(text)) {
      action = 'approve';
    } else if (text === '2' || /estafa/i.test(text)) {
      action = 'fraud';
    } else if (text === '3' || /bloquear/i.test(text)) {
      action = 'block';
    }

    if (!action) return false; // Not a reviewer command

    // Find the transfer — by button ID (DB first, then Map), or latest pending
    let transfer = null;

    if (transferIdFromButton) {
      // 1. Try DB lookup by exact ID (works even after server restart)
      try {
        const { data: dbTransfer, error: dbErr } = await supabase
          .from('oasis_wa_transfers')
          .select('*')
          .eq('id', transferIdFromButton)
          .single();
        if (!dbErr && dbTransfer) {
          transfer = {
            id: dbTransfer.id,
            clientJid: dbTransfer.chat_jid,
            phone: dbTransfer.phone,
            pushName: dbTransfer.push_name,
            orderSummary: dbTransfer.order_summary,
            total: dbTransfer.total,
            paymentMethod: dbTransfer.payment_method
          };
          log('Transfer found in DB by button ID:', transferIdFromButton);
        }
      } catch (e) { logErr('DB lookup by ID error:', e.message); }

      // 2. Fallback to in-memory Map
      if (!transfer && pendingTransfers.has(transferIdFromButton)) {
        transfer = { id: transferIdFromButton, ...pendingTransfers.get(transferIdFromButton) };
        log('Transfer found in memory Map:', transferIdFromButton);
      }
    }

    // 3. Last resort: latest pending transfer from DB
    if (!transfer) {
      const { data, error } = await supabase
        .from('oasis_wa_transfers')
        .select('*')
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
      if (error || !data) { logErr('No pending transfer found in DB'); return false; }
      transfer = {
        id: data.id,
        clientJid: data.chat_jid,
        phone: data.phone,
        pushName: data.push_name,
        orderSummary: data.order_summary,
        total: data.total,
        paymentMethod: data.payment_method
      };
      log('Transfer found as latest pending:', transfer.id);
    }

    const rJid = receptorJid();

    if (action === 'approve') {
      await supabase
        .from('oasis_wa_transfers')
        .update({ status: 'approved', reviewed_at: new Date().toISOString() })
        .eq('id', transfer.id);
      await sock.sendMessage(transfer.clientJid, {
        text: `✅ ¡${transfer.pushName}, tu pantallazo fue confirmado!\n\nTu pedido ya va en camino 📦🚀\n\n• Envío: 1 a 3 días hábiles\n• Transportadora: Interrapidísimo\n• Te avisaremos cuando tengamos el código de guía\n\n¡Gracias por confiar en nosotros! 🙌`
      });
      if (rJid) await sock.sendMessage(rJid, { text: `✅ Transferencia de ${transfer.pushName} aprobada.` });
      log('Transfer approved:', transfer.id);
    } else if (action === 'fraud') {
      await supabase
        .from('oasis_wa_transfers')
        .update({ status: 'fraud', reviewed_at: new Date().toISOString() })
        .eq('id', transfer.id);
      // Archive client chat
      await supabase
        .from('oasis_wa_chats')
        .update({ archived: true })
        .eq('jid', transfer.clientJid);
      if (rJid) await sock.sendMessage(rJid, { text: '⚠️ Chat archivado para revisión manual.' });
      log('Transfer flagged as fraud:', transfer.id);
    } else if (action === 'block') {
      await supabase
        .from('oasis_wa_transfers')
        .update({ status: 'blocked', reviewed_at: new Date().toISOString() })
        .eq('id', transfer.id);
      await sock.sendMessage(transfer.clientJid, {
        text: 'Este pantallazo es falso. Dios te bendiga. 🙏'
      });
      // Block: update config to prevent auto-replies for this client
      try {
        const { data: cfgRows } = await supabase
          .from('oasis_wa_config')
          .select('id, contact_map')
          .eq('id', 'default')
          .limit(1);
        const cfgData = cfgRows && cfgRows[0];
        const contactMap = (cfgData && cfgData.contact_map) || {};
        contactMap[transfer.clientJid] = false;
        await supabase
          .from('oasis_wa_config')
          .update({ contact_map: contactMap })
          .eq('id', 'default');
      } catch (blockErr) {
        logErr('Error updating contact_map for block:', blockErr.message || blockErr);
      }
      if (rJid) await sock.sendMessage(rJid, { text: `🚫 Cliente ${transfer.pushName} bloqueado.` });
      log('Transfer blocked:', transfer.id);
    }

    // Clean up in-memory
    pendingTransfers.delete(transfer.id);
    return true;
  } catch (err) {
    logErr('handleReviewerResponse error:', err.message || err);
    return false;
  }
}

/**
 * 15-minute reminder — if still awaiting, nudge the client.
 */
async function checkScreenshotReminder(chatJid, pushName) {
  try {
    const still = await isAwaitingScreenshot(chatJid);
    if (!still) return;
    await sock.sendMessage(chatJid, {
      text: `Hola ${pushName}! Estamos atentos para procesar tu envío 📦 Cuando tengas el pantallazo de la transferencia, envíanoslo por aquí 🙌`
    });
    log('Reminder sent to', chatJid);
  } catch (err) {
    logErr('checkScreenshotReminder error:', err.message || err);
  }
}

// ── exports ──────────────────────────────────────────────────────────────────

module.exports = {
  initTransferHandler,
  updateSocket,
  getConfig,
  detectPaymentMethod,
  activateScreenshotMode,
  isAwaitingScreenshot,
  handleScreenshot,
  handleReviewerResponse,
  checkScreenshotReminder
};
    