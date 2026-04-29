const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, isJidGroup, isJidBroadcast, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const NodeCache = require('node-cache');
const { saveMessage, upsertChat, syncInitialChats, updateMessageStatus } = require('./supabase');
const { useSupabaseAuthState, clearAuth, clearLocalAuth, saveAuthToSupabase } = require('./auth-store');
const { handleIncomingMessage, updateSocket, setSseManager } = require('./auto-reply');

let sock = null;
let qrCode = null;
let connectionState = 'disconnected';
let sseManager = null;
let supabaseClient = null;
let initialSyncDone = false;

const photoCache = new NodeCache({ stdTTL: 900, checkperiod: 120 });
const contactCache = new NodeCache({ stdTTL: 3600, checkperiod: 300 });

function normalizeJid(jid) {
  if (!jid) return jid;
  return jid.replace(/@s\.whatsapp\.net$/, '');
}

function getSocket() { return sock; }
function getQR() { return qrCode; }
function getConnectionState() { return connectionState; }

async function initBaileys(supabase, sse) {
  supabaseClient = supabase;
  sseManager = sse;
  setSseManager(sse); // Pasar SSE manager a auto-reply para eventos bot_typing
  await connectToWhatsApp();
}


// ââ Audio transcription via Gemini â 3 capas (literal + contextual + intenciÃ³n) ââââââ
async function transcribeAudio(msg) {
  try {
    const { getConfig } = require('./auto-reply');
    const cfg = getConfig();
    const key = cfg.geminiKey;
    if (!key) return null;
    const buffer = await downloadMediaMessage(msg, 'buffer', {});
    if (!buffer || buffer.length === 0) return null;
    const b64 = buffer.toString('base64');
    const mime = msg.message?.audioMessage?.mimetype || 'audio/ogg; codecs=opus';

    const prompt = `Eres experto en transcripciÃ³n de audios de WhatsApp colombianos.
El audio puede ser de una persona mayor (60-80 aÃ±os), con voz baja, acento regional, ruido de fondo o pronunciaciÃ³n poco clara.

Haz 3 interpretaciones del audio:
LITERAL: (escribe textualmente lo que escuchas, aunque sea parcial o con ruido)
CONTEXTUAL: (interpreta lo que probablemente quiso decir; es cliente de una tienda de cosmÃ©ticos naturales colombiana â jabones artesanales, cremas, productos para manchas, acnÃ©, piel grasa/seca, precios, envÃ­os, pedidos)
INTENCION: (Â¡quÃ© estÃ¡ preguntando o pidiendo concretamente? escrÃ­belo en una frase clara y directa)

Luego elige la interpretaciÃ³n mÃ¡s Ãºtil y completa para que la IA pueda responder con precisiÃ³n:
FINAL: (puede combinar las 3 capas â debe ser claro y completo aunque el audio fuera difÃ­cil de entender)

Responde SOLO con este formato. Sin comentarios adicionales.`;

    const resp = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + key,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [
            { text: prompt },
            { inline_data: { mime_type: mime, data: b64 } }
          ]}],
          generationConfig: { temperature: 0.1, maxOutputTokens: 700 }
        })
      }
    );
    if (!resp.ok) { console.error('[transcribeAudio] Gemini error', resp.status); return null; }
    const data = await resp.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
    if (!raw) return null;

    const getLayer = (label, next) => {
      const re = new RegExp(label + ':\\s*([\\s\\S]+?)(?=' + next + ':|$)');
      const m = raw.match(re);
      return m ? m[1].trim() : '';
    };
    const l1 = getLayer('LITERAL', 'CONTEXTUAL');
    const l2 = getLayer('CONTEXTUAL', 'INTENCION');
    const l3 = getLayer('INTENCION', 'FINAL');
    const finalMatch = raw.match(/FINAL:\s*([\s\S]+)$/);
    const finalText = finalMatch ? finalMatch[1].trim() : raw;

    if (l1) console.log('[Audio L0-literal]    ' + l1.substring(0, 70));
    if (l2) console.log('[Audio L2-contextual] ' + l2.substring(0, 70));
    if (l3) console.log('[Audio L3-intencion]  ' + l3.substring(0, 70));
    console.log('[Audio FINAL] ' + finalText.substring(0, 100));

    return finalText || l3 || l2 || l1 || null;
  } catch (e) {
    console.error('[transcribeAudio] Error:', e.message);
    return null;
  }
}


