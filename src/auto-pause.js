/**
 * src/auto-pause.js
 *
 * Auto-pause de difusiones masivas cuando ban_risk_score >= 50
 * Pausa todas las campañas activas + notifica al panel via Supabase realtime
 *
 * INSTALACIÓN:
 * 1. Guardar en src/auto-pause.js
 * 2. Es requerido automáticamente por anti-ban-metrics-cron.js cuando risk>=50
 * 3. Commit + push → Render auto-deploy
 */

const PAUSE_DURATION_MS = 24 * 60 * 60 * 1000; // 24h por defecto
const _activelyPaused = new Map(); // store_id → timestamp pause iniciado

async function triggerPause(store, riskScore) {
  if (!store || !store.id) return false;
  if (_activelyPaused.has(store.id)) {
    const elapsed = Date.now() - _activelyPaused.get(store.id);
    if (elapsed < PAUSE_DURATION_MS) return false; // ya pausado
  }
  _activelyPaused.set(store.id, Date.now());

  console.warn(
    `[auto-pause] BAN RISK ALTO (${riskScore}/100) — pausando ${store.slug} por 24h`
  );

  try {
    // Lazy require supabase
    const { getSupabase } = require('./supabase');
    const supabase = getSupabase();
    if (!supabase) {
      console.warn('[auto-pause] no supabase, abort');
      return false;
    }

    // 1. Pausar todas las difusiones activas para esta tienda
    const { error: difErr } = await supabase
      .from('oasis_difusion_campaigns')
      .update({
        status: 'paused_auto',
        paused_at: new Date().toISOString(),
        paused_reason: `Auto-pause: ban_risk=${riskScore}/100`,
      })
      .eq('store_id', store.id)
      .in('status', ['running', 'pending', 'scheduled']);
    if (difErr) console.warn('[auto-pause] pause campaigns failed:', difErr.message);

    // 2. Marcar la tienda como suspendida temporalmente
    const { error: stErr } = await supabase
      .from('oasis_stores')
      .update({
        suspended: true,
        temp_access_until: new Date(Date.now() + PAUSE_DURATION_MS).toISOString(),
        last_anti_ban_check: new Date().toISOString(),
      })
      .eq('id', store.id);
    if (stErr) console.warn('[auto-pause] suspend store failed:', stErr.message);

    // 3. Log el evento
    await supabase.from('oasis_error_log').insert({
      store_id: store.id,
      level: 'WARNING',
      source: 'auto-pause',
      message: `Tienda pausada automáticamente por ban_risk_score=${riskScore}`,
      context: {
        risk_score: riskScore,
        pause_duration_hours: 24,
        triggered_at: new Date().toISOString(),
      },
    });

    // 4. Notify panel via SSE if available
    try {
      const sse = global.__sseManager;
      if (sse && sse.broadcast) {
        sse.broadcast({
          type: 'auto_pause_triggered',
          store_id: store.id,
          slug: store.slug,
          risk_score: riskScore,
          duration_hours: 24,
        });
      }
    } catch (e) {}

    return true;
  } catch (e) {
    console.error('[auto-pause] exception:', e.message);
    return false;
  }
}

async function checkAndUnpause(storeId) {
  // Llamado periódicamente para des-pausar tiendas que ya cumplieron las 24h
  if (!_activelyPaused.has(storeId)) return false;
  const startedAt = _activelyPaused.get(storeId);
  if (Date.now() - startedAt < PAUSE_DURATION_MS) return false;
  _activelyPaused.delete(storeId);
  try {
    const { getSupabase } = require('./supabase');
    const supabase = getSupabase();
    if (!supabase) return false;
    await supabase
      .from('oasis_stores')
      .update({
        suspended: false,
        temp_access_until: null,
      })
      .eq('id', storeId);
    console.log('[auto-pause] Tienda re-activada tras 24h pausa:', storeId);
    return true;
  } catch (e) {
    console.warn('[auto-pause] unpause failed:', e.message);
    return false;
  }
}

module.exports = { triggerPause, checkAndUnpause };
