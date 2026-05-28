 const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, } = require('@whiskeysockets/baileys');
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const fs2 = require('fs');
const pino = require('pino');
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => { if (req.path.startsWith('/api/whatsapp')) { req.url = req.url.replace('/api/whatsapp', '') || '/'; } next(); });

const SECRET = process.env.SECRET || process.env.BAILEYS_SECRET || 'sanate_secret_2025';
const PORT = process.env.PORT || 3000;
const WA_HISTORY_DAYS = 3;
const MAX_DEVICES = 10;
let currentSettings = { backendPublicUrl: '', n8nEnabled: false, n8nUrl: '', openaiKey: '', prompt: '' };

// ══════════════════════════════════════════════════════════════════
// ANTI-BAN ENGINE v1.0 — Sánate WhatsApp Bot
// ══════════════════════════════════════════════════════════════════

// --- ANTI-BAN: Browser fingerprints reales de WhatsApp Web ---
const REAL_BROWSERS = [
  ['Windows', 'Chrome', '126.0.6478.127'],
  ['Windows', 'Chrome', '125.0.6422.142'],
  ['Windows', 'Edge', '126.0.2592.87'],
  ['macOS', 'Chrome', '126.0.6478.127'],
  ['macOS', 'Safari', '17.5'],
];
function getRandomBrowser() {
  return REAL_BROWSERS[Math.floor(Math.random() * REAL_BROWSERS.length)];
}

// --- ANTI-BAN: Backoff exponencial para reconexión ---
const reconnectAttempts = new Map();
function getReconnectDelay(deviceId) {
  const data = reconnectAttempts.get(deviceId) || { count: 0, lastAttempt: 0 };
  data.count++;
  data.lastAttempt = Date.now();
  reconnectAttempts.set(deviceId, data);
  const delays = [5000, 15000, 30000, 60000, 120000, 300000];
  const idx = Math.min(data.count - 1, delays.length - 1);
  const base = delays[idx];
  const jitter = base * 0.2 * (Math.random() * 2 - 1);
  return Math.round(base + jitter);
}
function resetReconnectCount(deviceId) {
  reconnectAttempts.delete(deviceId);
}

// --- ANTI-BAN: Límite de QR attempts ---
const MAX_QR_ATTEMPTS = 5;
const QR_COOLDOWN_MS = 3 * 60 * 1000;
const qrAttempts = new Map();
function canGenerateQR(deviceId) {
  const data = qrAttempts.get(deviceId) || { count: 0, firstAttempt: 0, cooldownUntil: 0 };
  if (Date.now() < data.cooldownUntil) {
    const remaining = Math.ceil((data.cooldownUntil - Date.now()) / 1000);
    return { allowed: false, reason: `Cooldown activo. Espera ${remaining}s para evitar ban.`, remaining };
  }
  if (data.firstAttempt && Date.now() - data.firstAttempt > 10 * 60 * 1000) {
    qrAttempts.set(deviceId, { count: 0, firstAttempt: 0, cooldownUntil: 0 });
    return { allowed: true };
  }
  if (data.count >= MAX_QR_ATTEMPTS) {
    data.cooldownUntil = Date.now() + QR_COOLDOWN_MS;
    qrAttempts.set(deviceId, data);
    return { allowed: false, reason: `Máximo ${MAX_QR_ATTEMPTS} intentos alcanzado. Cooldown de 3 minutos.`, remaining: QR_COOLDOWN_MS / 1000 };
  }
  return { allowed: true };
}
function trackQRAttempt(deviceId) {
  const data = qrAttempts.get(deviceId) || { count: 0, firstAttempt: 0, cooldownUntil: 0 };
  if (!data.firstAttempt) data.firstAttempt = Date.now();
  data.count++;
  qrAttempts.set(deviceId, data);
}

// --- ANTI-BAN: Rate limiting para envíos basado en warmup ---
const warmupDay = {};
function getWarmupState(deviceId) {
  const state = warmupDay[deviceId] || { connectedSince: Date.now(), dailySent: 0, lastSentAt: 0, lastReset: new Date().toDateString() };
  const today = new Date().toDateString();
  if (state.lastReset !== today) {
    state.dailySent = 0;
    state.lastReset = today;
  }
  const daysSinceConnect = Math.floor((Date.now() - state.connectedSince) / 86400000);
  const day = Math.min(daysSinceConnect + 1, 14);
  const LIMITS = {
    1: { perDay: 20, perHour: 5, perMinute: 1, canBroadcast: false },
    2: { perDay: 50, perHour: 10, perMinute: 2, canBroadcast: false },
    3: { perDay: 100, perHour: 20, perMinute: 3, canBroadcast: false },
    4: { perDay: 150, perHour: 30, perMinute: 4, canBroadcast: false },
    5: { perDay: 200, perHour: 40, perMinute: 5, canBroadcast: false },
    6: { perDay: 300, perHour: 50, perMinute: 6, canBroadcast: false },
    7: { perDay: 400, perHour: 60, perMinute: 8, canBroadcast: true, maxBroadcast: 50 },
    8: { perDay: 500, perHour: 80, perMinute: 10, canBroadcast: true, maxBroadcast: 100 },
    9: { perDay: 600, perHour: 100, perMinute: 12, canBroadcast: true, maxBroadcast: 150 },
    10: { perDay: 700, perHour: 120, perMinute: 15, canBroadcast: true, maxBroadcast: 200 },
    11: { perDay: 800, perHour: 150, perMinute: 18, canBroadcast: true, maxBroadcast: 300 },
    12: { perDay: 900, perHour: 180, perMinute: 20, canBroadcast: true, maxBroadcast: 400 },
    13: { perDay: 1000, perHour: 200, perMinute: 25, canBroadcast: true, maxBroadcast: 500 },
    14: { perDay: 1200, perHour: 250, perMinute: 30, canBroadcast: true, maxBroadcast: 800 },
  };
  const limits = LIMITS[day] || LIMITS[14];
  warmupDay[deviceId] = state;
  return { day, state, limits, dailySent: state.dailySent };
}

