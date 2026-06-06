/* wire-anti-ban.js - Conecta los 4 modulos anti-ban a Baileys con UNA SOLA LINEA
 *
 * Uso en src/baileys.js (despues de crear el sock):
 *   const wireAntiBan = require('./wire-anti-ban');
 *   wireAntiBan(sock, supabaseClient, process.env.STORE_ID || '00000000-0000-0000-0000-000000000001');
 *
 * Esa unica linea activa:
 *   - optout-handler (auto-respuesta + archive en mensajes 'no me escriban')
 *   - anti-ban-v2.trackEngagement (cuenta reply ratio incluyendo button taps)
 *   - account-age-check (post-connection.open, espera 30s + analiza)
 *
 * Para que sendBroadcast use variantes + canSend + humanDelay + trackSent,
 * llamar wireSender(sendMessageFn, supabase, storeId) y usar el wrapper retornado.
 */

const optout = require('./optout-handler');
const ageCheck = require('./account-age-check');
const antiban = require('./anti-ban-v2');
const variant = require('./variant-rotator');

function wireAntiBan(sock, supabase, storeId) {
  if (!sock || !sock.ev) {
    console.warn('[wire-anti-ban] sock or sock.ev missing');
    return;
  }
  console.log('[wire-anti-ban] wiring 4 modules for store=' + storeId);

  sock.ev.on('connection.update', function(update) {
    try {
      if (update.connection === 'open') {
        setTimeout(function() {
          ageCheck.runAccountAgeCheck(sock, supabase, storeId)
            .then(function(r) {
              if (r && r.verdict !== 'OK') {
                console.warn('[wire-anti-ban] account check:', r.verdict, 'flags=', r.flags);
              }
            })
            .catch(function(err) { console.warn('[wire-anti-ban] ageCheck error:', err.message); });
        }, 30000);
      }
    } catch (e) {
      console.warn('[wire-anti-ban] connection hook error:', e.message);
    }
  });

  sock.ev.on('messages.upsert', async function(payload) {
    var messages = payload.messages || [];
    for (var i = 0; i < messages.length; i++) {
      var msg = messages[i];
      try {
        if (msg.key.fromMe) continue;
        if (!msg.message) continue;
        var text = msg.message.conversation
                || (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text)
                || '';
        antiban.trackEngagement(supabase, msg, storeId).catch(function(){});
        await optout.checkAndHandleOptout(sock, supabase, msg.key.remoteJid, text);
      } catch (e) {
        console.warn('[wire-anti-ban] msg hook error:', e.message);
      }
    }
  });

  console.log('[wire-anti-ban] OK - 4 modules active');
}

function wireSender(sendMessageFn, supabase, storeId) {
  if (typeof sendMessageFn !== 'function') {
    console.warn('[wire-anti-ban] wireSender requires a function');
    return sendMessageFn;
  }
  return async function wrappedSend(jid, content, options) {
    try {
      var ok = await antiban.canSend(supabase, storeId);
      if (!ok) {
        console.warn('[wire-anti-ban] canSend=false, blocking message to', jid);
        return { key: { id: 'blocked-antiban' } };
      }
    } catch (e) {
      console.warn('[wire-anti-ban] canSend error:', e.message);
    }
    try { await antiban.humanDelay(); } catch (e) {}
    var result = await sendMessageFn(jid, content, options);
    try { antiban.trackSent(supabase, storeId, jid).catch(function(){}); } catch (e) {}
    return result;
  };
}

async function sendTemplateWithVariant(sendMessageFn, supabase, jid, templateId) {
  try {
    var tpl = await variant.getTemplateById(supabase, templateId);
    if (!tpl) throw new Error('template not found: ' + templateId);
    var payload = variant.pickTemplateVariant(tpl);
    var result = await sendMessageFn(jid, { text: payload.content });
    if (Array.isArray(payload.media_urls_versioned)) {
      for (var i = 0; i < payload.media_urls_versioned.length; i++) {
        var url = payload.media_urls_versioned[i];
        await antiban.humanDelay();
        await sendMessageFn(jid, { image: { url: url } });
      }
    }
    return result;
  } catch (e) {
    console.warn('[wire-anti-ban] sendTemplateWithVariant error:', e.message);
    throw e;
  }
}

module.exports = wireAntiBan;
module.exports.wireSender = wireSender;
module.exports.sendTemplateWithVariant = sendTemplateWithVariant;

