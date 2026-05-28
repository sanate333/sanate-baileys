/**
 * store-context.js — Multi-tenant store context manager
 *
 * Provides store_id resolution for all DB queries.
 * Single-tenant mode: uses DEFAULT_STORE_ID (backward compatible)
 * Multi-tenant mode: resolves store_id from request headers, env var, or API key
 */

const DEFAULT_STORE_ID = '00000000-0000-0000-0000-000000000001';

// In-memory store cache (loaded from Supabase on init)
let storesCache = new Map();
let supabaseRef = null;

function init(supabase) {
  supabaseRef = supabase;
}

/**
 * Get store_id from various sources (priority order):
 * 1. Explicit store_id in request header (X-Store-Id)
 * 2. Store slug in URL path (/api/s/:slug/...)
 * 3. API key → mapped to store_id
 * 4. Environment variable STORE_ID
 * 5. Default store (backward compatible)
 */
function getStoreId(req) {
  if (!req) return process.env.STORE_ID || DEFAULT_STORE_ID;

  // 1. Explicit header
  const headerStoreId = req.headers['x-store-id'];
  if (headerStoreId && isValidUUID(headerStoreId)) return headerStoreId;

  // 2. URL slug: /api/s/:slug/...
  if (req.params && req.params.storeSlug) {
    const store = storesCache.get(req.params.storeSlug);
    if (store) return store.id;
  }

  // 3. Attached by middleware (e.g., from API key auth)
  if (req.storeId) return req.storeId;

  // 4. Environment variable
  if (process.env.STORE_ID) return process.env.STORE_ID;

  // 5. Default
  return DEFAULT_STORE_ID;
}

/**
 * Express middleware: attaches storeId to req
 */
function storeMiddleware(req, res, next) {
  req.storeId = getStoreId(req);
  next();
}

/**
 * Load stores from Supabase into cache
 */
async function loadStores() {
  if (!supabaseRef) return;
  try {
    const { data, error } = await supabaseRef
      .from('oasis_stores')
      .select('id, name, slug, status, config')
      .eq('status', 'active');
    if (error) throw error;
    storesCache.clear();
    for (const store of (data || [])) {
      storesCache.set(store.slug, store);
      storesCache.set(store.id, store);
    }
    console.log(`[Stores] ${storesCache.size / 2} tiendas activas cargadas`);
  } catch (e) {
    console.error('[Stores] Error cargando tiendas:', e.message);
  }
}

/**
 * Get store info by id or slug
 */
function getStore(idOrSlug) {
  return storesCache.get(idOrSlug) || null;
}

function isValidUUID(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

module.exports = {
  DEFAULT_STORE_ID,
  init,
  getStoreId,
  getStore,
  storeMiddleware,
  loadStores
};