// ── Image analysis via Gemini Vision ───────────────────────────────────────
async function analyzeImage(msg) {
  try {
    const { getConfig } = require('./auto-reply');
    const cfg = getConfig();
    const key = cfg.geminiKey;
    if (!key) return null;
    const buffer = await downloadMediaMessage(msg, 'buffer', {});
    if (!buffer || buffer.length === 0) return null;
    const b64 = buffer.toString('base64');
    const mime = msg.message?.imageMessage?.mimetype || 'image/jpeg';
    const caption = msg.message?.imageMessage?.caption || '';
    const resp = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + key,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [
            { text: 'Analiza esta imagen en español colombiano. Si es un comprobante de pago o transferencia bancaria, responde: "COMPROBANTE DE PAGO: [monto, banco, fecha y referencia si se ven]". Si muestra piel, rostro o condición dermatológica/estética, describe clínicamente: condición, ubicación, características (manchas, rojeces, textura, melasma, acné, etc). Para cualquier otra imagen, describe brevemente qué muestra.' + (caption ? ' El usuario también escribió: ' + caption : '') + ' Sé conciso y directo.' },
            { inline_data: { mime_type: mime, data: b64 } }
          ]}],
          generationConfig: { temperature: 0.1, maxOutputTokens: 400 }
        })
      }
    );
    if (!resp.ok) { console.error('[analyzeImage] Gemini error', resp.status); return caption || null; }
    const data = await resp.json();
    const analysis = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
    if (caption && analysis) return caption + '\n[Imagen: ' + analysis + ']';
    return analysis || caption || null;
  } catch (e) {
    console.error('[analyzeImage] Error:', e.message);
    return msg.message?.imageMessage?.caption || null;
  }
}


