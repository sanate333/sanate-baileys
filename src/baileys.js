const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, isJidGroup, isJidBroadcast } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const NodeCache = require('node-cache');
const path = require('path');
const { existsSync, mkdirSync, rmSync } = require('fs');
const { saveMessage, upsertChat, syncInitialChats } = require('./supabase');

let sock = null;
let qrCode = null;
let connectionState = 'disconnected';
let sseManager = null;
let supabaseClient = null;
let initialSyncDone = false;

const photoCache = new NodeCache({ stdTTL: 900, checkperiod: 120 });
const contactCache = new NodeCache({ stdTTL: 3600, checkperiod: 300 });

function getSocket() { return sock; }
function getQR() { return qrCode; }
function getConnectionState() { return connectionState; }

async function initBaileys(supabase, sse) {
  supabaseClient = supabase;
  sseManager = sse;
  const authDir = path.join(__dirname, '..', 'auth_info');
  if (!existsSync(authDir)) mkdirSync(authDir, { recursive: true });
  await connectToWhatsApp();
}

async function connectToWhatsApp() {
  const authDir = path.join(__dirname, '..', 'auth_info');
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
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
    getMessage: async (key) => ({ conversation: '' })
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
        console.log('Reconectando en 5 segundos...');
        setTimeout(connectToWhatsApp, 5000);
      } else {
        console.log('Logout. Borrando sesion...');
        const authDir2 = path.join(__dirname, '..', 'auth_info');
        rmSync(authDir2, { recursive: true, force: true });
        mkdirSync(authDir2, { recursive: true });
        qrCode = null;
        initialSyncDone = false;
      }
    }

    if (connection === 'open') {
      connectionState = 'connected';
      qrCode = null;
      console.log('WhatsApp CONECTADO');
      if (sseManager) sseManager.broadcast({ type: 'connection', data: { status: 'connected' } });
      if (!initialSyncDone) setTimeout(runInitialSync, 3000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      if (!msg.message) continue;
      if (isJidBroadcast(msg.key.remoteJid)) continue;
      if (msg.key.remoteJid === 'status@broadcast') continue;

      const chatId = msg.key.remoteJid;
      const fromMe = msg.key.fromMe || false;
      const isGroup = isJidGroup(chatId);
      const pushName = msg.pushName || null;
      const senderName = pushName || contactCache.get(chatId) || chatId.split('@')[0];
      const messageText = extractText(msg);
      const messageType = getMessageType(msg);
      const timestamp = msg.messageTimestamp;

      if (pushName && !isGroup) contactCache.set(chatId, pushName);

      console.log((fromMe ? '-> ' : '<- ') + senderName + ': ' + (messageText || '').substring(0, 50) + ' [' + messageType + ']');

      await saveMessage(chatId, senderName, {
        messageId: msg.key.id,
        text: messageText,
        type: messageType,
        fromMe,
        timestamp: timestamp ? (typeof timestamp === 'object' ? timestamp.low : timestamp) : Math.floor(Date.now() / 1000)
      });

      await upsertChat(chatId, senderName, messageText || '[' + messageType + ']',
        typeof timestamp === 'object' ? timestamp.low : timestamp
      );

      if (sseManager) sseManager.broadcast({
        type: 'message',
        data: { chatId, messageId: msg.key.id, pushName, senderName, text: messageText, messageType, fromMe, isGroup, timestamp: Date.now() }
      });
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
      if (msg.key.remoteJid === 'status@broadcast') return;
      if (isJidBroadcast(msg.key.remoteJid)) return;

      const chatId = msg.key.remoteJid;
      if (!syncedChats.has(chatId)) {
        syncedChats.set(chatId, {
          jid: chatId,
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
  if (!sock || connectionState !== 'connected') throw new Error('WhatsApp no esta conectado');
  const messagePayload = typeof content === 'string' ? { text: content } : content;
  const sent = await sock.sendMessage(chatId, messagePayload);
  const sentText = typeof content === 'string' ? content : (content.text || '[media]');

  await saveMessage(chatId, 'Sanate Bot', {
    messageId: sent.key.id,
    text: sentText,
    type: 'text',
    fromMe: true,
    timestamp: Math.floor(Date.now() / 1000)
  });

  await upsertChat(chatId, null, sentText, Math.floor(Date.now() / 1000));

  if (sseManager) sseManager.broadcast({
    type: 'message_sent',
    data: { chatId, messageId: sent.key.id, text: sentText, timestamp: Date.now() }
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
