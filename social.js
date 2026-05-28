// social.js — Instagram & Facebook Messenger integration (multi-store)
// Cada tienda se identifica por storeId (pasado como query param)

const META_APP_ID      = process.env.META_APP_ID      || '';
const META_APP_SECRET  = process.env.META_APP_SECRET  || '';
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || 'sanate_verify_2025';
const BACKEND_URL      = process.env.BACKEND_URL || 'https://sanate-baileys.onrender.com';

// ── In-memory multi-store state ──────────────────────────────────────
// storeTokens: Map<storeId, { messenger?: {...}, instagram?: {...} }>
const storeTokens = new Map();
// socialChats: Map<storeId, Map<chatId, chatObject>>
const socialChats = new Map();
// pageToStore: Map<pageId|igId, storeId>  (para routing de webhooks)
const pageToStore = new Map();

function getStoreChats(sid) {
  if (!socialChats.has(sid)) socialChats.set(sid, new Map());
  return socialChats.get(sid);
}
function upsertChat(sid, chatId, upd) {
  const m = getStoreChats(sid);
  const prev = m.get(chatId) || { id: chatId, messages: [] };
  m.set(chatId, Object.assign(prev, upd));
  return m.get(chatId);
}
function addMessage(sid, chatId, msg) {
  const chat = upsertChat(sid, chatId, {});
  chat.messages.push(msg);
  if (chat.messages.length > 200) chat.messages = chat.messages.slice(-200);
}

