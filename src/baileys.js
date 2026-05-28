const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, isJidGroup, isJidBroadcast, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const NodeCache = require('node-cache');
const fs = require('fs');
const path = require('path');
const { saveMessage, upsertChat, syncInitialChats, updateMessageStatus } = require('./supabase');
const { useSupabaseAuthState, clearAuth, clearLocalAuth, saveAuthToSupabase } = require('./auth-store');
const { handleIncomingMessage, updateSocket, setSseManager } = require('./auto-reply');
const { updateAudioSocket } = require('./audio-tts');
const transferHandler = require('./transfer-handler');

// ── PROXY: optional SOCKS5/HTTP proxy for IP rotation ──
let SocksProxyAgent, HttpsProxyAgent;
try {
  SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent;
  HttpsProxyAgent = require('https-proxy-agent').HttpsProxyAgent;
  console.log('[Proxy] Módulos proxy cargados OK');
} catch (e) {
  console.warn('[Proxy] Módulos proxy no disponibles:', e.message);
}

function getProxyAgent() {
  const proxyUrl = process.env.WA_PROXY_URL;
  if (!proxyUrl) return undefined;
  try {
    if (proxyUrl.startsWith('socks')) {
      return new SocksProxyAgent(proxyUrl);
    } else {
      return new HttpsProxyAgent(proxyUrl);
    }
  } catch (e) {
    console.error('[Proxy] Error creando agent:', e.message);
    return undefined;
  }
}

// ── ANTI-BAN: baileys-antiban integration ──
let AntiBan, wrapSocket, classifyDisconnect, getStealthSocketConfig;
try {
  const antiban = require('baileys-antiban');
  AntiBan = antiban.AntiBan;
  wrapSocket = antiban.wrapSocket;
  classifyDisconnect = antiban.classifyDisconnect;
  getStealthSocketConfig = antiban.getStealthSocketConfig;
  console.log('[AntiBan] baileys-antiban cargado OK');
} catch (e) {
  console.warn('[AntiBan] baileys-antiban no disponible:', e.message, '— continuando sin protección anti-ban');
  AntiBan = null;
  wrapSocket = null;
  classifyDisconnect = null;
  getStealthSocketConfig = null;
}

// ── ANTI-BAN: instancia global ──
let antiBanInstance = null;
const ANTIBAN_STATE_FILE = path.join(__dirname, '..', 'antiban-state.json');

async function initAntiBan() {
  if (!AntiBan) return null;
  try {
    // Cargar warm-up state desde Supabase (persiste entre deploys — Render usa ephemeral filesystem)
    let warmUpState = null;
    try {
      if (supabaseClient) {
        const { data } = await supabaseClient
          .from('app_config')
          .select('value')
          .eq('key', 'antiban_warmup_state')
          .single();
        if (data && data.value) {
          warmUpState = typeof data.value === 'string' ? JSON.parse(data.value) : data.value;
          console.log('[AntiBan] Estado warm-up cargado desde Supabase');
        }
      }
      // Fallback: intentar disco local (para desarrollo)
      if (!warmUpState && fs.existsSync(ANTIBAN_STATE_FILE)) {
        warmUpState = JSON.parse(fs.readFileSync(ANTIBAN_STATE_FILE, 'utf-8'));
        console.log('[AntiBan] Estado warm-up cargado desde disco (fallback)');
      }
    } catch (e) { console.warn('[AntiBan] No se pudo cargar estado previo:', e.message); }

    antiBanInstance = new AntiBan({
      // Rate limiting conservador para tienda de cosméticos
      maxPerMinute: 6,
      maxPerHour: 120,
      maxPerDay: 800,
      minDelayMs: 2000,
      maxDelayMs: 6000,
      newChatDelayMs: 4000,
      burstAllowance: 3,
      maxIdenticalMessages: 3,
      identicalMessageWindowMs: 3600000,
      // Warm-up de 7 días
      warmupDays: 7,
      day1Limit: 20,
      growthFactor: 1.8,
      inactivityThresholdHours: 72,
      // Health monitor
      autoPauseAt: 'high',
      // Persistencia
      logging: true,
    }, warmUpState);

    console.log('[AntiBan] Inicializado — warm-up day:', antiBanInstance.getStats?.()?.warmUp?.day || 'N/A');

    // Guardar estado cada 5 minutos en Supabase + disco
    setInterval(async () => {
      try {
        const state = antiBanInstance.exportWarmUpState();
        // Supabase (persiste entre deploys)
        if (supabaseClient) {
          await supabaseClient
            .from('app_config')
            .upsert({ key: 'antiban_warmup_state', value: JSON.stringify(state) }, { onConflict: 'key' });
        }
        // Disco local (backup)
        fs.writeFileSync(ANTIBAN_STATE_FILE, JSON.stringify(state));
      } catch (e) { /* ignorar errores de guardado */ }
    }, 300000);

    return antiBanInstance;
  } catch (e) {
    console.error('[AntiBan] Error inicializando:', e.message);
    return null;
  }
}

// Exponer función para que auto-reply consulte anti-ban antes de enviar
function getAntiBan() { return antiBanInstance; }

let sock = null;
let qrCode = null;
let connectionState = 'disconnected';
let sseManager = null;
let supabaseClient = null;
let initialSyncDone = false;
let intentionalLogout = false; // Flag para evitar auto-reconnect despues de Desvincular
let userDisconnected = false; // Flag permanente - solo se resetea con POST /connect
let isDisconnecting = false; // Guard para bloquear saveCreds durante disconnect
let disconnectLockUntil = 0; // Timestamp: ignorar POST /connect hasta este momento
let permanentDisconnect = false; // Solo se resetea con POST /connect?force=true
let qrAttempts = 0; // Contador de intentos de QR para backoff
const MAX_QR_ATTEMPTS = 8; // Maximo 8 intentos antes de pausar (cada QR dura ~20s = ~2.5 min)
let reconnectTimer = null; // Timer de reconexion (para poder cancelarlo)

