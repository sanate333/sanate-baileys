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
const WA_HISTORY_DAYS = 15;
const MAX_DEVICES = 10;
let currentSettings = { backendPublicUrl: '', n8nEnabled: false, n8nUrl: '', openaiKey: '', prompt: '' };

// Ã¢ÂÂÃ¢ÂÂ Multi-device store Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
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

// Normalize JID for storage keys: strip @s.whatsapp.net to prevent duplicate chats
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

// Ã¢ÂÂÃ¢ÂÂ Contact persistence Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
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

// Ã¢ÂÂÃ¢ÂÂ OpenAI auto-lead classification Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
async function autoClassifyLead(dev, jid) {
  try {
    const msgs = dev.waMessages.get(jid) || [];
    if (!msgs.length) return;
    const existing = dev.waLifecycle.get(jid);
    // Don't overwrite manual assignments
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
              { role: 'system', content: 'Eres un clasificador de leads de WhatsApp. Analiza la conversaciÃÂ³n y responde SOLO con una de estas palabras: nuevo, potencial, cliente, perdido. Reglas: nuevo=primer contacto o saludo inicial, potencial=mostrÃÂ³ interÃÂ©s en productos/precios, cliente=realizÃÂ³ una compra o confirmÃÂ³ pedido, perdido=sin interÃÂ©s o inactivo mÃÂ¡s de 7 dÃÂ­as.' },
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
      if (/compr[eÃÂ©]|pedido|pagu[eÃÂ©]|confirmar|recib[iÃÂ­]|comprÃÂ³|compre/.test(allText)) { stage = 'cliente'; }
      else if (/precio|cu[aÃÂ¡]nto|costo|cuesta|informaci[oÃÂ³]n|interesa|quiero|disponible|cÃÂ³mo funciona|mÃÂ¡s info/.test(allText)) { stage = 'potencial'; }
      else { const last = msgs[msgs.length-1]; const days = (Date.now()-(last.ts||0))/864e5; stage = days>7?'perdido':'potencial'; }
    }
    dev.waLifecycle.set(jid, { stage, updatedAt: Date.now(), source });
  } catch(e) { console.error('autoClassifyLead:', e.message); }
}

// Ã¢ÂÂÃ¢ÂÂ Broadcast queue Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
const broadcastJobs = new Map();
const JOBS_FILE = './broadcast_jobs.json';
function saveJobs() { try { fs2.writeFileSync(JOBS_FILE, JSON.stringify(Array.from(broadcastJobs.entries())), 'utf8'); } catch(e){} }
function loadJobs() { try { if (fs2.existsSync(JOBS_FILE)) { for (const [id, job] of JSON.parse(fs2.readFileSync(JOBS_FILE,"utf8"))) broadcastJobs.set(id, job); } } catch(e){} }
function inSchedule(job) { const now = new Date(); const cur = now.getHours()*60+now.getMinutes(); const st=(job.startHour??10)*60+(job.startMin??0); const en=(job.endHour??18)*60+(job.endMin??33); return cur>=st&&cur<en; }
const DELAYS = { veryShort:3000, short:12000, medium:35000, large:85000, veryLarge:210000 };

setInterval(async () => {
  for (const [, job] of broadcastJobs) {
    if (job.status !== 'running') { if (job.status==='paused_schedule'&&inSchedule(job)) job.status='running'; continue; }
    if (!inSchedule(job)) { job.status='paused_schedule'; saveJobs(); continue; }
    if (job.position>=(job.numbers||[]).length) { job.status='completed'; job.completedAt=Date.now(); saveJobs(); continue; }
    let devId=job.deviceId||'default';
    if (job.rotateDevices&&job.deviceIds?.length>1) { const idx=Math.floor(job.position/(job.rotateEvery||3))%job.deviceIds.length; devId=job.deviceIds[idx]; }
    const dev=getDevice(devId);
    if (!dev.sock||dev.status!=='connected') continue;
    const raw=String(job.numbers[job.position]).replace(/\D/g,'');
    const jid=raw+'@s.whatsapp.net';
    try {
      if (job.mediaUrl) { await dev.sock.sendMessage(jid,{image:{url:job.mediaUrl},caption:job.message||''}); }
      else { await dev.sock.sendMessage(jid,{text:job.message}); }
      job.position++; job.sentCount=(job.sentCount||0)+1; job.lastSentAt=Date.now(); saveJobs();
    } catch(e) { job.errors=(job.errors||0)+1; }
    const base=DELAYS[job.delayType]||DELAYS.short;
    await new Promise(r=>setTimeout(r,base+Math.random()*base*0.3));
    break;
  }
}, 4000);

// Ã¢ÂÂÃ¢ÂÂ storeMsg Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
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

