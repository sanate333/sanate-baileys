/**
 * src/meta/webhook.js
 *
 * Receptor de webhooks WhatsApp Cloud API.
 * Valida signature X-Hub-Signature-256 con HMAC-SHA256 + App Secret.
 *
 * Webhooks Meta envía:
 * - messages.received: mensajes nuevos del cliente
 * - messages.status: delivery, read, failed
 * - account_review_update: cambios en review state
 * - phone_number_quality_update: cambios en quality rating
 */

const crypto = require('crypto');

/**
 * Verifica signature HMAC-SHA256 del webhook.
 * Protege contra requests forjados que no vienen de Meta.
 */
function verifySignature(rawBody, signatureHeader, appSecret) {
  if (!signatureHeader || !appSecret) return false;
  const expectedSig = signatureHeader.replace(/^sha256=/, '');
  const computedSig = crypto
    .createHmac('sha256', appSecret)
    .update(rawBody, 'utf8')
    .digest('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(computedSig, 'hex'),
      Buffer.from(expectedSig, 'hex')
    );
  } catch (e) {
    return false;
  }
}

/**
 * Handler GET — verificación inicial de webhook por Meta.
 * Meta envía hub.mode=subscribe + hub.verify_token + hub.challenge.
 * Respondemos con challenge si verify_token coincide.
 */
function handleVerify(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const expectedToken = process.env.META_WEBHOOK_VERIFY_TOKEN;
  if (mode === 'subscribe' && token === expectedToken && expectedToken) {
    console.log('[Meta Webhook] ✅ Verified by Meta');
    return res.status(200).send(challenge);
  }
  console.warn('[Meta Webhook] ❌ Verification failed', { mode, tokenMatch: token === expectedToken });
  return res.status(403).end();
}

/**
 * Handler POST — recibe eventos de Meta (mensajes, status, etc).
 * Valida signature antes de procesar.
 */
function makeHandler({ supabase, onMessage, onStatus, appSecret }) {
  return async function handleEvent(req, res) {
    try {
      // Validar signature (req.rawBody debe estar disponible via middleware express.raw)
      const sig = req.headers['x-hub-signature-256'];
      const raw = req.rawBody || JSON.stringify(req.body);
      if (appSecret && !verifySignature(raw, sig, appSecret)) {
        console.warn('[Meta Webhook] ❌ Invalid signature');
        return res.status(401).end();
      }

      const body = req.body;
      // Meta siempre envía: { object: 'whatsapp_business_account', entry: [...] }
      if (body.object !== 'whatsapp_business_account') {
        return res.sendStatus(200);
      }

      for (const entry of (body.entry || [])) {
        const wabaId = entry.id;
        for (const change of (entry.changes || [])) {
          const value = change.value || {};
          const phoneNumberId = value.metadata?.phone_number_id;
          const displayPhone = value.metadata?.display_phone_number;

          // Mensajes entrantes
          for (const msg of (value.messages || [])) {
            await handleIncomingMessage({
              supabase,
              wabaId,
              phoneNumberId,
              displayPhone,
              msg,
              contacts: value.contacts,
              onMessage,
            });
          }

          // Statuses (delivery, read, failed)
          for (const status of (value.statuses || [])) {
            await handleMessageStatus({
              supabase,
              wabaId,
              phoneNumberId,
              status,
              onStatus,
            });
          }
        }
      }
      res.sendStatus(200);
    } catch (err) {
      console.error('[Meta Webhook] handler error:', err);
      res.sendStatus(500); // Meta reintentará
    }
  };
}