// ── Register all social routes ─────────────────────────────────────
function registerSocialRoutes(app, auth) {

  // ════════════════ MESSENGER ════════════════

  // Redirige al usuario a Facebook OAuth
  app.get('/api/social/messenger/auth', (req, res) => {
    const storeId = req.query.storeId || 'default';
    if (!META_APP_ID) return res.status(500).send('META_APP_ID no configurado en Render env vars');
    const redirect = encodeURIComponent(BACKEND_URL + '/api/social/messenger/callback');
    const scope    = 'pages_messaging,pages_show_list,pages_read_engagement';
    const state    = encodeURIComponent(JSON.stringify({ storeId }));
    res.redirect(
      `https://www.facebook.com/dialog/oauth?client_id=${META_APP_ID}&redirect_uri=${redirect}&scope=${scope}&state=${state}&response_type=code`
    );
  });

  // Meta redirige aqui con ?code=xxx
  app.get('/api/social/messenger/callback', async (req, res) => {
    const close = (type, data) =>
      res.send(`<script>try{window.opener.postMessage(${JSON.stringify({ type, ...data })},'*')}catch(e){}window.close();</script>`);
    try {
      const { code, state, error } = req.query;
      if (error) return close('social_error', { platform: 'messenger', error });
      const { storeId = 'default' } = JSON.parse(decodeURIComponent(state || '{}'));
      const redirect = encodeURIComponent(BACKEND_URL + '/api/social/messenger/callback');

      // Intercambiar code por user token
      const tr = await fetch(
        `https://graph.facebook.com/v19.0/oauth/access_token?client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&redirect_uri=${redirect}&code=${code}`
      );
      const td = await tr.json();
      if (td.error) throw new Error(td.error.message);

      // Obtener páginas del usuario
      const pr = await fetch(`https://graph.facebook.com/v19.0/me/accounts?access_token=${td.access_token}`);
      const pd = await pr.json();
      if (!pd.data?.length) throw new Error('No se encontraron Páginas de Facebook');

      const page = pd.data[0]; // primera página (se puede expandir a selector)
      if (!storeTokens.has(storeId)) storeTokens.set(storeId, {});
      storeTokens.get(storeId).messenger = {
        pageId: page.id, pageToken: page.access_token, pageName: page.name
      };
      pageToStore.set(page.id, storeId);

      // Suscribir la página al webhook de mensajes
      await fetch(`https://graph.facebook.com/v19.0/${page.id}/subscribed_apps?access_token=${page.access_token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscribed_fields: 'messages,messaging_postbacks' })
      });

      close('social_connected', { platform: 'messenger', pageName: page.name, pageId: page.id });
    } catch (e) {
      close('social_error', { platform: 'messenger', error: e.message });
    }
  });

  // Meta verifica el webhook con GET
  app.get('/api/social/messenger/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === META_VERIFY_TOKEN)
      return res.status(200).send(req.query['hub.challenge']);
    res.status(403).send('Forbidden');
  });

  // Meta envía mensajes con POST
  app.post('/api/social/messenger/webhook', (req, res) => {
    res.status(200).send('EVENT_RECEIVED');
    try {
      if (req.body.object !== 'page') return;
      for (const entry of (req.body.entry || [])) {
        const sid = pageToStore.get(entry.id) || 'default';
        for (const ev of (entry.messaging || [])) {
          if (!ev.message) continue;
          const chatId = `ms_${entry.id}_${ev.sender.id}`;
          addMessage(sid, chatId, {
            id: ev.message.mid || String(Date.now()),
            from: ev.sender.id, text: ev.message.text || '[adjunto]',
            ts: ev.timestamp || Date.now(), dir: 'in'
          });
          upsertChat(sid, chatId, {
            source: 'messenger', name: `Messenger ${ev.sender.id.slice(-4)}`,
            lastMsg: ev.message.text || '[adjunto]', lastTs: ev.timestamp || Date.now(), pageId: entry.id
          });
        }
      }
    } catch (e) { console.error('[social-ms-wh]', e.message); }
  });

  // Enviar mensaje Messenger
  app.post('/api/social/messenger/send', auth, async (req, res) => {
    try {
      const { storeId = 'default', chatId, text } = req.body;
      const s = storeTokens.get(storeId);
      if (!s?.messenger) return res.status(400).json({ error: 'Messenger no conectado' });
      const { pageId, pageToken } = s.messenger;
      const senderId = chatId.split('_')[2];
      const r = await fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${pageToken}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: { id: senderId }, message: { text } })
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error.message);
      addMessage(storeId, chatId, { id: d.message_id || String(Date.now()), from: pageId, text, ts: Date.now(), dir: 'out' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ════════════════ INSTAGRAM ════════════════

  app.get('/api/social/instagram/auth', (req, res) => {
    const storeId = req.query.storeId || 'default';
    if (!META_APP_ID) return res.status(500).send('META_APP_ID no configurado');
    const redirect = encodeURIComponent(BACKEND_URL + '/api/social/instagram/callback');
    const scope    = 'instagram_basic,instagram_manage_messages,pages_show_list,pages_read_engagement';
    const state    = encodeURIComponent(JSON.stringify({ storeId }));
    res.redirect(
      `https://www.facebook.com/dialog/oauth?client_id=${META_APP_ID}&redirect_uri=${redirect}&scope=${scope}&state=${state}&response_type=code`
    );
  });

  app.get('/api/social/instagram/callback', async (req, res) => {
    const close = (type, data) =>
      res.send(`<script>try{window.opener.postMessage(${JSON.stringify({ type, ...data })},'*')}catch(e){}window.close();</script>`);
    try {
      const { code, state, error } = req.query;
      if (error) return close('social_error', { platform: 'instagram', error });
      const { storeId = 'default' } = JSON.parse(decodeURIComponent(state || '{}'));
      const redirect = encodeURIComponent(BACKEND_URL + '/api/social/instagram/callback');

      const tr = await fetch(
        `https://graph.facebook.com/v19.0/oauth/access_token?client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&redirect_uri=${redirect}&code=${code}`
      );
      const td = await tr.json();
      if (td.error) throw new Error(td.error.message);

      const pr = await fetch(`https://graph.facebook.com/v19.0/me/accounts?access_token=${td.access_token}`);
      const pd = await pr.json();
      const page = pd.data?.[0];
      if (!page) throw new Error('No se encontró Página de Facebook');

      const ir = await fetch(`https://graph.facebook.com/v19.0/${page.id}?fields=instagram_business_account&access_token=${page.access_token}`);
      const id2 = await ir.json();
      const igId = id2.instagram_business_account?.id;
      if (!igId) throw new Error('No hay cuenta Instagram Business vinculada a esta Página');

      const iu = await fetch(`https://graph.facebook.com/v19.0/${igId}?fields=username,name&access_token=${page.access_token}`);
      const iud = await iu.json();

      if (!storeTokens.has(storeId)) storeTokens.set(storeId, {});
      storeTokens.get(storeId).instagram = {
        igId, pageToken: page.access_token, username: iud.username || igId
      };
      pageToStore.set(igId, storeId);

      close('social_connected', { platform: 'instagram', username: iud.username || igId, igId });
    } catch (e) {
      close('social_error', { platform: 'instagram', error: e.message });
    }
  });

  app.get('/api/social/instagram/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === META_VERIFY_TOKEN)
      return res.status(200).send(req.query['hub.challenge']);
    res.status(403).send('Forbidden');
  });

  app.post('/api/social/instagram/webhook', (req, res) => {
    res.status(200).send('EVENT_RECEIVED');
    try {
      if (req.body.object !== 'instagram') return;
      for (const entry of (req.body.entry || [])) {
        const sid = pageToStore.get(entry.id) || 'default';
        for (const ev of (entry.messaging || [])) {
          if (!ev.message) continue;
          const chatId = `ig_${entry.id}_${ev.sender.id}`;
          addMessage(sid, chatId, {
            id: ev.message.mid || String(Date.now()),
            from: ev.sender.id, text: ev.message.text || '[adjunto]',
            ts: ev.timestamp || Date.now(), dir: 'in'
          });
          upsertChat(sid, chatId, {
            source: 'instagram', name: `Instagram DM ${ev.sender.id.slice(-4)}`,
            lastMsg: ev.message.text || '[adjunto]', lastTs: ev.timestamp || Date.now(), igId: entry.id
          });
        }
      }
    } catch (e) { console.error('[social-ig-wh]', e.message); }
  });

  app.post('/api/social/instagram/send', auth, async (req, res) => {
    try {
      const { storeId = 'default', chatId, text } = req.body;
      const s = storeTokens.get(storeId);
      if (!s?.instagram) return res.status(400).json({ error: 'Instagram no conectado' });
      const { igId, pageToken } = s.instagram;
      const senderId = chatId.split('_')[2];
      const r = await fetch(`https://graph.facebook.com/v19.0/${igId}/messages?access_token=${pageToken}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: { id: senderId }, message: { text } })
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error.message);
      addMessage(storeId, chatId, { id: d.message_id || String(Date.now()), from: igId, text, ts: Date.now(), dir: 'out' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ════════════════ SHARED ENDPOINTS ════════════════

  // GET /api/social/chats?storeId=xxx&platform=messenger|instagram|all
  app.get('/api/social/chats', auth, (req, res) => {
    const { storeId = 'default', platform = 'all' } = req.query;
    const chats = getStoreChats(storeId);
    const list = [];
    for (const [, c] of chats) {
      if (platform === 'all' || c.source === platform)
        list.push({ id: c.id, source: c.source, name: c.name, lastMsg: c.lastMsg, lastTs: c.lastTs });
    }
    list.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
    res.json(list);
  });

  // GET /api/social/messages?storeId=xxx&chatId=xxx
  app.get('/api/social/messages', auth, (req, res) => {
    const { storeId = 'default', chatId } = req.query;
    const chat = getStoreChats(storeId).get(chatId);
    res.json(chat ? chat.messages : []);
  });

  // GET /api/social/status?storeId=xxx
  app.get('/api/social/status', auth, (req, res) => {
    const { storeId = 'default' } = req.query;
    const s = storeTokens.get(storeId) || {};
    res.json({
      messenger: s.messenger
        ? { connected: true, pageName: s.messenger.pageName, pageId: s.messenger.pageId }
        : { connected: false },
      instagram: s.instagram
        ? { connected: true, username: s.instagram.username, igId: s.instagram.igId }
        : { connected: false }
    });
  });

  // DELETE /api/social/disconnect?storeId=xxx&platform=messenger|instagram
  app.delete('/api/social/disconnect', auth, (req, res) => {
    const { storeId = 'default', platform } = req.query;
    const s = storeTokens.get(storeId);
    if (s) {
      if (platform === 'messenger' && s.messenger) { pageToStore.delete(s.messenger.pageId); delete s.messenger; }
      if (platform === 'instagram' && s.instagram) { pageToStore.delete(s.instagram.igId); delete s.instagram; }
    }
    res.json({ ok: true });
  });

  console.log('[social] ✅ Rutas registradas: Messenger + Instagram (multi-store)');
}

module.exports = { registerSocialRoutes };