function canSendMessage(deviceId) {
  const { day, state, limits } = getWarmupState(deviceId);
  if (state.dailySent >= limits.perDay) {
    return { allowed: false, reason: `Límite diario alcanzado (${state.dailySent}/${limits.perDay}). Día ${day} de warmup.` };
  }
  if (state.lastSentAt && Date.now() - state.lastSentAt < (60000 / limits.perMinute)) {
    return { allowed: false, reason: `Demasiado rápido. Espera unos segundos.` };
  }
  return { allowed: true };
}

function trackSentMessage(deviceId) {
  const state = warmupDay[deviceId] || { connectedSince: Date.now(), dailySent: 0, lastSentAt: 0, lastReset: new Date().toDateString() };
  state.dailySent++;
  state.lastSentAt = Date.now();
  warmupDay[deviceId] = state;
}

// --- ANTI-BAN: Presencia intermitente (simula humano) ---
function startPresenceSimulation(sock, deviceId) {
  const intervals = [];
  function simulatePresence() {
    if (!sock || !sock.user) return;
    try { sock.sendPresenceUpdate('unavailable'); } catch(e) {}
    const nextOnline = (5 + Math.random() * 10) * 60 * 1000;
    const onlineDuration = (1 + Math.random() * 2) * 60 * 1000;
    const timer = setTimeout(() => {
      try {
        sock.sendPresenceUpdate('available');
        setTimeout(() => {
          try { sock.sendPresenceUpdate('unavailable'); } catch(e) {}
          simulatePresence();
        }, onlineDuration);
      } catch(e) {}
    }, nextOnline);
    intervals.push(timer);
  }
  setTimeout(simulatePresence, 30000);
  return () => intervals.forEach(t => clearTimeout(t));
}

// ══ Multi-device store ══════════════════════════════════════════════
const devices = new Map();
function getDevice(id) {
  const did = String(id || 'default');
  if (!devices.has(did)) {
    devices.set(did, {
      id: did, sock: null, status: 'disconnected', qr: null, reconnectTimer: null, sseClients: new Set(),
      waChats: new Map(), waMessages: new Map(), waAvatars: new Map(),
      waLifecycle: new Map(), waContacts: new Map(), waSentWelcome: new Set(), waWelcomeTemplate: '',
    });
  }
  return devices.get(did);
}
getDevice('default');

function nJ(jid) {
  if (!jid) return jid;
  if (jid.endsWith('@g.us') || jid.endsWith('@lid') || jid === 'status@broadcast') return jid;
  return jid.replace(/@s\.whatsapp\.net$/, '');
}

function broadcastSSE(dev, event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of dev.sseClients) {
    try { client.write(msg); } catch(e) { dev.sseClients.delete(client); }
  }
}

// ══ Contact persistence ═════════════════════════════════════════════
function contactsFile(deviceId) { return './contacts_' + deviceId + '.json'; }
function saveContacts(dev) {
  try {
    const data = {};
    dev.waContacts.forEach((v, k) => { data[k] = v; });
    fs2.writeFileSync(contactsFile(dev.id), JSON.stringify(data), 'utf8');
  } catch(e) { console.error('saveContacts:', e.message); }
}
function loadContacts(dev) {
  try {
    const f = contactsFile(dev.id);
    if (fs2.existsSync(f)) {
      const data = JSON.parse(fs2.readFileSync(f, 'utf8'));
      Object.entries(data).forEach(([k, v]) => { dev.waContacts.set(k, v); });
      console.log('Loaded ' + Object.keys(data).length + ' contacts for device ' + dev.id);
    }
  } catch(e) { console.error('loadContacts:', e.message); }
}

// ══ OpenAI auto-lead classification ═════════════════════════════════
async function autoClassifyLead(dev, jid) {
  try {
    const msgs = dev.waMessages.get(jid) || [];
    if (!msgs.length) return;
    const existing = dev.waLifecycle.get(jid);
    if (existing && existing.source === 'manual') return;
    const allText = msgs.map(m => m.body || '').join(' ').toLowerCase();
    let stage = 'nuevo';
    let source = 'regex';
    if (process.env.OPENAI_API_KEY) {
      try {
        const recentMsgs = msgs.slice(-10).map(m => (m.fromMe ? 'Agente: ' : 'Cliente: ') + (m.body || '[media]')).join('\n');
        const resp = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY },
          body: JSON.stringify({
            model: 'gpt-3.5-turbo',
            messages: [
              { role: 'system', content: 'Eres un clasificador de leads de WhatsApp. Analiza la conversación y responde SOLO con una de estas palabras: nuevo, potencial, cliente, perdido. Reglas: nuevo=primer contacto o saludo inicial, potencial=mostró interés en productos/precios, cliente=realizó una compra o confirmó pedido, perdido=sin interés o inactivo más de 7 días.' },
              { role: 'user', content: recentMsgs }
            ],
            max_tokens: 10, temperature: 0,
          })
        });
        const data = await resp.json();
        const result = (data.choices?.[0]?.message?.content || '').trim().toLowerCase().replace(/[^a-z]/g,'');
        if (['nuevo','potencial','cliente','perdido'].includes(result)) { stage = result; source = 'openai'; }
      } catch(e) { /* fall through to regex */ }
    }
    if (source === 'regex') {
      if (/compr[eé]|pedido|pagu[eé]|confirmar|recib[ií]|compró|compre/.test(allText)) { stage = 'cliente'; }
      else if (/precio|cu[aá]nto|costo|cuesta|informaci[oó]n|interesa|quiero|disponible|cómo funciona|más info/.test(allText)) { stage = 'potencial'; }
      else { const last = msgs[msgs.length-1]; const days = (Date.now()-(last.ts||0))/864e5; stage = days>7?'perdido':'potencial'; }
    }
    dev.waLifecycle.set(jid, { stage, updatedAt: Date.now(), source });
  } catch(e) { console.error('autoClassifyLead:', e.message); }
}