// Ã¢ÂÂÃ¢ÂÂ connectDevice Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
async function connectDevice(deviceId) {
  const dev = getDevice(deviceId);
  try {
    const AUTH_DIR = './auth_'+deviceId;
    if (!fs2.existsSync(AUTH_DIR)) fs2.mkdirSync(AUTH_DIR,{recursive:true});
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();
    dev.sock = makeWASocket({
      version, auth: state, printQRInTerminal: false, logger: pino({level:'silent'}),
      browser: ['Windows','Chrome','121.0.0'], markOnlineOnConnect: true,
      connectTimeoutMs: 60000, defaultQueryTimeoutMs: 60000, keepAliveIntervalMs: 25000,
      syncFullHistory: true,
      shouldSyncHistoryMessage: (msg) => { const ts=(msg.messageTimestamp||0)*1000; return !ts||ts>Date.now()-WA_HISTORY_DAYS*86400000; },
    });
    dev.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) { dev.qr=qr; dev.status='qr'; }
      if (connection==='close') {
        dev.status='disconnected'; dev.qr=null;
      broadcastSSE(dev, 'status', { status: 'disconnected' });
        const code=lastDisconnect?.error?.output?.statusCode;
        if (code!==DisconnectReason.loggedOut) { if (dev.reconnectTimer) clearTimeout(dev.reconnectTimer); dev.reconnectTimer=setTimeout(()=>connectDevice(deviceId),5000); }
      }
      if (connection==='open') { dev.status='connected'; dev.qr=null;
      broadcastSSE(dev, 'status', { status: 'connected' }); console.log('Conectado device='+deviceId+' chats='+dev.waChats.size); }
    });
    dev.sock.ev.on('creds.update', saveCreds);
    dev.sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type!=='notify'&&type!=='append') return;
      for (const msg of messages) storeMsg(dev, msg);
      messages.forEach(m => {
        if (m.pushName&&m.key?.remoteJid) { dev.waContacts.set(nJ(m.key.remoteJid), m.pushName); }
        const fromJid = m.key?.remoteJid; // full JID for sendMessage
        const fromKey = nJ(fromJid);       // normalized key for storage
        if (fromKey&&!fromKey.endsWith('@g.us')&&m.key&&!m.key.fromMe) {
          // Auto-classify lead for incoming messages
          setTimeout(() => autoClassifyLead(dev, fromKey), 1000);
          // Welcome message
          if (dev.waWelcomeTemplate&&!dev.waSentWelcome.has(fromKey)) {
            const msgs = dev.waMessages.get(fromKey)||[];
            if (msgs.length<=1) {
              dev.waSentWelcome.add(fromKey);
              setTimeout(() => { if (dev.sock&&dev.status==='connected') dev.sock.sendMessage(fromJid,{text:dev.waWelcomeTemplate}).catch(()=>{}); }, 2000);
            }
          }
        }
      });
      // Persist contacts after update
      setTimeout(() => saveContacts(dev), 3000);
    });
    dev.sock.ev.on('messaging-history.set', ({ chats, messages, isLatest }) => {
      console.log('history.set device='+deviceId+': '+chats.length+' chats '+messages.length+' msgs isLatest='+isLatest);
      const cutoff = Date.now()-WA_HISTORY_DAYS*86400000;
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
      // Persist contacts
      setTimeout(() => saveContacts(dev), 2000);
    });
  } catch(err) {
    console.error('connectDevice error device='+deviceId+':', err.message);
    if (dev.reconnectTimer) clearTimeout(dev.reconnectTimer);
    dev.reconnectTimer = setTimeout(()=>connectDevice(deviceId),8000);
  }
}

// Ã¢ÂÂÃ¢ÂÂ Auth middleware Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
const auth = (req,res,next) => { const s=req.headers['x-secret']||req.query.secret; if (s!==SECRET) return res.status(401).json({error:'No autorizado'}); next(); };

// Ã¢ÂÂÃ¢ÂÂ Health / Ping Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
app.get('/health', (req,res) => { const d=getDevice('default'); res.json({ok:true,status:d.status,hasQR:!!d.qr}); });
app.get('/ping', (req,res) => { const d=getDevice('default'); res.json({v:'3.1',chats:d.waChats.size,msgs:d.waMessages.size,status:d.status,ts:Date.now()}); });

