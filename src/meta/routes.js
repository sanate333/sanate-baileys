/**
 * src/meta/routes.js
 *
 * Endpoints REST para integración Meta WhatsApp Cloud API.
 *
 * POST /api/whatsapp/meta/embedded-signup    — recibe code/access_token de Embedded Signup
 * GET  /api/whatsapp/meta/webhook            — verificación inicial
 * POST /api/whatsapp/meta/webhook            — eventos (mensajes, status)
 * POST /api/whatsapp/meta/send               — enviar mensaje via Cloud API
 * GET  /api/whatsapp/meta/status             — estado conexión para un store
 * GET  /api/whatsapp/meta/templates          — lista plantillas aprobadas
 * POST /api/whatsapp/meta/templates          — crear plantilla para aprobación
 * GET  /api/whatsapp/meta/conversations      — métricas costos
 * POST /api/whatsapp/meta/disconnect         — desconectar (mantiene chats)
 */

const express = require('express');
const cloudApi = require('./cloud-api');
const webhook = require('./webhook');

function makeRoutes({ supabase, sse, onMessage }) {
  const router = express.Router();

  const APP_ID = process.env.META_APP_ID || '1468787708298775';
  const APP_SECRET = process.env.META_APP_SECRET;
  const REDIRECT_URI = process.env.META_REDIRECT_URI || 'https://sanate.store/dashboard/whatsapp-bot';

  // Middleware para acceder a rawBody en el webhook (necesario para signature)
  // NOTA: si express.json() global tiene verify callback, req.rawBody ya está set
  router.use('/meta/webhook', (req, res, next) => {
    if (req.method === 'POST') {
      // Only fall back to raw parsing if rawBody not already captured by global verify
      if (!req.rawBody && Buffer.isBuffer(req.body)) {
        try {
          req.rawBody = req.body.toString('utf8');
          req.body = JSON.parse(req.rawBody);
        } catch (e) {
          req.body = {};
        }
      }
    }
    next();
  });

  /* GET webhook — Meta verification */
  router.get('/meta/webhook', webhook.handleVerify);

  /* POST webhook — events */
  router.post('/meta/webhook', webhook.makeHandler({
    supabase,
    appSecret: APP_SECRET,
    onMessage,
    onStatus: async ({ status }) => {
      // Broadcast via SSE
      try {
        if (sse && sse.broadcast) {
          sse.broadcast({ type: 'meta_status', data: status });
        }
      } catch (e) {}
    },
  }));

  /* Embedded Signup callback — frontend manda code OR access_token + store_id */
  router.post('/meta/embedded-signup', express.json({ limit: '512kb' }), async (req, res) => {
    try {
      const { code, access_token, store_id } = req.body;
      if (!store_id) return res.status(400).json({ error: 'store_id requerido' });

      let token = access_token;

      if (code && APP_SECRET) {
        // Exchange code → token
        const result = await cloudApi.exchangeCodeForToken(code, APP_ID, APP_SECRET, REDIRECT_URI);
        token = result.access_token;
        // Extend to ~60 days
        try {
          const extended = await cloudApi.extendToken(token, APP_ID, APP_SECRET);
          token = extended.access_token;
        } catch (e) {
          console.warn('[Meta] extend token failed:', e.message);
        }
      }

      if (!token) return res.status(400).json({ error: 'code o access_token requerido' });

      // Fetch WABA info
      const wabaInfo = await cloudApi.getWABAInfo(token);
      if (!wabaInfo.data || !wabaInfo.data.length) {
        return res.status(400).json({ error: 'No business portfolio encontrado' });
      }

      const business = wabaInfo.data[0];
      const wabaList = business.whatsapp_business_accounts?.data || [];
      if (!wabaList.length) return res.status(400).json({ error: 'No WhatsApp Business Account vinculado' });

      const waba = wabaList[0];
      const phoneList = waba.phone_numbers?.data || [];
      if (!phoneList.length) return res.status(400).json({ error: 'No número en WABA' });

      const phone = phoneList[0];

      // Subscribe webhook
      try {
        await cloudApi.subscribeWebhook(waba.id, token);
      } catch (e) {
        console.warn('[Meta] subscribe webhook:', e.message);
      }

      // Save to DB
      const { error: upErr } = await supabase
        .from('oasis_waba_connections')
        .upsert({
          store_id,
          display_name: waba.name || phone.verified_name,
          phone_number: phone.display_phone_number,
          phone_number_id: phone.id,
          waba_id: waba.id,
          access_token: token,
          quality_rating: phone.quality_rating || 'UNKNOWN',
          status: 'connected',
          meta_verified: phone.name_status === 'APPROVED',
          updated_at: new Date().toISOString(),
        }, { onConflict: 'store_id' });

      if (upErr) throw new Error('DB save failed: ' + upErr.message);

      res.json({
        ok: true,
        connection: {
          display_name: waba.name,
          phone_number: phone.display_phone_number,
          phone_number_id: phone.id,
          waba_id: waba.id,
          quality_rating: phone.quality_rating,
        },
      });
    } catch (err) {
      console.error('[Meta Signup]', err);
      res.status(500).json({ error: err.message, details: err.details });
    }
  });

  /* Send message via Cloud API */
  router.post('/meta/send', express.json({ limit: '5mb' }), async (req, res) => {
    try {
      const { store_id, to, message, template, lang_code, components, image, buttons, list, type } = req.body;
      if (!store_id || !to) return res.status(400).json({ error: 'store_id + to requeridos' });

      const { data: conn } = await supabase
        .from('oasis_waba_connections')
        .select('phone_number_id, access_token, status')
        .eq('store_id', store_id)
        .maybeSingle();

      if (!conn || conn.status !== 'connected') {
        return res.status(400).json({ error: 'Meta no conectado para este store' });
      }

      let result;
      if (template) {
        result = await cloudApi.sendTemplate(conn.phone_number_id, to, template, lang_code, components, conn.access_token);
      } else if (image) {
        result = await cloudApi.sendImage(conn.phone_number_id, to, image.url, image.caption, conn.access_token);
      } else if (buttons && Array.isArray(buttons)) {
        result = await cloudApi.sendInteractiveButtons(conn.phone_number_id, to, message, buttons, conn.access_token);
      } else if (list) {
        result = await cloudApi.sendInteractiveList(conn.phone_number_id, to, message, list.buttonText, list.sections, conn.access_token);
      } else {
        result = await cloudApi.sendText(conn.phone_number_id, to, message, conn.access_token);
      }

      // Save outgoing to DB
      const messageId = result.messages?.[0]?.id;
      if (messageId) {
        await supabase.from('oasis_wa_messages').insert({
          store_id,
          jid: to,
          direction: 'out',
          body: message || `[${type || 'media'}]`,
          source: 'meta',
          ts: new Date().toISOString(),
          meta_message_id: messageId,
          status: 'sent',
        }).then(() => {}).catch(() => {});
      }

      res.json({ ok: true, result });
    } catch (err) {
      console.error('[Meta Send]', err);
      res.status(500).json({ error: err.message, details: err.details });
    }
  });

  /* Status for a store */
  router.get('/meta/status', async (req, res) => {
    try {
      const store_id = req.query.store_id;
      if (!store_id) return res.status(400).json({ error: 'store_id requerido' });

      const { data: conn } = await supabase
        .from('oasis_waba_connections')
        .select('display_name, phone_number, phone_number_id, waba_id, quality_rating, status, meta_verified, updated_at')
        .eq('store_id', store_id)
        .maybeSingle();

      if (!conn) return res.json({ connected: false });

      // Refresh phone info from Meta
      if (conn.status === 'connected') {
        try {
          const { data: connWithToken } = await supabase
            .from('oasis_waba_connections')
            .select('access_token')
            .eq('store_id', store_id)
            .maybeSingle();
          if (connWithToken?.access_token) {
            const liveInfo = await cloudApi.getPhoneInfo(conn.phone_number_id, connWithToken.access_token);
            conn.quality_rating = liveInfo.quality_rating;
            conn.messaging_limit = liveInfo.messaging_limit;
          }
        } catch (e) {
          // Token might be expired
          if (e.code === 190) {
            await supabase.from('oasis_waba_connections').update({ status: 'token_expired' }).eq('store_id', store_id);
            conn.status = 'token_expired';
          }
        }
      }

      res.json({ connected: conn.status === 'connected', ...conn });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /* List approved templates */
  router.get('/meta/templates', async (req, res) => {
    try {
      const store_id = req.query.store_id;
      const { data: conn } = await supabase
        .from('oasis_waba_connections')
        .select('waba_id, access_token, status')
        .eq('store_id', store_id)
        .maybeSingle();
      if (!conn || conn.status !== 'connected') return res.status(400).json({ error: 'Not connected' });
      const templates = await cloudApi.listTemplates(conn.waba_id, conn.access_token);
      res.json(templates);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /* Create template for review */
  router.post('/meta/templates', express.json(), async (req, res) => {
    try {
      const { store_id, name, language, category, components } = req.body;
      const { data: conn } = await supabase
        .from('oasis_waba_connections')
        .select('waba_id, access_token, status')
        .eq('store_id', store_id)
        .maybeSingle();
      if (!conn || conn.status !== 'connected') return res.status(400).json({ error: 'Not connected' });
      const result = await cloudApi.createTemplate(conn.waba_id, name, language, category, components, conn.access_token);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /* Conversations / costs */
  router.get('/meta/conversations', async (req, res) => {
    try {
      const store_id = req.query.store_id;
      const days = parseInt(req.query.days || '30', 10);
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

      const { data: conn } = await supabase
        .from('oasis_waba_connections')
        .select('phone_number_id')
        .eq('store_id', store_id)
        .maybeSingle();
      if (!conn) return res.status(400).json({ error: 'Not connected' });

      const { data: convs } = await supabase
        .from('oasis_meta_conversations')
        .select('category, billable, created_at')
        .eq('phone_number_id', conn.phone_number_id)
        .gte('created_at', since);

      // Aggregate
      const summary = {};
      for (const c of (convs || [])) {
        const cat = c.category || 'unknown';
        if (!summary[cat]) summary[cat] = { count: 0, billable: 0 };
        summary[cat].count++;
        if (c.billable) summary[cat].billable++;
      }

      res.json({ days, total: convs?.length || 0, by_category: summary });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /* v5.144: Get WhatsApp Business Profile from Meta */
  router.get('/meta/profile', async (req, res) => {
    try {
      const store_id = req.query.store_id;
      if (!store_id) return res.status(400).json({ error: 'store_id requerido' });
      const { data: conn } = await supabase
        .from('oasis_waba_connections')
        .select('phone_number_id, access_token, status')
        .eq('store_id', store_id)
        .maybeSingle();
      if (!conn || conn.status !== 'connected') return res.status(400).json({ error: 'No conectado a Meta' });
      const url = `https://graph.facebook.com/v22.0/${conn.phone_number_id}/whatsapp_business_profile?fields=about,address,description,email,profile_picture_url,websites,vertical`;
      const r = await fetch(url, { headers: { 'Authorization': `Bearer ${conn.access_token}` } });
      const j = await r.json();
      if (!r.ok || j.error) return res.status(500).json({ error: j.error?.message || 'Error Meta', details: j.error });
      const profile = (j.data && j.data[0]) || {};
      res.json({ ok: true, profile });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /* v5.144: Update WhatsApp Business Profile via Meta Graph API */
  router.post('/meta/profile/update', express.json({ limit: '5mb' }), async (req, res) => {
    try {
      const { store_id, about, description, address, email, vertical, websites } = req.body;
      if (!store_id) return res.status(400).json({ error: 'store_id requerido' });
      const { data: conn } = await supabase
        .from('oasis_waba_connections')
        .select('phone_number_id, access_token, status')
        .eq('store_id', store_id)
        .maybeSingle();
      if (!conn || conn.status !== 'connected') return res.status(400).json({ error: 'No conectado a Meta' });
      const payload = { messaging_product: 'whatsapp' };
      if (about !== undefined) payload.about = String(about).slice(0, 139);
      if (description !== undefined) payload.description = String(description).slice(0, 512);
      if (address !== undefined) payload.address = String(address).slice(0, 256);
      if (email !== undefined) payload.email = String(email).slice(0, 128);
      if (vertical !== undefined) payload.vertical = vertical;
      if (websites !== undefined && Array.isArray(websites)) payload.websites = websites.slice(0, 2);
      const url = `https://graph.facebook.com/v22.0/${conn.phone_number_id}/whatsapp_business_profile`;
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${conn.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!r.ok || j.error) return res.status(500).json({ error: j.error?.message || 'Error actualizando perfil', details: j.error });
      res.json({ ok: true, updated: j });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /* v5.144: List all phone numbers for the WABA (multi-número support) */
  router.get('/meta/numbers', async (req, res) => {
    try {
      const store_id = req.query.store_id;
      if (!store_id) return res.status(400).json({ error: 'store_id requerido' });
      const { data: conn } = await supabase
        .from('oasis_waba_connections')
        .select('waba_id, access_token, status, phone_number_id, phone_number, display_name')
        .eq('store_id', store_id)
        .maybeSingle();
      if (!conn || conn.status !== 'connected') return res.json({ numbers: [] });
      const url = `https://graph.facebook.com/v22.0/${conn.waba_id}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,messaging_limit,name_status,certificate`;
      const r = await fetch(url, { headers: { 'Authorization': `Bearer ${conn.access_token}` } });
      const j = await r.json();
      if (!r.ok || j.error) return res.json({ numbers: [{ id: conn.phone_number_id, display_phone_number: conn.phone_number, verified_name: conn.display_name }] });
      res.json({ numbers: j.data || [], primary_id: conn.phone_number_id });
    } catch (err) {
      res.json({ numbers: [], error: err.message });
    }
  });

  /* Disconnect — mantiene chats, solo invalida el token */
  router.post('/meta/disconnect', express.json(), async (req, res) => {
    try {
      const { store_id } = req.body;
      await supabase
        .from('oasis_waba_connections')
        .update({ status: 'disconnected', access_token: null, updated_at: new Date().toISOString() })
        .eq('store_id', store_id);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = makeRoutes;
