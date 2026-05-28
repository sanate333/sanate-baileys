// ── Tracking Cron — Auto-sync orders with Interrapidísimo every 30 min ──
// Queries oasis_pedidos in Supabase for active orders, checks tracking API,
// updates DB and sends WhatsApp notification when status changes.

const SB_URL = 'https://lvmeswlvszsmvgaasazs.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx2bWVzd2x2c3pzbXZnYWFzYXpzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE1MjYzMTEsImV4cCI6MjA4NzEwMjMxMX0.pKhuLjRLgpWMBsEUv1WhCytpbUUT6tKj3sacIGit2z4';

const TRACKING_INTERVAL = 30 * 60 * 1000; // 30 minutes
const INTER_API = 'https://apicm.interrapidisimo.com/ConsultaGuiasSTE/api/v1';

// Status emoji map
const STATUS_EMOJI = {
  'por-iniciar': '📋',
  'en-transito': '🚚',
  'entregado': '✅',
  'devolucion': '🔄',
  'desconocido': '📦'
};

// Status display names
const STATUS_DISPLAY = {
  'por-iniciar': 'En preparación',
  'en-transito': 'En camino',
  'entregado': 'Entregado',
  'devolucion': 'En devolución',
  'desconocido': 'Pendiente'
};

function mapEstado(raw) {
  if (!raw) return 'desconocido';
  const r = raw.toLowerCase();
  if (r.includes('entregado') || r.includes('delivered')) return 'entregado';
  if (r.includes('tránsito') || r.includes('transito') || r.includes('ruta') || r.includes('reparto')) return 'en-transito';
  if (r.includes('devoluc') || r.includes('devuelt')) return 'devolucion';
  if (r.includes('iniciar') || r.includes('alistamiento') || r.includes('recogido') || r.includes('bodega')) return 'por-iniciar';
  return 'desconocido';
}

async function trackGuia(guia) {
  try {
    // Step 1: Get consultation GUID
    const r1 = await fetch(`${INTER_API}/Guias/ConsultarGuias?NumerosGuias=${encodeURIComponent(guia)}&tokenRecaptcha=`);
    if (!r1.ok) return null;
    const data1 = await r1.json();
    if (!data1.operacionExitosa || !data1.resultado?.guid) return null;

    // Step 2: Get tracking details
    const r2 = await fetch(`${INTER_API}/ResultadoConsulta/ConsultarGuias`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ IdConsulta: data1.resultado.guid })
    });
    if (!r2.ok) return null;
    const data2 = await r2.json();
    if (data2.operacionExitosa && data2.resultado?.guias?.length) {
      return { ...data2.resultado.guias[0], _trackingGuid: data1.resultado.guid };
    }
    return null;
  } catch (e) {
    console.error('[tracking-cron] trackGuia error:', guia, e.message);
    return null;
  }
}

async function getActivePedidos() {
  try {
    const r = await fetch(
      `${SB_URL}/rest/v1/oasis_pedidos?estado_envio=not.in.(entregado,devolucion)&select=*`,
      { headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY } }
    );
    if (!r.ok) { console.error('[tracking-cron] Supabase fetch error:', r.status); return []; }
    return await r.json();
  } catch (e) {
    console.error('[tracking-cron] getActivePedidos error:', e.message);
    return [];
  }
}