// ══ Broadcast queue ═════════════════════════════════════════════════
const broadcastJobs = new Map();
const JOBS_FILE = './broadcast_jobs.json';
function saveJobs() { try { fs2.writeFileSync(JOBS_FILE, JSON.stringify(Array.from(broadcastJobs.entries())), 'utf8'); } catch(e){} }
function loadJobs() { try { if (fs2.existsSync(JOBS_FILE)) { for (const [id, job] of JSON.parse(fs2.readFileSync(JOBS_FILE,"utf8"))) broadcastJobs.set(id, job); } } catch(e){} }
function inSchedule(job) { const now = new Date(); const cur = now.getHours()*60+now.getMinutes(); const st=(job.startHour??10)*60+(job.startMin??0); const en=(job.endHour??18)*60+(job.endMin??33); return cur>=st&&cur<en; }
const DELAYS = { veryShort:3000, short:12000, medium:35000, large:85000, veryLarge:210000 };

// ══ ANTI-BAN: Broadcast loop con warmup check y rate-limiting ═══════
setInterval(async () => {
  for (const [, job] of broadcastJobs) {
    if (job.status !== 'running') { if (job.status==='paused_schedule'&&inSchedule(job)) job.status='running'; continue; }
    if (!inSchedule(job)) { job.status='paused_schedule'; saveJobs(); continue; }
    if (job.position>=(job.numbers||[]).length) { job.status='completed'; job.completedAt=Date.now(); saveJobs(); continue; }

    let devId=job.deviceId||'default';
    if (job.rotateDevices&&job.deviceIds?.length>1) { const idx=Math.floor(job.position/(job.rotateEvery||3))%job.deviceIds.length; devId=job.deviceIds[idx]; }
    const dev=getDevice(devId);
    if (!dev.sock||dev.status!=='connected') continue;

    // ══════ ANTI-BAN: Verificar warmup antes de broadcast ══════
    const warmup = getWarmupState(devId);
    if (!warmup.limits.canBroadcast) {
      job.status = 'paused_warmup';
      job.pauseReason = `Número en día ${warmup.day}/14 — difusiones no permitidas hasta día 7`;
      saveJobs();
      console.log(`[ANTI-BAN] Broadcast ${job.id} pausado: ${job.pauseReason}`);
      continue;
    }

    const rateCheck = canSendMessage(devId);
    if (!rateCheck.allowed) {
      console.log(`[ANTI-BAN] Broadcast rate-limited: ${rateCheck.reason}`);
      continue;
    }

    const raw=String(job.numbers[job.position]).replace(/\D/g,'');
    const jid=raw+'@s.whatsapp.net';
    try {
      // ══════ ANTI-BAN: Typing simulation antes de broadcast ══════
      await dev.sock.sendPresenceUpdate('composing', jid).catch(() => {});
      await new Promise(r => setTimeout(r, 1500 + Math.random() * 2500));
      await dev.sock.sendPresenceUpdate('paused', jid).catch(() => {});

      if (job.mediaUrl) { await dev.sock.sendMessage(jid,{image:{url:job.mediaUrl},caption:job.message||''}); }
      else { await dev.sock.sendMessage(jid,{text:job.message}); }

      trackSentMessage(devId);
      job.position++; job.sentCount=(job.sentCount||0)+1; job.lastSentAt=Date.now(); saveJobs();
    } catch(e) { job.errors=(job.errors||0)+1; }

    // ══════ ANTI-BAN: Delays más largos y humanizados ══════
    const base=DELAYS[job.delayType]||DELAYS.short;
    const humanized = base + Math.random() * base * 0.5 + Math.random() * 5000;
    await new Promise(r=>setTimeout(r,humanized));
    break;
  }
}, 6000);

// ══ storeMsg ════════════════════════════════════════════════════════
function storeMsg(dev, msg) {
  try {
    const cutoff = Date.now() - WA_HISTORY_DAYS*86400000;
    const ts = (msg.messageTimestamp||0)*1000;
    if (ts && ts < cutoff) return;
    const jid = nJ(msg.key?.remoteJid);
    if (!jid || jid === 'status@broadcast') return;
    const m = msg.message || {};
    const body = m.conversation || m.extendedTextMessage?.text
      || (m.imageMessage&&(m.imageMessage.caption||'[Imagen]'))
      || (m.videoMessage&&(m.videoMessage.caption||'[Video]'))
      || (m.audioMessage&&'[Audio]') || (m.documentMessage&&'[Documento]')
      || (m.stickerMessage&&'[Sticker]')
      || m.buttonsResponseMessage?.selectedDisplayText
      || m.listResponseMessage?.title || '[Mensaje]';
    const name = msg.pushName || dev.waContacts.get(jid) || dev.waChats.get(jid)?.name || jid.split('@')[0];
    if (msg.pushName) { dev.waContacts.set(jid, msg.pushName); }
    const prev = dev.waChats.get(jid) || {};
    dev.waChats.set(jid, { id:jid, name, unread:(prev.unread||0)+(msg.key?.fromMe?0:1), lastMsg:body, ts:ts||prev.ts||Date.now() });
      broadcastSSE(dev, 'chat_update', { id: jid, name, lastMsg: body, ts: ts||prev.ts||Date.now(), unread: (prev.unread||0)+(msg.key?.fromMe?0:1) });
    const arr = dev.waMessages.get(jid) || [];
    arr.push({ id:msg.key?.id, fromMe:!!msg.key?.fromMe, body, ts, type:Object.keys(m)[0]||'unknown', mediaUrl:m.imageMessage?.url||m.videoMessage?.url||null, mimetype:m.imageMessage?.mimetype||m.videoMessage?.mimetype||null });
    if (arr.length>200) arr.splice(0,arr.length-200);
    dev.waMessages.set(jid, arr);
  } catch(e){ console.error('storeMsg:', e.message); }
}

