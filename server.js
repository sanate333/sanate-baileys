const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const express = require('express');
const cors    = require('cors');
const qrcode  = require('qrcode');
const fs2     = require('fs');
const pino    = require('pino');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

const SECRET       = process.env.SECRET || process.env.BAILEYS_SECRET || 'sanate_secret_2025';
const PORT         = process.env.PORT || 3000;
const WA_HISTORY_DAYS = 15;
const MAX_DEVICES  = 10;

// ── Multi-device store ─────────────────────────────────────────
const devices = new Map();

function getDevice(id) {
  const did = String(id || 'default');
  if (!devices.has(did)) {
    devices.set(did, {
      id: did,
      sock: null,
      status: 'disconnected',
      qr: null,
      reconnectTimer: null,
      waChats:    new Map(),
      waMessages: new Map(),
      waAvatars:  new Map(),
      waLifecycle: new Map(),
      waContacts: new Map(),
      waSentWelcome: new Set(),
      waWelcomeTemplate: '',
    });
  }
  return devices.get(did);
}
getDevice('default');

// ── Broadcast queue ────────────────────────────────────────────
const broadcastJobs = new Map();
const JOBS_FILE = './broadcast_jobs.json';

function saveJobs() {
  try { fs2.writeFileSync(JOBS_FILE, JSON.stringify(Array.from(broadcastJobs.entries())), 'utf8'); } catch(e){}
}
function loadJobs() {
  try {
    if (fs2.existsSync(JOBS_FILE)) {
      for (const [id, job] of JSON.parse(fs2.readFileSync(JOBS_FILE,"utf8"))) broadcastJobs.set(id, job);
    }
  } catch(e){}
}

function inSchedule(job) {
  const now = new Date();
  const cur = now.getHours()*60 + now.getMinutes();
  const st  = (job.startHour ?? 10)*60 + (job.startMin ?? 0);
  const en  = (job.endHour ?? 18)*60  + (job.endMin ?? 33);
  return cur >= st && cur < en;
}

const DELAYS = { veryShort:3000, short:12000, medium:35000, large:85000, veryLarge:210000 };

setInterval(async () => {
  for (const [, job] of broadcastJobs) {
    if (job.status !== 'running') {
      if (job.status === 'paused_schedule' && inSchedule(job)) job.status = 'running';
      continue;
    }
    if (!inSchedule(job)) { job.status = 'paused_schedule'; saveJobs(); continue; }
    if (job.position >= (job.numbers||[]).length) { job.status = 'completed'; job.completedAt = Date.now(); saveJobs(); continue; }

    // Device rotation
    let devId = job.deviceId || 'default';
    if (job.rotateDevices && job.deviceIds?.length > 1) {
      const idx = Math.floor(job.position / (job.rotateEvery||3)) % job.deviceIds.length;
      devId = job.deviceIds[idx];
    }
    const dev = getDevice(devId);
    if (!dev.sock || dev.status !== 'connected') continue;

    const raw = String(job.numbers[job.position]).replace(/\D/g,'');
    const jid = raw + '@s.whatsapp.net';
    try {
      if (job.mediaUrl) {
        await dev.sock.sendMessage(jid, { image: { url: job.mediaUrl }, caption: job.message || '' });
      } else {
        await dev.sock.sendMessage(jid, { text: job.message });
      }
      job.position++;
      job.sentCount = (job.sentCount||0) + 1;
      job.lastSentAt = Date.now();
      saveJobs();
    } catch(e) { job.errors = (job.errors||0)+1; }

    const base = DELAYS[job.delayType] || DELAYS.short;
    await new Promise(r => setTimeout(r, base + Math.random()*base*0.3));
    break; // one per tick
  }
}, 4000);

