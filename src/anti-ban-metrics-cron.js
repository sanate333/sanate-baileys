/**
 * src/anti-ban-metrics-cron.js
 *
 * Cron worker que cada hora actualiza métricas Meta 2026 anti-ban
 * por cada tienda en oasis_stores:
 *   - reply_ratio_24h: (replies recibidos / mensajes enviados) * 100
 *   - unanswered_24h: mensajes enviados sin respuesta dentro de 24h
 *   - ban_risk_score: cálculo compuesto (0-100, 100 = ban inminente)
 *
 * INSTALACIÓN:
 * 1. Guardar en src/anti-ban-metrics-cron.js
 * 2. En src/index.js dentro de start(), agregar al final:
 *    const antiBanCron = require('./anti-ban-metrics-cron');
 *    antiBanCron.start(supabase);
 * 3. Commit + push → Render auto-deploy
 */

const INTERVAL_MS = 60 * 60 * 1000; // 1 hora
let _interval = null;
let _supabase = null;

/**
 * Calcula ban_risk_score 0-100 según pesos Meta 2026:
 *  - reply_ratio < 10%   → +30 pts
 *  - reply_ratio < 5%    → +50 pts (en lugar de 30)
 *  - unanswered > 50     → +25 pts
 *  - unanswered > 100    → +40 pts (en lugar de 25)
 *  - msgs_today > 200 día 1-7 (warmup violation) → +30 pts
 *  - msgs_today > 500 cualquier día → +20 pts
 *  - reconnect_count > 5 últimas 24h → +15 pts
 */
function calculateRiskScore(store, replyRatio, unansweredCount, msgsToday) {
  let score = 0;
  // Reply ratio (peso más alto en 2026)
  if (replyRatio < 5 && msgsToday > 5) score += 50;
  else if (replyRatio < 10 && msgsToday > 5) score += 30;
  // Unanswered count (nuevo en 2026)
  if (unansweredCount > 100) score += 40;
  else if (unansweredCount > 50) score += 25;
  // Warmup violation
  if (store.warmup_day && store.warmup_day < 8) {
    const warmupLimit = Math.min(20 + (store.warmup_day || 1) * 30, 200);
    if (msgsToday > warmupLimit) score += 30;
  }
  // Daily limit hard cap
  if (msgsToday > 500) score += 20;
  // Connection instability
  if ((store.reconnect_count || 0) > 5) score += 15;
  return Math.min(100, score);
}

async function processStore(store) {
  if (!_supabase) return;
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    // Query messages last 24h for this store
    const { data: msgs, error } = await _supabase
      .from('oasis_wa_messages')
      .select('jid, direction, ts')
      .eq('store_id', store.id)
      .gte('ts', since);
    if (error) {
      console.warn('[anti-ban-cron] error querying msgs for', store.slug, error.message);
      return;
    }
    const outbound = (msgs || []).filter(m => m.direction === 'out');
    const inbound = (msgs || []).filter(m => m.direction === 'in');
    // Group by jid to compute who replied
    const jidsContacted = new Set(outbound.map(m => m.jid));
    const jidsReplied = new Set(inbound.map(m => m.jid));
    const unansweredJids = [...jidsContacted].filter(j => !jidsReplied.has(j));
    const replyRatio = outbound.length > 0
      ? Math.round((inbound.length / outbound.length) * 100 * 100) / 100
      : 0;
    const unansweredCount = unansweredJids.length;
    const msgsToday = outbound.length;
    const banRisk = calculateRiskScore(store, replyRatio, unansweredCount, msgsToday);

    // Update store record
    const { error: upErr } = await _supabase
      .from('oasis_stores')
      .update({
        reply_ratio_24h: replyRatio,
        unanswered_24h: unansweredCount,
        ban_risk_score: banRisk,
        msgs_today: msgsToday,
        last_anti_ban_check: new Date().toISOString(),
      })
      .eq('id', store.id);
    if (upErr) {
      console.warn('[anti-ban-cron] update failed for', store.slug, upErr.message);
      return;
    }
    console.log(
      `[anti-ban-cron] ${store.slug}: reply=${replyRatio}% unans=${unansweredCount} risk=${banRisk} msgs=${msgsToday}`
    );
    // If risk > 50, trigger auto-pause (see auto-pause module)
    if (banRisk >= 50) {
      try {
        const autoPause = require('./auto-pause');
        await autoPause.triggerPause(store, banRisk);
      } catch (e) {
        console.warn('[anti-ban-cron] auto-pause failed:', e.message);
      }
    }
  } catch (e) {
    console.error('[anti-ban-cron] processStore exception:', e.message);
  }
}

async function tick() {
  if (!_supabase) return;
  try {
    const { data: stores, error } = await _supabase
      .from('oasis_stores')
      .select('id, slug, name, warmup_day, reconnect_count, status')
      .eq('status', 'active');
    if (error) {
      console.error('[anti-ban-cron] error fetching stores:', error.message);
      return;
    }
    for (const store of stores || []) {
      await processStore(store);
    }
  } catch (e) {
    console.error('[anti-ban-cron] tick exception:', e.message);
  }
}

function start(supabase) {
  _supabase = supabase;
  if (_interval) clearInterval(_interval);
  // Run immediately on startup
  setTimeout(tick, 10000);
  // Then every hour
  _interval = setInterval(tick, INTERVAL_MS);
  console.log('[anti-ban-cron] Started — checking metrics every 1h');
}

function stop() {
  if (_interval) clearInterval(_interval);
  _interval = null;
}

module.exports = { start, stop, tick, calculateRiskScore };