async function connectToWhatsApp() {
  const { state, saveCreds } = await useSupabaseAuthState(supabaseClient);
  const { version } = await fetchLatestBaileysVersion();
  const logger = pino({ level: 'silent' });

  sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    printQRInTerminal: true,
    generateHighQualityLinkPreview: true,
    syncFullHistory: true,
    markOnlineOnConnect: true,
    getMessage: async (key) => {
      // Retornar undefined permite que Baileys maneje los reintentos de sesion Signal
      // correctamente. Retornar { conversation: '' } causaba un loop de prekey bundle.
      return undefined;
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrCode = qr;
      connectionState = 'qr';
      console.log('QR listo - escanea con tu telefono');
      if (sseManager) sseManager.broadcast({ type: 'qr', data: qr });
    }

    if (connection === 'close') {
      connectionState = 'disconnected';
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log('Desconectado. Razon: ', reason);
      if (sseManager) sseManager.broadcast({ type: 'connection', data: { status: 'disconnected', reason } });

      if (reason !== DisconnectReason.loggedOut) {
        if (reason === DisconnectReason.connectionReplaced) {
          // Otra instancia reemplazó esta conexión (deploy solapado).
          // NO reconectar — si reconectamos causamos otro 440 fight que corrompe
          // la sesión Signal. En su lugar, salimos limpiamente y dejamos que
          // Render reinicie este proceso UNA sola vez ya sin conflicto.
          console.log('[440] Conexion reemplazada - cerrando proceso para evitar conflicto de sesion...');
          setTimeout(() => {
            console.log('[440] Saliendo - la nueva instancia es la activa.');
            process.exit(0);
          }, 3000);
        } else {
          console.log('Reconectando en 5 segundos...');
          setTimeout(connectToWhatsApp, 5000);
        }
      } else {
        console.log('Logout. Borrando sesion...');
        await clearAuth(supabaseClient);
        qrCode = null;
        initialSyncDone = false;
      }
    }

    if (connection === 'open') {
      connectionState = 'connected';
      qrCode = null;
      console.log('WhatsApp CONECTADO');
      if (sseManager) sseManager.broadcast({ type: 'connection', data: { status: 'connected' } });
      // Guardar sesion completa en Supabase al conectar
      saveAuthToSupabase(supabaseClient).catch(() => {});
      // Update auto-reply socket reference
      updateSocket(sock);
      if (!initialSyncDone) setTimeout(runInitialSync, 3000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // DEBUG: log every upsert event to diagnose missing incoming messages
    console.log('[UPSERT] type=' + type + ' count=' + messages.length);
    for (const msg of messages) {
      const rjid = msg.key.remoteJid || 'null';
      console.log('[MSG] jid=' + rjid + ' fromMe=' + msg.key.fromMe + ' hasMsg=' + !!msg.message);
      if (isJidBroadcast(msg.key.remoteJid)) continue;
      if (msg.key.remoteJid === 'status@broadcast') continue;
      // NOTE: removed @lid filter — some real contacts use @lid JIDs in newer WA versions

      // Si msg.message es null: Bad MAC / sesion Signal corrupta.
      // Registrar siempre para diagnóstico, y resetear sesion para cualquier tipo.
      if (!msg.message) {
        const jid = msg.key.remoteJid;
        console.log('[SESSION] Mensaje nulo de', jid ? jid.split('@')[0] : 'unknown', '| type=' + type, '| fromMe=' + msg.key.fromMe);
        if (!msg.key.fromMe && jid) {
          // Resetear la sesion Signal corrupta para este contacto
          try {
            if (sock.authState && sock.authState.keys) {
              await sock.authState.keys.set({ 'session': { [jid]: null } });
              console.log('[SESSION] Sesion Signal eliminada para', jid.split('@')[0]);
              saveAuthToSupabase(supabaseClient).catch(() => {});
            }
          } catch (clearErr) {
            console.log('[SESSION] Error limpiando sesion:', clearErr.message);
          }
          // Para mensajes en tiempo real (notify), enviar zero-width space para forzar
          // nuevo intercambio de claves Signal
          if (type === 'notify') {
            try {
              await sock.sendMessage(jid, { text: '\u200b' });
              console.log('[SESSION] Reset Signal enviado a', jid.split('@')[0], '- el proximo mensaje deberia llegar correctamente');
            } catch (e) {
              console.log('[SESSION] Error enviando reset:', e.message);
            }
          }
        }
        continue;
      }
      const chatId = msg.key.remoteJid;
      const storageId = normalizeJid(chatId);
      const fromMe = msg.key.fromMe || false;
      const isGroup = isJidGroup(chatId);
      const pushName = msg.pushName || null;
      const senderName = pushName || contactCache.get(chatId) || chatId.split('@')[0];
      const messageText = extractText(msg);
      const messageType = getMessageType(msg);
      const timestamp = msg.messageTimestamp;

      // Saltar mensajes fromMe sin texto legible (protocol msgs, ACKs, mensajes del bot
      // ya guardados por auto-reply.js/routes.js) — evita bubbles vacíos en el dashboard
      if (fromMe && !messageText && messageType === 'other') {
        console.log('[SKIP] fromMe sin texto legible, tipo=other, id=' + msg.key.id?.substring(0, 8));
        continue;
      }

      if (pushName && !isGroup) contactCache.set(chatId, pushName);

      console.log((fromMe ? '-> ' : '<- ') + senderName + ': ' + (messageText || '').substring(0, 50) + ' [' + messageType + ']');

      await saveMessage(storageId, senderName, {
        messageId: msg.key.id,
        text: messageText,
        type: messageType,
        fromMe,
        timestamp: timestamp ? (typeof timestamp === 'object' ? timestamp.low : timestamp) : Math.floor(Date.now() / 1000)
      });

      /* Solo guardar en lista de chats si NO es grupo — grupos no deben aparecer en Clientes */
      if (!isGroup) {
        await upsertChat(storageId, senderName, messageText || '[' + messageType + ']',
          typeof timestamp === 'object' ? timestamp.low : timestamp
        );
      }

      if (sseManager) sseManager.broadcast({
        type: 'message',
        data: { chatId: storageId, messageId: msg.key.id, pushName, senderName, text: messageText, messageType, fromMe, isGroup, timestamp: Date.now() }
      });

      // Auto-reply: texto + audio (transcrito) + imagen (analizada con Gemini)
      if (!fromMe && !isGroup && type === 'notify') {
        let effectiveText = messageText;
        if (!effectiveText && messageType === 'audio') {
          try {
            const transcript = await transcribeAudio(msg);
            if (transcript) {
              effectiveText = transcript;
              console.log('[Audio→Texto] ' + chatId.split('@')[0] + ': ' + transcript.substring(0, 80));
            }
          } catch (e) { console.error('[transcribeAudio] error:', e.message); }
        }
        if (!effectiveText && messageType === 'image') {
          try {
            const analysis = await analyzeImage(msg);
            if (analysis) {
              effectiveText = analysis;
              console.log('[Imagen→Texto] ' + chatId.split('@')[0] + ': ' + analysis.substring(0, 80));
            }
          } catch (e) { console.error('[analyzeImage] error:', e.message); }
        }
        if (effectiveText) {
          handleIncomingMessage(chatId, effectiveText, pushName || senderName, msg.key.id).catch(err => {
            console.error('Auto-reply error:', err.message);
          });
        }
      }
    }
  });

  sock.ev.on('contacts.update', (updates) => {
    for (const { id, notify } of updates) {
      if (notify) contactCache.set(id, notify);
    }
  });

  sock.ev.on('presence.update', (update) => {
    if (sseManager) sseManager.broadcast({ type: 'presence', data: update });
  });

  // Track message delivery/read status
  sock.ev.on('messages.update', async (updates) => {
    for (const { key, update } of updates) {
      if (update.status !== undefined) {
        const statusMap = { 0: 'error', 1: 'pending', 2: 'sent', 3: 'delivered', 4: 'read', 5: 'played' };
        const statusName = statusMap[update.status] || 'unknown';
        console.log('MSG STATUS:', key.remoteJid?.split('@')[0], key.id?.substring(0,8), '->', statusName);
        // Persistir status en Supabase para que ticks sobrevivan recarga
        try { await updateMessageStatus(key.id, statusName); } catch(e) {}
        if (sseManager) sseManager.broadcast({
          type: 'message_status',
          data: {
            chatId: normalizeJid(key.remoteJid),
            messageId: key.id,
            fromMe: key.fromMe || false,
            status: update.status,
            statusName: statusName
          }
        });
      }
    }
  });
}
async function runInitialSync() {
  if (initialSyncDone) return;
  if (!sock || connectionState !== 'connected') return;

  console.log('SYNC INICIAL: Ultimos 15 chats');
  if (sseManager) sseManager.broadcast({ type: 'sync_start', data: { message: 'Sincronizando ultimos 15 chats...' } });

  try {
    let syncedChats = new Map();
    let syncTimeout = null;

    const processMsg = (msg) => {
      if (!msg.message || !msg.key?.remoteJid) return;
      if (msg.key.remoteJid.endsWith('@lid')) return;
      if (msg.key.remoteJid === 'status@broadcast') return;
      if (isJidBroadcast(msg.key.remoteJid)) return;

      const chatId = msg.key.remoteJid;
        const storageId = normalizeJid(chatId);
      if (!syncedChats.has(chatId)) {
        syncedChats.set(chatId, {
          jid: storageId,
          name: msg.pushName || contactCache.get(chatId) || chatId.split('@')[0],
          lastMessage: extractText(msg) || '[media]',
          lastTimestamp: msg.messageTimestamp,
          messages: []
        });
      }
      if (msg.pushName) contactCache.set(chatId, msg.pushName);
      const chatData = syncedChats.get(chatId);
      if (chatData.messages.length < 20) {
        chatData.messages.push({
          messageId: msg.key.id,
          text: extractText(msg),
          type: getMessageType(msg),
          fromMe: msg.key.fromMe || false,
          timestamp: msg.messageTimestamp
        });
      }
    };

    const historySyncHandler = ({ chats: hChats, contacts: hContacts, messages: hMsgs, isLatest }) => {
      console.log('HISTORY EVENT: ' + (hMsgs?.length || 0) + ' msgs, ' + (hChats?.length || 0) + ' chats, isLatest=' + isLatest);
      if (hContacts) {
        for (const c of hContacts) {
          if (c.id && c.id.endsWith('@lid')) continue;
          if (c.id && c.notify) contactCache.set(c.id, c.notify);
        }
      }
      if (hMsgs) {
        for (const msg of hMsgs) processMsg(msg);
      }
      if (hChats) {
        for (const chat of hChats) {
          if (!chat.id || chat.id === 'status@broadcast' || isJidBroadcast(chat.id)) continue;
          if (!syncedChats.has(chat.id)) {
            syncedChats.set(chat.id, {
              jid: chat.id,
              name: chat.name || contactCache.get(chat.id) || chat.id.split('@')[0],
              lastMessage: '',
              lastTimestamp: chat.conversationTimestamp,
              messages: []
            });
          }
        }
      }
      console.log('SYNC PROGRESS: ' + syncedChats.size + ' chats');
      clearTimeout(syncTimeout);
      syncTimeout = setTimeout(finishSync, isLatest ? 3000 : 8000);
    };

    const msgUpsertHandler = async ({ messages }) => {
      for (const msg of messages) processMsg(msg);
      clearTimeout(syncTimeout);
      syncTimeout = setTimeout(finishSync, 8000);
    };

    async function finishSync() {
      sock.ev.off('messaging-history.set', historySyncHandler);
      sock.ev.off('messages.upsert', msgUpsertHandler);

      if (syncedChats.size === 0) {
        console.log('No se recibio historial. Chats se sincronizan en tiempo real.');
        initialSyncDone = true;
        if (sseManager) sseManager.broadcast({ type: 'sync_complete', data: { synced: 0, message: 'Sin historial previo.' } });
        return;
      }

      const chatsArray = Array.from(syncedChats.values())
        .sort((a, b) => {
          const tsA = typeof a.lastTimestamp === 'object' ? a.lastTimestamp.low : (a.lastTimestamp || 0);
          const tsB = typeof b.lastTimestamp === 'object' ? b.lastTimestamp.low : (b.lastTimestamp || 0);
          return tsB - tsA;
        })
        .slice(0, 15);

      const result = await syncInitialChats(chatsArray);
      initialSyncDone = true;
      console.log('SYNC COMPLETO: ' + result.synced + ' chats guardados');
      if (sseManager) sseManager.broadcast({
        type: 'sync_complete',
        data: {
          synced: result.synced,
          errors: result.errors,
          chats: chatsArray.map(c => ({ jid: c.jid, name: c.name, msgs: c.messages.length }))
        }
      });
    }

    sock.ev.on('messaging-history.set', historySyncHandler);
    sock.ev.on('messages.upsert', msgUpsertHandler);
    syncTimeout = setTimeout(finishSync, 30000);

  } catch (err) {
    console.error('Error en sync inicial:', err.message);
    initialSyncDone = true;
  }
              }

