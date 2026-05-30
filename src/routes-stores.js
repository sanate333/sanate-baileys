/**
 * routes-stores.js — Multi-Tenant Store Management Endpoints
 *
 * Mounted under /api/whatsapp by index.js.
 *
 * Endpoints:
 *   GET  /stores             — list all stores with status (active + has-auth)
 *   GET  /stores/active      — get currently active store id
 *   POST /stores/:id/activate — switch to a different store (saves current, loads new)
 *   POST /stores/save-current — manually save current auth as the active store
 */

const express = require('express');
const router = express.Router();
const multiStore = require('./multi-store');

router.get('/stores', async (req, res) => {
  try {
    const stores = await multiStore.listStoresWithStatus();
    res.json({ ok: true, activeStoreId: multiStore.getActiveStoreId(), stores });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/stores/active', (req, res) => {
  res.json({ ok: true, activeStoreId: multiStore.getActiveStoreId() });
});

/**
 * Activate a different store.
 * NOTE: This requires the WhatsApp socket to be restarted to take effect.
 * The handler triggers a reconnect AFTER swapping auth.
 *
 * Body (optional): { reconnect: true|false }  — default true
 */
router.post('/stores/:id/activate', async (req, res) => {
  try {
    const storeId = req.params.id;
    if (!storeId) return res.status(400).json({ error: 'storeId requerido' });

    // Step 1: switch active store (saves current auth, loads new)
    const switchResult = await multiStore.switchActiveStore(storeId);

    // Step 2: trigger Baileys reconnect with the new auth (lazy require avoids circular)
    let reconnectStatus = 'skipped';
    if (req.body?.reconnect !== false) {
      try {
        const baileys = require('./baileys');
        // disconnect current sock
        try { await baileys.disconnect(); } catch (e) { /* may already be down */ }
        // reconnect with new auth dir (already populated by switchActiveStore)
        const supabase = req.app.get('supabase');
        const sse = req.app.get('sse');
        await baileys.startConnection({ force: true, supabase, sse });
        reconnectStatus = 'started';
      } catch (e) {
        reconnectStatus = 'error: ' + e.message;
      }
    }

    res.json({
      ok: true,
      activeStoreId: multiStore.getActiveStoreId(),
      ...switchResult,
      reconnectStatus
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Manually save the current in-memory auth as the active store.
 * Useful when QR was just scanned and we want to checkpoint.
 */
router.post('/stores/save-current', async (req, res) => {
  try {
    const activeId = multiStore.getActiveStoreId();
    const r = await multiStore.saveCurrentAuthAs(activeId);
    res.json({ ok: r.ok, activeStoreId: activeId, files: r.files || 0, error: r.error });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
