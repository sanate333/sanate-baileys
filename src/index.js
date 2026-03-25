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
const apiRoutes = require('./routes');
const { initConfigStore, loadConfigFromSupabase } = require('./auto-reply');

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

// === ARRANCAR TODO ===
async function start() {
  console.log('Sanate WhatsApp Bot Server');
  console.log('================================');

  console.log('Conectando Supabase...');
  const supabase = initSupabase();
  app.set('supabase', supabase);

  // Initialize AI config persistence
  initConfigStore(supabase);
  console.log('Cargando configuracion AI desde Supabase...');
  const configLoaded = await loadConfigFromSupabase();
  console.log(configLoaded ? 'Config AI cargada de Supabase' : 'No habia config guardada, usando defaults');

  server.listen(PORT, () => {
    console.log('Servidor corriendo en puerto ' + PORT);
    console.log('SSE disponible en /api/whatsapp/events');
  });

  // Self-ping to keep Render awake (every 10 min)
  const PING_URL = 'https://sanate-wa-bot.onrender.com/';
  setInterval(() => {
    const http = require('http');
    const https = require('https');
    const mod = PING_URL.startsWith('https') ? https : http;
    mod.get(PING_URL, (res) => {
      console.log('[Ping] Keep-alive: status', res.statusCode);
    }).on('error', (e) => {
      console.log('[Ping] Error:', e.message);
    });
  }, 10 * 60 * 1000); // 10 minutes
  console.log('[Ping] Self-ping activado cada 10 minutos');

  console.log('Iniciando conexion WhatsApp...');
  await initBaileys(supabase, sse);
  console.log('Baileys iniciado');
}

start().catch(err => {
  console.error('Error fatal:', err);
  process.exit(1);
});