function extractText(msg) {
  const m = msg.message;
  if (!m) return null;
  const inner = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message || m;
  return inner.conversation || inner.extendedTextMessage?.text || inner.imageMessage?.caption || inner.videoMessage?.caption || inner.documentMessage?.caption || inner.buttonsResponseMessage?.selectedDisplayText || inner.listResponseMessage?.title || inner.templateButtonReplyMessage?.selectedDisplayText || null;
}

function getMessageType(msg) {
  const m = msg.message;
  if (!m) return 'unknown';
  const inner = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m;
  if (inner.conversation || inner.extendedTextMessage) return 'text';
  if (inner.imageMessage) return 'image';
  if (inner.videoMessage) return 'video';
  if (inner.audioMessage) return 'audio';
  if (inner.documentMessage) return 'document';
  if (inner.stickerMessage) return 'sticker';
  if (inner.contactMessage || inner.contactsArrayMessage) return 'contact';
  if (inner.locationMessage || inner.liveLocationMessage) return 'location';
  return 'other';
}

async function getProfilePhoto(jid) {
  const cached = photoCache.get(jid);
  if (cached !== undefined) return cached;
  try {
    if (!sock || connectionState !== 'connected') return null;
    const url = await sock.profilePictureUrl(jid, 'image');
    photoCache.set(jid, url || null);
    return url || null;
  } catch {
    photoCache.set(jid, null);
    return null;
  }
}