async function updatePedidoInDB(pedido, newEstado, newEstadoRaw, trackData) {
  try {
    const body = {
      estado_envio: newEstado,
      estado_raw: newEstadoRaw,
      ciudad_origen: trackData.descripcionCiudadOrigen || pedido.ciudad_origen,
      ciudad_destino: trackData.descripcionCiudadDestino || pedido.ciudad_destino,
      updated_at: new Date().toISOString()
    };
    if (trackData.fechaEstimadaEntrega) body.fecha_estimada = trackData.fechaEstimadaEntrega;

    const r = await fetch(`${SB_URL}/rest/v1/oasis_pedidos?id=eq.${pedido.id}`, {
      method: 'PATCH',
      headers: {
        'apikey': SB_KEY,
        'Authorization': 'Bearer ' + SB_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    return r.ok;
  } catch (e) {
    console.error('[tracking-cron] updatePedido error:', pedido.guia, e.message);
    return false;
  }
}

function buildTrackingMessage(pedido, newEstado, newEstadoRaw, trackData) {
  const emoji = STATUS_EMOJI[newEstado] || '📦';
  const display = STATUS_DISPLAY[newEstado] || newEstadoRaw;
  const origen = trackData.descripcionCiudadOrigen || pedido.ciudad_origen || '';
  const destino = trackData.descripcionCiudadDestino || pedido.ciudad_destino || '';
  const ruta = origen && destino ? `${origen} → ${destino}` : '';
  const trackUrl = `https://sanate.store/rastreo.php?guia=${encodeURIComponent(pedido.guia)}`;

  let msg = `${emoji} *Actualización de tu pedido*\n\n`;
  msg += `📦 *Guía:* ${pedido.guia}\n`;
  msg += `🚛 *Transportadora:* Interrapidísimo\n`;
  msg += `📍 *Estado:* ${display}\n`;
  if (ruta) msg += `🗺️ *Ruta:* ${ruta}\n`;
  if (trackData.fechaEstimadaEntrega) {
    const fecha = new Date(trackData.fechaEstimadaEntrega).toLocaleDateString('es-CO', {
      day: 'numeric', month: 'long', year: 'numeric'
    });
    msg += `📅 *Entrega estimada:* ${fecha}\n`;
  }
  msg += `\n🔗 *Rastrear tu pedido:*\n${trackUrl}`;

  return { text: msg, trackUrl };
}

async function sendTrackingNotification(sock, pedido, newEstado, newEstadoRaw, trackData) {
  if (!pedido.cliente_phone || !sock) return;

  const phone = pedido.cliente_phone.replace(/\D/g, '');
  if (phone.length < 7) return;

  const jid = phone + '@s.whatsapp.net';
  const { text, trackUrl } = buildTrackingMessage(pedido, newEstado, newEstadoRaw, trackData);

  try {
    // Send image with caption and tracking URL
    await sock.sendMessage(jid, {
      image: { url: 'https://interrapidisimo.com/wp-content/uploads/interrapidisimo-1.png' },
      caption: text
    });
    console.log('[tracking-cron] WhatsApp sent to', phone, 'guia:', pedido.guia, 'new status:', newEstado);
  } catch (e) {
    // Fallback to text-only if image fails
    try {
      await sock.sendMessage(jid, { text });
      console.log('[tracking-cron] WhatsApp text sent to', phone, '(image failed)');
    } catch (e2) {
      console.error('[tracking-cron] WhatsApp send failed:', phone, e2.message);
    }
  }
}

function startTrackingCron(getDeviceFn) {
  console.log('[tracking-cron] Starting auto-tracking every', TRACKING_INTERVAL / 60000, 'minutes');

  async function runTrackingCycle() {
    const dev = getDeviceFn('default');
    if (!dev || !dev.sock || dev.status !== 'connected') {
      console.log('[tracking-cron] Skipping — WhatsApp not connected');
      return;
    }

    const pedidos = await getActivePedidos();
    if (!pedidos.length) {
      console.log('[tracking-cron] No active orders to track');
      return;
    }

    console.log('[tracking-cron] Checking', pedidos.length, 'active orders...');
    let updated = 0;
    let notified = 0;

    for (const pedido of pedidos) {
      // Rate limit: wait 2s between API calls
      if (pedidos.indexOf(pedido) > 0) {
        await new Promise(r => setTimeout(r, 2000));
      }

      const trackData = await trackGuia(pedido.guia);
      if (!trackData) continue;

      const newEstado = mapEstado(trackData.estadoGuia);
      const oldEstado = pedido.estado_envio;

      // Always update the DB with latest data (even if status didn't change)
      await updatePedidoInDB(pedido, newEstado, trackData.estadoGuia || '', trackData);
      updated++;

      // Only send WhatsApp if status actually changed
      if (newEstado !== oldEstado && newEstado !== 'desconocido') {
        await sendTrackingNotification(dev.sock, pedido, newEstado, trackData.estadoGuia, trackData);
        notified++;
        // Wait 5s between WhatsApp messages to avoid rate limiting
        await new Promise(r => setTimeout(r, 5000));
      }
    }

    console.log('[tracking-cron] Cycle done:', updated, 'updated,', notified, 'notified');
  }

  // Run immediately on startup (after 60s delay to let WA connect)
  setTimeout(runTrackingCycle, 60000);

  // Then every 30 minutes
  setInterval(runTrackingCycle, TRACKING_INTERVAL);

  // Also expose an API endpoint for manual trigger
  return {
    runNow: runTrackingCycle
  };
}

module.exports = { startTrackingCron };
