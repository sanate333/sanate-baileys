/**
 * Supabase-backed auth state for Baileys
 * Persists WhatsApp session credentials in Supabase so they survive Render deploys.
 * Falls back to local filesystem if Supabase is unavailable.
 */

const { useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } = require('fs');
const path = require('path');

const AUTH_DIR = path.join(__dirname, '..', 'auth_info');
const DEVICE_ID = process.env.DEVICE_ID || 'default';

/**
 * Load auth files from Supabase into local auth_info directory
 */
async function loadAuthFromSupabase(supabase) {
  if (!supabase) return false;
  try {
    const { data, error } = await supabase
      .from('oasis_wa_auth')
      .select('id, data')
      .eq('device_id', DEVICE_ID);

    if (error) throw error;
    if (!data || data.length === 0) {
      console.log('[AUTH] No hay sesion guardada en Supabase para device=' + DEVICE_ID);
      return false;
    }

    // Ensure auth dir exists
    if (!existsSync(AUTH_DIR)) mkdirSync(AUTH_DIR, { recursive: true });

    // Write each file to disk
    let restored = 0;
    for (const row of data) {
      const filePath = path.join(AUTH_DIR, row.id);
      writeFileSync(filePath, JSON.stringify(row.data));
      restored++;
    }

    console.log('[AUTH] Sesion restaurada desde Supabase: ' + restored + ' archivos');
    return true;
  } catch (err) {
    console.error('[AUTH] Error cargando sesion desde Supabase:', err.message);
    return false;
  }
}

/**
 * Save all auth files from local directory to Supabase
 */
async function saveAuthToSupabase(supabase) {
  if (!supabase) return;
  try {
    const files = existsSync(AUTH_DIR) ? readdirSync(AUTH_DIR) : [];
    if (files.length === 0) return;

    const rows = [];
    for (const file of files) {
      const filePath = path.join(AUTH_DIR, file);
      try {
        const content = readFileSync(filePath, 'utf8');
        const data = JSON.parse(content);
        rows.push({
          id: file,
          device_id: DEVICE_ID,
          data: data,
          updated_at: new Date().toISOString()
        });
      } catch { /* skip non-json files */ }
    }

    if (rows.length === 0) return;

    const { error } = await supabase
      .from('oasis_wa_auth')
      .upsert(rows, { onConflict: 'id' });

    if (error) throw error;
    console.log('[AUTH] Sesion guardada en Supabase: ' + rows.length + ' archivos');
  } catch (err) {
    console.error('[AUTH] Error guardando sesion en Supabase:', err.message);
  }
}

/**
 * Clear only local auth files (keeps Supabase intact).
 * Used when reconnecting after connectionReplaced (440) so the next
 * useSupabaseAuthState() call reloads fresh keys from Supabase.
 */
async function clearLocalAuth() {
  try {
    if (existsSync(AUTH_DIR)) {
      rmSync(AUTH_DIR, { recursive: true, force: true });
    }
    mkdirSync(AUTH_DIR, { recursive: true });
    console.log('[AUTH] Auth local limpiada - se recargara desde Supabase en la proxima conexion');
  } catch (err) {
    console.error('[AUTH] Error limpiando auth local:', err.message);
  }
}

/**
 * Clear auth from both filesystem and Supabase
 */
async function clearAuth(supabase) {
  // Clear local
  if (existsSync(AUTH_DIR)) {
    rmSync(AUTH_DIR, { recursive: true, force: true });
    mkdirSync(AUTH_DIR, { recursive: true });
  }

  // Clear from Supabase
  if (supabase) {
    try {
      await supabase
        .from('oasis_wa_auth')
        .delete()
        .eq('device_id', DEVICE_ID);
      console.log('[AUTH] Sesion eliminada de Supabase para device=' + DEVICE_ID);
    } catch (err) {
      console.error('[AUTH] Error eliminando sesion de Supabase:', err.message);
    }
  }
}

/**
 * Get auth state with Supabase persistence
 * 1. Try to restore session from Supabase to local filesystem
 * 2. Use standard useMultiFileAuthState
 * 3. Wrap saveCreds to also save to Supabase
 */
async function useSupabaseAuthState(supabase) {
  // Ensure auth dir exists
  if (!existsSync(AUTH_DIR)) mkdirSync(AUTH_DIR, { recursive: true });

  // Step 1: Restore from Supabase if local is empty
  const localFiles = existsSync(AUTH_DIR) ? readdirSync(AUTH_DIR) : [];
  if (localFiles.length === 0) {
    await loadAuthFromSupabase(supabase);
  }

  // Step 2: Use standard Baileys file-based auth
  const { state, saveCreds: originalSaveCreds } = await useMultiFileAuthState(AUTH_DIR);

  // Step 3: Wrap saveCreds to also persist to Supabase
  // Wrap keys.set para sincronizar sesiones Signal a Supabase en tiempo real
  // Esto previene el error "Bad MAC" despues de reinicios del servidor
  let _sessionSyncTimer = null;
  const _originalKeysSet = state.keys.set.bind(state.keys);
  state.keys.set = async (data) => {
    await _originalKeysSet(data);
    // Si hay cambios de sesion, sincronizar a Supabase (debounced 4s)
    if (data && (data['session'] || data['sender-key'] || data['app-state-sync-key'])) {
      clearTimeout(_sessionSyncTimer);
      _sessionSyncTimer = setTimeout(() => {
        saveAuthToSupabase(supabase).catch(err =>
          console.error('[AUTH] Session sync error:', err.message)
        );
      }, 4000);
    }
  };

  const saveCreds = async () => {
    await originalSaveCreds();
    // Save to Supabase in background (don't await to avoid blocking)
    saveAuthToSupabase(supabase).catch(err => {
      console.error('[AUTH] Background save failed:', err.message);
    });
  };

  return { state, saveCreds };
}

module.exports = { useSupabaseAuthState, clearAuth, clearLocalAuth, saveAuthToSupabase, loadAuthFromSupabase };