// ══ connectDevice — ANTI-BAN ENHANCED ═══════════════════════════════
async function connectDevice(deviceId) {
  const dev = getDevice(deviceId);
  try {
    const AUTH_DIR = './auth_'+deviceId;
    if (!fs2.existsSync(AUTH_DIR)) fs2.mkdirSync(AUTH_DIR,{recursive:true});
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    // ══════ ANTI-BAN: Verificar QR cooldown ══════
    const qrCheck = canGenerateQR(deviceId);
    if (!qrCheck.allowed) {
      console.log(`[ANTI-BAN] QR bloqueado para ${deviceId}: ${qrCheck.reason}`);
      dev.status = 'qr_cooldown';
      broadcastSSE(dev, 'status', { status: 'qr_cooldown', reason: qrCheck.reason, remaining: qrCheck.remaining });
      if (dev.reconnectTimer) clearTimeout(dev.reconnectTimer);
      dev.reconnectTimer = setTimeout(() => connectDevice(deviceId), (qrCheck.remaining + 5) * 1000);
      return;
    }

    // ══════ ANTI-BAN: Browser fingerprint real de WhatsApp Web ══════
    const browserFingerprint = getRandomBrowser();
    console.log(`[ANTI-BAN] Conectando ${deviceId} como: ${browserFingerprint.join(' / ')}`);

    dev.sock = makeWASocket({
      version, auth: state, printQRInTerminal: false, logger: pino({level:'silent'}),

      // ══════ ANTI-BAN: Fingerprint idéntico a WhatsApp Web oficial ══════
      browser: browserFingerprint,

      // ══════ ANTI-BAN: NO marcar online automáticamente ══════
      markOnlineOnConnect: false,

      // ══════ ANTI-BAN: Timeouts conservadores ══════
      connectTimeoutMs: 60000, defaultQueryTimeoutMs: 60000, keepAliveIntervalMs: 25000,

      // ══════ ANTI-BAN: NO sincronizar historial completo ══════
      syncFullHistory: false,
      shouldSyncHistoryMessage: (msg) => {
        const ts = (msg.messageTimestamp || 0) * 1000;
        return !ts || ts > Date.now() - 3 * 86400000;
      },

      // ══════ ANTI-BAN: Reducir huella de tráfico ══════
      generateHighQualityLinkPreview: false,
      getMessage: async () => { return { conversation: '' }; },
    });

    let presenceCleanup = null;

    dev.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        // ══════ ANTI-BAN: Trackear intentos de QR ══════
        trackQRAttempt(deviceId);
        const qrState = qrAttempts.get(deviceId);
        console.log(`[ANTI-BAN] QR generado para ${deviceId} (intento ${qrState.count}/${MAX_QR_ATTEMPTS})`);

        dev.qr = qr;
        dev.status = 'qr';
        broadcastSSE(dev, 'qr', { qr, attempt: qrState.count, maxAttempts: MAX_QR_ATTEMPTS });
      }

      if (connection === 'close') {
        dev.status = 'disconnected';
        dev.qr = null;
        if (presenceCleanup) { presenceCleanup(); presenceCleanup = null; }
        broadcastSSE(dev, 'status', { status: 'disconnected' });

        const code = lastDisconnect?.error?.output?.statusCode;

        if (code === DisconnectReason.loggedOut) {
          console.log(`[ANTI-BAN] ${deviceId} deslogueado — NO reconectar automáticamente`);
          if (fs2.existsSync(AUTH_DIR)) fs2.rmSync(AUTH_DIR, { recursive: true });
          resetReconnectCount(deviceId);
          return;
        }

        // ══════ ANTI-BAN: Backoff exponencial ══════
        const delay = getReconnectDelay(deviceId);
        console.log(`[ANTI-BAN] Reconectando ${deviceId} en ${delay / 1000}s (intento ${reconnectAttempts.get(deviceId)?.count || 1})`);

        if (dev.reconnectTimer) clearTimeout(dev.reconnectTimer);
        dev.reconnectTimer = setTimeout(() => connectDevice(deviceId), delay);
      }

      if (connection === 'open') {
        dev.status = 'connected';
        dev.qr = null;

        // ══════ ANTI-BAN: Reset contadores al conectar exitosamente ══════
        resetReconnectCount(deviceId);
        qrAttempts.delete(deviceId);

        // ══════ ANTI-BAN: Inicializar warmup tracker ══════
        if (!warmupDay[deviceId]) {
          warmupDay[deviceId] = { connectedSince: Date.now(), dailySent: 0, lastSentAt: 0, lastReset: new Date().toDateString() };
        }

        // ══════ ANTI-BAN: Presencia intermitente ══════
        presenceCleanup = startPresenceSimulation(dev.sock, deviceId);

        broadcastSSE(dev, 'status', { status: 'connected' });
        const warmupInfo = getWarmupState(deviceId);
        console.log(`[ANTI-BAN] Conectado ${deviceId} — Día ${warmupInfo.day}/14, límite: ${warmupInfo.limits.perDay}/día`);
      }
    });

    dev.sock.ev.on('creds.update', saveCreds);

    dev.sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type!=='notify'&&type!=='append') return;
      for (const msg of messages) storeMsg(dev, msg);
      messages.forEach(m => {
        if (m.pushName&&m.key?.remoteJid) { dev.waContacts.set(nJ(m.key.remoteJid), m.pushName); }
        const fromJid = m.key?.remoteJid;
        const fromKey = nJ(fromJid);
        if (fromKey&&!fromKey.endsWith('@g.us')&&m.key&&!m.key.fromMe) {
          setTimeout(() => autoClassifyLead(dev, fromKey), 1000);
          if (dev.waWelcomeTemplate&&!dev.waSentWelcome.has(fromKey)) {
            const msgs = dev.waMessages.get(fromKey)||[];
            if (msgs.length<=1) {
              dev.waSentWelcome.add(fromKey);
              // ══════ ANTI-BAN: Delay humanizado para welcome ══════
              const humanDelay = 3000 + Math.random() * 5000;
              setTimeout(() => {
                if (dev.sock&&dev.status==='connected') {
                  dev.sock.sendPresenceUpdate('composing', fromJid).catch(() => {});
                  setTimeout(() => {
                    dev.sock.sendMessage(fromJid,{text:dev.waWelcomeTemplate}).catch(()=>{});
                    dev.sock.sendPresenceUpdate('paused', fromJid).catch(() => {});
                    trackSentMessage(deviceId);
                  }, 2000 + Math.random() * 3000);
                }
              }, humanDelay);
            }
          }
        }
      });
      setTimeout(() => saveContacts(dev), 3000);
    });

    dev.sock.ev.on('messaging-history.set', ({ chats, messages, isLatest }) => {
      console.log('history.set device='+deviceId+': '+chats.length+' chats '+messages.length+' msgs isLatest='+isLatest);
      const cutoff = Date.now()-3*86400000;
      for (const chat of chats) {
        if (!chat.id||chat.id==='status@broadcast') continue;
        const cid = nJ(chat.id);
        if (!dev.waChats.has(cid)) {
          dev.waChats.set(cid, { id:cid, name:dev.waContacts.get(cid)||chat.name||cid.split('@')[0], unread:chat.unreadCount||0, lastMsg:'', ts:Date.now() });
        }
      }
      for (const msg of messages) { const ts=(msg.messageTimestamp||0)*1000; if (ts&&ts<cutoff) continue; storeMsg(dev,msg); }
      console.log('After history device='+deviceId+': chats='+dev.waChats.size);
    });

    dev.sock.ev.on('chats.upsert', (chats) => {
      for (const chat of chats) {
        if (!chat.id||chat.id==='status@broadcast') continue;
        const cid = nJ(chat.id);
        const prev = dev.waChats.get(cid)||{};
        dev.waChats.set(cid, { ...prev, id:cid, name:dev.waContacts.get(cid)||chat.name||prev.name||cid.split('@')[0], unread:chat.unreadCount!==undefined?chat.unreadCount:(prev.unread||0), ts:prev.ts||Date.now() });
      }
    });

    dev.sock.ev.on('contacts.upsert', contacts => {
      contacts.forEach(c => {
        const name = c.notify||c.name||c.verifiedName;
        const cid = nJ(c.id);
        if (name) {
          dev.waContacts.set(cid, name);
          if (dev.waChats.has(cid)) dev.waChats.set(cid,{...dev.waChats.get(cid),name});
        }
      });
      setTimeout(() => saveContacts(dev), 2000);
    });

  } catch(err) {
    console.error('connectDevice error device='+deviceId+':', err.message);
    // ══════ ANTI-BAN: Backoff exponencial en error ══════
    const delay = getReconnectDelay(deviceId);
    if (dev.reconnectTimer) clearTimeout(dev.reconnectTimer);
    dev.reconnectTimer = setTimeout(()=>connectDevice(deviceId), delay);
  }
}

