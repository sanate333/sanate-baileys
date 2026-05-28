/* Fix 103 — Chat Click Reliability + Date Separators + Sync (v1)
 * 1. Robust click handler: retry JID resolution with multiple fallbacks
 * 2. Date separators (Hoy / Ayer / date) between chat items
 * 3. Force sync refresh on sidebar Chats click
 */
(function fix103_chatFixes(){
  'use strict';
  if(window.__fix103_applied) return;
  window.__fix103_applied = true;
  if(window.location.pathname.indexOf('/dashboard/whatsapp-bot') !== 0) return;

  var API = 'https://sanate-wa-bot.onrender.com/api/whatsapp';

  /* ── CSS ── */
  var css = document.createElement('style');
  css.id = 'fix103-css';
  css.textContent = [
    '.fix103-date-sep { padding:6px 16px 4px; font-size:11px; font-weight:700; color:#10b981; text-transform:uppercase; letter-spacing:0.5px; background:#f0fdf4; border-bottom:1px solid #e5e7eb; user-select:none; }',
    /* Ensure chat items are always clickable */
    '.wbv5-conv-itm { cursor:pointer!important; position:relative!important; }',
    '.wbv5-conv-itm:active { background:#f3f4f6!important; }',
    /* Click feedback ripple */
    '.fix103-ripple { position:absolute; border-radius:50%; background:rgba(16,185,129,0.15); transform:scale(0); animation:fix103-ripple 0.4s ease-out forwards; pointer-events:none; z-index:5; }',
    '@keyframes fix103-ripple { to { transform:scale(2.5); opacity:0; } }',
  ].join('\n');
  document.head.appendChild(css);

  /* ── 1. Enhanced click handler with multi-fallback JID resolution ── */
  function patchClickHandler(){
    var inbox = document.querySelector('.wbv5-inbox-list') || document.querySelector('.wbv5-il-convs');
    if(!inbox || inbox.__fix103click) return;
    inbox.__fix103click = true;

    inbox.addEventListener('click', function(e){
      var item = e.target.closest('.wbv5-conv-itm');
      if(!item) return;

      // Visual feedback
      addRipple(item, e);

      // Desktop only for iframe handling
      if(window.innerWidth <= 900) return;

      // Try multiple JID sources
      var jid = resolveJid(item);

      if(jid && jid !== '__pending__'){
        window.__lastClickedJid = jid;
        window.__spUserPickedChat = true;
        if(window.__spHidePlaceholder) window.__spHidePlaceholder();
        setTimeout(function(){
          if(window.injectDesktopChatIframe) window.injectDesktopChatIframe();
        }, 50);
        return;
      }

      // If no JID found, set pending and try enhanced resolution
      window.__lastClickedJid = '__pending__';
      window.__spUserPickedChat = true;

      // Click the item in React's handler first
      enhancedResolve(item);
    }, true); // useCapture to run before Fix 47
  }

  function resolveJid(item){
    // Method 1: data attributes
    var jid = item.getAttribute('data-jid') || item.getAttribute('data-id') || '';
    if(jid && jid.indexOf('@') !== -1) return jid;

    // Method 2: phone number from name element
    var nameEl = item.querySelector('.wbv5-ci-name');
    if(nameEl){
      var raw = nameEl.textContent.replace(/⚡[^⚡]*/g,'').replace(/[^\d+\s\-()]/g,'').trim();
      var digits = raw.replace(/\D/g,'');
      if(digits.length >= 8 && digits.length <= 15) return digits + '@s.whatsapp.net';
    }

    // Method 3: phone in preview text (some items show phone as preview)
    var prevEl = item.querySelector('.wbv5-ci-prev');
    if(prevEl){
      var prevDigits = prevEl.textContent.replace(/\D/g,'');
      if(prevDigits.length >= 10 && prevDigits.length <= 15) return prevDigits + '@s.whatsapp.net';
    }

    // Method 4: stored in our cache from last API fetch
    var nameText = nameEl ? nameEl.textContent.replace(/⚡/g,'').trim() : '';
    if(nameText && window.__fix103_chatMap && window.__fix103_chatMap[nameText]){
      return window.__fix103_chatMap[nameText];
    }

    return null;
  }

  function enhancedResolve(item){
    // Watch for React to update the header with contact info
    var resolved = false;
    var tries = 0;
    function poll(){
      if(resolved) return;
      tries++;

      // Check header subtitle for phone number
      var sub = document.querySelector('.wbv5-cw-sub');
      if(sub){
        var digits = sub.textContent.replace(/[^0-9]/g,'');
        if(digits.length >= 8){
          resolved = true;
          var newJid = digits + '@s.whatsapp.net';
          window.__lastClickedJid = newJid;
          if(window.__spHidePlaceholder) window.__spHidePlaceholder();
          if(window.injectDesktopChatIframe) window.injectDesktopChatIframe();
          return;
        }
      }

      // Check header title for phone
      var title = document.querySelector('.wbv5-cw-name');
      if(title){
        var tDigits = title.textContent.replace(/[^0-9]/g,'');
        if(tDigits.length >= 8){
          resolved = true;
          var newJid2 = tDigits + '@s.whatsapp.net';
          window.__lastClickedJid = newJid2;
          if(window.__spHidePlaceholder) window.__spHidePlaceholder();
          if(window.injectDesktopChatIframe) window.injectDesktopChatIframe();
          return;
        }
      }

      if(tries < 40) setTimeout(poll, 50); // 40 x 50ms = 2s max
    }
    setTimeout(poll, 30);
  }

  function addRipple(item, e){
    var rect = item.getBoundingClientRect();
    var ripple = document.createElement('span');
    ripple.className = 'fix103-ripple';
    var size = Math.max(rect.width, rect.height);
    ripple.style.width = ripple.style.height = size + 'px';
    ripple.style.left = (e.clientX - rect.left - size/2) + 'px';
    ripple.style.top = (e.clientY - rect.top - size/2) + 'px';
    item.appendChild(ripple);
    setTimeout(function(){ ripple.remove(); }, 500);
  }

  /* ── 2. Date separators ── */
  function insertDateSeparators(){
    var convs = document.querySelector('.wbv5-il-convs');
    if(!convs) return;

    // Remove existing separators
    convs.querySelectorAll('.fix103-date-sep').forEach(function(s){ s.remove(); });

    var items = convs.querySelectorAll('.wbv5-conv-itm');
    if(!items.length) return;

    var now = new Date();
    var todayStr = now.toDateString();
    var yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    var yesterdayStr = yesterday.toDateString();

    var lastGroup = '';

    items.forEach(function(item){
      // Get timestamp from the time element
      var timeEl = item.querySelector('.wbv5-ci-time');
      if(!timeEl) return;

      var timeText = timeEl.textContent.trim();
      var itemDate = parseTimeText(timeText, now);
      var dateStr = itemDate ? itemDate.toDateString() : '';

      var group;
      if(dateStr === todayStr) group = 'Hoy';
      else if(dateStr === yesterdayStr) group = 'Ayer';
      else if(itemDate) {
        var opts = {weekday:'long', day:'numeric', month:'short'};
        group = itemDate.toLocaleDateString('es-ES', opts);
        group = group.charAt(0).toUpperCase() + group.slice(1);
      } else {
        group = '';
      }

      if(group && group !== lastGroup){
        lastGroup = group;
        var sep = document.createElement('div');
        sep.className = 'fix103-date-sep';
        sep.textContent = group;
        item.parentNode.insertBefore(sep, item);
      }
    });
  }

  function parseTimeText(text, now){
    // Formats: "12:30", "12:30 p. m.", "Ayer", "15/05/2026", "5/15/26"
    text = text.toLowerCase().trim();
    if(!text) return null;

    if(text === 'hoy' || text.match(/^\d{1,2}:\d{2}/)){
      // Today — time only
      return new Date(now.getFullYear(), now.getMonth(), now.getDate());
    }
    if(text === 'ayer'){
      var y = new Date(now);
      y.setDate(y.getDate() - 1);
      return new Date(y.getFullYear(), y.getMonth(), y.getDate());
    }
    // Try date parsing (dd/mm/yyyy or similar)
    var parts = text.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
    if(parts){
      var day = parseInt(parts[1]);
      var month = parseInt(parts[2]) - 1;
      var year = parseInt(parts[3]);
      if(year < 100) year += 2000;
      return new Date(year, month, day);
    }
    return null;
  }

  /* ── 3. Build chat name→JID map from API for fallback resolution ── */
  function buildChatMap(){
    fetch(API + '/chats')
      .then(function(r){ return r.json(); })
      .then(function(data){
        var chats = data.chats || data || [];
        if(!Array.isArray(chats)) return;
        window.__fix103_chatMap = {};
        chats.forEach(function(c){
          // Support both API formats: {jid,name} and {chat_jid,contact_name}
          var jid = c.jid || c.chat_jid || '';
          var name = c.name || c.contact_name || c.display_name || '';
          if(name && jid){
            window.__fix103_chatMap[name] = jid;
          }
          // Also map by phone number
          if(jid && jid.indexOf('@') !== -1){
            var phone = jid.split('@')[0];
            if(phone.length >= 8){
              window.__fix103_chatMap[phone] = jid;
              // Format with country code separator
              if(phone.length > 10){
                var formatted = '+' + phone.substring(0,2) + ' ' + phone.substring(2);
                window.__fix103_chatMap[formatted] = jid;
              }
            }
          }
        });
        console.log('[Fix103] Chat map built:', Object.keys(window.__fix103_chatMap).length, 'entries');
      })
      .catch(function(e){ console.warn('[Fix103] Chat map error:', e.message); });
  }

  /* ── Apply ── */
  function apply(){
    patchClickHandler();
    insertDateSeparators();
  }

  // Build chat map early
  buildChatMap();
  // Refresh chat map every 60s
  setInterval(buildChatMap, 60000);

  // Apply fixes
  setTimeout(apply, 500);
  setTimeout(apply, 1500);
  setTimeout(apply, 3000);

  // Re-apply on DOM changes (React re-renders)
  var debounce = null;
  new MutationObserver(function(){
    clearTimeout(debounce);
    debounce = setTimeout(function(){
      patchClickHandler();
      // Only re-insert separators if conversation list changed
      var convs = document.querySelector('.wbv5-il-convs');
      if(convs && convs.__fix103_lastCount !== convs.children.length){
        convs.__fix103_lastCount = convs.children.length;
        insertDateSeparators();
      }
    }, 300);
  }).observe(document.body, {childList:true, subtree:true});

  console.info('[WA-OASIS] Fix 103: Chat click + date separators + sync loaded');
})();date separators + sync loaded');
})();
