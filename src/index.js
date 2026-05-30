/**
 * SANATE WhatsApp Bot Server
 * Reemplazo completo de n8n + Baileys standalone
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { createServer } = require('http');

const { initBaileys, getSocket, getQR, getConnectionState } = require('./baileys');
const { saveAuthToSupabase } = require('./auth-store');
const { initSupabase } = require('./supabase');
const { SSEManager } = require('./sse');
const { initAutoReply } = require('./auto-reply');
const { initAudioTTS, updateAudioSocket } = require('./audio-tts');
const apiRoutes = require('./routes');
const { startTrackingCron } = require('../tracking-cron');
const storeContext = require('./store-context');
const multiStore = require('./multi-store');
const storesRoutes = require('./routes-stores');
const transfersRoutes = require('./routes-transfers');

const app = express();
const server = createServer(app);
const PORT = process.env.PORT || 5055;
let trackingCron = null;

// === MIDDLEWARE ===
// ── ANTI-BAN: API rate limiting to prevent abuse ──
let rateLimit;
try {
  rateLimit = require('express-rate-limit');
  // General API rate limit: 100 requests per minute
  app.use('/api/', rateLimit({ windowMs: 60 * 1000, max: 100, message: { error: 'Rate limit exceeded. Try again in a minute.' } }));
  // Stricter limit for send endpoints: 30 per minute
  app.use('/api/whatsapp/send', rateLimit({ windowMs: 60 * 1000, max: 30, message: { error: 'Send rate limit. Slow down to avoid bans.' } }));
  app.use('/api/whatsapp/chats/*/send', rateLimit({ windowMs: 60 * 1000, max: 30, message: { error: 'Send rate limit. Slow down to avoid bans.' } }));
  console.log('[ANTI-BAN] Express rate limiting activo');
} catch(e) {
  console.warn('[ANTI-BAN] express-rate-limit no disponible:', e.message);
}

