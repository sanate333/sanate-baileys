/**
 * src/meta/index.js
 *
 * Mount point para el módulo Meta Cloud API.
 *
 * INSTALACIÓN (en src/index.js del bot):
 *
 *   const setupMeta = require('./meta');
 *   setupMeta(app, { supabase, sse });
 *
 * Variables de entorno necesarias en Render:
 *   META_APP_ID                  = 1468787708298775 (ya configurada)
 *   META_APP_SECRET              = (generar en Meta App Dashboard)
 *   META_WEBHOOK_VERIFY_TOKEN    = (string aleatorio que usás también en Meta App Dashboard)
 *   META_REDIRECT_URI            = https://sanate.store/dashboard/whatsapp-bot (opcional, default)
 */

const makeRoutes = require('./routes');
const cloudApi = require('./cloud-api');
const webhook = require('./webhook');

function setupMeta(app, { supabase, sse, onMessage } = {}) {
  if (!app) throw new Error('Express app requerido');
  if (!supabase) {
    console.warn('[Meta] Sin supabase — funcionalidad limitada');
  }
  const router = makeRoutes({ supabase, sse, onMessage });
  app.use('/api/whatsapp', router);
  console.log('[Meta] ✅ Cloud API routes montadas en /api/whatsapp/meta/*');
  // Print env status
  const hasSecret = !!process.env.META_APP_SECRET;
  const hasVerifyToken = !!process.env.META_WEBHOOK_VERIFY_TOKEN;
  console.log(`[Meta] APP_ID:    ${process.env.META_APP_ID || '1468787708298775 (default)'}`);
  console.log(`[Meta] APP_SECRET: ${hasSecret ? 'SET' : '⚠️ MISSING — set in Render env'}`);
  console.log(`[Meta] VERIFY_TOKEN: ${hasVerifyToken ? 'SET' : '⚠️ MISSING — set in Render env'}`);
}

module.exports = setupMeta;
module.exports.cloudApi = cloudApi;
module.exports.webhook = webhook;
