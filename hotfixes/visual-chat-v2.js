/* ══════════════════════════════════════════════════════════════════════
   SANATE VISUAL PATCH v2.0 — Chat UX Improvements
   - Ticks más grandes y colores correctos (gris=entregado, azul=leído)
   - "🤖 Respondiendo..." en sidebar cuando bot está generando respuesta
   - "✍️ Escribiendo..." en sidebar cuando el cliente está escribiendo
   ══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.__sanateVisualV2) return;
  window.__sanateVisualV2 = true;

  const BOT_SSE = 'https://sanate-wa-bot.onrender.com/api/whatsapp/events';

  /* ── 1. CSS GLOBAL ─────────────────────────────────────────────────── */
  const css = document.createElement('style');
  css.id = 'sanate-visual-v2-css';
  css.textContent = `
    /* === TICKS MÁS GRANDES === */
    /* SVG íconos de check estilo WhatsApp */
    svg[data-icon="msg-check"],
    svg[data-icon="msg-dblcheck"] {
      width: 20px !important;
      height: 20px !important;
      min-width: 20px !important;
    }
    /* SVGs genéricos con viewBox de ticks */
    .sanate-tick-svg {
      width: 19px !important;
      height: 19px !important;
      vertical-align: middle;
    }
    /* Texto tick (✓ ✓✓) dentro de spans */
    span.sanate-tick-text {
      font-size: 15px !important;
      font-weight: 600 !important;
      vertical-align: middle;
    }

    /* === COLORES DE TICK POR ESTADO === */
    /* Enviado (1 tick gris) */
    .sanate-status-sent svg path,
    .sanate-status-sent svg polyline,
    .sanate-status-sent svg line {
      stroke: #aaa !important;
    }
    /* Entregado (2 ticks grises) */
    .sanate-status-delivered svg path,
    .sanate-status-delivered svg polyline,
    .sanate-status-delivered svg line {
      stroke: #aaa !important;
    }
    /* Leído (2 ticks azules) */
    .sanate-status-read svg path,
    .sanate-status-read svg polyline,
    .sanate-status-read svg line {
      stroke: #53bdeb !important;
    }
    /* Ticks de texto */
    .sanate-status-sent .sanate-tick-text,
    .sanate-status-delivered .sanate-tick-text { color: #aaa !important; }
    .sanate-status-read .sanate-tick-text { color: #53bdeb !important; }

    /* === INDICADORES SIDEBAR === */
    .sanate-typing-label {
      display: block;
      font-size: 11.5px;
      margin-top: 2px;
      font-style: italic;
      line-height: 1.3;
      pointer-events: none;
    }
    .sanate-typing-respondiendo {
      color: #25d366 !important;
      animation: sanate-pulse 1.2s ease-in-out infinite;
    }
    .sanate-typing-escribiendo {
      color: #00bcd4 !important;
      animation: sanate-pulse 0.9s ease-in-out infinite;
    }
    @keyframes sanate-pulse {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0.45; }
    }
  `;
  document.head.appendChild(css);

  /* ── 2. ESTADO ─────────────────────────────────────────────────────── */
  const typingTimeouts = new Map();   // chatId -> timeoutId
  const botTypingChats = new Set();   // chatIds donde el bot está respondiendo
  const msgStatusMap   = new Map();   // messageId -> statusName

  /* ── 3. SSE ────────────────────────────────────────────────────────── */
  function conectarSSE() {
    try {
      const es = new EventSource(BOT_SSE);

      es.onmessage = (evt) => {
        try { manejarEvento(JSON.parse(evt.data)); } catch (e) {}
      };

      es.onerror = () => {
        es.close();
        setTimeout(conectarSSE, 6000);
      };

      console.log('[Sánate Visual v2] SSE conectado ✅');
    } catch (e) {
      console.warn('[Sánate Visual v2] SSE error:', e.message);
      setTimeout(conectarSSE, 8000);
    }
  }

  function manejarEvento(data) {
    if (!data || !data.type) return;

    /* Bot generando respuesta */
    if (data.type === 'bot_typing') {
      const { chatId, typing } = data.data || {};
      if (!chatId) return;
      if (typing) {
        botTypingChats.add(chatId);
        actualizarSidebar(chatId, 'respondiendo');
      } else {
        botTypingChats.delete(chatId);
        actualizarSidebar(chatId, null);
      }
    }

    /* Cliente escribiendo */
    if (data.type === 'presence') {
      const { id, presences } = data.data || {};
      const chatId = (id || '').split('@')[0];
      if (!chatId) return;
      const p = (presences || {})[id] || {};
      const estado = p.lastKnownPresence;

      if (estado === 'composing') {
        if (!botTypingChats.has(chatId)) actualizarSidebar(chatId, 'escribiendo');
        clearTimeout(typingTimeouts.get(chatId));
        typingTimeouts.set(chatId, setTimeout(() => {
          typingTimeouts.delete(chatId);
          if (!botTypingChats.has(chatId)) actualizarSidebar(chatId, null);
        }, 6000));
      } else {
        clearTimeout(typingTimeouts.get(chatId));
        typingTimeouts.delete(chatId);
        if (!botTypingChats.has(chatId)) actualizarSidebar(chatId, null);
      }
    }

    /* Estado de mensaje → actualizar tick */
    if (data.type === 'message_status') {
      const d = data.data || {};
      if (d.fromMe && d.messageId && d.statusName) {
        msgStatusMap.set(d.messageId, d.statusName);
        aplicarTickEnDOM(d.messageId, d.statusName);
      }
    }
  }

  /* ── 4. SIDEBAR ────────────────────────────────────────────────────── */
  /* Estrategia: buscar por número de teléfono en el texto del item o en data-attrs */
  function actualizarSidebar(chatId, estado) {
    const digits = chatId.replace(/\D/g, '').slice(-9); // últimos 9 dígitos
    if (!digits) return;

    let found = false;

    /* Selectores comunes de frameworks de chat */
    const candidatos = document.querySelectorAll(
      '[class*="chat-item"], [class*="conversation-item"], [class*="contact-item"], ' +
      '[class*="ChatItem"], [class*="ConversationItem"], [class*="chat-row"], ' +
      '[class*="chat_item"], [class*="list-item"]'
    );

    candidatos.forEach(el => {
      const txt = (el.innerText || el.textContent || '').replace(/\D/g, '');
      if (txt.includes(digits)) {
        setEtiqueta(el, estado);
        found = true;
      }
    });

    /* Fallback: data attributes */
    if (!found) {
      const attrs = [
        `[data-chat-id*="${chatId}"]`, `[data-jid*="${chatId}"]`,
        `[data-phone*="${chatId}"]`,   `[data-id*="${chatId}"]`
      ];
      attrs.forEach(sel => {
        const el = document.querySelector(sel);
        if (el) { setEtiqueta(el, estado); found = true; }
      });
    }
  }

  function setEtiqueta(item, estado) {
    let etiqueta = item.querySelector('.sanate-typing-label');

    if (!estado) {
      if (etiqueta) etiqueta.remove();
      return;
    }

    if (!etiqueta) {
      etiqueta = document.createElement('span');
      etiqueta.className = 'sanate-typing-label';
      /* Insertar bajo el nombre del contacto */
      const nombre = item.querySelector(
        '[class*="name"], [class*="title"], [class*="Name"], [class*="Title"], strong, b'
      ) || item.firstElementChild;
      if (nombre && nombre.parentNode) {
        nombre.parentNode.insertBefore(etiqueta, nombre.nextSibling);
      } else {
        item.appendChild(etiqueta);
      }
    }

    etiqueta.className = 'sanate-typing-label ' +
      (estado === 'respondiendo' ? 'sanate-typing-respondiendo' : 'sanate-typing-escribiendo');
    etiqueta.textContent =
      estado === 'respondiendo' ? '🤖 Respondiendo...' : '✍️ Escribiendo...';
  }

  /* ── 5. TICKS ──────────────────────────────────────────────────────── */
  function aplicarTickEnDOM(messageId, statusName) {
    const sel = [
      `[data-message-id="${messageId}"]`,
      `[data-id="${messageId}"]`,
      `[id="${messageId}"]`,
      `[data-key="${messageId}"]`
    ].join(', ');
    const el = document.querySelector(sel);
    if (el) aplicarClaseTick(el, statusName);
  }

  function aplicarClaseTick(el, statusName) {
    el.classList.remove(
      'sanate-status-sent', 'sanate-status-delivered',
      'sanate-status-read', 'sanate-status-pending', 'sanate-status-error'
    );
    const map = {
      sent: 'sanate-status-sent', delivered: 'sanate-status-delivered',
      read: 'sanate-status-read', played: 'sanate-status-read',
      pending: 'sanate-status-pending', error: 'sanate-status-error'
    };
    if (map[statusName]) el.classList.add(map[statusName]);
  }

  /* Reaplicar estados cuando el DOM cambia (re-renders de React) */
  function reescanearTicks() {
    /* Reaplicar estados conocidos */
    msgStatusMap.forEach((statusName, messageId) => {
      aplicarTickEnDOM(messageId, statusName);
    });

    /* Agrandar SVGs de tick por viewBox típico de WhatsApp */
    document.querySelectorAll('svg').forEach(svg => {
      const vb = svg.getAttribute('viewBox') || '';
      if (vb === '0 0 16 15' || vb === '0 0 18 18' || vb === '0 0 18 15') {
        svg.classList.add('sanate-tick-svg');
      }
    });

    /* Marcar spans que contienen ✓ o ✓✓ */
    document.querySelectorAll('span, i, em').forEach(span => {
      const t = span.textContent || '';
      if ((t === '✓' || t === '✓✓' || t === '✔' || t === '✔✔') && !span.classList.contains('sanate-tick-text')) {
        span.classList.add('sanate-tick-text');
      }
    });
  }

  let scanTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(reescanearTicks, 250);
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: false });

  /* ── INIT ──────────────────────────────────────────────────────────── */
  setTimeout(() => {
    conectarSSE();
    reescanearTicks();
  }, 1500);

})();
