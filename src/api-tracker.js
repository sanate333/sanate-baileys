/**
 * API Tracker — registra estado de cada API key en Supabase
 * Se llama después de cada fetch a Gemini/Vertex/etc para track_api_ping
 */
'use strict';
let supabaseClient = null;
const KEY_NAME_BY_VALUE = new Map(); // mapa key_value -> {id, name} cargado de Supabase

async function init(supabase) {
  supabaseClient = supabase;
  if (!supabase) return;
  try {
    const { data } = await supabase.from('oasis_api_keys')
      .select('id, name, key_masked, meta');
    if (data) data.forEach(k => {
      // Hash o full match con últimos 4 chars del key real
      const last4 = (k.key_masked || '').replace(/[^A-Za-z0-9]/g,'').slice(-4);
      if (last4) KEY_NAME_BY_VALUE.set(last4, { id: k.id, name: k.name });
    });
    console.log(`[ApiTracker] ${KEY_NAME_BY_VALUE.size} keys cargadas`);
  } catch (e) {
    console.warn('[ApiTracker] init error:', e.message);
  }
}

/**
 * Reportar resultado de un fetch a API externa
 * @param {string} keyValue - el API key usado (para identificar)
 * @param {boolean} ok - true si funcionó, false si falló
 * @param {number} status - HTTP status code
 */
async function track(keyValue, ok, status) {
  if (!supabaseClient || !keyValue) return;
  try {
    const last4 = (keyValue || '').slice(-4);
    const info = KEY_NAME_BY_VALUE.get(last4);
    if (!info) {
      // Auto-register: la primera vez que vemos esta key
      const masked = '...' + last4;
      const { data, error } = await supabaseClient
        .from('oasis_api_keys')
        .insert({
          name: 'GEMINI_AUTO_' + last4,
          provider: 'gemini',
          key_masked: masked,
          store_id: process.env.STORE_ID || '00000000-0000-0000-0000-000000000001',
          is_working: ok,
          last_ping_at: new Date().toISOString(),
          last_ping_status: status,
          total_uses: 1
        })
        .select('id, name')
        .single();
      if (data) KEY_NAME_BY_VALUE.set(last4, { id: data.id, name: data.name });
      return;
    }
    // Update stats via RPC
    await supabaseClient.rpc('track_api_ping', {
      p_key_id: info.id,
      p_status: status,
      p_ok: ok
    });
    // Increment usage counter
    await supabaseClient.rpc('increment_api_use', { p_key_id: info.id }).catch(() => {});
  } catch (e) {
    // silent — no romper flujo principal
  }
}

/**
 * Wrap fetch para auto-track
 */
async function fetchWithTracking(url, opts) {
  const keyMatch = url.match(/[?&]key=([^&]+)/);
  const key = keyMatch ? keyMatch[1] : null;
  const t0 = Date.now();
  try {
    const r = await fetch(url, opts);
    if (key) track(key, r.ok, r.status).catch(()=>{});
    return r;
  } catch (e) {
    if (key) track(key, false, 0).catch(()=>{});
    throw e;
  }
}

module.exports = { init, track, fetchWithTracking };
