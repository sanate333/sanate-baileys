/**
 * SANATE WhatsApp Bot Server
 * Reemplazo completo de n8n + Baileys standalone
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createServer } = require('http');

const { initBaileys, getSocket, getQR, getConnectionState } = require('./baileys');
const { initSupabase } = require('./supabase');
const { SSEManager } = require('./sse');
const { initAutoReply } = require('./auto-reply');
const apiRoutes = require('./routes');

const app = express();
const server = createServer(app);
const PORT = process.env.PORT || 5055;

// === MIDDLEWARE ===
app.use(cors({
  origin: ['https://sanate.store', 'http://localhost:3000'],
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));

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

// === SELF-PING KEEP-ALIVE (evita que Render apague el servicio) ===
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || 'https://sanate-wa-bot.onrender.com';
const KEEP_ALIVE_INTERVAL = 10 * 60 * 1000; // 10 minutos
let keepAliveTimer = null;

function startKeepAlive() {
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  keepAliveTimer = setInterval(async () => {
    try {
      const res = await fetch(RENDER_URL + '/');
      const data = await res.json();
      console.log('[KeepAlive] Ping OK - status:', data.status, 'connection:', data.connection, 'uptime:', data.uptime + 's');
    } catch (err) {
      console.log('[KeepAlive] Ping fall\u00f3:', err.message);
    }
  }, KEEP_ALIVE_INTERVAL);
  console.log('[KeepAlive] Self-ping activo cada 10 min -> ' + RENDER_URL);
}

// === ARRANCAR TODO ===
async function start() {
  console.log('Sanate WhatsApp Bot Server');
  console.log('================================');

  console.log('Conectando Supabase...');
  const supabase = initSupabase();
  app.set('supabase', supabase);

  server.listen(PORT, () => {
    console.log('Servidor corriendo en puerto ' + PORT);
    console.log('SSE disponible en /api/whatsapp/events');
    // Iniciar self-ping una vez el servidor est\u00e9 escuchando
    startKeepAlive();
  });

  console.log('Iniciando auto-reply...');
  await initAutoReply(supabase, null); // socket will be set on connection

  console.log('Iniciando conexion WhatsApp...');
  await initBaileys(supabase, sse);
  console.log('Baileys iniciado');
}

start().catch(err => {
  console.error('Error fatal:', err);
  process.exit(1);
});