async function handleIncomingMessage({ supabase, wabaId, phoneNumberId, displayPhone, msg, contacts, onMessage }) {
  const from = msg.from;
  const contactName = contacts?.[0]?.profile?.name || from;
  let body = '';
  let mediaUrl = null;
  let mediaType = null;
  let buttonReply = null;

  switch (msg.type) {
    case 'text':
      body = msg.text?.body || '';
      break;
    case 'image':
      body = msg.image?.caption || '[Imagen]';
      mediaUrl = msg.image?.id; // need to fetch via Graph API
      mediaType = msg.image?.mime_type;
      break;
    case 'video':
      body = msg.video?.caption || '[Video]';
      mediaUrl = msg.video?.id;
      mediaType = msg.video?.mime_type;
      break;
    case 'audio':
      body = '[Audio]';
      mediaUrl = msg.audio?.id;
      mediaType = msg.audio?.mime_type;
      break;
    case 'document':
      body = msg.document?.caption || msg.document?.filename || '[Documento]';
      mediaUrl = msg.document?.id;
      mediaType = msg.document?.mime_type;
      break;
    case 'sticker':
      body = '[Sticker]';
      break;
    case 'location':
      body = `[Ubicación: ${msg.location?.latitude},${msg.location?.longitude}]`;
      break;
    case 'interactive':
      if (msg.interactive?.button_reply) {
        buttonReply = msg.interactive.button_reply.id;
        body = msg.interactive.button_reply.title;
      } else if (msg.interactive?.list_reply) {
        buttonReply = msg.interactive.list_reply.id;
        body = msg.interactive.list_reply.title;
      }
      break;
    default:
      body = `[${msg.type || 'desconocido'}]`;
  }

  // Resolve store_id from phone_number_id
  let storeId = null;
  if (supabase && phoneNumberId) {
    const { data } = await supabase
      .from('oasis_waba_connections')
      .select('store_id')
      .eq('phone_number_id', phoneNumberId)
      .maybeSingle();
    storeId = data?.store_id || null;
  }

  // Save to DB (oasis_wa_messages table)
  if (supabase) {
    await supabase.from('oasis_wa_messages').insert({
      store_id: storeId,
      jid: from,
      contact_name: contactName,
      direction: 'in',
      body,
      source: 'meta',
      ts: new Date(parseInt(msg.timestamp, 10) * 1000).toISOString(),
      meta_message_id: msg.id,
      media_url: mediaUrl,
      media_type: mediaType,
      button_reply: buttonReply,
    }).then(() => {}).catch(e => console.warn('[Meta Webhook] save msg:', e.message));

    // Upsert chat
    await supabase.from('oasis_wa_chats').upsert({
      store_id: storeId,
      jid: from,
      contact_name: contactName,
      last_msg: body,
      last_ts: new Date(parseInt(msg.timestamp, 10) * 1000).toISOString(),
      source: 'meta',
    }, { onConflict: 'store_id,jid' }).then(() => {}).catch(e => console.warn('[Meta Webhook] upsert chat:', e.message));
  }

  // Callback para auto-reply / IA
  if (typeof onMessage === 'function') {
    try {
      await onMessage({ storeId, from, contactName, body, type: msg.type, buttonReply, raw: msg, phoneNumberId });
    } catch (e) {
      console.error('[Meta Webhook] onMessage callback:', e.message);
    }
  }
}

async function handleMessageStatus({ supabase, wabaId, phoneNumberId, status, onStatus }) {
  if (!supabase) return;
  const map = { sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed' };
  const statusName = map[status.status] || status.status;
  await supabase
    .from('oasis_wa_messages')
    .update({ status: statusName, status_ts: new Date(parseInt(status.timestamp, 10) * 1000).toISOString() })
    .eq('meta_message_id', status.id)
    .then(() => {}).catch(e => console.warn('[Meta Webhook] status update:', e.message));

  if (status.conversation) {
    // Track conversation costs
    await supabase.from('oasis_meta_conversations').insert({
      conversation_id: status.conversation.id,
      phone_number_id: phoneNumberId,
      origin_type: status.conversation.origin?.type,
      category: status.pricing?.category,
      pricing_model: status.pricing?.pricing_model,
      billable: status.pricing?.billable,
      expiration_ts: status.conversation.expiration_timestamp ? new Date(parseInt(status.conversation.expiration_timestamp, 10) * 1000).toISOString() : null,
    }).then(() => {}).catch(e => {/* ignore duplicates */});
  }

  if (typeof onStatus === 'function') {
    try {
      await onStatus({ wabaId, phoneNumberId, status });
    } catch (e) {
      console.error('[Meta Webhook] onStatus callback:', e.message);
    }
  }
}

module.exports = {
  verifySignature,
  handleVerify,
  makeHandler,
};
