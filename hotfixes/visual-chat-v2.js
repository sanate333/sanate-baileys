/* ══════════════════════════════════════════════════════════════════════
   SANATE VISUAL PATCH v2.1 — Chat UX Improvements
   - Ticks más grandes y colores correctos (gris=entregado, azul=leído)
   - "🤖 Respondiendo..." en sidebar cuando bot está generando respuesta
   - "✍️ Escribiendo..." en sidebar cuando el cliente está escribiendo
   ══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.__sanateVisualV2 && window.__sanateVisualV2version === '2.1') return;
  window.__sanateVisualV2 = true;
  window.__sanateVisualV2version = '2.1';

  const BOT_SSE = 'https://sanate-wa-bot.onrender.com/api/whatsapp/events';

  /* ── 1. CSS GLOBAL ─────────────────────────────────────────────────── */
  const css = document.createElement('style');
  css.id = 'sanate-visual-v2-css';
  css.textContent = `
    /* === TICKS MÁS GRANDES === */
    svg[data-icon="msg-check"],
    svg[data-icon="msg-dblcheck"] {
      width: 20px !important;
      height: 20px !important;
      min-width: 20px !important;
    }
    .sanate-tick-svg {
      width: 19px !important;
      height: 19px !important;
      vertical-align: middle;
    }
    span.sanate-tick-text {
      font-size: 15px !important;
      font-weight: 600 !important;
      vertical-align: middle;
    }
    /* Ticks específicos del dashboard wbv5 */
    .wbv5-msg-time span {
      font-size: 14px !important;
      font-weight: 600 !important;
    }

    /* === COLORES DE TICK POR ESTADO === */
    .sanate-status-sent svg path,
    .sanate-status-sent svg polyline,
    .sanate-status-sent svg line { stroke: #aaa !important; }
    .sanate-status-delivered svg path,
    .sanate-status-delivered svg polyline,
    .sanate-status-delivered svg line { stroke: #aaa !important; }
    .sanate-status-read svg path,
    .sanate-status-read svg polyline,
    .sanate-status-read svg line { stroke: #53bdeb !important; }
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
  const typingTimeouts = new Map();
  const botTypingChats = new Set();
  const msgStatusMap   = new Map();

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

    if (data.type === 'message_status') {
      const d = data.data || {};
      if (d.fromMe && d.messageId && d.statusName) {
        msgStatusMap.set(d.messageId, d.statusName);
        aplicarTickEnDOM(d.messageId, d.statusName);
      }
    }
  }

  /* ── 4. SIDEBAR ────────────────────────────────────────────────────── */
  function actualizarSidebar(chatId, estado) {
    const digits = chatId.replace(/\D/g, '').slice(-9);
    if (!digits) return;
    let found = false;

    /* Selector específico wbv5 + genéricos */
    const candidatos = document.querySelectorAll(
      '.wbv5-conv-itm, ' +
      '[class*="chat-item"], [class*="conversation-item"], [class*="contact-item"], ' +
      '[class*="ChatItem"], [class*="ConversationItem"], [class*="chat-row"], ' +
      '[class*="chat_item"], [class*="list-item"]'
    );

    /* Solo el PRIMER item que coincida */
    for (const el of candidatos) {
      const txt = (el.innerText || el.textContent || '').replace(/\D/g, '');
      if (txt.includes(digits)) {
        setEtiqueta(el, estado);
        found = true;
        break;
      }
    }

    if (!found) {
      const attrs = [
        `[data-chat-id*="${chatId}"]`, `[data-jid*="${chatId}"]`,
        `[data-phone*="${chatId}"]`,   `[data-id*="${chatId}"]`
      ];
      for (const sel of attrs) {
        const el = document.querySelector(sel);
        if (el) { setEtiqueta(el, estado); found = true; break; }
      }
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
      /* wbv5: insertar antes del preview */
      const prevEl = item.querySelector('.wbv5-ci-prev, [class*="preview"], [class*="prev"], [class*="last-msg"]');
      const nombre = item.querySelector(
        '[class*="name"], [class*="title"], [class*="Name"], [class*="Title"], strong, b'
      ) || item.firstElementChild;
      if (prevEl && prevEl.parentNode) {
        prevEl.parentNode.insertBefore(etiqueta, prevEl);
      } else if (nombre && nombre.parentNode) {
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
    el.classList.remove('sanate-status-sent','sanate-status-delivered','sanate-status-read','sanate-status-pending','sanate-status-error');
    const map = {
      sent:'sanate-status-sent', delivered:'sanate-status-delivered',
      read:'sanate-status-read', played:'sanate-status-read',
      pending:'sanate-status-pending', error:'sanate-status-error'
    };
    if (map[statusName]) el.classList.add(map[statusName]);
  }

  function reescanearTicks() {
    msgStatusMap.forEach((statusName, messageId) => {
      aplicarTickEnDOM(messageId, statusName);
    });
    document.querySelectorAll('svg').forEach(svg => {
      const vb = svg.getAttribute('viewBox') || '';
      if (vb === '0 0 16 15' || vb === '0 0 18 18' || vb === '0 0 18 15') {
        svg.classList.add('sanate-tick-svg');
      }
    });
    /* Marcar spans con ✓ o ✓✓ (con posible espacio alrededor) */
    document.querySelectorAll('span, i, em').forEach(span => {
      const t = (span.textContent || '').trim();
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
