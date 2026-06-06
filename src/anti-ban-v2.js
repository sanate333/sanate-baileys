/* anti-ban-v2.js - Reply ratio (including button taps) + Gaussian jitter + warmup + retry guard
 * Research base junio 2026:
 *   - Reply ratio <10% = high risk Meta (5% if all templates have buttons)
 *   - Button taps DO count as engagement
 *   - URL clicks do NOT count (outside WA)
 *   - Quality rating Green > Yellow > Red
 *   - Retry spirals (same msg repeated) high risk
 *   - Gaussian jitter humanizes timing
 *
 * Usage in src/baileys.js:
 *   const antiban = require('./anti-ban-v2');
 *   await antiban.trackEngagement(supabase, msg, STORE_ID);
 *   if (!await antiban.canSend(supabase, STORE_ID)) continue;
 *   await antiban.humanDelay();
 *   await sock.sendMessage(jid, payload);
 *   await antiban.trackSent(supabase, STORE_ID, jid);
 */

const DAILY_LIMITS_BY_WARMUP = {
  1:20, 2:25, 3:30, 4:40, 5:50, 6:60, 7:80,
  8:100, 9:120, 10:140, 11:160, 12:180, 13:200, 14:220, 15:250,
  16:280, 17:300, 18:320, 19:340, 20:360
};

const MIN_REPLY_RATIO = 0.10;
const MIN_REPLY_RATIO_SCALE = 0.05;

async function getEffectiveMinRatio(supabase) {
  const { data } = await supabase
    .from('oasis_wa_config')
    .select('system_prompt')
    .eq('id', 'wa_templates')
    .single();
  if (!data) return MIN_REPLY_RATIO;
  const tpls = JSON.parse(data.system_prompt || '[]');
  if (tpls.length === 0) return MIN_REPLY_RATIO;
  const allHaveButtons = tpls.every(function(t) {
    return (Array.isArray(t.buttons) && t.buttons.length > 0) ||
           (Array.isArray(t.messages) && t.messages.some(function(m){return m.type === 'interactive_buttons';}));
  });
  return allHaveButtons ? MIN_REPLY_RATIO_SCALE : MIN_REPLY_RATIO;
}

async function trackEngagement(supabase, msg, storeId) {
  try {
    let weight = 0;
    let kind = 'unknown';
    const m = msg.message || {};
    if (m.conversation || (m.extendedTextMessage && m.extendedTextMessage.text)) {
      weight = 1; kind = 'text';
    } else if (m.buttonsResponseMessage || m.templateButtonReplyMessage) {
      weight = 1; kind = 'button_tap';
    } else if (m.listResponseMessage) {
      weight = 1; kind = 'list_select';
    } else if (m.reactionMessage) {
      weight = 0.5; kind = 'reaction';
    } else if (m.imageMessage || m.videoMessage || m.audioMessage) {
      weight = 1; kind = 'media';
    }
    if (weight === 0) return;
    await supabase.from('oasis_wa_response_log').insert({
      store_id: storeId,
      chat_jid: msg.key.remoteJid,
      kind: kind,
      weight: weight,
      received_at: new Date((msg.messageTimestamp || Date.now()/1000) * 1000).toISOString()
    });
  } catch (e) {
    console.warn('[antiban-v2] trackEngagement failed:', e.message);
  }
}

async function trackSent(supabase, storeId, jid) {
  try {
    const { data: cur } = await supabase
      .from('oasis_stores')
      .select('msgs_today, msgs_last_hour')
      .eq('id', storeId)
      .single();
    await supabase.from('oasis_stores').update({
      msgs_today: (cur ? cur.msgs_today : 0) + 1,
      msgs_last_hour: (cur ? cur.msgs_last_hour : 0) + 1,
      updated_at: new Date().toISOString()
    }).eq('id', storeId);
  } catch (e) {
    console.warn('[antiban-v2] trackSent failed:', e.message);
  }
}

async function canSend(supabase, storeId) {
  const { data: store } = await supabase
    .from('oasis_stores')
    .select('warmup_day, msgs_today, msgs_last_hour, ban_risk_score')
    .eq('id', storeId)
    .single();
  if (!store) return false;
  const warmupDay = Math.max(1, store.warmup_day || 1);
  const dayLimit = DAILY_LIMITS_BY_WARMUP[warmupDay] || 500;
  if ((store.msgs_today || 0) >= dayLimit) {
    console.warn('[antiban-v2] daily limit', dayLimit, 'reached');
    return false;
  }
  const hourLimit = warmupDay < 15 ? 60 : 120;
  if ((store.msgs_last_hour || 0) >= hourLimit) {
    console.warn('[antiban-v2] hour burst limit', hourLimit);
    return false;
  }
  if (store.ban_risk_score >= 70) {
    console.warn('[antiban-v2] ban_risk_score', store.ban_risk_score, 'too high');
    return false;
  }
  if ((store.msgs_today || 0) >= 50) {
    const { data: replies } = await supabase
      .from('oasis_wa_response_log')
      .select('weight')
      .eq('store_id', storeId)
      .gte('received_at', new Date(Date.now() - 24*60*60*1000).toISOString());
    const totalReplies = (replies || []).reduce(function(s, r) { return s + (r.weight || 0); }, 0);
    const ratio = totalReplies / store.msgs_today;
    const minRatio = await getEffectiveMinRatio(supabase);
    if (ratio < minRatio) {
      console.warn('[antiban-v2] reply ratio', (ratio*100).toFixed(1), '% < min', (minRatio*100).toFixed(0), '%');
      return false;
    }
  }
  return true;
}

function humanDelay() {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  let ms = 5000 + z * 2000;
  ms = Math.max(1500, Math.min(15000, ms));
  return new Promise(function(r) { setTimeout(r, Math.round(ms)); });
}

const _retryCounts = new Map();
function shouldRetry(jid, messageId) {
  const key = jid + ':' + messageId;
  const count = (_retryCounts.get(key) || 0) + 1;
  _retryCounts.set(key, count);
  if (_retryCounts.size > 500) {
    const keys = Array.from(_retryCounts.keys()).slice(0, 250);
    keys.forEach(function(k) { _retryCounts.delete(k); });
  }
  if (count > 2) {
    console.warn('[antiban-v2] retry spiral', key, 'refusing retry #', count);
    return false;
  }
  return true;
}

module.exports = {
  trackEngagement: trackEngagement,
  trackSent: trackSent,
  canSend: canSend,
  humanDelay: humanDelay,
  shouldRetry: shouldRetry,
  DAILY_LIMITS_BY_WARMUP: DAILY_LIMITS_BY_WARMUP,
  getEffectiveMinRatio: getEffectiveMinRatio
};

