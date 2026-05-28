/* Warmup Meter v1.0 — SANATE
 * Muestra barra de calentamiento del numero en seccion Resumen
 * Se inyecta en el panel de Resumen del dashboard
 * Guard: window.__snaWarmupV1
 */
(function() {
  'use strict';
  if (window.__snaWarmupV1) return;
  window.__snaWarmupV1 = true;

  var API_BASE = window.location.origin.includes('sanate.store')
    ? 'https://sanate-wa-bot.onrender.com'
    : window.location.origin;
  var POLL_INTERVAL = 60000; // Actualizar cada 60s
  var warmupData = null;

  function getColor(percent) {
    if (percent >= 70) return '#22c55e'; // verde
    if (percent >= 40) return '#f59e0b'; // amarillo
    return '#ef4444'; // rojo
  }

  function getRiskIcon(risk) {
    if (risk === 'low') return '✅';
    if (risk === 'medium') return '⚠️';
    return '❌';
  }

  function createWidget(data) {
    var w = document.createElement('div');
    w.id = 'sna-warmup-meter';
    w.style.cssText = 'background:linear-gradient(135deg,#1a1a2e,#16213e);border-radius:16px;padding:20px;margin:12px 0;color:#e0e0e0;font-family:system-ui,-apple-system,sans-serif;box-shadow:0 4px 20px rgba(0,0,0,0.3);';

    var percent = data.warmthPercent || 0;
    var color = getColor(percent);
    var canBroadcast = data.canBroadcast ? '✅ Difusiones habilitadas' : '⛔ Difusiones NO recomendadas';

    w.innerHTML = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">' +
      '<div style="display:flex;align-items:center;gap:10px">' +
        '<span style="font-size:24px">🔥</span>' +
        '<span style="font-size:16px;font-weight:700;color:#fff">Calentamiento del Número</span>' +
      '</div>' +
      '<span style="font-size:13px;color:#9ca3af">Día ' + (data.day || 0) + '/14</span>' +
    '</div>' +
    /* Barra de progreso */
    '<div style="background:#2d2d44;border-radius:12px;height:28px;overflow:hidden;position:relative;margin-bottom:12px">' +
      '<div style="background:linear-gradient(90deg,' + color + ',' + color + 'cc);height:100%;width:' + percent + '%;border-radius:12px;transition:width 1s ease;display:flex;align-items:center;justify-content:center">' +
        '<span style="font-weight:700;font-size:14px;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,0.5)">' + percent + '%</span>' +
      '</div>' +
    '</div>' +
    /* Stats grid */
    '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:12px">' +
      '<div style="background:#2d2d44;border-radius:10px;padding:10px;text-align:center">' +
        '<div style="font-size:11px;color:#9ca3af">Enviados hoy</div>' +
        '<div style="font-size:20px;font-weight:700;color:#fff">' + (data.dailySent || 0) + '</div>' +
        '<div style="font-size:10px;color:#6b7280">de ' + (data.dailyLimit || 800) + '</div>' +
      '</div>' +
      '<div style="background:#2d2d44;border-radius:10px;padding:10px;text-align:center">' +
        '<div style="font-size:11px;color:#9ca3af">Riesgo</div>' +
        '<div style="font-size:20px">' + getRiskIcon(data.risk) + '</div>' +
        '<div style="font-size:10px;color:#6b7280">' + (data.risk || 'N/A') + '</div>' +
      '</div>' +
      '<div style="background:#2d2d44;border-radius:10px;padding:10px;text-align:center">' +
        '<div style="font-size:11px;color:#9ca3af">Difusiones</div>' +
        '<div style="font-size:20px">' + (data.canBroadcast ? '✅' : '⛔') + '</div>' +
        '<div style="font-size:10px;color:#6b7280">' + (data.canBroadcast ? 'max ' + (data.maxBroadcast || 0) : 'Esperar') + '</div>' +
      '</div>' +
    '</div>' +
    /* Recomendacion */
    '<div style="background:#2d2d44;border-radius:10px;padding:10px;font-size:12px;color:#d1d5db;line-height:1.5">' +
      '<span style="color:#f59e0b;font-weight:600">💡 </span>' + (data.recommendation || 'Cargando...') +
    '</div>';

    return w;
  }

  function updateWidget(data) {
    var existing = document.getElementById('sna-warmup-meter');
    var newWidget = createWidget(data);
    if (existing) {
      existing.replaceWith(newWidget);
    } else {
      injectWidget(newWidget);
    }
  }

  function injectWidget(widget) {
    // Buscar el contenedor de Resumen — es el primer panel visible en la seccion principal
    var targets = document.querySelectorAll('.wbv5-content, [class*="dashboard"], [class*="summary"], [class*="resumen"]');
    var injected = false;

    // Strategy 1: buscar el h2/h3 que diga "Resumen" y poner debajo
    var headings = document.querySelectorAll('h1,h2,h3,h4,h5');
    for (var i = 0; i < headings.length; i++) {
      var txt = (headings[i].textContent || '').trim().toLowerCase();
      if (txt === 'resumen' || txt.includes('resumen') || txt.includes('dashboard')) {
        headings[i].parentNode.insertBefore(widget, headings[i].nextSibling);
        injected = true;
        break;
      }
    }

    // Strategy 2: inyectar al inicio del content area
    if (!injected) {
      var content = document.querySelector('.wbv5-content') || document.querySelector('[class*="content"]');
      if (content) {
        content.insertBefore(widget, content.firstChild);
        injected = true;
      }
    }

    // Strategy 3: append al body como overlay flotante
    if (!injected) {
      widget.style.cssText += 'position:fixed;bottom:20px;right:20px;z-index:9999;max-width:380px;';
      document.body.appendChild(widget);
    }
  }

  async function fetchWarmup() {
    try {
      var resp = await fetch(API_BASE + '/api/whatsapp/warmup-stats');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      warmupData = await resp.json();
      updateWidget(warmupData);
    } catch (e) {
      console.warn('[WarmupMeter] Error:', e.message);
      // Mostrar widget con datos por defecto
      updateWidget({ warmthPercent: 0, day: 0, risk: 'unknown', dailySent: 0, dailyLimit: 800, recommendation: 'No se pudo conectar al servidor. Verifica que el bot esté corriendo.', canBroadcast: false });
    }
  }

  // Detectar cuando se navega a Resumen y mostrar el widget
  function checkAndInject() {
    // Verificar si estamos en la seccion Resumen
    var sidebar = document.querySelectorAll('[class*="sidebar"] a, [class*="nav"] a, [class*="menu"] li');
    var isResumen = false;

    // Check URL o texto activo del sidebar
    var activeItems = document.querySelectorAll('[class*="active"], .selected, [aria-selected="true"]');
    for (var i = 0; i < activeItems.length; i++) {
      var t = (activeItems[i].textContent || '').trim().toLowerCase();
      if (t === 'resumen' || t.includes('panel') || t.includes('inicio')) {
        isResumen = true;
        break;
      }
    }

    // Tambien checkear si hay un heading de Resumen visible
    var headings = document.querySelectorAll('h1,h2,h3');
    for (var j = 0; j < headings.length; j++) {
      if ((headings[j].textContent || '').toLowerCase().includes('resumen')) {
        isResumen = true;
        break;
      }
    }

    if (isResumen && !document.getElementById('sna-warmup-meter')) {
      fetchWarmup();
    } else if (!isResumen) {
      var existing = document.getElementById('sna-warmup-meter');
      if (existing) existing.remove();
    }
  }

  // Observar cambios de navegacion
  var observer = new MutationObserver(function() {
    clearTimeout(window.__snaWarmupDebounce);
    window.__snaWarmupDebounce = setTimeout(checkAndInject, 500);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Initial check + polling
  setTimeout(checkAndInject, 2000);
  setInterval(function() {
    if (document.getElementById('sna-warmup-meter')) fetchWarmup();
  }, POLL_INTERVAL);

  console.log('[WarmupMeter] v1.0 cargado');
})();