// ── storeMsg ───────────────────────────────────────────────────
function storeMsg(dev, msg) {
  try {
    const cutoff = Date.now() - WA_HISTORY_DAYS*86400000;
    const ts  = (msg.messageTimestamp||0)*1000;
    if (ts && ts < cutoff) return;
    const jid = msg.key?.remoteJid;
    if (!jid || jid === 'status@broadcast') return;
    const m = msg.message || {};
    const body =
      m.conversation ||
      m.extendedTextMessage?.text ||
      (m.imageMessage && (m.imageMessage.caption||'[Imagen]')) ||
      (m.videoMessage && (m.videoMessage.caption||'[Video]')) ||
      (m.audioMessage && '[Audio]') ||
      (m.documentMessage && '[Documento]') ||
      (m.stickerMessage && '[Sticker]') ||
      m.buttonsResponseMessage?.selectedDisplayText ||
      m.listResponseMessage?.title ||
      '[Mensaje]';
    const name = msg.pushName || dev.waContacts.get(jid) || dev.waChats.get(jid)?.name || jid.split('@')[0];
    if (msg.pushName) dev.waContacts.set(jid, msg.pushName);
    const prev = dev.waChats.get(jid) || {};
    dev.waChats.set(jid, { id:jid, name, unread:(prev.unread||0)+(msg.key?.fromMe?0:1), lastMsg:body, ts:ts||prev.ts||Date.now() });
    const arr = dev.waMessages.get(jid) || [];
    arr.push({ id:msg.key?.id, fromMe:!!msg.key?.fromMe, body, ts, type:Object.keys(m)[0]||'unknown',
      mediaUrl: m.imageMessage?.url||m.videoMessage?.url||null,
      mimetype: m.imageMessage?.mimetype||m.videoMessage?.mimetype||null });
    if (arr.length > 200) arr.splice(0, arr.length-200);
    dev.waMessages.set(jid, arr);
  } catch(e){ console.error('storeMsg:', e.message); }
}

// ── connectDevice ──────────────────────────────────────────────
async function connectDevice(deviceId) {
  const dev = getDevice(deviceId);
  try {
    const AUTH_DIR = './auth_' + deviceId;
    if (!fs2.existsSync(AUTH_DIR)) fs2.mkdirSync(AUTH_DIR, { recursive:true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    dev.sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level:'silent' }),
      browser: ['Windows','Chrome','121.0.0'],
      markOnlineOnConnect: true,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      syncFullHistory: true,
      shouldSyncHistoryMessage: (msg) => {
        const ts = (msg.messageTimestamp||0)*1000;
        return !ts || ts > Date.now() - WA_HISTORY_DAYS*86400000;
      },
    });

    dev.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) { dev.qr = qr; dev.status = 'qr'; }
      if (connection === 'close') {
        dev.status = 'disconnected'; dev.qr = null;
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code !== DisconnectReason.loggedOut) {
          if (dev.reconnectTimer) clearTimeout(dev.reconnectTimer);
          dev.reconnectTimer = setTimeout(() => connectDevice(deviceId), 5000);
        }
      }
      if (connection === 'open') {
        dev.status = 'connected'; dev.qr = null;
        console.log('Conectado device=' + deviceId + ' chats=' + dev.waChats.size);
      }
    });

    dev.sock.ev.on('creds.update', saveCreds);

    dev.sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify' && type !== 'append') return;
      for (const msg of messages) storeMsg(dev, msg);
      messages.forEach(m => {
        if (m.pushName && m.key?.remoteJid) dev.waContacts.set(m.key.remoteJid, m.pushName);
        const fromJid = m.key?.remoteJid;
        if (fromJid && !fromJid.endsWith('@g.us') && m.key && !m.key.fromMe && dev.waWelcomeTemplate && !dev.waSentWelcome.has(fromJid)) {
          const msgs = dev.waMessages.get(fromJid)||[];
          if (msgs.length <= 1) {
            dev.waSentWelcome.add(fromJid);
            setTimeout(() => {
              if (dev.sock && dev.status === 'connected') dev.sock.sendMessage(fromJid,{text:dev.waWelcomeTemplate}).catch(()=>{});
            }, 2000);
          }
        }
      });
    });

    dev.sock.ev.on('messaging-history.set', ({ chats, messages, isLatest }) => {
      console.log('history.set device=' + deviceId + ': ' + chats.length + ' chats ' + messages.length + ' msgs isLatest=' + isLatest);
      const cutoff = Date.now() - WA_HISTORY_DAYS*86400000;
      for (const chat of chats) {
        if (!chat.id || chat.id === 'status@broadcast') continue;
        if (!dev.waChats.has(chat.id)) {
          dev.waChats.set(chat.id, {
            id: chat.id,
            name: dev.waContacts.get(chat.id) || chat.name || chat.id.split('@')[0],
            unread: chat.unreadCount||0, lastMsg:'', ts: Date.now()
          });
        }
      }
      for (const msg of messages) {
        const ts = (msg.messageTimestamp||0)*1000;
        if (ts && ts < cutoff) continue;
        storeMsg(dev, msg);
      }
      console.log('After history device=' + deviceId + ': chats=' + dev.waChats.size);
    });

    dev.sock.ev.on('chats.upsert', (chats) => {
      for (const chat of chats) {
        if (!chat.id || chat.id === 'status@broadcast') continue;
        const prev = dev.waChats.get(chat.id)||{};
        dev.waChats.set(chat.id, {
          ...prev, id:chat.id,
          name: dev.waContacts.get(chat.id)||chat.name||prev.name||chat.id.split('@')[0],
          unread: chat.unreadCount !== undefined ? chat.unreadCount : (prev.unread||0),
          ts: prev.ts||Date.now()
        });
      }
    });

    dev.sock.ev.on('contacts.upsert', contacts => {
      contacts.forEach(c => {
        const name = c.notify||c.name||c.verifiedName;
        if (name) {
          dev.waContacts.set(c.id, name);
          if (dev.waChats.has(c.id)) dev.waChats.set(c.id, { ...dev.waChats.get(c.id), name });
        }
      });
    });

  } catch(err) {
    console.error('connectDevice error device=' + deviceId + ':', err.message);
    if (dev.reconnectTimer) clearTimeout(dev.reconnectTimer);
    dev.reconnectTimer = setTimeout(() => connectDevice(deviceId), 8000);
  }
}

