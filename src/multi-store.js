/**
 * multi-store.js — Multi-Tenant Store Manager (Option A: switching active store)
 *
 * Provides the ability to switch the active WhatsApp store at runtime without
 * losing other stores' auth state. Each store's auth is saved with its own
 * device_id in oasis_wa_auth and can be reloaded on demand.
 *
 * For TRUE simultaneous multi-WA, see PANEL-MEMORY.md "Multi-tienda sprint"
 * notes — requires a worker pool architecture (Fly.io machines, etc.)
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_STORE_ID = '00000000-0000-0000-0000-000000000001';
const AUTH_DIR = path.join(__dirname, '..', 'auth_info');

let _activeStoreId = process.env.STORE_ID || DEFAULT_STORE_ID;
let _supabase = null;

function init(supabase) { _supabase = supabase; }

function getActiveStoreId() { return _activeStoreId; }

function getProxyUrlForStore(storeId) {
  // Base proxy URL: socks5://user:pass@host:port
  // For sticky session per store, we inject the storeId in the user segment.
  // Example: socks5://user-session-{shortId}:pass@host:port
  const base = process.env.WA_PROXY_URL;
  if (!base) return null;
  if (!storeId || storeId === DEFAULT_STORE_ID) return base;
  // Convert UUID to short alphanumeric for proxy session id
  const shortId = storeId.replace(/-/g, '').substring(0, 12);
  try {
    // Pattern: socks5://USER:PASS@HOST:PORT  →  socks5://USER-session-SHORT:PASS@HOST:PORT
    const url = new URL(base);
    if (url.username && !url.username.includes('-session-')) {
      url.username = url.username + '-session-' + shortId;
      return url.toString();
    }
    return base;
  } catch (e) {
    return base;
  }
}

/**
 * Save current auth_info dir to Supabase, tagged with the given storeId.
 * This is called BEFORE switching to a different store, to preserve the
 * current store's session.
 */
async function saveCurrentAuthAs(storeId) {
  if (!_supabase) return { ok: false, error: 'No supabase' };
  if (!fs.existsSync(AUTH_DIR)) return { ok: true, files: 0 };
  try {
    const files = fs.readdirSync(AUTH_DIR);
    if (files.length === 0) return { ok: true, files: 0 };
    const rows = [];
    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(AUTH_DIR, f), 'utf8'));
        rows.push({
          id: f,
          device_id: storeId,
          store_id: storeId,
          data,
          updated_at: new Date().toISOString()
        });
      } catch {}
    }
    if (rows.length === 0) return { ok: true, files: 0 };
    // Delete previous rows for this store to avoid orphan keys
    await _supabase.from('oasis_wa_auth').delete().eq('device_id', storeId);
    // Insert fresh
    const { error } = await _supabase.from('oasis_wa_auth').insert(rows);
    if (error) throw error;
    return { ok: true, files: rows.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Load auth for a store from Supabase into the local AUTH_DIR.
 * Returns { ok, files }.
 */
async function loadAuthForStore(storeId) {
  if (!_supabase) return { ok: false, error: 'No supabase' };
  try {
    const { data, error } = await _supabase
      .from('oasis_wa_auth')
      .select('id, data')
      .eq('device_id', storeId);
    if (error) throw error;
    // Clear local dir
    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    if (!data || data.length === 0) return { ok: true, files: 0, isNew: true };
    for (const row of data) {
      fs.writeFileSync(path.join(AUTH_DIR, row.id), JSON.stringify(row.data));
    }
    return { ok: true, files: data.length, isNew: false };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Switch the active store.
 * 1. Save current auth tagged with the CURRENT active store
 * 2. Update _activeStoreId
 * 3. Update DEVICE_ID env var so auth-store.js uses the new key
 * 4. Update WA_PROXY_URL env var to use the new store's session ID
 * Caller must restart Baileys after this call to apply.
 */
async function switchActiveStore(newStoreId) {
  if (!newStoreId) throw new Error('newStoreId requerido');
  if (newStoreId === _activeStoreId) return { ok: true, noChange: true, activeStoreId: _activeStoreId };

  // 1. Save current auth (in-memory snapshot) as the OLD store
  const saveResult = await saveCurrentAuthAs(_activeStoreId);

  // 2. Load auth for the new store
  const loadResult = await loadAuthForStore(newStoreId);

  // 3. Update active store id + env
  _activeStoreId = newStoreId;
  process.env.DEVICE_ID = newStoreId;

  // 4. Re-derive WA_PROXY_URL with new session
  const baseProxy = process.env._WA_PROXY_URL_BASE || process.env.WA_PROXY_URL;
  if (baseProxy && !process.env._WA_PROXY_URL_BASE) {
    process.env._WA_PROXY_URL_BASE = baseProxy; // remember the base
  }
  const newProxy = getProxyUrlForStore(newStoreId);
  if (newProxy) process.env.WA_PROXY_URL = newProxy;

  return {
    ok: true,
    activeStoreId: _activeStoreId,
    savedFiles: saveResult.files || 0,
    loadedFiles: loadResult.files || 0,
    isNewStore: loadResult.isNew || false,
    proxyApplied: !!newProxy
  };
}

/**
 * List all stores with their auth state (whether they have saved sessions).
 */
async function listStoresWithStatus() {
  if (!_supabase) { console.warn('[MultiStore] _supabase NULL en listStoresWithStatus'); return []; }
  try {
    const { data: stores, error: storesErr } = await _supabase
      .from('oasis_stores')
      .select('id, name, slug, status, phone, plan')
      .order('created_at', { ascending: true });
    if (storesErr) {
      console.error('[MultiStore] Error consultando oasis_stores:', storesErr.message);
      return [];
    }
    const { data: auths } = await _supabase
      .from('oasis_wa_auth')
      .select('device_id');
    const authSet = new Set((auths || []).map(a => a.device_id).filter(Boolean));
    const result = (stores || []).map(s => ({
      ...s,
      hasAuth: authSet.has(s.id),
      isActive: s.id === _activeStoreId
    }));
    console.log('[MultiStore] listStoresWithStatus devolvio', result.length, 'tiendas');
    return result;
  } catch (e) {
    console.error('[MultiStore] Excepcion en listStoresWithStatus:', e.message);
    return [];
  }
}

module.exports = {
  DEFAULT_STORE_ID,
  init,
  getActiveStoreId,
  getProxyUrlForStore,
  saveCurrentAuthAs,
  loadAuthForStore,
  switchActiveStore,
  listStoresWithStatus
};