const photoCache = new NodeCache({ stdTTL: 900, checkperiod: 120 });
const contactCache = new NodeCache({ stdTTL: 3600, checkperiod: 300 });

// ── LID → Phone resolution ──
// WhatsApp newer versions use @lid JIDs for incoming messages.
// We maintain a bidirectional map so messages are stored under the real phone number.
const lidToPhoneMap = new Map();  // lidNumber → phoneNumber
const phoneToLidMap = new Map();  // phoneNumber → lidNumber

function registerLidPhoneMapping(lidNum, phoneNum) {
  if (!lidNum || !phoneNum || lidNum === phoneNum) return;
  // Only register if phone looks real (7-15 digits, no @lid pattern)
  if (phoneNum.length < 7 || phoneNum.length > 15) return;
  if (lidNum.length < 7) return;
  lidToPhoneMap.set(lidNum, phoneNum);
  phoneToLidMap.set(phoneNum, lidNum);
  console.log('[LID-MAP] Registered:', lidNum, '→', phoneNum);
}

/** Load LID→Phone mappings from Supabase (oasis_wa_chats push_name matching) */
async function loadLidPhoneMappings() {
  if (!supabaseClient) return;
  try {
    const { data } = await supabaseClient
      .from('oasis_wa_chats')
      .select('jid,phone,push_name')
      .limit(500);
    if (!data) return;

    // Group by push_name AND name to find lid↔phone pairs
    const byName = {};
    data.forEach(row => {
      const names = new Set();
      if ((row.push_name || '').trim().length >= 2) names.add(row.push_name.trim());
      if ((row.name || '').trim().length >= 2) names.add(row.name.trim());
      for (const name of names) {
        if (!byName[name]) byName[name] = [];
        byName[name].push(row);
      }
    });

    for (const name of Object.keys(byName)) {
      const entries = byName[name];
      let phoneJid = null, lidJid = null;
      for (const e of entries) {
        const jid = e.jid || '';
        const phone = (e.phone || '').replace(/\D/g, '');
        if (jid.includes('@lid')) {
          lidJid = jid.replace(/@lid$/, '');
        } else if (phone.length >= 7 && phone.length <= 15) {
          phoneJid = phone;
        }
      }
      if (phoneJid && lidJid) {
        registerLidPhoneMapping(lidJid, phoneJid);
      }
    }
    console.log('[LID-MAP] Loaded', lidToPhoneMap.size, 'mappings from Supabase');
  } catch (err) {
    console.error('[LID-MAP] Error loading mappings:', err.message);
  }
}

function normalizeJid(jid) {
  if (!jid) return jid;
  // Strip @s.whatsapp.net
  let clean = jid.replace(/@s\.whatsapp\.net$/, '');
  // Handle @lid → resolve to real phone if mapping exists
  if (clean.endsWith('@lid')) {
    const lidNum = clean.replace(/@lid$/, '');
    const phone = lidToPhoneMap.get(lidNum);
    if (phone) return phone;
    return lidNum; // Fallback: return lid number without suffix
  }
  return clean;
}

function getSocket() { return sock; }
function getQR() { if (userDisconnected) return null; return qrCode; }

// ── STEALTH: Simulación de presencia natural como WhatsApp Web real ──
// Un usuario real abre WhatsApp Web, lo usa un rato, luego cierra la pestaña.
// Simulamos este patrón con ciclos de disponible/no-disponible.
let _presenceTimer = null;
function startPresenceSimulation(socket) {
  if (_presenceTimer) clearInterval(_presenceTimer);

  // Marcar disponible inmediatamente (como abrir la pestaña)
  try { socket.sendPresenceUpdate('available'); } catch(e) {}
  console.log('[Stealth] Presencia: available (simulando pestaña abierta)');

  // Ciclo: cada 3-7 minutos, alternar entre available/unavailable
  // WhatsApp Web real envía "unavailable" cuando el tab pierde foco
  let isAvailable = true;
  _presenceTimer = setInterval(() => {
    if (connectionState !== 'connected' || userDisconnected) {
      clearInterval(_presenceTimer);
      _presenceTimer = null;
      return;
    }
    try {
      if (isAvailable) {
        // Simular que el usuario cambió de pestaña (30% probabilidad de irse)
        if (Math.random() < 0.3) {
          socket.sendPresenceUpdate('unavailable');
          isAvailable = false;
          console.log('[Stealth] Presencia: unavailable (simulando pestaña en background)');
        }
      } else {
        // Simular que volvió a la pestaña (70% probabilidad de volver)
        if (Math.random() < 0.7) {
          socket.sendPresenceUpdate('available');
          isAvailable = true;
          console.log('[Stealth] Presencia: available (simulando regreso a pestaña)');
        }
      }
    } catch(e) { /* ignorar errores de presencia */ }
  }, (180 + Math.floor(Math.random() * 240)) * 1000); // 3-7 minutos
}
function getConnectionState() {
  // Si el usuario desvinculó, SIEMPRE reportar disconnected
  // sin importar qué haga internamente el socket de Baileys
  if (userDisconnected) return 'disconnected';
  return connectionState;
}

async function initBaileys(supabase, sse) {
  supabaseClient = supabase;
  sseManager = sse;
  setSseManager(sse); // Pasar SSE manager a auto-reply para eventos bot_typing
  await connectToWhatsApp();
}


