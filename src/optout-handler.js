/* optout-handler.js — detect 'no me escriban' + humanized auto-response + archive + opt-out
 * Use: require('./optout-handler') then:
 *   const { checkAndHandleOptout } = require('./optout-handler');
 *   if (await checkAndHandleOptout(sock, supabase, jid, msgText)) return;
 */

const OPTOUT_KEYWORDS = /\bno\s+(gracias|quiero|me\s+escrib|mas\s+mensa|me\s+molest|estoy\s+interesad)|^\s*(para(r|d|me)?|stop|cancel|no\s*$|dejar?\s+de\s+enviar?|borra(r|me)?|elimina(r|me)?|quita(r|me)?\s+de\s+la\s+lista)\s*$/i;

const HUMANIZED_RESPONSES = [
  'Entendido. No te escribo mas. Si en algun momento necesitas algo, escribeme y con gusto te atiendo.',
  'Claro, te respeto. Que tengas un excelente dia.',
  'Perfecto, lo anoto. Cuidate mucho.',
  'Sin problema, te dejo en paz. Gracias por avisar.',
  'Recibido. Te quito de la lista. Si cambias de opinion, aqui estamos.'
];

function pickResponse() {
  return HUMANIZED_RESPONSES[Math.floor(Math.random() * HUMANIZED_RESPONSES.length)];
}

async function checkAndHandleOptout(sock, supabase, jid, msgText) {
  if (!msgText || !OPTOUT_KEYWORDS.test(msgText)) return false;

  const { data: chat } = await supabase
    .from('oasis_wa_chats')
    .select('memoria, archived')
    .eq('jid', jid)
    .single();

  const memoria = (chat && chat.memoria) || {};
  if (memoria.opt_out === true) return true;

  const delay = 1500 + Math.floor(Math.random() * 1500);
  await new Promise(r => setTimeout(r, delay));

  try {
    await sock.sendPresenceUpdate('composing', jid);
    await new Promise(r => setTimeout(r, 1200));
    await sock.sendMessage(jid, { text: pickResponse() });
    await sock.sendPresenceUpdate('paused', jid);
  } catch (e) {
    console.warn('[optout] send failed:', e.message);
  }

  await supabase
    .from('oasis_wa_chats')
    .update({
      archived: true,
      paused: true,
      memoria: Object.assign({}, memoria, { opt_out: true, opt_out_at: new Date().toISOString() })
    })
    .eq('jid', jid);

  await supabase
    .from('oasis_wa_msg_queue')
    .delete()
    .eq('chat_jid', jid);

  await supabase
    .from('oasis_activity_log')
    .insert({
      event_type: 'optout_auto_response',
      payload: { chat_jid: jid, response_used: 'auto' },
      created_at: new Date().toISOString()
    });

  console.log('[optout] processed for ' + jid);
  return true;
}

module.exports = { checkAndHandleOptout, OPTOUT_KEYWORDS };

