/**
 * src/linked-devices-endpoint.js
 *
 * Endpoint para verificar dispositivos vinculados via Baileys
 * Permite al panel confirmar que WA Web oficial se conectó correctamente.
 *
 * INSTALACIÓN:
 * 1. Guardar en src/linked-devices-endpoint.js
 * 2. En src/index.js, después de mount api routes, agregar:
 *    require('./linked-devices-endpoint')(app);
 * 3. Commit + push → Render auto-deploy
 *
 * USO:
 * GET /api/whatsapp/linked-devices
 * Returns: { ok: true, count: 2, devices: [...] }
 */

const { getSocket } = require('./baileys');

module.exports = function (app) {
  app.get('/api/whatsapp/linked-devices', async (req, res) => {
    try {
      const sock = getSocket();
      if (!sock) {
        return res.json({ ok: false, error: 'socket not initialized', count: 0, devices: [] });
      }
      if (!sock.user) {
        return res.json({ ok: false, error: 'not authenticated', count: 0, devices: [] });
      }
      // Baileys exposes the linked devices via sock.user
      // For multi-device list, we use sock.appStateKey or query getCompanionDevices
      let devices = [];
      try {
        // Method 1: get from in-memory device list (Baileys multi-device sync)
        if (sock.authState && sock.authState.creds && sock.authState.creds.account) {
          devices.push({
            id: sock.user.id,
            type: 'primary',
            platform: sock.user.platform || 'unknown',
            name: sock.user.name || sock.user.notify || '',
          });
        }
        // Method 2: query devices via Baileys query API
        if (sock.assertSessions) {
          // Query the device list from server
          const result = await sock.query({
            tag: 'iq',
            attrs: {
              id: sock.generateMessageTag(),
              type: 'get',
              xmlns: 'md',
              to: '@s.whatsapp.net',
            },
            content: [{ tag: 'devices', attrs: {} }],
          }).catch(() => null);
          if (result && result.content) {
            // Parse device nodes
            const deviceNodes = result.content.filter(n => n.tag === 'devices');
            deviceNodes.forEach(node => {
              if (node.content) {
                node.content.forEach(dev => {
                  if (dev.tag === 'device') {
                    devices.push({
                      id: dev.attrs.jid || dev.attrs.id,
                      type: 'companion',
                      platform: dev.attrs.platform || 'unknown',
                      name: dev.attrs.deviceName || '',
                    });
                  }
                });
              }
            });
          }
        }
      } catch (e) {
        // Fallback: just return primary
        console.warn('[linked-devices] query failed:', e.message);
      }
      res.json({
        ok: true,
        count: devices.length,
        devices,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      console.error('[linked-devices] error:', err);
      res.status(500).json({ ok: false, error: err.message, count: 0, devices: [] });
    }
  });
};