app.use(cors({
  origin: ['https://sanate.store', 'http://localhost:3000'],
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
// Multi-tenant: attach store_id to every request
app.use(storeContext.storeMiddleware);

// === HOTFIXES: sirve scripts de UI desde /hotfixes ===
app.use('/hotfixes', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
}, express.static(path.join(__dirname, '../hotfixes')));

// === SSE MANAGER (tiempo real) ===
const sse = new SSEManager();
app.set('sse', sse);

// === HEALTH CHECK (Render lo necesita) ===
app.get('/', (req, res) => {
  res.json({
    service: 'Sanate WhatsApp Bot',
    status: 'running',
    uptime: Math.floor(process.uptime()),
    connection: getConnectionState(),
    timestamp: new Date().toISOString()
  });
});

// === API ROUTES ===
app.use('/api/whatsapp', apiRoutes);
app.use('/api/whatsapp', storesRoutes);
app.use('/api/whatsapp', transfersRoutes);

// === TRACKING CRON — manual trigger endpoint ===
const TRACKING_SECRET = process.env.SECRET || process.env.BAILEYS_SECRET || 'sanate_secret_2025';
app.post('/tracking/run', (req, res) => {
  const s = req.headers['x-secret'] || req.query.secret;
  if (s !== TRACKING_SECRET) return res.status(401).json({ error: 'No autorizado' });
  if (!trackingCron) return res.status(500).json({ error: 'Tracking cron not initialized' });
  trackingCron.runNow()
    .then(() => res.json({ ok: true }))
    .catch(e => res.status(500).json({ error: e.message }));
});

// === SELF-PING KEEP-ALIVE (evita que Render apague el servicio) ===
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || 'https://sanate-wa-bot.onrender.com';
const KEEP_ALIVE_INTERVAL = 4 * 60 * 1000; // 4 minutos (Render free tier duerme a los 15 min)
let keepAliveTimer = null;

function startKeepAlive() {
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  keepAliveTimer = setInterval(async () => {
    try {
      const res = await fetch(RENDER_URL + '/');
      const data = await res.json();
      console.log('[KeepAlive] Ping OK - status:', data.status, 'connection:', data.connection, 'uptime:', data.uptime + 's');
    } catch (err) {
      console.log('[KeepAlive] Ping fallo:', err.message);
    }
  }, KEEP_ALIVE_INTERVAL);
  console.log('[KeepAlive] Self-ping activo cada 4 min -> ' + RENDER_URL);
}

// === CARGAR CONFIG DESDE SUPABASE ===
async function loadConfigFromSupabase(supabase) {
  if (!supabase) { console.log('[Config] Supabase no disponible'); return; }
  const keys = ['META_TOKEN', 'META_PHONE_NUMBER_ID'];
  keys.forEach(k => {
    const v = process.env[k];
    console.log('[Config] ENV ' + k + ': ' + (v ? v.length + ' chars' : 'VACIO'));
  });
  try {
    const { data, error } = await supabase
      .from('app_config')
      .select('key, value')
      .in('key', keys);
    if (error) throw error;
    console.log('[Config] Supabase devolvio ' + (data ? data.length : 0) + ' filas');
    (data || []).forEach(row => {
      if (row.value) {
        process.env[row.key] = row.value;
        console.log('[Config] ' + row.key + ' SET desde Supabase (' + row.value.length + ' chars)');
      }
    });
  } catch (err) {
    console.warn('[Config] Error cargando desde Supabase:', err.message);
  }
}

// === ARRANCAR TODO ===
async function start() {
  console.log('Sanate WhatsApp Bot Server v3.2');
  // Multi-instance: auto-sync DEVICE_ID with STORE_ID for worker isolation
  if (process.env.STORE_ID && !process.env.DEVICE_ID) {
    process.env.DEVICE_ID = process.env.STORE_ID;
    console.log('[MultiInstance] Auto-set DEVICE_ID=STORE_ID=' + process.env.STORE_ID.substring(0, 8) + '...');
  }

  console.log('================================');

  console.log('Conectando Supabase...');
  const supabase = initSupabase();
  app.set('supabase', supabase);

  // Multi-tenant: inicializar store context y cargar tiendas
  storeContext.init(supabase);
  multiStore.init(supabase);
  await storeContext.loadStores();

  console.log('Cargando configuracion desde Supabase...');
  await loadConfigFromSupabase(supabase);
  console.log('[Meta] metaCloudEnabled:', !!(process.env.META_TOKEN && process.env.META_PHONE_NUMBER_ID));

  server.listen(PORT, () => {
    console.log('Servidor corriendo en puerto ' + PORT);
    console.log('SSE disponible en /api/whatsapp/events');
    // Iniciar self-ping una vez el servidor este escuchando
    startKeepAlive();
  });

  console.log('Iniciando auto-reply...');
  await initAutoReply(supabase, null); // socket will be set on connection

  console.log('Iniciando Audio TTS...');
  initAudioTTS(supabase, null); // socket will be set on connection

    // Multi-store: derive proxy URL for active store (sticky session per store)
  if (process.env.WA_PROXY_URL) {
    process.env._WA_PROXY_URL_BASE = process.env._WA_PROXY_URL_BASE || process.env.WA_PROXY_URL;
    const activeStoreId = multiStore.getActiveStoreId();
    const storeProxyUrl = multiStore.getProxyUrlForStore(activeStoreId);
    if (storeProxyUrl) {
      process.env.WA_PROXY_URL = storeProxyUrl;
      console.log('[MultiStore] Proxy aplicado para store ' + activeStoreId.substring(0, 8) + '...');
    }
  }

  console.log('Iniciando conexion WhatsApp...');
  await initBaileys(supabase, sse);
  console.log('Baileys iniciado');

  // Start tracking cron — adapter bridges getSocket/getConnectionState to getDevice interface
  console.log('Iniciando tracking cron...');
  trackingCron = startTrackingCron(function() {
    return { sock: getSocket(), status: getConnectionState() === 'open' ? 'connected' : 'disconnected' };
  });
  console.log('Tracking cron activo');
}

start().catch(err => {
  console.error('Error fatal:', err);
  process.exit(1);
});

// === MANEJO DE SENALES (evita crash cuando Render reinicia el contenedor) ===
async function gracefulShutdown(signal) {
  console.log('[Shutdown] Senal ' + signal + ' recibida - guardando sesion...');
  if (keepAliveTimer) clearInterval(keepAliveTimer);

  // 1. Guardar auth en Supabase ANTES de cerrar - critico para reconexion sin QR
  const supabase = app.get('supabase');
  if (supabase) {
    try {
      await saveAuthToSupabase(supabase);
      console.log('[Shutdown] Auth guardada en Supabase OK');
    } catch (err) {
      console.error('[Shutdown] Error guardando auth:', err.message);
    }
  }

  // 2. Cerrar socket de Baileys limpiamente (evita connectionReplaced en nueva instancia)
  const sock = getSocket();
  if (sock) {
    try { sock.ev.removeAllListeners(); } catch(e) {}
    try { sock.end(undefined); } catch(e) {}
    console.log('[Shutdown] Socket de Baileys cerrado');
  }

  // 3. Cerrar servidor HTTP
  server.close(() => {
    console.log('[Shutdown] Servidor HTTP cerrado. Saliendo.');
    process.exit(0);
  });
  // Forzar salida si el cierre tarda mas de 8 segundos
  setTimeout(() => {
    console.log('[Shutdown] Timeout - forzando salida.');
    process.exit(0);
  }, 8000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

// === PROTECCION CONTRA CRASHES SILENCIOSOS ===
process.on('uncaughtException', (err) => {
  console.error('[UncaughtException] Error no capturado (bot sigue corriendo):', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('[UnhandledRejection] Promesa sin manejar (bot sigue corriendo):', reason);
});