// Ã¢ÂÂÃ¢ÂÂ Devices Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
app.get('/devices', auth, (req,res) => { res.json({devices:Array.from(devices.entries()).map(([id,d])=>({id,status:d.status,hasQR:!!d.qr,chats:d.waChats.size,contacts:d.waContacts.size}))}); });
app.post('/devices', auth, async (req,res) => {
  const { deviceId } = req.body;
  if (!deviceId) return res.status(400).json({error:'deviceId requerido'});
  if (Array.from(devices.keys()).filter(k=>k!=='default').length>=MAX_DEVICES-1) return res.status(400).json({error:'MÃÂ¡ximo '+MAX_DEVICES+' dispositivos'});
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

// Ã¢ÂÂÃ¢ÂÂ Status / QR Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
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

// Ã¢ÂÂÃ¢ÂÂ Sync (force reload) Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
app.post('/sync', auth, (req,res) => {
  const dev = getDevice(req.query.deviceId||req.body?.deviceId||'default');
  res.json({ ok:true, chats:dev.waChats.size, contacts:dev.waContacts.size, messages:dev.waMessages.size });
});

// Ã¢ÂÂÃ¢ÂÂ Chats Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
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

// Ã¢ÂÂÃ¢ÂÂ Messages Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
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
// Alias: /chats/:id/messages (frontend calls this URL)
app.get('/chats/:id/messages', auth, (req,res) => {
  const dev = getDevice(req.query.deviceId||'default');
  const jid = decodeURIComponent(req.params.id);
  res.json({ messages: getMessages(dev, jid) });
});

// Ã¢ÂÂÃ¢ÂÂ Send text Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
app.post('/send', auth, async (req,res) => {
  const { to, message, deviceId } = req.body;
  const dev = getDevice(deviceId||'default');
  if (!dev.sock||dev.status!=='connected') return res.status(400).json({error:'No conectado'});
  try {
    const jid = to.includes('@s.whatsapp.net') ? to : to + '@s.whatsapp.net';
    const key = nJ(jid);
    const result = await dev.sock.sendMessage(jid, { text: message });
    // Store sent message in waMessages so it shows in dashboard
    const arr = dev.waMessages.get(key) || [];
    arr.push({ id: result.key.id, body: message, fromMe: true, ts: Date.now() });
    if (arr.length > 500) arr.splice(0, arr.length - 500);
    dev.waMessages.set(key, arr);
    const chatPrev = dev.waChats.get(key) || {};
    dev.waChats.set(key, { ...chatPrev, id:key, name:dev.waContacts.get(key)||chatPrev.name||key, lastMsg:message, ts:Date.now() });
    res.json({ success: true, messageId: result.key.id });
  } catch (e) { res.status(500).json({ error: e.message }) }
});

// Ã¢ÂÂÃ¢ÂÂ Send buttons Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
app.post('/send-buttons', auth, async (req,res) => {
  const { to, text, footer, buttons, deviceId } = req.body;
  const dev = getDevice(deviceId||'default');
  if (!dev.sock||dev.status!=='connected') return res.status(400).json({error:'No conectado'});
  try {
    const jid=to.includes('@')?to:to.replace(/\D/g,'')+('@s.whatsapp.net');
    const waButtons=(buttons||[]).map((b,i)=>({buttonId:b.id||String(i+1),buttonText:{displayText:b.text||b.label||('OpciÃÂ³n '+(i+1))},type:1}));
    await dev.sock.sendMessage(jid,{text:text||'',footer:footer||'',buttons:waButtons,headerType:1});
    res.json({ok:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// Ã¢ÂÂÃ¢ÂÂ Send template buttons Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
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

// ── Send list (interactive menu with rows – renders visually on personal WA) ──
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

// Ã¢ÂÂÃ¢ÂÂ Broadcast Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
app.get('/broadcast', auth, (req,res) => { res.json({jobs:Array.from(broadcastJobs.values()).map(j=>({...j,numbers:undefined,totalNumbers:(j.numbers||[]).length}))}); });
app.post('/broadcast', auth, (req,res) => {
  const { name, numbers, message, mediaUrl, delayType, deviceId, deviceIds, rotateDevices, rotateEvery, startHour, startMin, endHour, endMin } = req.body;
  if (!numbers?.length||!message) return res.status(400).json({error:'numbers y message requeridos'});
  const jobId='job_'+Date.now();
  broadcastJobs.set(jobId,{ id:jobId, name:name||('DifusiÃÂ³n '+new Date().toLocaleDateString('es-ES')), numbers:numbers.map(n=>String(n).replace(/\D/g,'')), message, mediaUrl:mediaUrl||null, delayType:delayType||'short', deviceId:deviceId||'default', deviceIds, rotateDevices:!!rotateDevices, rotateEvery:rotateEvery||3, startHour:startHour??10, startMin:startMin??0, endHour:endHour??18, endMin:endMin??33, status:'running', position:0, sentCount:0, errors:0, createdAt:Date.now(), lastSentAt:null });
  saveJobs(); res.json({ok:true,jobId});
});
app.patch('/broadcast/:jobId', auth, (req,res) => {
  const job=broadcastJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({error:'No encontrado'});
  if (req.body.status) job.status=req.body.status; saveJobs();
  res.json({ok:true,job:{...job,numbers:undefined,totalNumbers:(job.numbers||[]).length}});
});
app.delete('/broadcast/:jobId', auth, (req,res) => { broadcastJobs.delete(req.params.jobId); saveJobs(); res.json({ok:true}); });

// Ã¢ÂÂÃ¢ÂÂ Photo Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
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

// Ã¢ÂÂÃ¢ÂÂ Lifecycle Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
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

// Ã¢ÂÂÃ¢ÂÂ Analyze (manual trigger) Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
app.get('/analyze/:jid', auth, async (req,res) => {
  const dev=getDevice(req.query.deviceId||'default');
  const jid=decodeURIComponent(req.params.jid);
  const msgs=dev.waMessages.get(jid)||[];
  if (!msgs.length) return res.json({stage:'nuevo',reason:'Sin mensajes'});
  // Force re-analyze ignoring manual flag
  const prev = dev.waLifecycle.get(jid) || {};
  dev.waLifecycle.set(jid, { ...prev, source: 'auto' });
  await autoClassifyLead(dev, jid);
  const result = dev.waLifecycle.get(jid) || { stage:'nuevo' };
  res.json({ stage:result.stage, source:result.source, reason:'Clasificado automÃÂ¡ticamente' });
});

// Ã¢ÂÂÃ¢ÂÂ Welcome Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
app.get('/welcome', auth, (req,res) => { res.json({template:getDevice(req.query.deviceId||'default').waWelcomeTemplate}); });
app.post('/welcome', auth, (req,res) => {
  const { template, deviceId } = req.body;
  if (template===undefined) return res.status(400).json({error:'template requerido'});
  const dev=getDevice(deviceId||'default'); dev.waWelcomeTemplate=template; dev.waSentWelcome.clear(); res.json({ok:true});
});

// Ã¢ÂÂÃ¢ÂÂ Logout Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
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

// Ã¢ÂÂÃ¢ÂÂ Start Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
// GET /settings
app.get('/settings', (req, res) => {
  res.json(currentSettings);
});

// POST /settings
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

// ── Social Routes (Instagram + Messenger multi-store) ──────────────────────
const { registerSocialRoutes } = require('./social');
registerSocialRoutes(app, auth);


// ── AI Reply endpoint (replaces N8N) ─────────────────────────────────
app.post('/ai-reply', async (req, res) => {
  try {
    const { chatId, messageType, text, clientName, systemPrompt, openaiKey, history } = req.body
    if (!openaiKey) return res.status(400).json({ error: 'No API key provided' })
    if (!text && messageType === 'text') return res.status(400).json({ error: 'No text provided' })

    // Build messages array for OpenAI
    const messages = []
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt })
    
    // Add conversation history if provided
    if (history && Array.isArray(history)) {
      history.forEach(h => {
        if (h.role && h.content) messages.push({ role: h.role, content: h.content })
      })
    }
    
    // Add the current user message
    messages.push({ role: 'user', content: text || '[mensaje multimedia]' })

    // Call OpenAI API directly via fetch
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
    })

    if (!oaiRes.ok) {
      const errBody = await oaiRes.text()
      console.error('[ai-reply] OpenAI error:', oaiRes.status, errBody)
      return res.status(502).json({ error: 'OpenAI API error', status: oaiRes.status, detail: errBody })
    }

    const oaiData = await oaiRes.json()
    const reply = oaiData.choices?.[0]?.message?.content || ''

    console.log('[ai-reply] Success for', chatId, '- reply length:', reply.length)
    res.json({ reply, model: 'gpt-4o-mini', usage: oaiData.usage })
  } catch (err) {
    console.error('[ai-reply] Error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

app.listen(PORT, () => {
  console.log('Puerto:', PORT, '| v3.1 multi-device + contact persistence + openai leads');
  loadJobs();
  // Load persisted contacts for all devices
  for (const [, dev] of devices) loadContacts(dev);
  connectDevice('default');
});

// ===================== KEEP-ALIVE SELF-PING =====================
// Prevents Render free tier from sleeping (pings every 14 min)
const SELF_URL = process.env.RENDER_EXTERNAL_URL || 'https://sanate-wa-bot.onrender.com';
setInterval(() => {
  fetch(SELF_URL)
    .then(r => console.log('[keep-alive] ping OK', r.status))
    .catch(e => console.log('[keep-alive] ping error', e.message));
}, 14 * 60 * 1000);
console.log('[keep-alive] Self-ping active every 14 min ->', SELF_URL);