// ══ Auth middleware ══════════════════════════════════════════════════
const auth = (req,res,next) => { const s=req.headers['x-secret']||req.query.secret; if (s!==SECRET) return res.status(401).json({error:'No autorizado'}); next(); };

// ══ Health / Ping ═══════════════════════════════════════════════════
app.get('/health', (req,res) => { const d=getDevice('default'); res.json({ok:true,status:d.status,hasQR:!!d.qr}); });
app.get('/ping', (req,res) => { const d=getDevice('default'); res.json({v:'3.2-antiban',chats:d.waChats.size,msgs:d.waMessages.size,status:d.status,ts:Date.now()}); });

// ══ Devices ═════════════════════════════════════════════════════════
app.get('/devices', auth, (req,res) => { res.json({devices:Array.from(devices.entries()).map(([id,d])=>({id,status:d.status,hasQR:!!d.qr,chats:d.waChats.size,contacts:d.waContacts.size}))}); });
app.post('/devices', auth, async (req,res) => {
  const { deviceId } = req.body;
  if (!deviceId) return res.status(400).json({error:'deviceId requerido'});
  if (Array.from(devices.keys()).filter(k=>k!=='default').length>=MAX_DEVICES-1) return res.status(400).json({error:'Máximo '+MAX_DEVICES+' dispositivos'});
  getDevice(deviceId); await connectDevice(deviceId); res.json({ok:true,deviceId});
});
app.delete('/devices/:deviceId', auth, async (req,res) => {
  const { deviceId } = req.params;
  if (deviceId==='default') return res.status(400).json({error:'No se puede eliminar el dispositivo principal'});
  const dev=devices.get(deviceId);
  if (!dev) return res.status(404).json({error:'No encontrado'});
  if (dev.sock) try { await dev.sock.logout(); } catch(e){}
  if (dev.reconnectTimer) clearTimeout(dev.reconnectTimer);
  const dir='./auth_'+deviceId;
  if (fs2.existsSync(dir)) fs2.rmSync(dir,{recursive:true});
  devices.delete(deviceId); res.json({ok:true});
});

// ══ Status / QR ═════════════════════════════════════════════════════
app.get('/events', auth, (req, res) => {
  const did = req.query.deviceId || 'default';
  const dev = devices.get(did);
  if (!dev) return res.status(404).end();
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  dev.sseClients.add(res);
  const keepAlive = setInterval(() => { try { res.write(':ping\n\n'); } catch(e) {} }, 25000);
  req.on('close', () => { clearInterval(keepAlive); dev.sseClients.delete(res); });
});

app.get('/status', auth, (req,res) => { const d=getDevice(req.query.deviceId||'default'); res.json({status:d.status,hasQR:!!d.qr}); });
app.get('/qr', auth, async (req,res) => {
  const d=getDevice(req.query.deviceId||'default');
  if (!d.qr) return res.json({qr:null,status:d.status});
  try { const qrDataUrl=await qrcode.toDataURL(d.qr,{width:500,margin:2,errorCorrectionLevel:'M'}); res.json({qr:qrDataUrl,status:d.status}); }
  catch(e) { res.status(500).json({error:e.message}); }
});

// ══ Sync (force reload) ═════════════════════════════════════════════
app.post('/sync', auth, (req,res) => {
  const dev = getDevice(req.query.deviceId||req.body?.deviceId||'default');
  res.json({ ok:true, chats:dev.waChats.size, contacts:dev.waContacts.size, messages:dev.waMessages.size });
});