// ── Audio transcription via Gemini — 3 capas (literal + contextual + intención) ──────
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

    const prompt = `Eres experto en transcripción de audios de WhatsApp colombianos.
El audio puede ser de una persona mayor (60-80 años), con voz baja, acento regional, ruido de fondo o pronunciación poco clara.

Haz 3 interpretaciones del audio:
LITERAL: (escribe textualmente lo que escuchas, aunque sea parcial o con ruido)
CONTEXTUAL: (interpreta lo que probablemente quiso decir; es cliente de una tienda de cosméticos naturales colombiana — jabones artesanales, cremas, productos para manchas, acné, piel grasa/seca, precios, envíos, pedidos)
INTENCION: (¡qué está preguntando o pidiendo concretamente? escríbelo en una frase clara y directa)

Luego elige la interpretación más útil y completa para que la IA pueda responder con precisión:
FINAL: (puede combinar las 3 capas — debe ser claro y completo aunque el audio fuera difícil de entender)

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


/**
 * Limpia el socket anterior de forma segura antes de reconectar.
 * Evita leak de event listeners y conexiones zombie.
 */
function cleanupOldSocket() {
  if (!sock) return;
  try { sock.ev.removeAllListeners(); } catch(e) {}
  try { sock.end(undefined); } catch(e) {}
  sock = null;
}

async function connectToWhatsApp() {
  // GUARD: si el usuario desvinculó, NO reconectar bajo ninguna circunstancia
  if (userDisconnected || isDisconnecting) {
    console.log('[Connect] BLOQUEADO — userDisconnected=' + userDisconnected + ' isDisconnecting=' + isDisconnecting);
    return;
  }
  // Limpiar socket anterior para evitar listeners duplicados
  cleanupOldSocket();
  // Limpiar QR viejo inmediatamente para no servir QR expirado
  qrCode = null;
  connectionState = 'connecting';
  if (sseManager) sseManager.broadcast({ type: 'connection', data: { status: 'connecting' } });

  // Inicializar anti-ban si no existe
  if (!antiBanInstance) await initAntiBan();

  const { state, saveCreds } = await useSupabaseAuthState(supabaseClient);
  const hasExistingSession = !!(state.creds && state.creds.me);
  console.log('[Connect] Sesion existente:', hasExistingSession ? 'SI (reconexion silenciosa)' : 'NO (necesita QR)');
  const { version } = await fetchLatestBaileysVersion();
  const logger = pino({ level: 'silent' });

  // ── STEALTH: fingerprint de WhatsApp Web real (Mayo 2026 — ACTUALIZADO) ──
  // WhatsApp identifica dispositivos vinculados por el campo browser[].
  // CRITICAL: versiones deben coincidir con releases ACTUALES, no de hace 2 años.
  // Chrome 148-149 (May 2026), Edge 148, Firefox 151, Safari 26.5
  const _realBrowserFingerprints = [
    ['Chrome (Windows)', 'Chrome', '148.0.3967.83'],
    ['Chrome (Windows)', 'Chrome', '149.0.7827.22'],
    ['Chrome (Mac OS)', 'Chrome', '148.0.3967.83'],
    ['Edge (Windows)', 'Edge', '148.0.3967.83'],
    ['Chrome (Linux)', 'Chrome', '148.0.3967.75'],
    ['Firefox (Windows)', 'Firefox', '151.0.2'],
    ['Chrome (Windows)', 'Chrome', '148.0.3967.97'],
    ['Safari (Mac OS)', 'Safari', '26.5'],
  ];
  // CRITICAL: PERSISTIR fingerprint — un usuario real NO cambia de Chrome a Firefox entre sesiones.
  // Guardar en creds para que sea consistente entre reconexiones y reinicios.
  let _selectedBrowser;
  if (state.creds && state.creds._browserFingerprint) {
    // Reusar fingerprint guardado de la sesión existente
    _selectedBrowser = state.creds._browserFingerprint;
    console.log('[Stealth] Reutilizando fingerprint persistido:', _selectedBrowser[0], _selectedBrowser[2]);
  } else {
    // Primera conexión: elegir uno aleatorio y persistirlo
    _selectedBrowser = _realBrowserFingerprints[Math.floor(Math.random() * _realBrowserFingerprints.length)];
    // Persistir en creds para futuras reconexiones
    if (state.creds) {
      state.creds._browserFingerprint = _selectedBrowser;
      saveCreds().catch(() => {});
    }
    console.log('[Stealth] Nuevo fingerprint seleccionado:', _selectedBrowser[0], _selectedBrowser[2]);
  }
  const stealthConfig = getStealthSocketConfig ? getStealthSocketConfig({ os: _selectedBrowser[0] }) : {};
  // Si stealth module provee su propio browser, usarlo; si no, usar nuestro pool realista

  // ── PROXY: inyectar agent si WA_PROXY_URL está configurado ──
  const proxyAgent = getProxyAgent();
  if (proxyAgent) console.log('[Proxy] Conectando vía proxy:', process.env.WA_PROXY_URL.replace(/\/\/.*@/, '//***@'));

  const rawSock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    // Browser fingerprint PERSISTIDO: prioridad stealth module > fingerprint guardado
    browser: stealthConfig.browser || _selectedBrowser,
    // WhatsApp Web real: marca online al conectar (tab activo)
    // NOTA: false era sospechoso — WA Web real SÍ marca online cuando la pestaña está enfocada
    markOnlineOnConnect: true,
    printQRInTerminal: true,
    // generateHighQualityLinkPreview genera tráfico extra detectable — desactivar
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    // WhatsApp Web real acepta mensajes recientes (últimas 24h) — rechazar TODO es sospechoso
    shouldSyncHistoryMessage: (msg) => {
      // Aceptar mensajes de las últimas 24 horas (como WA Web real)
      const msgAge = Date.now() / 1000 - (msg.messageTimestamp || 0);
      return msgAge < 86400; // 24 horas
    },
    // Firewall de presencia: emitir updates solo cuando hay actividad real (no en idle)
    emitOwnEvents: true,
    // Timeout de conexión: 60s como WhatsApp Web real
    connectTimeoutMs: 60000,
    // Retry en desconexiones temporales: WA Web real reintenta
    retryRequestDelayMs: 250,
    // Proxy agent para IP residencial/rotación (opcional — set WA_PROXY_URL env var)
    agent: proxyAgent,
    getMessage: async (key) => {
      return { conversation: '' };
    }
  });

  // ── ANTI-BAN: wrap socket con protección si disponible ──
  if (wrapSocket && antiBanInstance) {
    try {
      sock = wrapSocket(rawSock, {
        maxPerMinute: 6,
        maxPerHour: 120,
        maxPerDay: 800,
        minDelayMs: 2000,
        maxDelayMs: 6000,
        logging: true,
      });
      console.log('[AntiBan] Socket wrapped con protección anti-ban');
    } catch (e) {
      console.warn('[AntiBan] Error wrapping socket:', e.message, '— usando socket sin protección');
      sock = rawSock;
    }
  } else {
    sock = rawSock;
  }

  // Guard: no guardar creds si estamos en proceso de desvinculacion
  sock.ev.on('creds.update', () => {
    if (isDisconnecting || userDisconnected) {
      console.log('[AUTH] saveCreds BLOQUEADO — isDisconnecting=' + isDisconnecting + ' userDisconnected=' + userDisconnected);
      return;
    }
    saveCreds();
  });

  // ── AUTO-BACKUP + HIDE helper: crea backup y oculta datos al desconectar ──
  async function autoBackupAndHide(sb, s) {
    if (!sb) return;
    try {
      const rawPhoneId = s?.user?.id || '';
      const phoneNumber = rawPhoneId.replace(/:.*$/, '').replace(/@s\.whatsapp\.net$/, '').replace(/[^0-9]/g, '');
      if (!phoneNumber) { console.log('[AutoBackup] No phone number — skip'); return; }

      // Count chats & messages
      const { count: chatsCount } = await sb.from('oasis_wa_chats').select('*', { count: 'exact', head: true });
      const { count: messagesCount } = await sb.from('oasis_wa_messages').select('*', { count: 'exact', head: true });

      // Create backup record
      await sb.from('oasis_wa_backups').insert({
        phone_number: phoneNumber,
        backup_date: new Date().toISOString(),
        chats_count: chatsCount || 0,
        messages_count: messagesCount || 0,
        status: 'active'
      });

      // Tag untagged chats and messages with this phone
      await sb.from('oasis_wa_chats').update({ phone_number: phoneNumber }).is('phone_number', null);
      await sb.from('oasis_wa_messages').update({ phone_number: phoneNumber }).is('phone_number', null);

      // Hide data — set active_phone to hidden
      await sb.from('oasis_wa_config').upsert({
        id: 'active_phone',
        system_prompt: JSON.stringify({ phone: null, hidden: true, hidden_at: new Date().toISOString(), auto: true })
      });

      console.log('[AutoBackup] Backup creado para +' + phoneNumber + ' (' + chatsCount + ' chats, ' + messagesCount + ' msgs) — datos ocultos');
      if (sseManager) sseManager.broadcast({ type: 'backup', data: { phone: phoneNumber, chatsCount, messagesCount, hidden: true } });
    } catch (e) {
      console.error('[AutoBackup] Error:', e.message);
    }
  }

  // ── AUTO-RESTORE helper: restaura datos al reconectar con un número conocido ──
  async function autoRestore(sb, s) {
    if (!sb) return;
    try {
      const rawPhoneId = s?.user?.id || '';
      const phoneNumber = rawPhoneId.replace(/:.*$/, '').replace(/@s\.whatsapp\.net$/, '').replace(/[^0-9]/g, '');
      if (!phoneNumber) return;

      // Check if there's a backup for this number
      const { data: backups } = await sb.from('oasis_wa_backups')
        .select('*')
        .eq('phone_number', phoneNumber)
        .order('backup_date', { ascending: false })
        .limit(1);

      if (backups && backups.length > 0) {
        // Restore — set active phone and unhide
        await sb.from('oasis_wa_config').upsert({
          id: 'active_phone',
          system_prompt: JSON.stringify({ phone: phoneNumber, hidden: false, restored_at: new Date().toISOString(), auto: true })
        });
        console.log('[AutoRestore] Datos restaurados automáticamente para +' + phoneNumber);
        if (sseManager) sseManager.broadcast({ type: 'restore', data: { phone: phoneNumber, auto: true } });
      } else {
        // No backup — just set phone as active, not hidden
        await sb.from('oasis_wa_config').upsert({
          id: 'active_phone',
          system_prompt: JSON.stringify({ phone: phoneNumber, hidden: false, restored_at: new Date().toISOString() })
        });
        console.log('[AutoRestore] Número +' + phoneNumber + ' activado (sin backup previo)');
      }
    } catch (e) {
      console.error('[AutoRestore] Error:', e.message);
    }
  }

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrCode = qr;
      connectionState = 'qr';
      qrAttempts++;
      console.log('QR listo (intento ' + qrAttempts + '/' + MAX_QR_ATTEMPTS + ') - escanea con tu telefono');
      if (sseManager) sseManager.broadcast({ type: 'qr', data: qr, attempt: qrAttempts, maxAttempts: MAX_QR_ATTEMPTS });
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log('Desconectado. Razon:', reason);

      // ── ANTI-BAN: clasificar desconexión + notificar health monitor ──
      if (classifyDisconnect) {
        const classification = classifyDisconnect(reason);
        console.log('[AntiBan] Disconnect:', classification.category, '-', classification.message,
          '| shouldReconnect:', classification.shouldReconnect,
          '| backoff:', (classification.backoffMs || 0) + 'ms');
      }
      if (antiBanInstance) {
        try { antiBanInstance.onDisconnect(reason); } catch(e) {}
      }

      // Limpiar QR viejo inmediatamente para no servir QR expirado
      qrCode = null;
      connectionState = 'disconnected';
      if (sseManager) sseManager.broadcast({ type: 'connection', data: { status: 'disconnected', reason } });

      // Cancelar cualquier timer de reconexion pendiente
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

      // Si fue un logout intencional (boton Desvincular), NO reconectar
      if (intentionalLogout) {
        intentionalLogout = false;
        console.log('[Desvincular] Logout intencional - NO reconectar. Esperando POST /connect.');
        // ── AUTO-BACKUP + HIDE: guardar datos y ocultar paneles ──
        await autoBackupAndHide(supabaseClient, sock);
        await clearAuth(supabaseClient);
        initialSyncDone = false;
        return;
      }

      // Si el usuario desconecto manualmente, NO reconectar bajo NINGUNA razon
      if (userDisconnected) {
        console.log('[Desvincular] userDisconnected=true - ignorando close event (reason=' + reason + ')');
        return;
      }

      // ── SAFE RECONNECT HELPER: siempre verifica flags antes de reconectar ──
      function safeReconnect(delayMs, label) {
        if (userDisconnected || isDisconnecting) {
          console.log('[' + label + '] BLOQUEADO por flags — userDisconnected=' + userDisconnected + ' isDisconnecting=' + isDisconnecting);
          return;
        }
        reconnectTimer = setTimeout(() => {
          if (userDisconnected || isDisconnecting) {
            console.log('[' + label + '] Timer fired but BLOQUEADO — userDisconnected=' + userDisconnected);
            return;
          }
          connectToWhatsApp();
        }, delayMs);
      }

      if (reason === DisconnectReason.loggedOut) {
        // Sesion invalidada por WhatsApp (usuario removio dispositivo desde telefono)
        console.log('[LoggedOut] Sesion invalidada - limpiando auth y generando nuevo QR...');
        // ── AUTO-BACKUP + HIDE: guardar datos y ocultar paneles ──
        await autoBackupAndHide(supabaseClient, sock);
        await clearAuth(supabaseClient);
        initialSyncDone = false;
        qrAttempts = 0;
        safeReconnect(2000, 'LoggedOut');
      } else if (reason === DisconnectReason.restartRequired) {
        // QR expirado o sesion necesita reinicio
        if (qrAttempts >= MAX_QR_ATTEMPTS) {
          console.log('[QR] ' + qrAttempts + ' intentos sin escanear — pausando. Usar POST /connect para reanudar.');
          connectionState = 'qr_timeout';
          if (sseManager) sseManager.broadcast({ type: 'connection', data: { status: 'qr_timeout', attempts: qrAttempts, message: 'QR expirado. Presiona Conectar para generar nuevo QR.' } });
          return;
        }
        const delay = Math.min(1000 + Math.floor(qrAttempts / 2) * 1000, 5000);
        console.log('[QR] Restart requerido (intento ' + qrAttempts + ') — nuevo QR en ' + delay + 'ms...');
        safeReconnect(delay, 'QR-restart');
      } else if (reason === DisconnectReason.connectionReplaced) {
        console.log('[440] Conexion reemplazada - cerrando proceso...');
        setTimeout(() => {
          console.log('[440] Saliendo - la nueva instancia es la activa.');
          process.exit(0);
        }, 3000);
      } else {
        qrAttempts = 0;
        console.log('[Reconnect] Reconectando en 5 segundos (reason=' + reason + ')...');
        connectionState = 'reconnecting';
        if (sseManager) sseManager.broadcast({ type: 'connection', data: { status: 'reconnecting', reason } });
        safeReconnect(5000, 'Reconnect');
      }
    }

    if (connection === 'open') {
      connectionState = 'connected';
      qrCode = null;
      qrAttempts = 0; // Reset QR counter on successful connection
      console.log('WhatsApp CONECTADO' + (hasExistingSession ? ' (reconexion silenciosa - sin QR)' : ' (nueva sesion via QR)'));
      if (sseManager) sseManager.broadcast({ type: 'connection', data: { status: 'connected' } });
      // ── ANTI-BAN: notificar reconexión exitosa ──
      if (antiBanInstance) {
        try { antiBanInstance.onReconnect(); } catch(e) {}
        const stats = antiBanInstance.getStats();
        console.log('[AntiBan] Health:', stats.health?.risk || 'unknown',
          '| Score:', stats.health?.score || 0,
          '| WarmUp day:', stats.warmUp?.day || 'N/A');
      }
      // Guardar sesion completa en Supabase al conectar (CRITICO para reconexion)
      saveAuthToSupabase(supabaseClient).then(() => {
        console.log('[AUTH] Sesion guardada en Supabase tras conexion OK');
      }).catch(err => {
        console.error('[AUTH] ERROR guardando sesion tras conexion:', err.message);
      });
      // ── AUTO-RESTORE: restaurar datos si hay backup para este número ──
      autoRestore(supabaseClient, sock).catch(e => console.error('[AutoRestore] Error:', e.message));
      // Update auto-reply, audio-tts, and transfer-handler socket references
      updateSocket(sock);
      updateAudioSocket(sock);
      transferHandler.updateSocket(sock);
      transferHandler.initTransferHandler(supabaseClient, sock).catch(e => console.error('[Transfer] Init error:', e.message));
      // Load LID→Phone mappings from Supabase for proper message routing
      loadLidPhoneMappings().catch(e => console.error('[LID-MAP] Init error:', e.message));
      if (!initialSyncDone) setTimeout(runInitialSync, 3000);

      // ── STEALTH: Simulación de presencia como WhatsApp Web real ──
      // WA Web real: marca "available" al abrir pestaña, "unavailable" al cerrarla.
      // Simulamos un patrón natural: online al conectar, luego ciclos on/off.
      startPresenceSimulation(sock);
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
          // Signal session reset is handled silently by clearing the session keys above.
          // DO NOT send any message (even zero-width space) — it arrives as blank in WhatsApp.
          console.log('[SESSION] Signal reset silencioso para', jid.split('@')[0], '- proximo msg deberia funcionar');
        }
        continue;
      }
      const chatId = msg.key.remoteJid;
      let storageId = normalizeJid(chatId);
      const fromMe = msg.key.fromMe || false;
      const isGroup = isJidGroup(chatId);
      const pushName = msg.pushName || null;
      const senderName = pushName || contactCache.get(chatId) || chatId.split('@')[0];
      const messageText = extractText(msg);
      const messageType = getMessageType(msg);
      const timestamp = msg.messageTimestamp;

      // ── Dynamic LID→Phone resolution ──
      // When we see a @lid message, resolve to real phone number
      if (chatId && chatId.endsWith('@lid') && !isGroup) {
        const lidNum = chatId.replace(/@lid$/, '');
        if (lidToPhoneMap.has(lidNum)) {
          storageId = lidToPhoneMap.get(lidNum);
        } else if (supabaseClient) {
          try {
            let resolved = false;
            // Strategy 1: Look up by push_name OR name in oasis_wa_chats
            if (pushName) {
              const { data: matches } = await supabaseClient
                .from('oasis_wa_chats')
                .select('phone,jid')
                .or('push_name.eq.' + pushName + ',name.eq.' + pushName)
                .not('jid', 'like', '%@lid')
                .limit(5);
              if (matches && matches.length > 0) {
                for (const m of matches) {
                  const phone = (m.phone || '').replace(/\D/g, '');
                  if (phone.length >= 7 && phone.length <= 15) {
                    registerLidPhoneMapping(lidNum, phone);
                    storageId = phone;
                    resolved = true;
                    break;
                  }
                }
              }
            }
            if (!resolved) {
              console.log('[LID-MAP] Could not resolve LID', lidNum, 'pushName:', pushName);
            }
          } catch (lookupErr) {
            console.log('[LID-MAP] Lookup error for', pushName, ':', lookupErr.message);
          }
        }
      }

      // Saltar mensajes fromMe sin texto legible (protocol msgs, ACKs, mensajes del bot
      // ya guardados por auto-reply.js/routes.js) — evita bubbles vacíos en el dashboard
      if (fromMe && !messageText && messageType === 'other') {
        console.log('[SKIP] fromMe sin texto legible, tipo=other, id=' + msg.key.id?.substring(0, 8));
        continue;
      }

      if (pushName && !isGroup) contactCache.set(chatId, pushName);

      console.log((fromMe ? '-> ' : '<- ') + senderName + ': ' + (messageText || '').substring(0, 50) + ' [' + messageType + ']');

      // --- Subir media (audio/image/video) a Supabase Storage para obtener URL pública ---
      let mediaUrl = null;
      if (['audio', 'image', 'video'].includes(messageType) && !fromMe) {
        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {});
          if (buffer && buffer.length > 0) {
            const ext = messageType === 'audio' ? 'ogg' : messageType === 'image' ? 'jpg' : 'mp4';
            const fileName = `${storageId}/${Date.now()}_${msg.key.id?.substring(0, 8)}.${ext}`;
            const mime = messageType === 'audio'
              ? (msg.message?.audioMessage?.mimetype || 'audio/ogg')
              : messageType === 'image'
                ? (msg.message?.imageMessage?.mimetype || 'image/jpeg')
                : (msg.message?.videoMessage?.mimetype || 'video/mp4');
            const { data: uploadData, error: uploadErr } = await supabaseClient.storage
              .from('wa-media')
              .upload(fileName, buffer, { contentType: mime, upsert: true });
            if (!uploadErr && uploadData) {
              const { data: urlData } = supabaseClient.storage
                .from('wa-media')
                .getPublicUrl(fileName);
              mediaUrl = urlData?.publicUrl || null;
              console.log('[Media] Subido:', messageType, '->', mediaUrl?.substring(0, 80));
            } else if (uploadErr) {
              console.error('[Media] Error subiendo:', uploadErr.message);
            }
          }
        } catch (mediaErr) {
          console.error('[Media] Error descargando:', mediaErr.message);
        }
      }

      await saveMessage(storageId, senderName, {
        messageId: msg.key.id,
        text: messageText,
        type: messageType,
        fromMe,
        mediaUrl,
        timestamp: timestamp ? (typeof timestamp === 'object' ? timestamp.low : timestamp) : Math.floor(Date.now() / 1000)
      });

      /* Solo guardar en lista de chats si NO es grupo — grupos no deben aparecer en Clientes */
      if (!isGroup) {
        await upsertChat(storageId, senderName, messageText || '[' + messageType + ']',
          typeof timestamp === 'object' ? timestamp.low : timestamp,
          fromMe ? 'outgoing' : 'incoming'
        );
      }

      if (sseManager) sseManager.broadcast({
        type: 'message',
        data: { chatId: storageId, messageId: msg.key.id, pushName, senderName, text: messageText, messageType, fromMe, isGroup, timestamp: Date.now() }
      });

      // ── TRANSFER HANDLER: intercept reviewer responses & screenshot images ──
      if (!fromMe && !isGroup && type === 'notify') {
        const replyJid = storageId.includes('@') ? storageId : storageId + '@s.whatsapp.net';
        const tCfg = transferHandler.getConfig();

        // Check if this message is from the WA receptor (reviewer)
        const receptorNum = (tCfg.transfer_wa_receptor || '').replace(/\D/g, '');
        const senderNum = storageId.replace(/\D/g, '');
        if (receptorNum && senderNum === receptorNum && messageText) {
          const handled = await transferHandler.handleReviewerResponse(chatId, messageText).catch(() => false);
          if (handled) {
            console.log('[Transfer] Reviewer response handled from', senderNum);
            continue; // Skip auto-reply for reviewer commands
          }
        }

        // Check if client is awaiting screenshot and sent an image
        if (messageType === 'image' && tCfg.transfer_enabled) {
          try {
            const awaiting = await transferHandler.isAwaitingScreenshot(replyJid);
            if (awaiting && mediaUrl) {
              const analysis = await analyzeImage(msg);
              console.log('[Transfer] Screenshot received from', storageId, '| mediaUrl:', (mediaUrl || '').substring(0, 60));
              await transferHandler.handleScreenshot(replyJid, storageId, pushName || senderName, mediaUrl, analysis);
              continue; // Don't process as normal auto-reply
            }
          } catch (tErr) { console.error('[Transfer] Screenshot check error:', tErr.message); }
        }
      }

      // Auto-reply: texto + audio (transcrito) + imagen (analizada con Gemini)
      if (!fromMe && !isGroup && type === 'notify') {
      // Suscribirse a presencia para recibir eventos de escritura
      try { sock.presenceSubscribe(chatId).catch(() => {}); } catch(e) {}
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
          // Use resolved phone JID for auto-reply (so responses go to phone, not @lid)
          try { sock.sendPresenceUpdate('composing', chatId).catch(() => {}); } catch(e) {}
          const audioDuration = messageType === 'audio'
            ? (msg.message?.audioMessage?.seconds || 0) : 0;
          handleIncomingMessage(replyJid, effectiveText, pushName || senderName, msg.key.id,
            { isAudioMessage: messageType === 'audio', audioDuration, messageType, mediaUrl })
            .then(() => { try { sock.sendPresenceUpdate('paused', chatId).catch(() => {}); } catch(e) {} })
            .catch(err => {
              console.error('Auto-reply error:', err.message);
              try { sock.sendPresenceUpdate('paused', chatId).catch(() => {}); } catch(e) {}
            });
        }
      }
    }
  });

  // ── contacts.upsert: capture LID→Phone mappings from Baileys ──
  sock.ev.on('contacts.upsert', (contacts) => {
    for (const contact of contacts) {
      const id = contact.id || '';
      const lid = contact.lid || '';
      const notify = contact.notify || contact.name || '';
      if (id && lid && !id.endsWith('@lid') && lid.includes('@lid')) {
        const phone = id.replace(/@s\.whatsapp\.net$/, '').replace(/\D/g, '');
        const lidNum = lid.replace(/@lid$/, '');
        if (phone.length >= 7 && phone.length <= 15 && lidNum.length >= 7) {
          registerLidPhoneMapping(lidNum, phone);
        }
      }
      if (notify && id) contactCache.set(id, notify);
    }
  });

  sock.ev.on('contacts.update', (updates) => {
    for (const { id, notify } of updates) {
      if (notify) {
        contactCache.set(id, notify);
        // Persist pushName to Supabase (fix: contacts.update was memory-only)
        const phone = normalizeJid(id);
        if (supabaseClient && phone && notify !== phone) {
          supabaseClient.from('oasis_wa_chats')
            .update({ push_name: notify, updated_at: new Date().toISOString() })
            .eq('phone', phone)
            .then(({ error }) => { if (error && error.code !== 'PGRST116') console.warn('[contacts.update] SB:', error.message); })
            .catch(() => {});
        }
      }
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
        .slice(0, 50);

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
  // Standard text types
  const txt = inner.conversation || inner.extendedTextMessage?.text || inner.imageMessage?.caption || inner.videoMessage?.caption || inner.documentMessage?.caption || inner.buttonsResponseMessage?.selectedDisplayText || inner.listResponseMessage?.title || inner.templateButtonReplyMessage?.selectedDisplayText || null;
  if (txt) return txt;
  // Interactive button response (nativeFlow quick_reply) — extract button ID
  try {
    const irm = inner.interactiveResponseMessage;
    if (irm && irm.nativeFlowResponseMessage) {
      const params = JSON.parse(irm.nativeFlowResponseMessage.paramsJson || '{}');
      if (params.id) return params.id; // Returns the button ID e.g. "transfer_approve_123"
    }
  } catch (_e) { /* ignore parse errors */ }
  return null;
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
  // Guard: never send blank/invisible-only text messages
  const _invisRe = /[\u200b\u200c\u200d\u200e\u200f\ufeff\u00ad\u2060\u180e\s]/g;
  if (typeof content === 'string' && !content.replace(_invisRe, '')) {
    console.log('[sendMessage] BLOCKED blank/invisible msg to', chatId);
    return { key: { id: 'blocked-invisible' } };
  }
  if (content && content.text && !content.text.replace(_invisRe, '')) {
    console.log('[sendMessage] BLOCKED blank/invisible msg to', chatId);
    return { key: { id: 'blocked-invisible' } };
  }
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

  await upsertChat(storageId, null, sentText, Math.floor(Date.now() / 1000), 'outgoing');

  if (sseManager) sseManager.broadcast({
    type: 'message_sent',
    data: { chatId: storageId, messageId: sent.key.id, text: sentText, timestamp: Date.now() }
  });

  return sent;
}

async function disconnect() {
  console.log('[Desvincular] Iniciando desvinculacion...');

  // 1. Flags PRIMERO — bloquean cualquier auto-reconnect Y saveCreds
  isDisconnecting = true;
  intentionalLogout = true;
  userDisconnected = true;
  disconnectLockUntil = Date.now() + 15000; // Bloquear POST /connect por 15 segundos
  permanentDisconnect = true; // Solo se resetea con POST /connect?force=true (click explícito del usuario)

  // 2. Cancelar TODOS los timers de reconexion pendientes
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  // 3. Limpiar estado inmediatamente
  qrCode = null;
  initialSyncDone = false;
  qrAttempts = 0;
  connectionState = 'disconnected';

  if (sock) {
    const oldSock = sock;
    sock = null; // Nullificar ANTES de cualquier async para evitar race conditions

    // 4. Remover TODOS los listeners para evitar que el close event dispare reconnect
    try { oldSock.ev.removeAllListeners(); } catch(e) {}
    console.log('[Desvincular] Listeners removidos');

    // 5. Limpiar auth de filesystem y Supabase
    await clearAuth(supabaseClient);
    console.log('[Desvincular] Auth limpiada (1/3)');

    // 6. Logout del socket (puede fallar si ya esta desconectado, no importa)
    try {
      await oldSock.logout();
      console.log('[Desvincular] sock.logout() exitoso');
    } catch (err) {
      console.log('[Desvincular] sock.logout() error (normal):', err.message);
    }

    // 7. Cerrar socket de todas las formas posibles
    try { oldSock.end(undefined); } catch(e) {}
    try { if (oldSock.ws) oldSock.ws.close(); } catch(e) {} // Forzar cierre WebSocket
    console.log('[Desvincular] Socket destruido');

    // 8. Limpiar auth OTRA VEZ (por si saveCreds corrio durante logout)
    await clearAuth(supabaseClient);
    console.log('[Desvincular] Auth limpiada (2/3)');

    // 9. Limpiar auth una TERCERA vez despues de 3 segundos (atrapar saveCreds fire-and-forget)
    setTimeout(async () => {
      await clearAuth(supabaseClient);
      console.log('[Desvincular] Auth limpiada (3/3 - delayed cleanup)');
      isDisconnecting = false;
    }, 3000);
  } else {
    isDisconnecting = false;
  }

  // 10. DISCONNECT GUARD: seguir matando cualquier timer de reconexion por 30 segundos
  // Esto atrapa timers que se crearon por eventos que ya estaban en el event loop
  const _disconnectGuard = setInterval(() => {
    if (reconnectTimer) {
      console.log('[Desvincular] GUARD: matando timer de reconexion tardio');
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }, 500);
  setTimeout(() => clearInterval(_disconnectGuard), 30000);

  // 11. Broadcast para que el frontend sepa que se desconecto
  if (sseManager) sseManager.broadcast({ type: 'connection', data: { status: 'disconnected', reason: 'intentional_logout' } });
  console.log('[Desvincular] Desvinculacion completa — userDisconnected=true, solo POST /connect puede reconectar');
}

async function startConnection(options) {
  const force = options && options.force;

  // Si ya esta conectado, no hacer nada
  if (connectionState === 'connected') {
    console.log('[Connect] Ya conectado, ignorando');
    return { blocked: true, reason: 'already_connected' };
  }

  // PERMANENT LOCK: después de Desvincular, solo reconectar si force=true
  if (permanentDisconnect && !force) {
    console.log('[Connect] BLOQUEADO — permanentDisconnect=true. Necesita force=true (click explícito del usuario).');
    return { blocked: true, reason: 'permanent_disconnect' };
  }

  // TIME LOCK: ignorar POST /connect si se acaba de desvincular
  if (Date.now() < disconnectLockUntil && !force) {
    const secsLeft = Math.ceil((disconnectLockUntil - Date.now()) / 1000);
    console.log('[Connect] BLOQUEADO por disconnectLock — faltan ' + secsLeft + 's.');
    return { blocked: true, reason: 'disconnect_lock', secsLeft };
  }

  console.log('[Connect] Iniciando nueva conexion' + (force ? ' (FORCE)' : '') + ' para generar QR...');

  // Cancelar cualquier timer de reconexion pendiente
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  // Limpiar socket anterior si existe
  cleanupOldSocket();

  // Resetear todos los flags para permitir conexion limpia
  userDisconnected = false;
  intentionalLogout = false;
  isDisconnecting = false;
  permanentDisconnect = false;
  disconnectLockUntil = 0;
  qrCode = null;
  initialSyncDone = false;
  qrAttempts = 0;

  // Limpiar auth para forzar nuevo QR
  await clearAuth(supabaseClient);

  await connectToWhatsApp();
}

function getQrAttempts() { return qrAttempts; }

function getDebugFlags() {
  return {
    userDisconnected,
    intentionalLogout,
    isDisconnecting,
    connectionState,
    hasSock: !!sock,
    qrCode: !!qrCode,
    reconnectTimerActive: !!reconnectTimer,
    disconnectLockSecsLeft: Math.max(0, Math.ceil((disconnectLockUntil - Date.now()) / 1000))
  };
}

module.exports = { initBaileys, getSocket, getQR, getConnectionState, getQrAttempts, getProfilePhoto, getContactName, sendMessage, disconnect, startConnection, contactCache, getAntiBan, getDebugFlags };
