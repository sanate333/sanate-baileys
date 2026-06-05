/* account-age-check.js — Verifies account age/legitimacy post-QR for anti-ban
 * Use:
 *   const { runAccountAgeCheck } = require('./account-age-check');
 *   sock.ev.on('connection.update', async (u) => {
 *     if (u.connection === 'open') {
 *       setTimeout(() => runAccountAgeCheck(sock, supabase, storeId), 30000);
 *     }
 *   });
 */

const SUSPICIOUS_THRESHOLDS = {
  MIN_CONTACTS: 20,
  MIN_CHATS: 5,
  MIN_PUSHNAME_LEN: 3,
  WAIT_BEFORE_CHECK_MS: 30000
};

async function runAccountAgeCheck(sock, supabase, storeId) {
  try {
    const contactsCount = Object.keys(sock.contacts || {}).length;
    const chatsCount = Object.keys(sock.chats || {}).length;
    const myPushName = (sock.user && (sock.user.name || sock.user.notify)) || '';
    const myJid = (sock.user && sock.user.id) || '';

    let riskScore = 0;
    const flags = [];

    if (contactsCount < SUSPICIOUS_THRESHOLDS.MIN_CONTACTS) { riskScore += 30; flags.push('few_contacts(' + contactsCount + ')'); }
    if (chatsCount < SUSPICIOUS_THRESHOLDS.MIN_CHATS) { riskScore += 25; flags.push('few_chats(' + chatsCount + ')'); }
    if (!myPushName || myPushName.length < SUSPICIOUS_THRESHOLDS.MIN_PUSHNAME_LEN) { riskScore += 15; flags.push('no_pushname'); }

    let verdict = 'OK';
    if (riskScore >= 50) verdict = 'BLOCK_MASIVOS';
    else if (riskScore >= 30) verdict = 'WARMUP_STRICT';

    const policies = {
      OK: { max_msgs_day: 500, allow_masivos: true },
      WARMUP_STRICT: { max_msgs_day: 30, allow_masivos: false },
      BLOCK_MASIVOS: { max_msgs_day: 5, allow_masivos: false }
    };
    const policy = policies[verdict];

    console.log('[account-age-check] store=' + storeId + ' contacts=' + contactsCount + ' chats=' + chatsCount + ' risk=' + riskScore + ' verdict=' + verdict);

    const checkResult = {
      verdict: verdict,
      risk_score: riskScore,
      flags: flags,
      contacts_at_link: contactsCount,
      chats_at_link: chatsCount,
      policy: policy,
      checked_at: new Date().toISOString()
    };

    await supabase
      .from('oasis_stores')
      .update({
        ban_risk_score: Math.min(100, riskScore + 5),
        whatsapp_phone: myJid.replace(/[^0-9]/g, '').slice(0, 20)
      })
      .eq('id', storeId);

    if (verdict !== 'OK') {
      await supabase
        .from('oasis_activity_log')
        .insert({
          store_id: storeId,
          event_type: 'account_age_warning',
          payload: checkResult
        });
    }

    return checkResult;
  } catch (e) {
    console.error('[account-age-check] failed:', e.message);
    return null;
  }
}

module.exports = { runAccountAgeCheck, SUSPICIOUS_THRESHOLDS };