function getContactName(jid) {
  return contactCache.get(jid) || null;
}

async function sendMessage(chatId, content) {
  const storageId = normalizeJid(chatId);
  if (!sock || connectionState !== 'connected') throw new Error('WhatsApp no esta conectado');
  const messagePayload = typeof content === 'string' ? { text: content } : content;
  const waJid = chatId.includes('@') ? chatId : chatId + '@s.whatsapp.net';
  const sent = await sock.sendMessage(waJid, messagePayload);
  const sentText = typeof content === 'string' ? content : (content.text || '[media]');

  await saveMessage(storageId, 'Sanate Bot', {
    messageId: sent.key.id,
    text: sentText,
    type: 'text',
    fromMe: true,
    timestamp: Math.floor(Date.now() / 1000)
  });

  await upsertChat(storageId, null, sentText, Math.floor(Date.now() / 1000));

  if (sseManager) sseManager.broadcast({
    type: 'message_sent',
    data: { chatId: storageId, messageId: sent.key.id, text: sentText, timestamp: Date.now() }
  });

  return sent;
}

async function disconnect() {
  if (sock) {
    await sock.logout();
    sock = null;
  }
  connectionState = 'disconnected';
  initialSyncDone = false;
}

module.exports = { initBaileys, getSocket, getQR, getConnectionState, getProfilePhoto, getContactName, sendMessage, disconnect, contactCache };