// ══ Chats ════════════════════════════════════════════════════════════
app.get('/chats', auth, (req,res) => {
  const dev = getDevice(req.query.deviceId||'default');
  const all = Array.from(dev.waChats.values());
  const sortTs = (a,b) => (b.ts||0)-(a.ts||0);
  const withMsgs = all.filter(c=>dev.waMessages.has(c.id)).sort(sortTs);
  const noMsgs = all.filter(c=>!dev.waMessages.has(c.id)).sort(sortTs);
  const sorted = [...withMsgs,...noMsgs].slice(0,100);
  res.json({ chats: sorted.map(chat => ({
    id: chat.id, phone: chat.id.split('@')[0], preview: chat.lastMsg||'',
    time: chat.ts ? new Date(chat.ts).toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'}) : '',
    unread: chat.unread||0,
    name: dev.waContacts.get(chat.id)||chat.name||chat.id.split('@')[0],
    isGroup: chat.id.endsWith('@g.us'),
    avatar: dev.waAvatars.get(chat.id)||null,
    lifecycle: dev.waLifecycle.get(chat.id)||null,
  }))});
});

// ══ Messages ════════════════════════════════════════════════════════
function getMessages(dev, jid) {
  let msgs = dev.waMessages.get(jid)||[];
  if (!msgs.length && !jid.includes('@')) msgs = dev.waMessages.get(jid+'@s.whatsapp.net')||[];
  if (dev.waChats.has(jid)) dev.waChats.set(jid,{...dev.waChats.get(jid),unread:0});
  return msgs.slice(-50).map(msg => ({
    id:msg.id, dir:msg.fromMe?'s':'r', txt:msg.body||'',
    time: msg.ts?new Date(msg.ts).toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'}):'',
    ts:msg.ts, mediaUrl:msg.mediaUrl||null, mimetype:msg.mimetype||null,
  })).filter(m => m.txt || m.mediaUrl);
}
app.get('/messages/:id', auth, (req,res) => {
  const dev = getDevice(req.query.deviceId||'default');
  const jid = decodeURIComponent(req.params.id);
  res.json({ messages: getMessages(dev, jid) });
});
app.get('/chats/:id/messages', auth, (req,res) => {
  const dev = getDevice(req.query.deviceId||'default');
  const jid = decodeURIComponent(req.params.id);
  res.json({ messages: getMessages(dev, jid) });
});