// ── Auth middleware ────────────────────────────────────────────
const auth = (req, res, next) => {
  const s = req.headers['x-secret'] || req.query.secret;
  if (s !== SECRET) return res.status(401).json({ error:'No autorizado' });
  next();
};

// ── Health / Ping ──────────────────────────────────────────────
app.get('/health', (req,res) => {
  const d = getDevice('default');
  res.json({ ok:true, status:d.status, hasQR:!!d.qr });
});
app.get('/ping', (req,res) => {
  const d = getDevice('default');
  res.json({ v:'3.0', chats:d.waChats.size, msgs:d.waMessages.size, status:d.status, ts:Date.now() });
});

// ── Devices ───────────────────────────────────────────────────
app.get('/devices', auth, (req,res) => {
  res.json({ devices: Array.from(devices.entries()).map(([id,d]) => ({
    id, status:d.status, hasQR:!!d.qr, chats:d.waChats.size, contacts:d.waContacts.size
  }))});
});

app.post('/devices', auth, async (req,res) => {
  const { deviceId } = req.body;
  if (!deviceId) return res.status(400).json({ error:'deviceId requerido' });
  if (Array.from(devices.keys()).filter(k=>k!=='default').length >= MAX_DEVICES-1)
    return res.status(400).json({ error:'Máximo '+MAX_DEVICES+' dispositivos' });
  getDevice(deviceId);
  await connectDevice(deviceId);
  res.json({ ok:true, deviceId });
});

app.delete('/devices/:deviceId', auth, async (req,res) => {
  const { deviceId } = req.params;
  if (deviceId === 'default') return res.status(400).json({ error:'No se puede eliminar el dispositivo principal' });
  const dev = devices.get(deviceId);
  if (!dev) return res.status(404).json({ error:'No encontrado' });
  if (dev.sock) try { await dev.sock.logout(); } catch(e){}
  if (dev.reconnectTimer) clearTimeout(dev.reconnectTimer);
  const dir = './auth_' + deviceId;
  if (fs2.existsSync(dir)) fs2.rmSync(dir, { recursive:true });
  devices.delete(deviceId);
  res.json({ ok:true });
});

// ── Status / QR ───────────────────────────────────────────────
app.get('/status', auth, (req,res) => {
  const d = getDevice(req.query.deviceId||'default');
  res.json({ status:d.status, hasQR:!!d.qr });
});

