/* ══════════════════════════════════════════════════════════════════════
   SANATE VISUAL PATCH v2.3
   - Ticks más grandes y colores correctos (gris=entregado, azul=leído)
   - "🤖 Respondiendo..." en sidebar cuando bot está generando respuesta
   - "✍️ Escribiendo..." en sidebar cuando el cliente está escribiendo
   FIX v2.3:
   - ✍️ Escribiendo: timeout reducido 6s→3s + limpieza al salir del chat
   - ✓✓ azul: no re-aplicar estado "leído" a mensajes nuevos sin confirmar
   ══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.__sanateVisualV2 && window.__sanateVisualV2version === '2.3') return;
  // Eliminar versión anterior si existe
  if (window.__sanateVisualV2) {
    var oldCss = document.getElementById('sanate-visual-v2-css');
    if (oldCss) oldCss.remove();
  }
  window.__sanateVisualV2 = true;
  window.__sanateVisualV2version = '2.3';

  const BOT_SSE = 'https://sanate-wa-bot.onrender.com/api/whatsapp/events';

  /* ── 1. CSS GLOBAL ─────────────────────────────────────────────────── */
  const css = document.createElement('style');
  css.id = 'sanate-visual-v2-css';
  css.textContent = `
    svg[data-icon="msg-check"],
    svg[data-icon="msg-dblcheck"] {
      width: 20px !important; height: 20px !important; min-width: 20px !important;
    }
    .sanate-tick-svg { width: 19px !important; height: 19px !important; vertical-align: middle; }
    span.sanate-tick-text { font-size: 15px !important; font-weight: 600 !important; vertical-align: middle; }
    .wbv5-msg-time span { font-size: 14px !important; font-weight: 600 !important; }
    .sanate-status-sent svg path, .sanate-status-sent svg polyline, .sanate-status-sent svg line { stroke: #aaa !important; }
    .sanate-status-delivered svg path, .sanate-status-delivered svg polyline, .sanate-status-delivered svg line { stroke: #aaa !important; }
    .sanate-status-read svg path, .sanate-status-read svg polyline, .sanate-status-read svg line { stroke: #53bdeb !important; }
    .sanate-status-sent .sanate-tick-text, .sanate-status-delivered .sanate-tick-text { color: #aaa !important; }
    .sanate-status-read .sanate-tick-text { color: #53bdeb !important; }
    .sanate-typing-label {
      display: block; font-size: 11.5px; margin-top: 2px;
      font-style: italic; line-height: 1.3; pointer-events: none;
    }
    .sanate-typing-respondiendo { color: #25d366 !important; animation: sanate-pulse 1.2s ease-in-out infinite; }
    .sanate-typing-escribiendo { color: #00bcd4 !important; animation: sanate-pulse 0.9s ease-in-out infinite; }
    @keyframes sanate-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
  `;
  document.head.appendChild(css);

  /* ── 2. ESTADO ─────────────────────────────────────────────────────── */
  const typingTimeouts = new Map();
  const botTypingChats = new Set();
  const msgStatusMap   = new Map();   // messageId → statusName
  const chatStatusMap  = new Map();   // chatId → statusName
  // FIX v2.3: rastrear chats con mensajes nuevos sin confirmación de lectura
  const chatHasNewMsg  = new Set();   // chatIds con mensajes recién enviados

  /* ── 3. SSE ────────────────────────────────────────────────────────── */
  function conectarSSE() {
    try {
      const es = new EventSource(BOT_SSE);
      es.onmessage = (evt) => {
        try { manejarEvento(JSON.parse(evt.data)); } catch (e) {}
      };
      es.onerror = () => { es.close(); setTimeout(conectarSSE, 6000); };
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
      if (typing) { botTypingChats.add(chatId); actualizarSidebar(chatId, 'respondiendo'); }
      else { botTypingChats.delete(chatId); actualizarSidebar(chatId, null); }
    }

    if (data.type === 'presence') {
      const { id, presences } = data.data || {};
      const chatId = (id || '').split('@')[0];
      if (!chatId) return;
      // Solo procesar presencia del contacto remoto (clave = id del chat)
      const p = (presences || {})[id] || {};
      const estado = p.lastKnownPresence;
      if (estado === 'composing' || estado === 'recording') {
        // FIX v2.3: solo mostrar si no es nuestro propio número
        if (!botTypingChats.has(chatId)) actualizarSidebar(chatId, 'escribiendo');
        clearTimeout(typingTimeouts.get(chatId));
        // FIX v2.3: timeout reducido de 6000ms a 3000ms
        typingTimeouts.set(chatId, setTimeout(() => {
          typingTimeouts.delete(chatId);
          if (!botTypingChats.has(chatId)) actualizarSidebar(chatId, null);
        }, 3000));
      } else {
        // paused / available / unavailable → limpiar inmediatamente
        clearTimeout(typingTimeouts.get(chatId));
        typingTimeouts.delete(chatId);
        if (!botTypingChats.has(chatId)) actualizarSidebar(chatId, null);
      }
    }

    if (data.type === 'message_status') {
      const d = data.data || {};
      if (d.fromMe && d.messageId && d.statusName) {
        msgStatusMap.set(d.messageId, d.statusName);
        if (d.chatId) {
          // Solo avanzar de estado (sent→delivered→read, nunca retroceder)
          const order = { pending:0, sent:1, delivered:2, read:3, played:3 };
          const prev = chatStatusMap.get(d.chatId);
          if ((order[d.statusName] || 0) > (order[prev] || 0)) {
            chatStatusMap.set(d.chatId, d.statusName);
            // FIX v2.3: cuando llega confirmación real, quitar la marca de "mensaje nuevo"
            if (d.statusName === 'read' || d.statusName === 'played' || d.statusName === 'delivered') {
              chatHasNewMsg.delete(d.chatId);
            }
            actualizarTicksChat(d.chatId, d.statusName);
          }
        }
      }
    }
  }

  /* ── TICKS DEL CHAT ABIERTO ────────────────────────────────────────── */
  function actualizarTicksChat(chatId, statusName) {
    const nameEl = document.querySelector('.wbv5-cw-name');
    if (!nameEl) return;
    const openDigits = (nameEl.textContent || '').replace(/\D/g, '').slice(-9);
    const chatDigits = String(chatId).replace(/\D/g, '').slice(-9);
    if (!openDigits || openDigits !== chatDigits) return;

    document.querySelectorAll('.wbv5-msg.s .wbv5-msg-time span').forEach(span => {
      if (statusName === 'read' || statusName === 'played') {
        span.textContent = ' ✓✓';
        span.style.setProperty('color', '#53bdeb', 'important');
      } else if (statusName === 'delivered') {
        span.textContent = ' ✓✓';
        span.style.setProperty('color', '#aaa', 'important');
      }
      span.style.setProperty('font-size', '14px', 'important');
      span.style.setProperty('font-weight', '600', 'important');
    });
    console.log('[Sánate Visual v2] Ticks →', statusName, 'en chat', chatDigits);
  }

  /* ── 4. SIDEBAR ────────────────────────────────────────────────────── */
  function actualizarSidebar(chatId, estado) {
    const digits = chatId.replace(/\D/g, '').slice(-9);
    if (!digits) return;
    let found = false;
    const candidatos = document.querySelectorAll(
      '.wbv5-conv-itm, [class*="chat-item"], [class*="conversation-item"], [class*="contact-item"], ' +
      '[class*="ChatItem"], [class*="ConversationItem"], [class*="chat-row"], [class*="chat_item"], [class*="list-item"]'
    );
    for (const el of candidatos) {
      if ((el.innerText || el.textContent || '').replace(/\D/g, '').includes(digits)) {
        setEtiqueta(el, estado); found = true; break;
      }
    }
    if (!found) {
      for (const sel of [`[data-chat-id*="${chatId}"]`, `[data-jid*="${chatId}"]`, `[data-phone*="${chatId}"]`, `[data-id*="${chatId}"]`]) {
        const el = document.querySelector(sel);
        if (el) { setEtiqueta(el, estado); break; }
      }
    }
  }

  function setEtiqueta(item, estado) {
    let etiqueta = item.querySelector('.sanate-typing-label');
    if (!estado) { if (etiqueta) etiqueta.remove(); return; }
    if (!etiqueta) {
      etiqueta = document.createElement('span');
      etiqueta.className = 'sanate-typing-label';
      const prevEl = item.querySelector('.wbv5-ci-prev, [class*="preview"], [class*="prev"], [class*="last-msg"]');
      const nombre = item.querySelector('[class*="name"], [class*="title"], strong, b') || item.firstElementChild;
      if (prevEl && prevEl.parentNode) { prevEl.parentNode.insertBefore(etiqueta, prevEl); }
      else if (nombre && nombre.parentNode) { nombre.parentNode.insertBefore(etiqueta, nombre.nextSibling); }
      else { item.appendChild(etiqueta); }
    }
    etiqueta.className = 'sanate-typing-label ' + (estado === 'respondiendo' ? 'sanate-typing-respondiendo' : 'sanate-typing-escribiendo');
    etiqueta.textContent = estado === 'respondiendo' ? '🤖 Respondiendo...' : '✍️ Escribiendo...';
  }

  /* ── 5. TICKS POR ID (cuando hay data attributes) ──────────────────── */
  function aplicarTickEnDOM(messageId, statusName) {
    const el = document.querySelector(`[data-message-id="${messageId}"], [data-id="${messageId}"], [id="${messageId}"], [data-key="${messageId}"]`);
    if (el) aplicarClaseTick(el, statusName);
  }
  function aplicarClaseTick(el, statusName) {
    el.classList.remove('sanate-status-sent','sanate-status-delivered','sanate-status-read','sanate-status-pending','sanate-status-error');
    const map = { sent:'sanate-status-sent', delivered:'sanate-status-delivered', read:'sanate-status-read', played:'sanate-status-read', pending:'sanate-status-pending', error:'sanate-status-error' };
    if (map[statusName]) el.classList.add(map[statusName]);
  }

  /* ── 6. RESCANEAR TICKS ────────────────────────────────────────────── */
  function reescanearTicks() {
    msgStatusMap.forEach((statusName, messageId) => aplicarTickEnDOM(messageId, statusName));
    document.querySelectorAll('svg').forEach(svg => {
      const vb = svg.getAttribute('viewBox') || '';
      if (vb === '0 0 16 15' || vb === '0 0 18 18' || vb === '0 0 18 15') svg.classList.add('sanate-tick-svg');
    });
    /* Agrandar ticks wbv5 directamente */
    document.querySelectorAll('.wbv5-msg-time span').forEach(span => {
      span.style.setProperty('font-size', '14px', 'important');
      span.style.setProperty('font-weight', '600', 'important');
    });
    document.querySelectorAll('span, i, em').forEach(span => {
      const t = (span.textContent || '').trim();
      if ((t === '✓' || t === '✓✓' || t === '✔' || t === '✔✔') && !span.classList.contains('sanate-tick-text')) {
        span.classList.add('sanate-tick-text');
      }
    });
    /* FIX v2.3: Re-aplicar status del chat abierto SOLO si no hay mensajes
       sin confirmación (tick simple ✓) que podrían colorearse incorrectamente */
    const nameEl = document.querySelector('.wbv5-cw-name');
    if (nameEl) {
      const openD = (nameEl.textContent || '').replace(/\D/g, '').slice(-9);
      for (const [cId, sName] of chatStatusMap) {
        if (String(cId).replace(/\D/g,'').slice(-9) === openD) {
          // FIX: no re-aplicar "read" si hay mensajes nuevos sin confirmar
          if (chatHasNewMsg.has(cId)) break;
          // FIX: no re-aplicar si hay ticks simples ✓ (mensaje reciên enviado)
          const hasSingleTick = [...document.querySelectorAll('.wbv5-msg.s .wbv5-msg-time span')]
            .some(s => (s.textContent || '').trim() === '✓');
          if (!hasSingleTick) {
            actualizarTicksChat(cId, sName);
          }
          break;
        }
      }
    }
  }

  /* FIX v2.3: Detectar nuevos mensajes salientes para evitar ticks azules falsos */
  function detectarMensajeNuevo(mutations) {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;
        // Buscar el mensaje saliente recién añadido
        const esMsgSaliente = node.classList && node.classList.contains('wbv5-msg') && node.classList.contains('s');
        const contieneMsgSaliente = !esMsgSaliente && node.querySelector && node.querySelector('.wbv5-msg.s');
        if (esMsgSaliente || contieneMsgSaliente) {
          // Obtener chat actual y marcarlo como "tiene mensaje nuevo"
          const nameEl = document.querySelector('.wbv5-cw-name');
          if (nameEl) {
            const openD = (nameEl.textContent || '').replace(/\D/g, '').slice(-9);
            for (const [cId] of chatStatusMap) {
              if (String(cId).replace(/\D/g,'').slice(-9) === openD) {
                chatHasNewMsg.add(cId);
                // Resetear estado: el nuevo mensaje empieza como "sent"
                chatStatusMap.set(cId, 'sent');
                console.log('[Sánate Visual v2] Nuevo mensaje → reset estado chat', openD);
                break;
              }
            }
          }
          break;
        }
      }
    }
  }

  let scanTimer = null;
  const observer = new MutationObserver((mutations) => {
    detectarMensajeNuevo(mutations);
    clearTimeout(scanTimer);
    scanTimer = setTimeout(reescanearTicks, 250);
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: false });

  /* ── INIT ──────────────────────────────────────────────────────────── */
  setTimeout(() => { conectarSSE(); reescanearTicks(); }, 1500);

})();