// ══ Send text — ANTI-BAN con rate-limiting y typing ═════════════════
app.post('/send', auth, async (req,res) => {
  const { to, message, deviceId } = req.body;
  const did = deviceId || 'default';
  const dev = getDevice(did);
  if (!dev.sock||dev.status!=='connected') return res.status(400).json({error:'No conectado'});

  // ══════ ANTI-BAN: Rate limiting por warmup ══════
  const rateCheck = canSendMessage(did);
  if (!rateCheck.allowed) {
    return res.status(429).json({ error: rateCheck.reason, warmup: getWarmupState(did) });
  }

  try {
    const jid = to.includes('@s.whatsapp.net') ? to : to + '@s.whatsapp.net';
    const key = nJ(jid);

    // ══════ ANTI-BAN: Simular typing antes de enviar ══════
    try {
      await dev.sock.sendPresenceUpdate('composing', jid);
      const typingDelay = Math.min(1000 + (message.length * 30), 8000);
      await new Promise(r => setTimeout(r, typingDelay));
      await dev.sock.sendPresenceUpdate('paused', jid);
    } catch(e) { /* presencia no crítica */ }

    const result = await dev.sock.sendMessage(jid, { text: message });

    // ══════ ANTI-BAN: Trackear envío ══════
    trackSentMessage(did);

    const arr = dev.waMessages.get(key) || [];
    arr.push({ id: result.key.id, body: message, fromMe: true, ts: Date.now() });
    if (arr.length > 500) arr.splice(0, arr.length - 500);
    dev.waMessages.set(key, arr);
    const chatPrev = dev.waChats.get(key) || {};
    dev.waChats.set(key, { ...chatPrev, id:key, name:dev.waContacts.get(key)||chatPrev.name||key, lastMsg:message, ts:Date.now() });

    const warmup = getWarmupState(did);
    res.json({ success: true, messageId: result.key.id, warmup: { day: warmup.day, sent: warmup.dailySent, limit: warmup.limits.perDay } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══ Send buttons ════════════════════════════════════════════════════
app.post('/send-buttons', auth, async (req,res) => {
  const { to, text, footer, buttons, deviceId } = req.body;
  const dev = getDevice(deviceId||'default');
  if (!dev.sock||dev.status!=='connected') return res.status(400).json({error:'No conectado'});
  try {
    const jid=to.includes('@')?to:to.replace(/\D/g,'')+('@s.whatsapp.net');
    const waButtons=(buttons||[]).map((b,i)=>({buttonId:b.id||String(i+1),buttonText:{displayText:b.text||b.label||('Opción '+(i+1))},type:1}));
    await dev.sock.sendMessage(jid,{text:text||'',footer:footer||'',buttons:waButtons,headerType:1});
    res.json({ok:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ══ Send template buttons ═══════════════════════════════════════════
app.post('/send-template', auth, async (req,res) => {
  const { to, text, templateButtons, deviceId } = req.body;
  const dev = getDevice(deviceId||'default');
  if (!dev.sock||dev.status!=='connected') return res.status(400).json({error:'No conectado'});
  try {
    const jid=to.includes('@')?to:to.replace(/\D/g,'')+('@s.whatsapp.net');
    await dev.sock.sendMessage(jid,{text:text||'',templateButtons:templateButtons||[]});
    res.json({ok:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── Send list ───────────────────────────────────────────────────────
app.post('/send-list', auth, async (req,res) => {
  const { to, text, footer, title, buttonText, sections, deviceId } = req.body;
  const dev = getDevice(deviceId||'default');
  if (!dev.sock||dev.status!=='connected') return res.status(400).json({error:'No conectado'});
  try {
    const jid = to.includes('@') ? to : to.replace(/\D/g,'') + '@s.whatsapp.net';
    const key = nJ(jid);
    const result = await dev.sock.sendMessage(jid, {
      text: text || '',
      footer: footer || '',
      title: title || '',
      buttonText: buttonText || 'Ver opciones',
      sections: sections || []
    });
    const arr = dev.waMessages.get(key) || [];
    arr.push({ id: result.key.id, body: '[Lista: ' + (buttonText||'Ver opciones') + ']', fromMe: true, ts: Date.now() });
    if (arr.length > 500) arr.splice(0, arr.length - 500);
    dev.waMessages.set(key, arr);
    const chatPrev = dev.waChats.get(key) || {};
    dev.waChats.set(key, { ...chatPrev, id:key, name:dev.waContacts.get(key)||chatPrev.name||key, lastMsg:'[Lista]', ts:Date.now() });
    res.json({ ok: true, messageId: result.key.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ Broadcast CRUD ══════════════════════════════════════════════════
app.get('/broadcast', auth, (req,res) => { res.json({jobs:Array.from(broadcastJobs.values()).map(j=>({...j,numbers:undefined,totalNumbers:(j.numbers||[]).length}))}); });
app.post('/broadcast', auth, (req,res) => {
  const { name, numbers, message, mediaUrl, delayType, deviceId, deviceIds, rotateDevices, rotateEvery, startHour, startMin, endHour, endMin } = req.body;
  if (!numbers?.length||!message) return res.status(400).json({error:'numbers y message requeridos'});
  const jobId='job_'+Date.now();
  broadcastJobs.set(jobId,{ id:jobId, name:name||('Difusión '+new Date().toLocaleDateString('es-ES')), numbers:numbers.map(n=>String(n).replace(/\D/g,'')), message, mediaUrl:mediaUrl||null, delayType:delayType||'short', deviceId:deviceId||'default', deviceIds, rotateDevices:!!rotateDevices, rotateEvery:rotateEvery||3, startHour:startHour??10, startMin:startMin??0, endHour:endHour??18, endMin:endMin??33, status:'running', position:0, sentCount:0, errors:0, createdAt:Date.now(), lastSentAt:null });
  saveJobs(); res.json({ok:true,jobId});
});
app.patch('/broadcast/:jobId', auth, (req,res) => {
  const job=broadcastJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({error:'No encontrado'});
  if (req.body.status) job.status=req.body.status; saveJobs();
  res.json({ok:true,job:{...job,numbers:undefined,totalNumbers:(job.numbers||[]).length}});
});
app.delete('/broadcast/:jobId', auth, (req,res) => { broadcastJobs.delete(req.params.jobId); saveJobs(); res.json({ok:true}); });

// ══ Photo ═══════════════════════════════════════════════════════════
app.get('/chats/:id/photo', auth, async (req,res) => {
  const dev=getDevice(req.query.deviceId||'default');
  const jid=decodeURIComponent(req.params.id);
  if (dev.waAvatars.has(jid)) return res.json({ok:!!dev.waAvatars.get(jid),photoUrl:dev.waAvatars.get(jid)||null});
  try {
    if (!dev.sock||dev.status!=='connected') return res.json({ok:false,photoUrl:null});
    const url=await dev.sock.profilePictureUrl(jid,'image').catch(()=>null);
    dev.waAvatars.set(jid,url); res.json({ok:!!url,photoUrl:url||null});
  } catch(e) { dev.waAvatars.set(jid,null); res.json({ok:false,photoUrl:null}); }
});

// ══ Lifecycle ═══════════════════════════════════════════════════════
app.get('/lifecycle', auth, (req,res) => {
  const dev=getDevice(req.query.deviceId||'default');
  const all={}; dev.waLifecycle.forEach((v,k)=>{all[k]=v;}); res.json({lifecycle:all});
});
app.post('/lifecycle', auth, (req,res) => {
  const { jid, stage, deviceId } = req.body;
  if (!jid||!stage) return res.status(400).json({error:'jid y stage requeridos'});
  if (!['nuevo','potencial','cliente','perdido'].includes(stage)) return res.status(400).json({error:'stage invalido'});
  const dev=getDevice(deviceId||'default');
  dev.waLifecycle.set(jid,{stage,updatedAt:Date.now(),source:'manual'}); res.json({ok:true});
});

// ══ Analyze (manual trigger) ════════════════════════════════════════
app.get('/analyze/:jid', auth, async (req,res) => {
  const dev=getDevice(req.query.deviceId||'default');
  const jid=decodeURIComponent(req.params.jid);
  const msgs=dev.waMessages.get(jid)||[];
  if (!msgs.length) return res.json({stage:'nuevo',reason:'Sin mensajes'});
  const prev = dev.waLifecycle.get(jid) || {};
  dev.waLifecycle.set(jid, { ...prev, source: 'auto' });
  await autoClassifyLead(dev, jid);
  const result = dev.waLifecycle.get(jid) || { stage:'nuevo' };
  res.json({ stage:result.stage, source:result.source, reason:'Clasificado automáticamente' });
});

// ══ Welcome ═════════════════════════════════════════════════════════
app.get('/welcome', auth, (req,res) => { res.json({template:getDevice(req.query.deviceId||'default').waWelcomeTemplate}); });
app.post('/welcome', auth, (req,res) => {
  const { template, deviceId } = req.body;
  if (template===undefined) return res.status(400).json({error:'template requerido'});
  const dev=getDevice(deviceId||'default'); dev.waWelcomeTemplate=template; dev.waSentWelcome.clear(); res.json({ok:true});
});

// ══ Logout ══════════════════════════════════════════════════════════
app.post('/logout', auth, async (req,res) => {
  const id=req.body?.deviceId||'default';
  const dev=getDevice(id);
  if (dev.sock) try { await dev.sock.logout(); } catch(e){}
  dev.status='disconnected'; dev.qr=null;
  dev.waChats.clear(); dev.waMessages.clear(); dev.waAvatars.clear(); dev.waLifecycle.clear(); dev.waContacts.clear(); dev.waSentWelcome.clear();
  if (dev.reconnectTimer) clearTimeout(dev.reconnectTimer);
  const dir='./auth_'+id; if (fs2.existsSync(dir)) fs2.rmSync(dir,{recursive:true});
  res.json({ok:true}); dev.reconnectTimer=setTimeout(()=>connectDevice(id),2000);
});

// ══ Settings ════════════════════════════════════════════════════════
app.get('/settings', (req, res) => {
  res.json(currentSettings);
});

app.post('/settings', (req, res) => {
  try {
    const { backendPublicUrl, n8nEnabled, n8nUrl, openaiKey, prompt } = req.body || {};
    if (backendPublicUrl !== undefined) currentSettings.backendPublicUrl = backendPublicUrl;
    if (n8nEnabled !== undefined) currentSettings.n8nEnabled = n8nEnabled;
    if (n8nUrl !== undefined) currentSettings.n8nUrl = n8nUrl;
    if (openaiKey !== undefined) currentSettings.openaiKey = openaiKey;
    if (prompt !== undefined) currentSettings.prompt = prompt;
    console.log('[settings] updated:', currentSettings);
    res.json({ ok: true, settings: currentSettings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Social Routes (Instagram + Messenger multi-store) ───────────────
const { registerSocialRoutes } = require('./social');
registerSocialRoutes(app, auth);

// ── Tracking Cron (auto-sync orders with Interrapidísimo) ───────────
const { startTrackingCron } = require('./tracking-cron');
let trackingCron = null;

// ── AI Reply endpoint (replaces N8N) ────────────────────────────────
app.post('/ai-reply', async (req, res) => {
  try {
    const { chatId, messageType, text, clientName, systemPrompt, openaiKey, history } = req.body;
    if (!openaiKey) return res.status(400).json({ error: 'No API key provided' });
    if (!text && messageType === 'text') return res.status(400).json({ error: 'No text provided' });
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    if (history && Array.isArray(history)) {
      history.forEach(h => {
        if (h.role && h.content) messages.push({ role: h.role, content: h.content });
      });
    }
    messages.push({ role: 'user', content: text || '[mensaje multimedia]' });
    const oaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + openaiKey,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages,
        max_tokens: 1024,
        temperature: 0.7,
      }),
    });
    if (!oaiRes.ok) {
      const errBody = await oaiRes.text();
      console.error('[ai-reply] OpenAI error:', oaiRes.status, errBody);
      return res.status(502).json({ error: 'OpenAI API error', status: oaiRes.status, detail: errBody });
    }
    const oaiData = await oaiRes.json();
    const reply = oaiData.choices?.[0]?.message?.content || '';
    console.log('[ai-reply] Success for', chatId, '- reply length:', reply.length);
    res.json({ reply, model: 'gpt-4o-mini', usage: oaiData.usage });
  } catch (err) {
    console.error('[ai-reply] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Manual tracking trigger endpoint ────────────────────────────────
app.post('/tracking/run', auth, async (req, res) => {
  if (!trackingCron) return res.status(500).json({ error: 'Tracking cron not initialized' });
  trackingCron.runNow().then(() => res.json({ ok: true })).catch(e => res.status(500).json({ error: e.message }));
});

// ══════════════════════════════════════════════════════════════════════
// ANTI-BAN: Warmup Stats endpoint (nuevo/mejorado)
// ══════════════════════════════════════════════════════════════════════
app.get('/warmup-stats', (req, res) => {
  const did = req.query.deviceId || 'default';
  const dev = getDevice(did);
  const warmup = getWarmupState(did);
  const qrState = qrAttempts.get(did) || { count: 0 };
  const reconnState = reconnectAttempts.get(did) || { count: 0 };

  const warmthPercent = Math.min(100, Math.round((warmup.day / 14) * 100));
  const risk = warmup.day <= 3 ? 'high' : warmup.day <= 7 ? 'medium' : 'low';

  res.json({
    day: warmup.day,
    score: warmthPercent,
    risk,
    dailySent: warmup.dailySent,
    dailyLimit: warmup.limits.perDay,
    perMinute: warmup.limits.perMinute,
    perHour: warmup.limits.perHour,
    warmthPercent,
    recommendation: warmup.day <= 2
      ? 'Número muy nuevo. Solo responder mensajes entrantes. NO hacer difusiones.'
      : warmup.day <= 5
        ? 'Número en calentamiento. Responder normalmente, evitar difusiones masivas.'
        : warmup.day <= 7
          ? 'Número madurando. Puedes empezar difusiones pequeñas (máx ' + (warmup.limits.maxBroadcast || 0) + ').'
          : 'Número estable. Difusiones permitidas con límites normales.',
    canBroadcast: warmup.limits.canBroadcast,
    maxBroadcast: warmup.limits.maxBroadcast || 0,
    connected: dev.status === 'connected',
    uptime: process.uptime(),
    antiBan: {
      browserFingerprint: 'Rotación automática (WhatsApp Web real)',
      qrAttempts: qrState.count + '/' + MAX_QR_ATTEMPTS,
      reconnectAttempts: reconnState.count,
      markOnline: false,
      syncHistory: 'Últimos 3 días',
      presenceSimulation: 'Activa (intermitente)',
      rateLimiting: 'Activo (' + warmup.dailySent + '/' + warmup.limits.perDay + ' hoy)'
    }
  });
});

// ══ Start ═══════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log('Puerto:', PORT, '| v3.2-antiban multi-device + tracking cron + contact persistence');
  console.log('[ANTI-BAN] Engine activo: browser rotation, backoff, QR limiting, warmup, presence simulation');
  loadJobs();
  for (const [, dev] of devices) loadContacts(dev);
  connectDevice('default');
  trackingCron = startTrackingCron(getDevice);
});

// ===================== KEEP-ALIVE SELF-PING =====================
const SELF_URL = process.env.RENDER_EXTERNAL_URL || 'https://sanate-wa-bot.onrender.com';
setInterval(() => {
  fetch(SELF_URL)
    .then(r => console.log('[keep-alive] ping OK', r.status))
    .catch(e => console.log('[keep-alive] ping error', e.message));
}, 14 * 60 * 1000);
console.log('[keep-alive] Self-ping active every 14 min ->', SELF_URL);