app.get('/qr', auth, async (req,res) => {
  const d = getDevice(req.query.deviceId||'default');
  if (!d.qr) return res.json({ qr:null, status:d.status });
  try {
    const qrDataUrl = await qrcode.toDataURL(d.qr, { width:500, margin:2, errorCorrectionLevel:'M' });
    res.json({ qr:qrDataUrl, status:d.status });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Chats ─────────────────────────────────────────────────────
app.get('/chats', auth, (req,res) => {
  const dev = getDevice(req.query.deviceId||'default');
  const all = Array.from(dev.waChats.values());
  const sortTs = (a,b) => (b.ts||0)-(a.ts||0);
  const withMsgs = all.filter(c=>dev.waMessages.has(c.id)).sort(sortTs);
  const noMsgs   = all.filter(c=>!dev.waMessages.has(c.id)).sort(sortTs);
  const sorted = [...withMsgs,...noMsgs].slice(0,100);
  res.json({ chats: sorted.map(chat => ({
    id: chat.id,
    phone: chat.id.split('@')[0],
    preview: chat.lastMsg||'',
    time: chat.ts ? new Date(chat.ts).toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'}) : '',
    unread: chat.unread||0,
    name: dev.waContacts.get(chat.id)||chat.name||chat.id.split('@')[0],
    isGroup: chat.id.endsWith('@g.us'),
    avatar: dev.waAvatars.get(chat.id)||null,
    lifecycle: dev.waLifecycle.get(chat.id)||null,
  }))});
});

// ── Messages ──────────────────────────────────────────────────
app.get('/messages/:id', auth, (req,res) => {
  const dev = getDevice(req.query.deviceId||'default');
  const jid = decodeURIComponent(req.params.id);
  let msgs = dev.waMessages.get(jid)||[];
  if (!msgs.length && !jid.includes('@')) msgs = dev.waMessages.get(jid+'@s.whatsapp.net')||[];
  if (dev.waChats.has(jid)) dev.waChats.set(jid,{...dev.waChats.get(jid), unread:0});
  res.json({ messages: msgs.slice(-50).map(msg => ({
    id:msg.id, dir:msg.fromMe?'s':'r', txt:msg.body||'',
    time: msg.ts ? new Date(msg.ts).toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'}) : '',
    ts:msg.ts, mediaUrl:msg.mediaUrl||null, mimetype:msg.mimetype||null,
  }))});
});

// ── Send text ─────────────────────────────────────────────────
app.post('/send', auth, async (req,res) => {
  const { to, message, deviceId } = req.body;
  const dev = getDevice(deviceId||'default');
  if (!dev.sock || dev.status!=='connected') return res.status(400).json({ error:'No conectado' });
  try {
    const jid = to.includes('@') ? to : to.replace(/\D/g,'')+('@s.whatsapp.net');
    await dev.sock.sendMessage(jid,{ text:message });
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Send buttons ──────────────────────────────────────────────
app.post('/send-buttons', auth, async (req,res) => {
  const { to, text, footer, buttons, deviceId } = req.body;
  const dev = getDevice(deviceId||'default');
  if (!dev.sock || dev.status!=='connected') return res.status(400).json({ error:'No conectado' });
  try {
    const jid = to.includes('@') ? to : to.replace(/\D/g,'')+('@s.whatsapp.net');
    const waButtons = (buttons||[]).map((b,i)=>({
      buttonId: b.id||String(i+1),
      buttonText:{ displayText: b.text||b.label||('Opción '+(i+1)) },
      type:1
    }));
    await dev.sock.sendMessage(jid,{ text:text||'', footer:footer||'', buttons:waButtons, headerType:1 });
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Send template buttons (URL/Quick-reply) ───────────────────
app.post('/send-template', auth, async (req,res) => {
  const { to, text, templateButtons, deviceId } = req.body;
  const dev = getDevice(deviceId||'default');
  if (!dev.sock || dev.status!=='connected') return res.status(400).json({ error:'No conectado' });
  try {
    const jid = to.includes('@') ? to : to.replace(/\D/g,'')+('@s.whatsapp.net');
    await dev.sock.sendMessage(jid,{ text:text||'', templateButtons:templateButtons||[] });
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Broadcast ─────────────────────────────────────────────────
app.get('/broadcast', auth, (req,res) => {
  res.json({ jobs: Array.from(broadcastJobs.values()).map(j=>({...j,numbers:undefined,totalNumbers:(j.numbers||[]).length})) });
});

app.post('/broadcast', auth, (req,res) => {
  const { name, numbers, message, mediaUrl, delayType, deviceId, deviceIds, rotateDevices, rotateEvery,
          startHour, startMin, endHour, endMin } = req.body;
  if (!numbers?.length || !message) return res.status(400).json({ error:'numbers y message requeridos' });
  const jobId = 'job_'+Date.now();
  broadcastJobs.set(jobId,{
    id:jobId, name:name||('Difusión '+new Date().toLocaleDateString('es-ES')),
    numbers: numbers.map(n=>String(n).replace(/\D/g,'')),
    message, mediaUrl:mediaUrl||null,
    delayType:delayType||'short',
    deviceId:deviceId||'default', deviceIds, rotateDevices:!!rotateDevices, rotateEvery:rotateEvery||3,
    startHour:startHour??10, startMin:startMin??0, endHour:endHour??18, endMin:endMin??33,
    status:'running', position:0, sentCount:0, errors:0, createdAt:Date.now(), lastSentAt:null,
  });
  saveJobs();
  res.json({ ok:true, jobId });
});

app.patch('/broadcast/:jobId', auth, (req,res) => {
  const job = broadcastJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error:'No encontrado' });
  if (req.body.status) job.status = req.body.status;
  saveJobs();
  res.json({ ok:true, job:{...job,numbers:undefined,totalNumbers:(job.numbers||[]).length} });
});

app.delete('/broadcast/:jobId', auth, (req,res) => {
  broadcastJobs.delete(req.params.jobId);
  saveJobs();
  res.json({ ok:true });
});

// ── Photo ─────────────────────────────────────────────────────
app.get('/chats/:id/photo', auth, async (req,res) => {
  const dev = getDevice(req.query.deviceId||'default');
  const jid = decodeURIComponent(req.params.id);
  if (dev.waAvatars.has(jid)) return res.json({ ok:!!dev.waAvatars.get(jid), photoUrl:dev.waAvatars.get(jid)||null });
  try {
    if (!dev.sock || dev.status!=='connected') return res.json({ ok:false, photoUrl:null });
    const url = await dev.sock.profilePictureUrl(jid,'image').catch(()=>null);
    dev.waAvatars.set(jid, url);
    res.json({ ok:!!url, photoUrl:url||null });
  } catch(e) { dev.waAvatars.set(jid,null); res.json({ ok:false, photoUrl:null }); }
});

// ── Lifecycle ─────────────────────────────────────────────────
app.get('/lifecycle', auth, (req,res) => {
  const dev = getDevice(req.query.deviceId||'default');
  const all = {};
  dev.waLifecycle.forEach((v,k) => { all[k]=v; });
  res.json({ lifecycle:all });
});
app.post('/lifecycle', auth, (req,res) => {
  const { jid, stage, deviceId } = req.body;
  if (!jid||!stage) return res.status(400).json({ error:'jid y stage requeridos' });
  if (!['nuevo','potencial','cliente','perdido'].includes(stage)) return res.status(400).json({ error:'stage invalido' });
  const dev = getDevice(deviceId||'default');
  dev.waLifecycle.set(jid,{ stage, updatedAt:Date.now() });
  res.json({ ok:true });
});

// ── Analyze ───────────────────────────────────────────────────
app.get('/analyze/:jid', auth, (req,res) => {
  const dev = getDevice(req.query.deviceId||'default');
  const jid = decodeURIComponent(req.params.jid);
  const msgs = dev.waMessages.get(jid)||[];
  if (!msgs.length) return res.json({ stage:'nuevo', reason:'Sin mensajes' });
  const text = msgs.map(m=>m.body||'').join(' ').toLowerCase();
  let stage='nuevo', reason='Contacto nuevo';
  if (/compr[eé]|pedido|pagu[eé]|confirmar|recib[ií]/.test(text)) { stage='cliente'; reason='Realizó una compra'; }
  else if (/precio|cu[aá]nto|costo|cuesta|informaci[oó]n|interesa|quiero|disponible/.test(text)) { stage='potencial'; reason='Mostró interés'; }
  else {
    const last = msgs[msgs.length-1];
    const days = (Date.now()-(last.ts||0))/864e5;
    stage = days>7 ? 'perdido' : 'potencial';
    reason = days>7 ? 'Sin respuesta 7+ días' : 'En conversación';
  }
  res.json({ stage, reason });
});

// ── Welcome ───────────────────────────────────────────────────
app.get('/welcome', auth, (req,res) => {
  res.json({ template: getDevice(req.query.deviceId||'default').waWelcomeTemplate });
});
app.post('/welcome', auth, (req,res) => {
  const { template, deviceId } = req.body;
  if (template===undefined) return res.status(400).json({ error:'template requerido' });
  const dev = getDevice(deviceId||'default');
  dev.waWelcomeTemplate = template;
  dev.waSentWelcome.clear();
  res.json({ ok:true });
});

// ── Logout ────────────────────────────────────────────────────
app.post('/logout', auth, async (req,res) => {
  const id = req.body?.deviceId||'default';
  const dev = getDevice(id);
  if (dev.sock) try { await dev.sock.logout(); } catch(e){}
  dev.status='disconnected'; dev.qr=null;
  dev.waChats.clear(); dev.waMessages.clear(); dev.waAvatars.clear();
  dev.waLifecycle.clear(); dev.waContacts.clear(); dev.waSentWelcome.clear();
  if (dev.reconnectTimer) clearTimeout(dev.reconnectTimer);
  const dir = './auth_'+id;
  if (fs2.existsSync(dir)) fs2.rmSync(dir, { recursive:true });
  res.json({ ok:true });
  dev.reconnectTimer = setTimeout(() => connectDevice(id), 2000);
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('Puerto:', PORT, '| v3.0 multi-device');
  loadJobs();
  connectDevice('default');
});
