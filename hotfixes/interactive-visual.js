/* ══════════════════════════════════════════════════════════════════════
   SANATE INTERACTIVE MESSAGE VISUAL v2.0
   Renders interactive buttons in chat messages.
   FIXED: Only processes within chat area, no global DOM queries.
   v1 BUG: querySelectorAll('span, div, p') on whole page = freeze
   ══════════════════════════════════════════════════════════════════════ */
(function() {
  'use strict';
  if (window.__sanateInteractiveVisual) return;
  window.__sanateInteractiveVisual = true;

  var css = document.createElement('style');
  css.id = 'sanate-interactive-css';
  css.textContent = [
    '.sn-interactive-card{margin-top:6px;border-top:1px solid rgba(0,0,0,0.08);padding-top:6px}',
    '.sn-interactive-label{font-size:10px;color:#667781;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;display:flex;align-items:center;gap:4px}',
    '.sn-interactive-label svg{width:12px;height:12px;fill:#667781}',
    '.sn-btn-row{display:flex;flex-direction:column;gap:4px}',
    '.sn-btn{display:flex;align-items:center;justify-content:center;gap:6px;padding:7px 12px;border-radius:8px;font-size:13px;font-weight:500;cursor:default;transition:background .15s;text-align:center}',
    '.sn-btn-quick{background:rgba(0,168,132,.08);color:#00a884;border:1px solid rgba(0,168,132,.2)}',
    '.sn-btn-url{background:rgba(0,122,255,.08);color:#007aff;border:1px solid rgba(0,122,255,.2)}',
    '.sn-btn-call{background:rgba(52,199,89,.08);color:#34c759;border:1px solid rgba(52,199,89,.2)}',
    '.sn-btn-copy{background:rgba(255,149,0,.08);color:#ff9500;border:1px solid rgba(255,149,0,.2)}',
    '.sn-btn-list{background:rgba(88,86,214,.08);color:#5856d6;border:1px solid rgba(88,86,214,.2)}',
    '.sn-btn-icon{width:14px;height:14px;flex-shrink:0}',
    '.sn-list-section{margin-top:4px}',
    '.sn-list-title{font-size:11px;font-weight:600;color:#5856d6;margin-bottom:2px;padding-left:4px}',
    '.sn-list-row{display:flex;flex-direction:column;padding:4px 8px;border-radius:6px;background:rgba(88,86,214,.04);margin-bottom:2px}',
    '.sn-list-row-title{font-size:12px;font-weight:500;color:#1a1a1a}',
    '.sn-list-row-desc{font-size:10px;color:#667781}'
  ].join('\n');
  document.head.appendChild(css);

  var ICONS = {
    quick:'<svg class="sn-btn-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>',
    url:'<svg class="sn-btn-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>',
    call:'<svg class="sn-btn-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg>',
    copy:'<svg class="sn-btn-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>',
    list:'<svg class="sn-btn-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z"/></svg>',
    interactive:'<svg viewBox="0 0 24 24"><path fill="currentColor" d="M21 6h-2v9H6v2c0 .55.45 1 1 1h11l4 4V7c0-.55-.45-1-1-1zm-4 6V3c0-.55-.45-1-1-1H3c-.55 0-1 .45-1 1v14l4-4h10c.55 0 1-.45 1-1z"/></svg>'
  };

  function escHtml(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  function parseButtons(text) {
    if (!text) return null;
    var sep = text.indexOf('---BUTTONS---');
    if (sep === -1) return null;
    try { return JSON.parse(text.substring(sep + 13).trim()); } catch(e) { return null; }
  }
  function getCleanText(text) {
    if (!text) return '';
    var sep = text.indexOf('---BUTTONS---');
    if (sep > -1) text = text.substring(0, sep).trim();
    return text.replace(/^\[interactive\]\s*/i, '');
  }
  function renderButtonsHTML(buttons) {
    if (!buttons || !buttons.length) return '';
    var html = '<div class="sn-interactive-card"><div class="sn-interactive-label">' + ICONS.interactive + ' Mensaje interactivo</div><div class="sn-btn-row">';
    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i];
      var params = {}; try { params = JSON.parse(btn.buttonParamsJson || '{}'); } catch(e) {}
      var name = btn.name || 'quick_reply';
      if (name === 'single_select') {
        var sections = params.sections || [];
        html += '<div class="sn-btn sn-btn-list">' + ICONS.list + ' ' + escHtml(params.title || 'Menu') + '</div>';
        for (var s = 0; s < sections.length; s++) {
          html += '<div class="sn-list-section">';
          if (sections[s].title) html += '<div class="sn-list-title">' + escHtml(sections[s].title) + '</div>';
          var rows = sections[s].rows || [];
          for (var r = 0; r < rows.length; r++) {
            html += '<div class="sn-list-row"><span class="sn-list-row-title">' + escHtml(rows[r].title || '') + '</span>';
            if (rows[r].description) html += '<span class="sn-list-row-desc">' + escHtml(rows[r].description) + '</span>';
            html += '</div>';
          }
          html += '</div>';
        }
      } else if (name === 'cta_url') { html += '<div class="sn-btn sn-btn-url">' + ICONS.url + ' ' + escHtml(params.display_text || 'Link') + '</div>';
      } else if (name === 'cta_call') { html += '<div class="sn-btn sn-btn-call">' + ICONS.call + ' ' + escHtml(params.display_text || 'Llamar') + '</div>';
      } else if (name === 'cta_copy') { html += '<div class="sn-btn sn-btn-copy">' + ICONS.copy + ' ' + escHtml(params.display_text || 'Copiar') + '</div>';
      } else { html += '<div class="sn-btn sn-btn-quick">' + ICONS.quick + ' ' + escHtml(params.display_text || btn.text || 'Opcion') + '</div>'; }
    }
    html += '</div></div>';
    return html;
  }

  /* ── Process ONLY within chat containers — NEVER global DOM ── */
  var processed = new WeakSet();
  function processMessages() {
    var chatArea = document.querySelector('.wbv5-cw-msgs, [class*="chat-messages"], [class*="message-list"], [class*="ChatMessages"]');
    if (!chatArea) return;
    var textEls = chatArea.querySelectorAll('.wbv5-msg-body, .wbv5-msg-text, [class*="messageContent"], [class*="msg-text"], [class*="message-text"]');
    if (textEls.length === 0) return;
    for (var i = 0; i < textEls.length; i++) {
      var el = textEls[i];
      if (processed.has(el)) continue;
      var text = el.textContent || '';
      if (text.indexOf('[interactive]') === -1 && text.indexOf('---BUTTONS---') === -1) continue;
      processed.add(el);
      var buttons = parseButtons(text);
      var cleanText = getCleanText(text);
      if (buttons && buttons.length > 0) {
        el.innerHTML = escHtml(cleanText) + renderButtonsHTML(buttons);
      } else if (text.indexOf('[interactive]') !== -1) {
        el.innerHTML = escHtml(cleanText) +
          '<div class="sn-interactive-card"><div class="sn-interactive-label">' + ICONS.interactive + ' Mensaje interactivo enviado</div></div>';
      }
    }
  }

  /* ── Observer scoped to chat area, NOT document.body ── */
  var observer = null;
  function startObserving() {
    var chatArea = document.querySelector('.wbv5-cw-msgs, [class*="chat-messages"], [class*="message-list"]');
    if (chatArea && !observer) {
      observer = new MutationObserver(function() {
        clearTimeout(window._snInteractiveTimer);
        window._snInteractiveTimer = setTimeout(processMessages, 500);
      });
      observer.observe(chatArea, { childList: true, subtree: true });
    }
  }

  function init() {
    setInterval(function() {
      processMessages();
      if (!observer) startObserving();
    }, 5000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { setTimeout(init, 2000); });
  } else {
    setTimeout(init, 2000);
  }

  console.log('[Sanate Interactive Visual v2.0] Loaded — scoped to chat area only');
})();
