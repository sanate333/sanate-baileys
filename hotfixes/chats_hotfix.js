/* WhatsApp Oasis — Chats hotfix CLEAN v6.0
 * Consolidated from v5.4 (5542 lines → ~2800 lines)
 * Removed all DISABLED fixes (19,20,22,23,25,26,27,28,28b,29,30,31,32,41)
 * Removed dead Fix 2+3 sorter code (superseded by Fix 50)
 * Active fixes preserved exactly as-is.
 *
 * Structure:
 *   1. Main IIFE: CSS + Fix 5,9,10,11,12,1,6,7,8
 *   2. Fix 13: Hide APPS CHAT
 *   3. Fix 15: Always show chat.html (defers to Fix 47)
 *   4. Fix 16: Visual separator sidebar/inbox
 *   5. Fix 17+17b: Grid swap columns (desktop media query)
 *   6. Fix 18: Mobile restore
 *   7. Fix 24b: no-white-box CSS
 *   8. Fix 33+34: Arrow/back button hidden desktop
 *   9. Fix 35-39: Hamburger, search, panel, sort stability
 *  10. Fix 42: Plantillas anti-flash
 *  11. Fix 44: Disparadores dropdown
 *  12. Fix 45+46: Chat panel CSS restoration
 *  13. Fix 47: Click handler maestro (CRITICAL)
 *  14. Fix 48: Difusiones panel
 *  15. Fix 50: Sort + placeholder + mobile + IA badge (CRITICAL)
 *  16. Fix 51: Name sync + dedup + name cache (CRITICAL)
 *  17. Fix 101: Reset on sidebar Chats click
 */

/* ═══════════════════════════════════════════════════════
   MAIN IIFE — CSS + Fix 1,5,6,7,8,9,10,11,12
   ═══════════════════════════════════════════════════════ */
(function(){
  'use strict';
  try {
    if(window.location.pathname.indexOf('/dashboard/whatsapp-bot')!==0) return;
    if(window.__spChatsV53) return;
    window.__spChatsV53 = true;

    /* ── CSS ───────────────────────────────────────────────────────── */
    (function injectCss(){
      if(document.getElementById('waoasis-chats-css-v53')) return;
      var s = document.createElement('style');
      s.id = 'waoasis-chats-css-v53';
      s.textContent = [

        /* Grid layout: chat-win col-1 (center), inbox-list col-2 (right) */
        '@media (min-width:901px){',
        '  .wbv5-chat-wrap{',
        '    display:grid!important;',
        '    grid-template-columns:1fr 360px!important;',
        '    grid-template-rows:1fr!important;',
        '  }',
        '  .wbv5-inbox-list{',
        '    grid-column:1!important;grid-row:1!important;',
        '    min-width:0!important;max-width:none!important;',
        '    overflow:hidden!important;',
        '    display:flex!important;flex-direction:column!important;',
        '  }',
        '  .wbv5-chat-win{',
        '    grid-column:2!important;grid-row:1!important;',
        '    min-width:0!important;',
        '    position:relative!important;overflow:hidden!important;',
        '  }',
        '  #sp-chat-iframe{',
        '    position:absolute!important;',
        '    left:0!important;top:0!important;',
        '    width:100%!important;height:100%!important;',
        '    z-index:10!important;',
        '  }',
        '  .wbv5-il-filters{',
        '    flex-wrap:wrap!important;overflow-x:auto!important;',
        '    max-height:none!important;flex-shrink:0!important;',
        '    scrollbar-width:none!important;',
        '  }',
        '  .wbv5-il-filters::-webkit-scrollbar{display:none!important;}',
        '}',

        /* Anti-flickering */
        '.wbv5-chat-wrap{will-change:auto!important;}',
        '.wbv5-inbox-list{will-change:auto!important;}',

        /* Item styles */
        '.wbv5-conv-itm .wbv5-ci-name{font-size:15.5px!important;font-weight:700!important;}',
        '.wbv5-conv-itm .wbv5-ci-prev{font-size:13px!important;font-weight:400!important;color:#374151!important;line-height:1.35!important;}',
        '.wbv5-conv-itm .wbv5-ci-time{font-size:12px!important;}',

        /* iframeGuard CSS */
        '.wbv5-cw.sp-iframe-active .wbv5-cw-msgs{display:none!important;}',
        '.wbv5-cw.sp-iframe-active .wbv5-cw-input-bar{display:none!important;}',
        '#sp-chat-iframe{position:absolute;top:0;left:0;width:100%;height:100%;border:none;z-index:10;background:#fff;}',

        /* Fix: Hide native SellerChat elements when no chat selected (sp-no-chat) */
        '.wbv5-chat-win.sp-no-chat:not(.sp-iframe-active) .wbv5-cw-input-bar{display:none!important;}',
        '.wbv5-chat-win.sp-no-chat:not(.sp-iframe-active) .wbv5-cw-header{display:none!important;}',
        '.wbv5-chat-win.sp-no-chat:not(.sp-iframe-active) .wbv5-cw-msgs{display:none!important;}',
        '.wbv5-chat-win.sp-no-chat:not(.sp-iframe-active) .wbv5-cw-sub{display:none!important;}',
        '.wbv5-chat-win.sp-no-chat:not(.sp-iframe-active) #sp50-placeholder{display:flex!important;}',
        '.wbv5-chat-win.sp-iframe-active #sp50-placeholder{display:none!important;}'

      ].join('\n');
      document.head.appendChild(s);
    })();

    /* ── Fix 5: patchReload ─────────────────────────────── */
    (function patchReload(){
      try {
        var _orig = window.location.reload.bind(window.location);
        window.location.reload = function(force) {
          var root = document.getElementById('root');
          if (!root || !root.children.length) { return _orig(force); }
          if (document.getElementById('sp-chat-iframe')) { return; }
          if (document.querySelector('.wbv5-sidebar') || document.querySelector('.wbv5-nav-item')) { return; }
          _orig(force);
        };
      } catch(e) {}
    })();

    /* ── Fix 11: White-screen watchdog (15s tolerance, no auto-reload) ─ */
    (function fixWatchdog(){
      if(window.__spWdOverride) return;
      window.__spWdOverride = true;
      var _wdCount = 0;
      setInterval(function(){
        var root = document.getElementById('root');
        if(!root || !root.children.length) return;
        var ok = document.querySelector('.wbv5-sidebar') || document.querySelector('.wbv5-nav-item');
        if(!ok){ _wdCount++; if(_wdCount >= 5){ console.warn('[v5] watchdog: panel blanco — NO recargamos (anti-loop)'); _wdCount = 0; } }
        else { _wdCount = 0; }
      }, 3000);
    })();

    /* ── Fix 12: iframeGuard (2s, only on change) ─ */
    (function iframeGuard(){
      var _lastIframe = null;
      setInterval(function(){
        var iframe = document.getElementById('sp-chat-iframe');
        var cw = document.querySelector('.wbv5-cw');
        if(!cw) return;
        if(iframe === _lastIframe) return;
        _lastIframe = iframe;
        if(iframe){
          cw.classList.add('sp-iframe-active');
          var msgs = cw.querySelector('.wbv5-cw-msgs');
          var bar  = cw.querySelector('.wbv5-cw-input-bar');
          if(msgs) msgs.style.setProperty('display','none','important');
          if(bar)  bar.style.setProperty('display','none','important');
        } else {
          cw.classList.remove('sp-iframe-active');
        }
      }, 2000);
    })();

    /* ── Fix 9 JS: enforce inbox width ── */
    (function fixInboxWidth(){
      function enforceWidth(){
        if(window.matchMedia('(max-width:900px)').matches) return;
        var inbox = document.querySelector('.wbv5-inbox-list');
        if(!inbox) return;
        var w = inbox.getBoundingClientRect().width;
        if(w < 300 && w > 0){
          inbox.style.setProperty('min-width','340px','important');
          inbox.style.setProperty('flex','0 0 360px','important');
        }
      }
      enforceWidth();
      window.addEventListener('resize', enforceWidth);
      var _roTimer = null;
      if(typeof ResizeObserver !== 'undefined'){
        var ro = new ResizeObserver(function(){
          clearTimeout(_roTimer);
          _roTimer = setTimeout(enforceWidth, 200);
        });
        function attachRO(){
          var wrap = document.querySelector('.wbv5-chat-wrap');
          if(wrap){ ro.observe(wrap); }
          else { setTimeout(attachRO, 1000); }
        }
        attachRO();
      }
    })();

    /* ── Fix 1: hideWbv5DiagFloat ─────────────── */
    var _diagHidden = false;
    window.hideWbv5DiagFloat = function(){
      if(_diagHidden) return;
      document.querySelectorAll('button,span,div').forEach(function(el){
        if(el.children.length > 0) return;
        var t = el.textContent.trim();
        if(t.length > 2) return;
        var pos = el.style.position || getComputedStyle(el).position;
        if(pos === 'fixed' && t.charCodeAt(0) === 128295){ el.style.display = 'none'; _diagHidden = true; }
      });
    };

    /* ── Fix 6: Click tracker ──────────────────── */
    (function fixClickTracker(){
      var _attached = false;
      function attachOnInbox(){
        if(_attached) return;
        var inbox = document.querySelector('.wbv5-inbox-list');
        if(!inbox){ setTimeout(attachOnInbox, 800); return; }
        _attached = true;
        inbox.addEventListener('click', function(e){
          var item = e.target.closest ? e.target.closest('.wbv5-conv-itm') : null;
          if(!item) return;
          var jid = item.getAttribute('data-jid') || item.getAttribute('data-id') || '';
          if(!jid){
            var nameEl = item.querySelector('.wbv5-ci-name');
            if(nameEl){
              var rawName = nameEl.textContent.replace(/⚡[^⚡]*/g,'').trim();
              var num = rawName.replace(/\D/g,'');
              if(num.length >= 8) jid = num + '@s.whatsapp.net';
            }
          }
          if(jid) window.__lastClickedJid = jid;
          window.__spUserPickedChat = true;
          setTimeout(function(){
            if(window.__lastClickedJid === '__pending__') return;
            if(typeof window.injectDesktopChatIframe === 'function'){
              window.injectDesktopChatIframe();
            }
          }, 150);
        }, true);
      }
      attachOnInbox();
    })();

    /* ── Fix 7: DOM dedup (3s interval + MutationObserver) ─────── */
    (function fixDedup(){
      function dedupInbox(){
        var inbox = document.querySelector('.wbv5-inbox-list');
        if(!inbox) return;
        var items = Array.prototype.slice.call(inbox.querySelectorAll('.wbv5-conv-itm'));
        var seen = {};
        items.forEach(function(item){
          var nameEl = item.querySelector('.wbv5-ci-name');
          var rawName = nameEl ? nameEl.textContent.replace(/[^\w\s\+]/g,'').trim() : '';
          var digOnly = rawName.replace(/\D/g,'');
          var key;
          if(digOnly.length >= 7 && rawName.replace(/[\d\s\+\-\(\)]/g,'').length === 0){
            key = 'p:' + digOnly.slice(-9);
          } else if(rawName.length >= 2){
            key = 'n:' + rawName.toLowerCase();
          } else { return; }
          if(seen[key]){
            item.style.setProperty('display','none','important');
            item.setAttribute('data-sp-dd','1');
          } else {
            seen[key] = true;
            if(item.getAttribute('data-sp-dd')){
              item.removeAttribute('data-sp-dd');
              item.style.removeProperty('display');
            }
          }
        });
      }
      function startDedup(){
        var inbox = document.querySelector('.wbv5-inbox-list');
        if(!inbox){ setTimeout(startDedup, 800); return; }
        dedupInbox();
        setInterval(dedupInbox, 3000);
        var obs = new MutationObserver(function(muts){
          if(muts.some(function(m){ return m.addedNodes.length > 0; })) setTimeout(dedupInbox, 300);
        });
        obs.observe(inbox, {childList:true, subtree:false});
      }
      startDedup();
    })();

    /* ── Fix 8: Fallback injectDesktopChatIframe ─────────── */
    (function fixInjectFallback(){
      function defineInject(){
        if(typeof window.injectDesktopChatIframe === 'function') return;
        window.injectDesktopChatIframe = function(){
          if(window.matchMedia('(max-width:900px)').matches) return;
          var jid = window.__lastClickedJid || '';
          if(!jid){
            var active = document.querySelector(
              '.wbv5-conv-itm.active,.wbv5-conv-itm.selected,.wbv5-conv-itm[aria-selected="true"],.wbv5-conv-itm[data-selected]'
            );
            if(active) jid = active.getAttribute('data-jid') || active.getAttribute('data-id') || '';
          }
          var cw = document.querySelector('.wbv5-cw');
          if(!cw) return;
          var old = document.getElementById('sp-chat-iframe');
          if(old) old.remove();
          var src = '/bot/chat.html';
          if(jid) src += '?jid=' + encodeURIComponent(jid);
          var iframe = document.createElement('iframe');
          iframe.id = 'sp-chat-iframe';
          iframe.src = src;
          iframe.setAttribute('allow', 'microphone; camera');
          iframe.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;border:none;z-index:10;background:#fff;';
          cw.style.position = 'relative';
          cw.appendChild(iframe);
          cw.classList.add('sp-iframe-active');
        };
      }
      defineInject();
      setTimeout(defineInject, 1500);
    })();

  } catch(e) {
    console.error('[WA-OASIS v5] init error:', e);
  }
})();

/* ═══════════════════════════════════════════════════════
   FIX 13 — Hide APPS CHAT (Instagram, Messenger, TikTok)
   ═══════════════════════════════════════════════════════ */
(function hideAppChats(){
  if(window.__spHideAppChats) return;
  window.__spHideAppChats = true;

  var st = document.createElement('style');
  st.id = 'sp-hide-appchat-style';
  st.textContent = '.sp-hide-appchat{display:none!important;}';
  if(!document.getElementById('sp-hide-appchat-style')) document.head.appendChild(st);

  var _HIDE = ['Instagram','Messenger','TikTok'];

  function hideItems(){
    document.querySelectorAll('.wbv5-nav-item').forEach(function(el){
      if(_HIDE.indexOf(el.textContent.trim()) !== -1) el.classList.add('sp-hide-appchat');
    });
    document.querySelectorAll('[class*="nav-section-title"],[class*="nav-group-title"],[class*="sidebar-title"]').forEach(function(el){
      if(el.textContent.trim().toUpperCase() === 'APPS CHAT') el.classList.add('sp-hide-appchat');
    });
    document.querySelectorAll('.wbv5-sidebar span, .wbv5-sidebar div').forEach(function(el){
      if(el.children.length === 0 && el.textContent.trim().toUpperCase() === 'APPS CHAT') el.classList.add('sp-hide-appchat');
    });
    document.querySelectorAll('button.wbv5-il-filter, button[class*="filter"], [role="tab"]').forEach(function(el){
      var txt = el.textContent.trim();
      if(_HIDE.some(function(h){ return txt.includes(h); })) el.classList.add('sp-hide-appchat');
    });
  }

  hideItems();
  [200,600,1500,3000].forEach(function(d){ setTimeout(hideItems, d); });
  var _debTimer = null;
  var obs = new MutationObserver(function(){
    clearTimeout(_debTimer);
    _debTimer = setTimeout(hideItems, 300);
  });
  obs.observe(document.body, {childList:true, subtree:true});
})();


/* ═══════════════════════════════════════════════════════
   FIX 15 — Always show chat.html in right panel (defers to Fix 47)
   ═══════════════════════════════════════════════════════ */
(function fixAlwaysShowChat(){
  if(window.__spFix15) return;
  window.__spFix15 = true;
  if(window.location.pathname.indexOf('/dashboard/whatsapp-bot')!==0) return;

  (function addCss(){
    if(document.getElementById('sp-fix15-css')) return;
    var s = document.createElement('style');
    s.id = 'sp-fix15-css';
    s.textContent = [
      '.wbv5-chat-win.sp-iframe-active .wbv5-cw-msgs{display:none!important;}',
      '.wbv5-chat-win.sp-iframe-active .wbv5-cw-input-bar{display:none!important;}',
      '.wbv5-chat-win.sp-iframe-active #sp-no-chat{display:none!important;}',
      '#sp-chat-iframe{position:absolute!important;top:0!important;left:0!important;',
      'width:100%!important;height:100%!important;border:none!important;z-index:10!important;background:#fff!important;}',
      '.wbv5-chat-win{position:relative!important;overflow:hidden!important;}'
    ].join('');
    document.head.appendChild(s);
  })();

  function overrideInject(){
    if(window.__spFix47) return;
    window.injectDesktopChatIframe = function(){
      if(window.matchMedia('(max-width:900px)').matches) return;
      if(window.location.pathname.indexOf('whatsapp-bot')===-1) return;
      var cw = document.querySelector('.wbv5-chat-win');
      if(!cw) return;
      var noDiv = document.getElementById('sp-no-chat');
      if(noDiv) noDiv.remove();
      var sub = document.querySelector('.wbv5-cw-sub');
      var jidNum = sub ? (sub.textContent||'').replace(/[^0-9]/g,'') : '';
      if((!jidNum||jidNum.length<9) && window.__lastClickedJid){
        jidNum = (window.__lastClickedJid||'').replace(/[^0-9]/g,'');
      }
      var jid = (jidNum && jidNum.length>=9) ? jidNum+'@s.whatsapp.net' : null;
      var existing = document.getElementById('sp-chat-iframe');
      if(existing){
        if(jid && existing.dataset.jid !== jid){
          existing.dataset.jid = jid;
          existing.src = '/bot/chat.html?jid='+encodeURIComponent(jid)+'&t='+Date.now();
        }
        cw.classList.add('sp-iframe-active');
        return;
      }
      var iframe = document.createElement('iframe');
      iframe.id  = 'sp-chat-iframe';
      iframe.dataset.jid = jid || '';
      iframe.src = jid
        ? '/bot/chat.html?jid='+encodeURIComponent(jid)+'&t='+Date.now()
        : '/bot/chat.html';
      iframe.allow = 'microphone';
      iframe.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;border:none;z-index:10;background:#fff;display:block;';
      cw.style.position = 'relative';
      cw.style.overflow = 'hidden';
      cw.classList.add('sp-iframe-active');
      cw.appendChild(iframe);
    };
    [100,600,1500,3000].forEach(function(d){ setTimeout(window.injectDesktopChatIframe,d); });
  }

  setTimeout(overrideInject, 1200);
  setTimeout(overrideInject, 3500);
})();


/* ═══════════════════════════════════════════════════════
   FIX 16 — Visual separator sidebar/inbox
   ═══════════════════════════════════════════════════════ */
(function fixVisualSeparator(){
  if(window.__spFix16) return;
  window.__spFix16 = true;
  if(window.location.pathname.indexOf('/dashboard/whatsapp-bot')!==0) return;

  var css = [
    '.wbv5-sidebar{border-right:2px solid rgba(0,0,0,0.13)!important;box-shadow:3px 0 8px rgba(0,0,0,0.07)!important;z-index:2!important;position:relative!important;}',
    '.wbv5-inbox-list{background:rgba(248,249,251,0.97)!important;border-left:1px solid rgba(0,0,0,0.07)!important;}',
    '.wbv5-il-header,.wbv5-inbox-header{background:#ffffff!important;border-bottom:1px solid rgba(0,0,0,0.08)!important;}'
  ].join('\n');

  var s = document.createElement('style');
  s.id = 'sp-fix16-css';
  s.textContent = css;
  if(!document.getElementById('sp-fix16-css')) document.head.appendChild(s);

  function applyStyles(){
    var sidebar = document.querySelector('.wbv5-sidebar');
    if(sidebar){
      sidebar.style.setProperty('border-right','2px solid rgba(0,0,0,0.13)','important');
      sidebar.style.setProperty('box-shadow','3px 0 8px rgba(0,0,0,0.07)','important');
    }
    var inbox = document.querySelector('.wbv5-inbox-list');
    if(inbox) inbox.style.setProperty('background','rgba(248,249,251,0.97)','important');
  }
  applyStyles();
  [300,800,2000].forEach(function(d){ setTimeout(applyStyles, d); });
})();


/* ═══════════════════════════════════════════════════════
   FIX 17 + 17b — Grid swap: chat-win CENTER, inbox-list RIGHT (desktop only)
   ═══════════════════════════════════════════════════════ */
(function fixSwapColumns(){
  if(window.__spFix17) return;
  window.__spFix17 = true;
  if(window.location.pathname.indexOf('/dashboard/whatsapp-bot')!==0) return;

  /* 17b: CSS with proper media query (overrides original Fix 17 CSS) */
  var styleEl = document.getElementById('sp-fix17-styles');
  if(!styleEl){
    styleEl = document.createElement('style');
    styleEl.id = 'sp-fix17-styles';
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = [
    '@media screen and (min-width:901px){',
    '  .wbv5-chat-wrap{display:grid!important;grid-template-columns:1fr 360px!important;grid-template-rows:1fr!important;}',
    '  .wbv5-chat-win{grid-column:1!important;grid-row:1!important;order:1!important;}',
    '  .wbv5-inbox-list{grid-column:2!important;grid-row:1!important;order:2!important;border-left:1.5px solid rgba(0,0,0,0.1)!important;border-right:none!important;}',
    '}',
    '@media screen and (max-width:900px){',
    '  .wbv5-chat-wrap{display:block!important;}',
    '  .wbv5-chat-win{grid-column:unset!important;grid-row:unset!important;order:unset!important;}',
    '  .wbv5-inbox-list{grid-column:unset!important;grid-row:unset!important;order:unset!important;border-left:none!important;}',
    '}'
  ].join('\n');
  window.__spFix17b = true;

  function enforceSwap(){
    if(window.matchMedia('(max-width:900px)').matches) return;
    var wrap    = document.querySelector('.wbv5-chat-wrap');
    var inbox   = document.querySelector('.wbv5-inbox-list');
    var chatWin = document.querySelector('.wbv5-chat-win');
    if(!wrap || !inbox || !chatWin) return;
    wrap.style.setProperty('display','grid','important');
    wrap.style.setProperty('grid-template-columns','1fr 360px','important');
    wrap.style.setProperty('grid-template-rows','1fr','important');
    chatWin.style.setProperty('grid-column','1','important');
    chatWin.style.setProperty('grid-row','1','important');
    chatWin.style.setProperty('order','1','important');
    inbox.style.setProperty('grid-column','2','important');
    inbox.style.setProperty('grid-row','1','important');
    inbox.style.setProperty('order','2','important');
    inbox.style.setProperty('border-left','1.5px solid rgba(0,0,0,0.1)','important');
    inbox.style.removeProperty('border-right');
  }

  enforceSwap();
  [200,500,1000,2000,4000].forEach(function(d){ setTimeout(enforceSwap,d); });

  var _swapBusy=false;
  var observer = new MutationObserver(function(muts){
    if(_swapBusy) return;
    for(var m of muts){
      if(m.target && (m.target.classList.contains('wbv5-chat-wrap')||
                      m.target.classList.contains('wbv5-chat-win')||
                      m.target.classList.contains('wbv5-inbox-list'))){
        _swapBusy=true; setTimeout(function(){_swapBusy=false;},200);
        enforceSwap();
        break;
      }
    }
  });
  function startObserver(){
    var wrap = document.querySelector('.wbv5-chat-wrap');
    if(wrap) observer.observe(wrap, {attributes:true, subtree:true, attributeFilter:['style','class']});
  }
  [300,1000,2500].forEach(function(d){ setTimeout(startObserver,d); });
  setInterval(enforceSwap, 1500);
})();


/* ═══════════════════════════════════════════════════════
   FIX 18 — Mobile: restore natural inbox layout
   ═══════════════════════════════════════════════════════ */
(function fixMobileInbox(){
  if(window.__spFix18) return;
  window.__spFix18 = true;
  if(window.location.pathname.indexOf('/dashboard/whatsapp-bot')!==0) return;

  function restoreMobile(){
    if(!window.matchMedia('(max-width:900px)').matches) return;
    var wrap = document.querySelector('.wbv5-chat-wrap');
    var inbox = document.querySelector('.wbv5-inbox-list');
    var chatWin = document.querySelector('.wbv5-chat-win');
    if(!wrap || !inbox || !chatWin) return;
    wrap.style.removeProperty('display');
    wrap.style.removeProperty('grid-template-columns');
    wrap.style.removeProperty('grid-template-rows');
    chatWin.style.removeProperty('grid-column');
    chatWin.style.removeProperty('grid-row');
    chatWin.style.removeProperty('order');
    inbox.style.removeProperty('grid-column');
    inbox.style.removeProperty('grid-row');
    inbox.style.removeProperty('order');
  }

  restoreMobile();
  [300,800,1500,3000].forEach(function(d){ setTimeout(restoreMobile,d); });
  setInterval(restoreMobile, 2000);
  window.addEventListener('resize', restoreMobile);
})();


/* ═══════════════════════════════════════════════════════
   FIX 24b — no-white-box CSS
   ═══════════════════════════════════════════════════════ */
(function fixWhiteBox(){
  if(window.__spFix24) return;
  window.__spFix24 = true;
  if(window.location.pathname.indexOf('/dashboard/whatsapp-bot')!==0) return;

  if(!document.getElementById('sp-fix24-css')){
    var s=document.createElement('style'); s.id='sp-fix24-css';
    s.textContent=
      '.wbv5-chat-win{background:#f0f2f5!important;}'+
      '.wbv5-cw-header{visibility:hidden!important;}'+
      '.wbv5-cw-msgs{visibility:hidden!important;}'+
      '.wbv5-cw-input-bar{visibility:hidden!important;}'+
      '@media(max-width:900px){'+
        '.wbv5-chat-win{display:none!important;}'+
        '.wbv5-inbox-list{width:100%!important;max-width:100%!important;'+
          'flex:1 1 100%!important;min-width:0!important;}'+
        '.wbv5-chat-wrap{display:block!important;}'+
      '}';
    document.head.appendChild(s);
  }
})();

/* ═══════════════════════════════════════════════════════
   FIX 33+34 — Arrow/back button hidden in desktop
   ═══════════════════════════════════════════════════════ */
(function fix33(){
  if(window.__spFix33) return;
  window.__spFix33 = true;

  function applyBackBtn(){
    var btns = Array.from(document.querySelectorAll('button'));
    var backBtn = btns.find(function(b){ return b.textContent.trim() === '←'; });
    if(!backBtn) return;
    var isMobile = window.innerWidth <= 768;
    backBtn.style.display = isMobile ? '' : 'none';
  }
  setInterval(applyBackBtn, 500);
  window.addEventListener('resize', applyBackBtn);
  setTimeout(applyBackBtn, 300);
})();

(function fix34(){
  if(window.__spFix34) return; window.__spFix34 = true;
  function applyBackBtnIframe(){
    var f = document.getElementById("sp-chat-iframe");
    if(!f) return;
    var cd;
    try { cd = f.contentDocument || f.contentWindow.document; } catch(e){ return; }
    var backBtn = cd.getElementById("back-btn");
    if(!backBtn) return;
    var isMobile = window.innerWidth <= 768;
    backBtn.style.display = isMobile ? "" : "none";
  }
  setInterval(applyBackBtnIframe, 500);
  window.addEventListener("resize", applyBackBtnIframe);
  setTimeout(applyBackBtnIframe, 300);
})();


/* ═══════════════════════════════════════════════════════
   FIX 35-39 — Hamburger mobile-only, search padding, panel button, sort stability
   ═══════════════════════════════════════════════════════ */
(function fix35(){
  if(window.__spFix35) return; window.__spFix35 = true;

  function restoreHamburger(){
    var ham = document.getElementById("sp-hamburger");
    if(ham && window.getComputedStyle(ham).display === "none"){
      ham.style.setProperty("display","flex","important");
    }
  }
  setInterval(restoreHamburger, 250);
  [100,300,700,1200,2000,3500].forEach(function(d){ setTimeout(restoreHamburger,d); });

  var gapStyle = document.createElement("style");
  gapStyle.id = "sp-fix35-css";
  gapStyle.textContent =
    ".wbv5-inbox-list{flex:1 1 auto!important;min-width:280px!important;max-width:400px!important;}" +
    ".wbv5-main,.wbv5-root{width:100vw!important;max-width:100vw!important;overflow-x:hidden!important;}" +
    ".wbv5-root > *{flex-shrink:0!important;}";
  document.head.appendChild(gapStyle);

  function fixGap(){
    var inbox = document.querySelector(".wbv5-inbox-list");
    if(!inbox) return;
    var main = document.querySelector(".wbv5-main") || inbox.parentElement;
    if(!main) return;
    main.style.setProperty("width","100%","important");
    main.style.setProperty("flex","1","important");
  }
  setInterval(fixGap, 1500);
  [200,600,1200].forEach(function(d){ setTimeout(fixGap,d); });

  var divStyle = document.createElement("style");
  divStyle.textContent = ".sp35-divider{display:block!important;width:100%!important;padding:3px 14px!important;font-size:10px!important;font-weight:700!important;color:#94a3b8!important;text-transform:uppercase!important;letter-spacing:0.6px!important;background:linear-gradient(to right,#f1f5f9,#e8edf4)!important;border-top:1px solid #e2e8f0!important;border-bottom:1px solid #e2e8f0!important;margin:1px 0!important;box-sizing:border-box!important;pointer-events:none!important;}";
  document.head.appendChild(divStyle);

  function injectDayDividers(){
    var convs = document.querySelector(".wbv5-il-convs");
    if(!convs) return;
    var items = Array.from(convs.querySelectorAll(".wbv5-il-item")).filter(function(el){
      return el.style.display !== "none" && !el.getAttribute("data-sp-dd");
    });
    if(items.length < 2) return;
    convs.querySelectorAll(".sp35-divider").forEach(function(d){ d.remove(); });
    var todayBoundaryDone = false;
    items.forEach(function(item){
      var timeEl = item.querySelector("[class*=ci-time],[class*=il-time]");
      if(!timeEl) return;
      var t = timeEl.textContent.trim();
      var isToday = /^d{1,2}:d{2}/.test(t);
      if(!isToday && !todayBoundaryDone){
        todayBoundaryDone = true;
        var div = document.createElement("div");
        div.className = "sp35-divider";
        div.textContent = "Anteriores";
        convs.insertBefore(div, item);
      }
    });
    var firstTime = items[0] && items[0].querySelector("[class*=ci-time],[class*=il-time]");
    if(firstTime && /^d{1,2}:d{2}/.test(firstTime.textContent.trim())){
      var existing = convs.querySelector(".sp35-divider-hoy");
      if(!existing){
        var divH = document.createElement("div");
        divH.className = "sp35-divider sp35-divider-hoy";
        divH.textContent = "Hoy";
        convs.insertBefore(divH, convs.firstChild);
      }
    }
  }
  setInterval(injectDayDividers, 2500);
  [1500,2500,4000].forEach(function(d){ setTimeout(injectDayDividers,d); });

  function killAIToast(){
    try{
      document.querySelectorAll("*").forEach(function(el){
        try{
          if(el.childElementCount < 5 && el.textContent &&
             (el.textContent.indexOf("Error") !== -1 || el.textContent.indexOf("error") !== -1) &&
             el.textContent.indexOf("IA") !== -1 &&
             ["fixed","absolute"].indexOf(window.getComputedStyle(el).position) !== -1 &&
             window.getComputedStyle(el).display !== "none" &&
             window.getComputedStyle(el).opacity !== "0"){
            el.style.setProperty("display","none","important");
          }
        }catch(ei){}
      });
    }catch(e){}
  }
  setInterval(killAIToast, 800);
})();

(function fix36(){
  if(window.__spFix36) return; window.__spFix36 = true;

  var gapCss = document.createElement("style");
  gapCss.id = "sp-fix36-css";
  gapCss.textContent =
    "@media(min-width:769px){" +
    ".wbv5-inbox-list{width:100%!important;max-width:100%!important;}" +
    "}";
  document.head.appendChild(gapCss);
  function fixInboxWidth(){
    var inbox = document.querySelector(".wbv5-inbox-list");
    if(!inbox) return;
    inbox.style.setProperty("width","100%","important");
    inbox.style.setProperty("max-width","100%","important");
  }
  setInterval(fixInboxWidth, 1000);
  [100,300,700,1500].forEach(function(d){ setTimeout(fixInboxWidth,d); });

  var divStyle = document.createElement("style");
  divStyle.textContent =
    ".sp36-div{display:flex!important;align-items:center!important;gap:8px!important;" +
    "padding:4px 12px!important;font-size:10px!important;font-weight:700!important;" +
    "color:#94a3b8!important;text-transform:uppercase!important;letter-spacing:0.5px!important;" +
    "background:#f1f5f9!important;border-top:1px solid #e2e8f0!important;" +
    "border-bottom:1px solid #e2e8f0!important;margin:0!important;" +
    "width:100%!important;box-sizing:border-box!important;pointer-events:none!important;}" +
    ".sp36-div::before,.sp36-div::after{content:'';flex:1;height:1px;background:#e2e8f0!important;}";
  document.head.appendChild(divStyle);

  var _lastDivCount = -1;
  function injectDayDividers(){
    var convs = document.querySelector(".wbv5-il-convs");
    if(!convs) return;
    var items = Array.from(convs.querySelectorAll(".wbv5-conv-itm")).filter(function(el){
      return el.style.display !== "none";
    });
    if(items.length === _lastDivCount) return;
    _lastDivCount = items.length;
    convs.querySelectorAll(".sp36-div").forEach(function(d){ d.remove(); });
    if(items.length === 0) return;
    var anteriorDone = false;
    var firstTimeEl = items[0].querySelector("[class*=ci-time],[class*=conv-time],[class*=time]");
    var firstTime = firstTimeEl ? firstTimeEl.textContent.trim() : "";
    var firstIsToday = /^\d{1,2}:\d{2}/.test(firstTime);
    if(firstIsToday){
      var divHoy = document.createElement("div");
      divHoy.className = "sp36-div";
      divHoy.setAttribute("data-sp36","hoy");
      divHoy.textContent = "Hoy";
      convs.insertBefore(divHoy, items[0]);
    }
    items.forEach(function(item){
      var timeEl = item.querySelector("[class*=ci-time],[class*=conv-time],[class*=time]");
      if(!timeEl) return;
      var t = timeEl.textContent.trim();
      var isToday = /^\d{1,2}:\d{2}/.test(t);
      if(!isToday && !anteriorDone){
        anteriorDone = true;
        var divAnt = document.createElement("div");
        divAnt.className = "sp36-div";
        divAnt.setAttribute("data-sp36","ant");
        divAnt.textContent = "Anteriores";
        convs.insertBefore(divAnt, item);
      }
    });
  }
  setInterval(injectDayDividers, 2000);
  [1000,2000,3500,5000].forEach(function(d){ setTimeout(injectDayDividers,d); });
})();

(function fix37(){
  if(window.__spFix37b) return; window.__spFix37b = true;

  var hamCSS = document.createElement("style");
  hamCSS.id = "sp-fix37-css";
  hamCSS.textContent =
    "@media(min-width:769px){#sp-hamburger{display:none!important;}}" +
    "@media(max-width:768px){" +
    "#sp-hamburger{display:flex!important;}" +
    ".wbv5-il-search{padding-left:56px!important;box-sizing:border-box!important;}" +
    "[class*=inbox-header],[class*=il-header]{padding-left:56px!important;}" +
    "}";
  document.head.appendChild(hamCSS);

  function syncHamburger(){
    var ham = document.getElementById("sp-hamburger");
    if(!ham) return;
    var isMobile = window.innerWidth <= 768;
    ham.style.setProperty("display", isMobile ? "flex" : "none", "important");
  }
  setInterval(syncHamburger, 200);
  window.addEventListener("resize", syncHamburger);
  [50,200,500,1000,2000].forEach(function(d){ setTimeout(syncHamburger,d); });

  function fixPanelBtn(){
    var btn = document.getElementById("sp-panel-btn");
    if(!btn || btn.__fix37patched) return;
    btn.__fix37patched = true;
    btn.addEventListener("click", function(e){
      e.stopPropagation(); e.preventDefault();
      var grid = document.querySelector(".containerGrid");
      if(!grid) return;
      var isOpen = grid.classList.contains("sp-nav-open");
      if(isOpen){ grid.classList.remove("sp-nav-open"); var bd=document.getElementById("sp-nav-bd"); if(bd) bd.remove(); }
      else {
        grid.classList.add("sp-nav-open");
        var bd2 = document.getElementById("sp-nav-bd");
        if(!bd2){ bd2=document.createElement("div"); bd2.id="sp-nav-bd"; bd2.style.cssText="position:fixed;inset:0;z-index:99998;background:rgba(0,0,0,.38);cursor:pointer"; bd2.onclick=function(){ var g2=document.querySelector(".containerGrid"); if(g2) g2.classList.remove("sp-nav-open"); bd2.remove(); }; document.body.appendChild(bd2); }
      }
      var sidebar = document.querySelector(".wbv5-sidebar");
      var overlay = document.getElementById("sp-sidebar-overlay");
      var hamBtn = document.getElementById("sp-hamburger");
      if(sidebar) sidebar.classList.remove("sp-open");
      if(overlay) overlay.classList.remove("active");
      if(hamBtn) hamBtn.classList.remove("open");
    }, true);
  }

  function ensurePanelBtn(){
    if(document.getElementById("sp-panel-btn")) { fixPanelBtn(); return; }
    var sb = document.querySelector(".wbv5-sidebar");
    if(!sb) return;
    var fs = sb.querySelector(".wbv5-nav-section");
    if(!fs) return;
    var btn = document.createElement("button");
    btn.id = "sp-panel-btn";
    btn.innerHTML = "&#127968; Panel";
    btn.style.cssText = "display:flex!important;align-items:center;gap:6px;padding:9px 14px;" +
      "margin:4px 8px 10px;background:#25D366;color:#fff;border:none;border-radius:8px;" +
      "cursor:pointer;font-size:13px;font-weight:600;width:calc(100% - 16px);box-sizing:border-box;";
    btn.__fix37patched = true;
    btn.addEventListener("click", function(e){
      e.stopPropagation(); e.preventDefault();
      var grid = document.querySelector(".containerGrid"); if(!grid) return;
      var isOpen = grid.classList.contains("sp-nav-open");
      if(isOpen){ grid.classList.remove("sp-nav-open"); var bd=document.getElementById("sp-nav-bd"); if(bd) bd.remove(); }
      else {
        grid.classList.add("sp-nav-open");
        var bd2 = document.getElementById("sp-nav-bd");
        if(!bd2){ bd2=document.createElement("div"); bd2.id="sp-nav-bd"; bd2.style.cssText="position:fixed;inset:0;z-index:99998;background:rgba(0,0,0,.38);cursor:pointer"; bd2.onclick=function(){ var g2=document.querySelector(".containerGrid"); if(g2) g2.classList.remove("sp-nav-open"); bd2.remove(); }; document.body.appendChild(bd2); }
      }
      var sidebar2 = document.querySelector(".wbv5-sidebar"); var ov2 = document.getElementById("sp-sidebar-overlay"); var hb2 = document.getElementById("sp-hamburger");
      if(sidebar2) sidebar2.classList.remove("sp-open"); if(ov2) ov2.classList.remove("active"); if(hb2) hb2.classList.remove("open");
    });
    sb.insertBefore(btn, fs);
  }
  setInterval(ensurePanelBtn, 1500);
  [500,1200,2500].forEach(function(d){ setTimeout(ensurePanelBtn,d); });
})();

(function fix38(){
  if(window.__spFix38) return; window.__spFix38 = true;

  var css = document.createElement("style");
  css.id = "sp-fix38-css";
  css.textContent =
    "@media(min-width:769px){#sp-hamburger{display:none!important;}}" +
    "@media(max-width:768px){" +
    "#sp-hamburger{display:flex!important;}" +
    ".wbv5-il-search{padding-left:58px!important;width:100%!important;box-sizing:border-box!important;}" +
    "}";
  document.head.appendChild(css);

  function getWantedDisplay(){ return window.innerWidth <= 768 ? "flex" : "none"; }
  function applyHam(ham){
    var want = getWantedDisplay();
    var cur = ham.style.getPropertyValue("display");
    var pri = ham.style.getPropertyPriority("display");
    if(cur !== want || pri !== "important"){
      if(ham.__fix38obs) ham.__fix38obs.disconnect();
      ham.style.setProperty("display", want, "important");
      if(ham.__fix38obs) ham.__fix38obs.observe(ham, {attributes:true,attributeFilter:["style"]});
    }
  }
  function attachObserver(){
    var ham = document.getElementById("sp-hamburger");
    if(!ham || ham.__fix38obs) return;
    applyHam(ham);
    var obs = new MutationObserver(function(){ applyHam(ham); });
    ham.__fix38obs = obs;
    obs.observe(ham, {attributes:true, attributeFilter:["style"]});
  }
  attachObserver();
  setInterval(function(){
    var ham = document.getElementById("sp-hamburger");
    if(ham && !ham.__fix38obs) attachObserver();
    else if(ham) applyHam(ham);
  }, 400);
  window.addEventListener("resize", function(){
    var ham = document.getElementById("sp-hamburger");
    if(ham) applyHam(ham);
  });

  function fixSearch(){
    if(window.innerWidth > 768) return;
    var s = document.querySelector(".wbv5-il-search");
    if(s) s.style.setProperty("padding-left","58px","important");
  }
  setInterval(fixSearch, 1500);
  [500,1200,2500].forEach(function(d){ setTimeout(fixSearch,d); });
})();

(function fix39(){
  if(window.__spFix39) return; window.__spFix39 = true;

  var panelCSS = document.createElement("style");
  panelCSS.textContent =
    ".navbarDashboard.sp-nav-panel-open{" +
    "display:block!important;position:fixed!important;" +
    "left:0!important;top:0!important;height:100vh!important;" +
    "width:220px!important;z-index:99999!important;" +
    "overflow-y:auto!important;background:#fff!important;" +
    "box-shadow:4px 0 20px rgba(0,0,0,0.15)!important;}" +
    "#sp-nav-bd39{position:fixed;inset:0;z-index:99998;background:rgba(0,0,0,0.4);cursor:pointer;}";
  document.head.appendChild(panelCSS);

  function openDashNav(){
    var navbar = document.querySelector(".navbarDashboard");
    if(!navbar) return;
    navbar.classList.add("sp-nav-panel-open");
    if(!document.getElementById("sp-nav-bd39")){
      var bd = document.createElement("div");
      bd.id = "sp-nav-bd39";
      bd.onclick = closeDashNav;
      document.body.appendChild(bd);
    }
  }
  function closeDashNav(){
    var navbar = document.querySelector(".navbarDashboard");
    if(navbar) navbar.classList.remove("sp-nav-panel-open");
    var bd = document.getElementById("sp-nav-bd39");
    if(bd) bd.remove();
  }

  function patchPanelBtn(){
    var btn = document.getElementById("sp-panel-btn");
    if(!btn || btn.__fix39) return;
    btn.__fix39 = true;
    btn.addEventListener("click", function(e){
      e.stopImmediatePropagation(); e.preventDefault();
      var navbar = document.querySelector(".navbarDashboard");
      if(!navbar) return;
      var isOpen = navbar.classList.contains("sp-nav-panel-open");
      if(isOpen){ closeDashNav(); } else { openDashNav(); }
      var sb = document.querySelector(".wbv5-sidebar");
      var ov = document.getElementById("sp-sidebar-overlay");
      var hb = document.getElementById("sp-hamburger");
      if(sb) sb.classList.remove("sp-open");
      if(ov) ov.classList.remove("active");
      if(hb){ hb.classList.remove("open"); hb.style.setProperty("display","none","important"); setTimeout(function(){ hb.style.setProperty("display",window.innerWidth<=768?"flex":"none","important"); },50); }
    }, true);
  }
  patchPanelBtn();
  setInterval(patchPanelBtn, 1500);

  if(!window.__spPageLoadTime) window.__spPageLoadTime = Date.now();
  var _origShow = window.__spShowPlaceholder;
  window.__spShowPlaceholder = function(){
    var iframe = document.getElementById("sp-chat-iframe");
    if(iframe && (Date.now() - (window.__spPageLoadTime||0)) < 4000) iframe.remove();
    if(_origShow) _origShow.apply(this, arguments);
  };
  setTimeout(function(){
    var iframe = document.getElementById("sp-chat-iframe");
    if(iframe) iframe.remove();
    if(window.__spShowPlaceholder) window.__spShowPlaceholder();
  }, 50);

  var sortCSS = document.createElement("style");
  sortCSS.textContent =
    ".wbv5-conv-itm{transition:background 0.2s!important;}" +
    ".wbv5-il-convs{overflow-anchor:none!important;}";
  document.head.appendChild(sortCSS);

  window.__spSortGrace = Date.now() + 5000;
  var _origFetch = window.fetchOrder;
  if(typeof _origFetch === "function"){
    window.fetchOrder = function(cb){
      if(Date.now() < (window.__spSortGrace||0)) return;
      return _origFetch.apply(this, arguments);
    };
  }
})();

(function fix40(){
  if(window.__spFix40) return; window.__spFix40 = true;
  var css = document.createElement("style");
  css.textContent = ".navbarDashboard.sp-nav-panel-open{background:linear-gradient(rgb(11,61,91),rgb(10,46,68))!important;box-shadow:4px 0 20px rgba(0,0,0,0.3)!important;}";
  document.head.appendChild(css);
})();
/* ═══ FIX 42: Plantillas — anti-flash + refresh dropdown + cleanup old panel ═══ */
(function fix42(){
  if(window.__spFix42) return; window.__spFix42=true;

  /* ─── 1. Patch cargarTplsPagina to clear stale data first + refresh prod dropdown ─── */
  var _fix42Gen=0; /* generation counter — invalidates stale promise callbacks */
  var _orig_cargarTplsPagina = window.cargarTplsPagina;
  window.cargarTplsPagina = function() {
    var gen=++_fix42Gen;
    /* Clear stale data immediately so buildPlantillasHTML shows 0 counts (no flash) */
    if(window._panelTpls) window._panelTpls=[];
    /* Also clear the grid while fetching */
    var grid=document.getElementById('sp-pag-grid');
    if(grid){
      grid.innerHTML='<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:#94a3b8;gap:10px;padding:40px;">'+
        '<div style="font-size:28px;">⏳</div>'+
        '<div style="font-size:13px;font-weight:600;color:#64748b;">Cargando plantillas...</div>'+
      '</div>';
    }
    var SB_P=window.SB_P||'https://lvmeswlvszsmvgaasazs.supabase.co';
    var SK_P=window.SK_P;
    if(!SK_P){
      /* fallback if orig function exists */
      if(_orig_cargarTplsPagina) _orig_cargarTplsPagina();
      return;
    }
    var p1=fetch(SB_P+'/rest/v1/oasis_wa_config?select=system_prompt&id=eq.wa_templates&limit=1',{
      headers:{'apikey':SK_P,'Authorization':'Bearer '+SK_P}
    }).then(function(r){return r.json();});
    var p2=fetch(SB_P+'/rest/v1/oasis_wa_config?select=system_prompt&id=eq.wa_products&limit=1',{
      headers:{'apikey':SK_P,'Authorization':'Bearer '+SK_P}
    }).then(function(r){return r.json();});
    Promise.all([p1,p2]).then(function(results){
      if(gen!==_fix42Gen) return; /* stale — newer fetch already in flight */
      var sp=results[0]&&results[0][0]&&results[0][0].system_prompt;
      window._panelTpls=sp?JSON.parse(sp):[];
      var pp=results[1]&&results[1][0]&&results[1][0].system_prompt;
      if(pp) window._panelProducts=JSON.parse(pp);
      /* Rebuild product dropdown list with fresh counts */
      var prodList=document.getElementById('sp-prod-list');
      if(prodList&&window._panelProducts&&window._panelProducts.length){
        var CMAP={jabones:'#e879f9',sebo:'#f97316',cierre:'#22c55e',seguimiento:'#3b82f6'};
        var CUST=['#8b5cf6','#ec4899','#14b8a6','#f59e0b','#6366f1','#ef4444','#06b6d4'];
        window._panelProducts.forEach(function(p,i){if(!CMAP[p.id])CMAP[p.id]=CUST[i%CUST.length];});
        var freshHtml=window._panelProducts.map(function(p){
          var cnt=(window._panelTpls||[]).filter(function(t){return (t.category||t.product||'')===p.id;}).length;
          return '<button onclick="elegirProducto(\''+p.id+'\')" '+
            'style="width:100%;padding:11px 16px;border:none;background:#fff;cursor:pointer;text-align:left;'+
            'font-size:13px;font-weight:600;color:#1e293b;display:flex;align-items:center;justify-content:space-between;transition:background 0.12s;" '+
            'onmouseover="this.style.background=\'#f8fafc\'" onmouseout="this.style.background=\'#fff\'">'+
            '<span>'+(p.icon||'📦')+' '+p.name+'</span>'+
            '<span style="font-size:10px;color:#94a3b8;">'+cnt+'</span>'+
            '</button><div style="height:1px;background:#f0f4f8;margin:0 8px;"></div>';
        }).join('');
        freshHtml+='<button onclick="elegirProducto(\'todos\')" style="width:100%;padding:11px 16px;border:none;background:#fff;cursor:pointer;text-align:left;font-size:13px;font-weight:600;color:#00a888;transition:background 0.12s;" onmouseover="this.style.background=\'#f0fffe\'" onmouseout="this.style.background=\'#fff\'">🔎 Todas las plantillas</button>';
        prodList.innerHTML=freshHtml;
      }
      if(typeof window.elegirProducto==='function') window.elegirProducto('todos');
    }).catch(function(){
      if(gen!==_fix42Gen) return;
      var g=document.getElementById('sp-pag-grid');
      if(g) g.innerHTML='<div style="grid-column:1/-1;text-align:center;padding:40px;color:#ef4444;">Error cargando plantillas</div>';
    });
  };

  /* ─── 2. Disable old floating panel (sp-plantillas-panel) to avoid double-panel clash ─── */
  var _origMostrar=window.mostrarPanelPlantillas;
  window.mostrarPanelPlantillas=function(){
    /* If the new panel system is active, just activate Plantillas section instead */
    if(window._enPlantillas&&document.getElementById('sp-plantillas-pagina')) return;
    /* Otherwise redirect to new system by simulating nav click */
    var navItems=document.querySelectorAll('.wbv5-nav-item,[class*="nav-item"],[class*="navItem"]');
    for(var i=0;i<navItems.length;i++){
      if(/plantillas/i.test(navItems[i].textContent)&&!/pro/i.test(navItems[i].textContent)){
        navItems[i].click(); return;
      }
    }
    /* Fallback: open old panel */
    if(_origMostrar) _origMostrar();
  };

  /* ─── 3. Force-refresh on every Plantillas section entry (not just first time) ─── */
  var _origInyectar=window.inyectarPanelPlantillasEnPagina;
  window.inyectarPanelPlantillasEnPagina=function(){
    if(!window._enPlantillas) return;
    var existing=document.getElementById('sp-plantillas-pagina');
    /* If visible but last refresh was >30s ago, force a data refresh */
    if(existing&&existing.offsetParent!==null){
      var now=Date.now();
      if(!existing._spLastLoad||now-existing._spLastLoad>30000){
        existing._spLastLoad=now;
        window.cargarTplsPagina(); /* refresh data silently */
      }
      return;
    }
    /* Call original to build the panel */
    if(_origInyectar) _origInyectar();
    /* Mark load time */
    setTimeout(function(){
      var p=document.getElementById('sp-plantillas-pagina');
      if(p) p._spLastLoad=Date.now();
    },100);
  };

  console.info('[WA-OASIS] Fix 42: Plantillas anti-flash + prod dropdown refresh + old panel cleanup');
})();

// ═══════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════
// FIX 44 v2 — Disparadores: Dropdown por Producto, +/× flujos, plantillas editables, etiquetas auto
// ═══════════════════════════════════════════════════════
(function fix44(){
  if(window.__spFix44) return; window.__spFix44=true;

  // Override Fix43 panel with enhanced version
  var _s = document.getElementById('sp43-css');
  if(_s) _s.remove();

  var css = document.createElement('style');
  css.id = 'sp44-css';
  css.textContent = `
    #sp-disp-productos{padding:4px 0 8px 0}
    /* ── Dropdown header ── */
    .sp44-hdr{display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap}
    .sp44-hdr-title{font-size:15px;font-weight:800;color:#1e293b;white-space:nowrap}
    .sp44-select{flex:1;min-width:160px;max-width:280px;padding:9px 14px;background:#fff;border:1px solid #cbd5e1;border-radius:10px;color:#1e293b;font-size:14px;font-weight:600;cursor:pointer;outline:none;appearance:none;-webkit-appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M3 5l3 3 3-3' stroke='%2364748b' fill='none' stroke-width='1.5'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center}
    .sp44-select:focus{border-color:#3b82f6}
    .sp44-btn-add{padding:7px 14px;border-radius:8px;border:1px dashed #94a3b8;background:transparent;color:#059669;font-size:13px;font-weight:700;cursor:pointer;transition:all .15s;white-space:nowrap}
    .sp44-btn-add:hover{border-color:#059669;background:#05966910}
    .sp44-btn-del{padding:7px 12px;border-radius:8px;border:none;background:#fef2f2;color:#dc2626;font-size:13px;font-weight:700;cursor:pointer;transition:opacity .15s}
    .sp44-btn-del:hover{opacity:.7}
    .sp44-flow{display:none}
    .sp44-flow.active{display:block}
    .sp44-flow-hdr{display:flex;align-items:center;gap:10px;margin-bottom:14px}
    .sp44-flow-icon{font-size:24px}
    .sp44-flow-title{font-size:16px;font-weight:700;color:#1e293b;flex:1}
    .sp44-flow-actions{display:flex;gap:6px}
    .sp44-fab{font-size:12px;padding:5px 12px;border-radius:7px;border:none;cursor:pointer;font-weight:600;transition:opacity .15s}
    .sp44-fab:hover{opacity:.8}
    .sp44-fab-edit{background:#f1f5f9;color:#475569;border:1px solid #cbd5e1}
    .sp44-fab-del{background:#fef2f2;color:#dc2626}
    .sp44-rules{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;margin-bottom:16px}
    .sp44-rules-title{font-size:12px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px}
    .sp44-rule{display:flex;gap:8px;align-items:flex-start;margin-bottom:6px;font-size:13px;color:#475569;line-height:1.5}
    .sp44-rule-icon{flex-shrink:0;font-size:14px}
    .sp44-keywords-box{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:14px 16px;margin-bottom:16px}
    .sp44-kw-title{font-size:12px;font-weight:700;color:#166534;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px}
    .sp44-kw-list{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
    .sp44-kw-tag{display:inline-flex;align-items:center;gap:4px;padding:4px 10px;background:#dcfce7;color:#166534;border:1px solid #86efac;border-radius:20px;font-size:13px;font-weight:600}
    .sp44-kw-tag .sp44-kw-x{cursor:pointer;font-size:14px;color:#dc2626;margin-left:2px;font-weight:700;line-height:1}
    .sp44-kw-tag .sp44-kw-x:hover{color:#991b1b}
    .sp44-kw-add-row{display:flex;gap:6px;align-items:center}
    .sp44-kw-input{flex:1;padding:7px 10px;background:#fff;border:1px solid #bbf7d0;border-radius:8px;color:#1e293b;font-size:13px;outline:none}
    .sp44-kw-input:focus{border-color:#22c55e}
    .sp44-kw-btn{padding:7px 12px;background:#059669;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer}
    .sp44-kw-btn:hover{background:#047857}
    .sp44-kw-hint{font-size:12px;color:#6b7280;margin-top:6px;font-style:italic}
    .sp44-section-lbl{font-size:12px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px;margin-top:4px}
    .sp44-seq{display:flex;flex-direction:column;gap:0;margin-bottom:16px}
    .sp44-step{display:flex;gap:12px;align-items:stretch}
    .sp44-step-line{display:flex;flex-direction:column;align-items:center;width:34px;flex-shrink:0}
    .sp44-step-dot{width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;z-index:1}
    .sp44-step-connector{width:2px;flex:1;min-height:12px;background:#e2e8f0}
    .sp44-step-card{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:14px;margin-bottom:8px;flex:1;transition:border-color .15s;position:relative;box-shadow:0 1px 3px rgba(0,0,0,.05)}
    .sp44-step-card:hover{border-color:#3b82f680}
    .sp44-step-card.stop{border-color:#fecaca;background:#fef2f2}
    .sp44-step-meta{display:flex;align-items:center;gap:8px;margin-bottom:7px}
    .sp44-day-badge{font-size:11px;padding:3px 10px;border-radius:20px;font-weight:700;border:1px solid transparent}
    .sp44-day-0{background:#dcfce7;color:#166534;border-color:#86efac}
    .sp44-day-1{background:#dbeafe;color:#1e40af;border-color:#93c5fd}
    .sp44-day-3{background:#ede9fe;color:#6d28d9;border-color:#c4b5fd}
    .sp44-day-7{background:#fff7ed;color:#c2410c;border-color:#fdba74}
    .sp44-day-14{background:#fef2f2;color:#dc2626;border-color:#fca5a5}
    .sp44-stop-badge{background:#fef2f2;color:#dc2626;font-size:11px;padding:3px 10px;border-radius:20px;font-weight:700;border:1px solid #fca5a5}
    .sp44-step-name{font-size:14px;font-weight:700;color:#1e293b;flex:1}
    .sp44-preview{font-size:13px;color:#64748b;line-height:1.5;max-height:52px;overflow:hidden;margin-bottom:7px;font-style:italic}
    .sp44-preview strong{color:#334155;font-style:normal}
    .sp44-media-badges{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:6px}
    .sp44-mbadge{font-size:11px;padding:3px 8px;border-radius:4px;font-weight:600}
    .sp44-mbadge-img{background:#dbeafe;color:#1e40af}
    .sp44-mbadge-vid{background:#ede9fe;color:#6d28d9}
    .sp44-mbadge-aud{background:#dcfce7;color:#166534}
    .sp44-mbadge-txt{background:#f1f5f9;color:#475569;border:1px solid #e2e8f0}
    .sp44-step-btns{display:flex;gap:6px;flex-wrap:wrap}
    .sp44-sb{font-size:12px;padding:5px 10px;border-radius:6px;border:none;cursor:pointer;font-weight:600;transition:opacity .15s}
    .sp44-sb:hover{opacity:.75}
    .sp44-sb-use{background:#1d4ed8;color:#fff}
    .sp44-sb-add{background:#059669;color:#fff}
    .sp44-sb-edit{background:#7c3aed;color:#fff}
    .sp44-sb-rem{background:#fef2f2;color:#dc2626;border:1px solid #fecaca}
    .sp44-addstep{border:2px dashed #cbd5e1;border-radius:10px;padding:12px;display:flex;align-items:center;justify-content:center;gap:8px;cursor:pointer;color:#64748b;font-size:13px;font-weight:600;margin-bottom:16px;transition:border-color .2s}
    .sp44-addstep:hover{border-color:#3b82f6;color:#3b82f6}
    .sp44-divider{border:none;border-top:1px solid #e2e8f0;margin:6px 0 22px}
    .sp44-labels{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;margin-bottom:16px}
    .sp44-label-row{display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:13px;color:#475569;line-height:1.5}
    .sp44-label-tag{padding:3px 10px;border-radius:6px;font-size:11px;font-weight:700;letter-spacing:.03em}
    .sp44-lbl-green{background:#dcfce7;color:#166534;border:1px solid #86efac}
    .sp44-lbl-orange{background:#fff7ed;color:#c2410c;border:1px solid #fdba74}
    .sp44-lbl-red{background:#fef2f2;color:#dc2626;border:1px solid #fecaca}
    .sp44-lbl-blue{background:#dbeafe;color:#1e40af;border:1px solid #93c5fd}
    .sp44-mbg{position:fixed;inset:0;background:#00000044;z-index:9999;display:flex;align-items:center;justify-content:center}
    .sp44-modal{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:24px;width:440px;max-width:92vw;max-height:90vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.15)}
    .sp44-modal h3{margin:0 0 16px;color:#1e293b;font-size:16px}
    .sp44-modal label{display:block;font-size:12px;color:#475569;margin-bottom:4px;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
    .sp44-modal input,.sp44-modal select,.sp44-modal textarea{width:100%;padding:9px 12px;background:#f8fafc;border:1px solid #cbd5e1;border-radius:8px;color:#1e293b;font-size:14px;margin-bottom:12px;box-sizing:border-box;outline:none;resize:vertical}
    .sp44-modal input:focus,.sp44-modal select:focus,.sp44-modal textarea:focus{border-color:#3b82f6;background:#fff}
    .sp44-mrow{display:flex;gap:8px;margin-top:6px}
    .sp44-msave{flex:1;padding:10px;background:#1d4ed8;color:#fff;border:none;border-radius:8px;font-weight:700;cursor:pointer;font-size:14px}
    .sp44-mcancel{flex:1;padding:10px;background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;border-radius:8px;font-weight:600;cursor:pointer;font-size:14px}
    .sp44-modal textarea{min-height:90px}
  `;
  document.head.appendChild(css);

  // ── helpers ──
  function creds(){ return {sb:window.__spCachedSB||'',sk:window.__spCachedSK||''}; }

  async function loadData(){
    var {sb,sk}=creds(); if(!sb||!sk) return {products:[],templates:[]};
    var [r1,r2]=await Promise.all([
      fetch(sb+'/rest/v1/oasis_wa_config?select=system_prompt&id=eq.wa_products',{headers:{'apikey':sk,'Authorization':'Bearer '+sk}}).then(r=>r.json()),
      fetch(sb+'/rest/v1/oasis_wa_config?select=system_prompt&id=eq.wa_templates',{headers:{'apikey':sk,'Authorization':'Bearer '+sk}}).then(r=>r.json())
    ]);
    var products=(r1[0]&&r1[0].system_prompt)?JSON.parse(r1[0].system_prompt):[];
    var templates=(r2[0]&&r2[0].system_prompt)?JSON.parse(r2[0].system_prompt):[];
    window.__sp44_products=products; window.__sp44_templates=templates;
    return {products,templates};
  }

  async function saveProducts(prods){
    var {sb,sk}=creds();
    await fetch(sb+'/rest/v1/oasis_wa_config?id=eq.wa_products',{
      method:'PATCH',
      headers:{'apikey':sk,'Authorization':'Bearer '+sk,'Content-Type':'application/json','Prefer':'return=minimal'},
      body:JSON.stringify({system_prompt:JSON.stringify(prods)})
    });
    window.__sp44_products=prods;
    window.__sp43_products=prods;
  }

  async function saveTemplates(tpls){
    var {sb,sk}=creds();
    await fetch(sb+'/rest/v1/oasis_wa_config?id=eq.wa_templates',{
      method:'PATCH',
      headers:{'apikey':sk,'Authorization':'Bearer '+sk,'Content-Type':'application/json','Prefer':'return=minimal'},
      body:JSON.stringify({system_prompt:JSON.stringify(tpls)})
    });
    window.__sp44_templates=tpls;
  }

  function dayLabel(d){ if(d===0) return 'INMEDIATO'; if(d===1) return '24 HORAS'; return 'DÍA '+d; }
  function dayClass(d){ if(d===0) return 'day-0'; if(d<=1) return 'day-1'; if(d<=3) return 'day-3'; if(d<=7) return 'day-7'; return 'day-14'; }

  function mediaHTML(media){
    if(!media||media.length===0) return '<span class="sp44-mbadge sp44-mbadge-txt">Solo texto</span>';
    return media.map(function(m){
      var ext=(m.url||m||'').toLowerCase();
      if(ext.includes('.mp4')||ext.includes('video')) return '<span class="sp44-mbadge sp44-mbadge-vid">🎥 Video</span>';
      if(ext.includes('.mp3')||ext.includes('audio')||ext.includes('.ogg')) return '<span class="sp44-mbadge sp44-mbadge-aud">🔊 Audio</span>';
      return '<span class="sp44-mbadge sp44-mbadge-img">🖼️ Imagen</span>';
    }).join('');
  }

  function previewText(content){
    if(!content) return '';
    var clean = content.replace(/\*([^*]+)\*/g,'<strong>$1</strong>').replace(/\{\{nombre\}\}/g,'<strong>[nombre]</strong>');
    var lines = clean.split('\n').filter(function(l){return l.trim();}).slice(0,3);
    return lines.join(' · ');
  }

  /* ── Product Modal (add/edit product) ── */
  function showProductModal(prod, onSave){
    var isNew=!prod;
    var bg=document.createElement('div'); bg.className='sp44-mbg';
    bg.innerHTML='<div class="sp44-modal" onclick="event.stopPropagation()">'+
      '<h3>'+(isNew?'➕ Nuevo Producto':'✏️ Editar Producto')+'</h3>'+
      '<label>Ícono</label><input id="sp44i-icon" value="'+(prod?prod.icon:'📦')+'" style="font-size:20px;text-align:center">'+
      '<label>Nombre</label><input id="sp44i-name" value="'+(prod?prod.name:'')+'" placeholder="Ej: Melena de León">'+
      '<label>ID único</label><input id="sp44i-id" value="'+(prod?prod.id:'')+'" placeholder="melena_leon" '+(isNew?'':'disabled style="opacity:.4"')+'>'+
      '<label>Mensaje de bienvenida</label><textarea id="sp44i-msg" rows="4" placeholder="Ej: \u00a1Hola {{nombre}}! \ud83c\udf3f Bienvenido a S\u00e1nate. Te cuento sobre nuestro producto...">'+(prod&&prod.message?prod.message.replace(/</g,'&lt;'):'')+'</textarea>'+
      '<label>Palabras clave (separadas por coma)</label><input id="sp44i-kw" value="'+(prod&&prod.keywords?prod.keywords.join(', '):'')+'" placeholder="hola, buenos d\u00edas, informaci\u00f3n, precio...">'+
      '<div style="font-size:12px;color:#6b7280;margin:-8px 0 12px;font-style:italic">Cuando un cliente escribe alguna de estas palabras, se activa este flujo autom\u00e1ticamente</div>'+
      '<div class="sp44-mrow">'+
        '<button class="sp44-msave" id="sp44-msave">💾 Guardar</button>'+
        '<button class="sp44-mcancel" id="sp44-mcancel">Cancelar</button>'+
      '</div></div>';
    document.body.appendChild(bg);
    bg.addEventListener('click',function(){bg.remove();});
    document.getElementById('sp44-mcancel').onclick=function(){bg.remove();};
    if(isNew){
      var ni=document.getElementById('sp44i-name');
      var ii=document.getElementById('sp44i-id');
      ni.addEventListener('input',function(){ ii.value=ni.value.toLowerCase().trim().replace(/\s+/g,'_').replace(/[^a-z0-9_]/g,''); });
    }
    document.getElementById('sp44-msave').onclick=async function(){
      var icon=document.getElementById('sp44i-icon').value.trim()||'📦';
      var name=document.getElementById('sp44i-name').value.trim();
      var id=document.getElementById('sp44i-id').value.trim();
      if(!name||!id){alert('Nombre e ID requeridos');return;}
      var kwRaw=document.getElementById('sp44i-kw').value;
      var keywords=kwRaw?kwRaw.split(',').map(function(k){return k.trim().toLowerCase();}).filter(function(k){return k;}):[];
      var message=document.getElementById('sp44i-msg').value||'';
      bg.remove(); onSave({icon:icon,name:name,id:id,subproducts:prod?prod.subproducts||[]:[],keywords:keywords,message:message});
    };
  }

  /* ── Template Edit Modal (inline edit template content) ── */
  function showEditTemplateModal(tpl, onSave){
    var bg=document.createElement('div'); bg.className='sp44-mbg';
    bg.innerHTML='<div class="sp44-modal" onclick="event.stopPropagation()">'+
      '<h3>✏️ Editar plantilla</h3>'+
      '<label>Nombre</label><input id="sp44e-name" value="'+((tpl.name||'').replace(/"/g,'&quot;'))+'">'+
      '<label>Categoría</label><input id="sp44e-cat" value="'+((tpl.category||'').replace(/"/g,'&quot;'))+'" placeholder="jabones, sebo, cierre...">'+
      '<label>Contenido del mensaje</label><textarea id="sp44e-content" rows="6">'+((tpl.content||'').replace(/</g,'&lt;'))+'</textarea>'+
      '<label>Día de seguimiento (0 = instantáneo)</label><input id="sp44e-days" type="number" value="'+(tpl.delay_days||0)+'" min="0" max="30">'+
      '<div style="display:flex;gap:8px;align-items:center;margin-bottom:10px">'+
        '<input type="checkbox" id="sp44e-followup" '+(tpl.followUp?'checked':'')+' style="width:auto;margin:0">'+
        '<label for="sp44e-followup" style="margin:0;cursor:pointer">Es seguimiento (follow-up automático)</label>'+
      '</div>'+
      '<div class="sp44-mrow">'+
        '<button class="sp44-msave" id="sp44e-save">💾 Guardar cambios</button>'+
        '<button class="sp44-mcancel" id="sp44e-cancel">Cancelar</button>'+
      '</div></div>';
    document.body.appendChild(bg);
    bg.addEventListener('click',function(){bg.remove();});
    document.getElementById('sp44e-cancel').onclick=function(){bg.remove();};
    document.getElementById('sp44e-save').onclick=function(){
      var updated = Object.assign({}, tpl, {
        name: document.getElementById('sp44e-name').value.trim(),
        category: document.getElementById('sp44e-cat').value.trim(),
        content: document.getElementById('sp44e-content').value,
        delay_days: parseInt(document.getElementById('sp44e-days').value)||0,
        followUp: document.getElementById('sp44e-followup').checked
      });
      bg.remove();
      onSave(updated);
    };
  }

  var _activeTab = 'jabones';

  function render(products, templates){
    var panel=document.getElementById('sp-disp-productos');
    if(!panel) return;

    // Group templates by product
    var byProd={};
    templates.forEach(function(t){
      var cat=t.category||'general';
      if(!byProd[cat]) byProd[cat]=[];
      byProd[cat].push(t);
    });

    // Sort follow-up templates by delay_days
    Object.keys(byProd).forEach(function(k){ byProd[k].sort(function(a,b){return (a.delay_days||0)-(b.delay_days||0);}); });

    // Ensure _activeTab is valid
    if(!products.find(function(p){return p.id===_activeTab;}) && products.length>0) _activeTab=products[0].id;

    // Build dropdown options
    var optionsHtml = products.map(function(p){
      return '<option value="'+p.id+'"'+(p.id===_activeTab?' selected':'')+'>'+(p.icon||'📦')+' '+p.name+'</option>';
    }).join('');

    // Build flows HTML for each product
    var flowsHtml = products.map(function(p,i){
      var ptpls = byProd[p.id] || [];
      var followUpTpls = ptpls.filter(function(t){return t.followUp;});
      var directTpls = ptpls.filter(function(t){return !t.followUp && !t.is_stop_trigger;});
      var stopTpl = templates.find(function(t){return t.is_stop_trigger;});

      // Sequence steps
      var stepsHtml = '';
      var bienvenida = directTpls.find(function(t){return t.id&&t.id.includes('bienvenida');})||directTpls[0];
      if(bienvenida){
        stepsHtml += stepHTML(bienvenida, 0, 'Primer contacto', false);
      }
      followUpTpls.forEach(function(t){
        var days = t.delay_days || 1;
        stepsHtml += stepHTML(t, days, t.name, false);
      });
      if(stopTpl){
        stepsHtml += stepHTML(stopTpl, null, 'Respuesta "No gracias"', true);
      }

      // Direct templates
      var directHtml = directTpls.filter(function(t){return !t.id||!t.id.includes('bienvenida');}).map(function(t){
        return '<div class="sp44-step-card" style="margin-bottom:6px" data-tpl-id="'+t.id+'">'+
          '<div class="sp44-step-meta">'+
            '<span class="sp44-day-badge sp44-day-0">⚡ INSTANTÁNEO</span>'+
            '<span class="sp44-step-name">'+t.name+'</span>'+
          '</div>'+
          '<div class="sp44-preview">'+previewText(t.content)+'</div>'+
          '<div class="sp44-media-badges">'+mediaHTML(t.media)+'</div>'+
          '<div class="sp44-step-btns">'+
            '<button class="sp44-sb sp44-sb-edit" data-tpl-id="'+t.id+'">✏️ Editar</button>'+
            '<button class="sp44-sb sp44-sb-rem" data-tpl-id="'+t.id+'">✕ Quitar</button>'+
          '</div>'+
        '</div>';
      }).join('');

      var hasContent = followUpTpls.length||bienvenida;
      var bodyHtml = hasContent
        ? '<div class="sp44-section-lbl">📋 PLANTILLAS DIRECTAS</div>'+directHtml+
          '<div class="sp44-section-lbl" style="margin-top:12px">🔄 SECUENCIA DE SEGUIMIENTO</div>'+
          '<div class="sp44-seq">'+stepsHtml+'</div>'
        : '<div style="color:#475569;font-size:12px;text-align:center;padding:20px">Sin plantillas para '+p.name+' — <span style="color:#3b82f6;cursor:pointer" class="sp44-gopl" data-prod="'+p.id+'">+ Agregar plantilla</span></div>';

      return '<div class="sp44-flow'+(p.id===_activeTab?' active':'')+'" data-prod="'+p.id+'">'+
        '<div class="sp44-flow-hdr">'+
          '<span class="sp44-flow-icon">'+(p.icon||'📦')+'</span>'+
          '<span class="sp44-flow-title">Flujo '+p.name+'</span>'+
          '<div class="sp44-flow-actions">'+
            '<button class="sp44-fab sp44-fab-edit sp44-btn-ep" data-idx="'+i+'">✏️ Editar</button>'+
          '</div>'+
        '</div>'+
        '<div class="sp44-rules">'+
          '<div class="sp44-rules-title">⚙️ Lógica del flujo</div>'+
          '<div class="sp44-rule"><span class="sp44-rule-icon">🟢</span><span>Cliente escribe palabra clave → se activa mensaje de bienvenida + secuencia automática</span></div>'+
          '<div class="sp44-rule"><span class="sp44-rule-icon">🔄</span><span>Sin respuesta → seguimiento automático: Día 1 → Día 3 → Día 7 → Día 14</span></div>'+
          '<div class="sp44-rule"><span class="sp44-rule-icon">🛑</span><span>"No gracias" / "Para" / "Stop" → detiene TODOS los disparadores + etiqueta <strong>Pausado</strong></span></div>'+
          '<div class="sp44-rule"><span class="sp44-rule-icon">⭐</span><span>Cliente envía datos de pedido → etiqueta <strong>Por Facturar</strong> automáticamente</span></div>'+
        '</div>'+
        (function(){
          var kws = p.keywords||[];
          var kwHtml = kws.length
            ? kws.map(function(k){return '<span class="sp44-kw-tag">'+k+' <span class="sp44-kw-x" data-prod="'+p.id+'" data-kw="'+k+'">\u00d7</span></span>';}).join('')
            : '<span style="font-size:13px;color:#6b7280;font-style:italic">Sin palabras clave configuradas</span>';
          return '<div class="sp44-keywords-box">'+
            '<div class="sp44-kw-title">\ud83d\udd11 Palabras clave que activan este flujo</div>'+
            '<div class="sp44-kw-list" data-prod="'+p.id+'">'+kwHtml+'</div>'+
            '<div class="sp44-kw-add-row">'+
              '<input class="sp44-kw-input" data-prod="'+p.id+'" placeholder="Escribir palabra clave..." onkeydown="if(event.key===\'Enter\'){event.preventDefault();this.nextElementSibling.click();}">'+
              '<button class="sp44-kw-btn sp44-kw-addbtn" data-prod="'+p.id+'">+ Agregar</button>'+
            '</div>'+
            '<div class="sp44-kw-hint">Ej: hola, buenos d\u00edas, informaci\u00f3n, precio, saludos</div>'+
          '</div>';
        })()+
        (p.message?'<div class="sp44-rules" style="background:#eff6ff;border-color:#bfdbfe"><div class="sp44-rules-title">\ud83d\udcac Mensaje de bienvenida</div><div style="font-size:13px;color:#1e40af;line-height:1.6;white-space:pre-wrap">'+previewText(p.message)+'</div></div>':'')+
        bodyHtml+
        '<div class="sp44-addstep sp44-btn-newtpl" data-prod="'+p.id+'">＋ Nueva plantilla para '+p.name+'</div>'+
      '</div>';
    }).join('');

    // Labels section
    var labelsHtml = '<div class="sp44-labels">'+
      '<div class="sp44-rules-title">🏷️ Etiquetas automáticas</div>'+
      '<div class="sp44-label-row">'+
        '<span class="sp44-label-tag sp44-lbl-green">Por Facturar</span>'+
        '<span>Se aplica cuando el cliente envía nombre + dirección + ciudad (datos de envío)</span>'+
      '</div>'+
      '<div class="sp44-label-row">'+
        '<span class="sp44-label-tag sp44-lbl-red">Pausado</span>'+
        '<span>Se aplica cuando el cliente dice "no gracias", "para", "stop" — detiene toda automatización</span>'+
      '</div>'+
      '<div class="sp44-label-row">'+
        '<span class="sp44-label-tag sp44-lbl-blue">Interesado</span>'+
        '<span>Se detecta cuando el cliente pregunta precios, pide info o muestra interés</span>'+
      '</div>'+
      '<div class="sp44-label-row">'+
        '<span class="sp44-label-tag sp44-lbl-orange">Cliente</span>'+
        '<span>Se detecta cuando confirma compra, envía comprobante de pago o datos</span>'+
      '</div>'+
    '</div>';

    panel.innerHTML =
      '<div class="sp44-hdr">'+
        '<span class="sp44-hdr-title">📦 Flujos por Producto</span>'+
        '<select class="sp44-select" id="sp44-prod-select">'+optionsHtml+'</select>'+
        '<button class="sp44-btn-add" id="sp44-addprod">＋ Agregar</button>'+
        '<button class="sp44-btn-del" id="sp44-delprod">✕ Quitar flujo</button>'+
      '</div>'+
      flowsHtml+
      '<hr class="sp44-divider">'+
      labelsHtml;

    // ── Bind events ──

    // Dropdown switching
    var sel=panel.querySelector('#sp44-prod-select');
    if(sel) sel.addEventListener('change',function(){
      _activeTab=sel.value;
      panel.querySelectorAll('.sp44-flow').forEach(function(f){f.classList.remove('active');});
      var flow=panel.querySelector('.sp44-flow[data-prod="'+_activeTab+'"]');
      if(flow) flow.classList.add('active');
    });

    // Add product
    var addBtn=panel.querySelector('#sp44-addprod');
    if(addBtn) addBtn.addEventListener('click',function(){
      showProductModal(null,async function(np){
        var prods=[].concat(window.__sp44_products||[]);
        if(prods.find(function(p){return p.id===np.id;})){alert('ID ya existe: '+np.id);return;}
        prods.push(np);
        await saveProducts(prods);
        _activeTab=np.id;
        render(prods,window.__sp44_templates||[]);
      });
    });

    // Delete current product flow
    var delBtn=panel.querySelector('#sp44-delprod');
    if(delBtn) delBtn.addEventListener('click',async function(){
      var prods=window.__sp44_products||[];
      var cur=prods.find(function(p){return p.id===_activeTab;});
      if(!cur){alert('Selecciona un producto primero');return;}
      if(!confirm('¿Quitar flujo "'+cur.name+'"?\nLas plantillas asociadas NO se eliminarán.')){return;}
      var newProds=prods.filter(function(p){return p.id!==_activeTab;});
      await saveProducts(newProds);
      _activeTab=newProds.length?newProds[0].id:'';
      render(newProds,window.__sp44_templates||[]);
    });

    // Edit product
    panel.querySelectorAll('.sp44-btn-ep').forEach(function(btn){
      btn.addEventListener('click',function(){
        var idx=parseInt(btn.dataset.idx);
        var prods=window.__sp44_products||[];
        showProductModal(prods[idx],async function(upd){
          prods[idx]=upd; await saveProducts([].concat(prods)); render(prods,window.__sp44_templates||[]);
        });
      });
    });

    // Edit template inline
    panel.querySelectorAll('.sp44-sb-edit').forEach(function(btn){
      btn.addEventListener('click',function(){
        var tplId=btn.dataset.tplId;
        var tpls=window.__sp44_templates||[];
        var tpl=tpls.find(function(t){return t.id===tplId;});
        if(!tpl){alert('Plantilla no encontrada');return;}
        showEditTemplateModal(tpl,async function(updated){
          var newTpls=tpls.map(function(t){return t.id===tplId?updated:t;});
          await saveTemplates(newTpls);
          render(window.__sp44_products||[],newTpls);
        });
      });
    });

    // Remove template from flow (just unsets category, doesn't delete)
    panel.querySelectorAll('.sp44-sb-rem').forEach(function(btn){
      btn.addEventListener('click',async function(){
        var tplId=btn.dataset.tplId;
        var tpls=window.__sp44_templates||[];
        var tpl=tpls.find(function(t){return t.id===tplId;});
        if(!tpl) return;
        if(!confirm('¿Quitar "'+tpl.name+'" de este flujo?\n(La plantilla no se elimina, solo se desasocia del producto)')){return;}
        var newTpls=tpls.map(function(t){
          if(t.id===tplId){var c=Object.assign({},t);c.category='general';return c;}
          return t;
        });
        await saveTemplates(newTpls);
        render(window.__sp44_products||[],newTpls);
      });
    });

    // New template → go to Plantillas + filter
    panel.querySelectorAll('.sp44-btn-newtpl,.sp44-gopl').forEach(function(btn){
      btn.addEventListener('click',function(){
        var prod=btn.dataset.prod;
        var navEl=Array.from(document.querySelectorAll('*')).find(function(el){return el.innerText&&el.innerText.trim()==='📋 Plantillas'&&el.children.length===0;});
        if(navEl){ navEl.click(); setTimeout(function(){ if(typeof window.elegirProducto==='function') window.elegirProducto(prod); setTimeout(function(){ var nb=Array.from(document.querySelectorAll('button')).find(function(b){return b.innerText.includes('Nueva plantilla')||b.innerText.includes('＋ Nueva');}); if(nb) nb.click(); },500); },700); }
      });
    });

    // "Use template" → go to Plantillas
    panel.querySelectorAll('.sp44-sb-use').forEach(function(btn){
      btn.addEventListener('click',function(){
        var navEl=Array.from(document.querySelectorAll('*')).find(function(el){return el.innerText&&el.innerText.trim()==='📋 Plantillas'&&el.children.length===0;});
        if(navEl) navEl.click();
      });
    });

    // "Add trigger" → click + Nuevo disparador
    panel.querySelectorAll('.sp44-sb-add').forEach(function(btn){
      btn.addEventListener('click',function(){
        var db=Array.from(document.querySelectorAll('button')).find(function(b){return b.innerText.trim()==='+ Nuevo disparador';});
        if(db) db.click();
      });
    });

    // ── Keyword add buttons ──
    panel.querySelectorAll('.sp44-kw-addbtn').forEach(function(btn){
      btn.addEventListener('click',async function(){
        var prodId=btn.dataset.prod;
        var input=panel.querySelector('.sp44-kw-input[data-prod="'+prodId+'"]');
        if(!input) return;
        var val=input.value.trim().toLowerCase();
        if(!val){input.focus();return;}
        var prods=[].concat(window.__sp44_products||[]);
        var prod=prods.find(function(p){return p.id===prodId;});
        if(!prod) return;
        if(!prod.keywords) prod.keywords=[];
        if(prod.keywords.indexOf(val)===-1) prod.keywords.push(val);
        await saveProducts(prods);
        render(prods,window.__sp44_templates||[]);
      });
    });

    // ── Keyword remove (× button) ──
    panel.querySelectorAll('.sp44-kw-x').forEach(function(btn){
      btn.addEventListener('click',async function(){
        var prodId=btn.dataset.prod;
        var kw=btn.dataset.kw;
        var prods=[].concat(window.__sp44_products||[]);
        var prod=prods.find(function(p){return p.id===prodId;});
        if(!prod||!prod.keywords) return;
        prod.keywords=prod.keywords.filter(function(k){return k!==kw;});
        await saveProducts(prods);
        render(prods,window.__sp44_templates||[]);
      });
    });
  }

  function stepHTML(tpl, days, label, isStop){
    var dc = dayClass(days);
    var dayBadge = isStop
      ? '<span class="sp44-stop-badge">🛑 STOP</span>'
      : '<span class="sp44-day-badge sp44-'+dc+'">'+dayLabel(days)+'</span>';
    var dotColors = {
      'day-0':['#dcfce7','#22c55e'],'day-1':['#dbeafe','#3b82f6'],
      'day-3':['#ede9fe','#8b5cf6'],'day-7':['#fff7ed','#f59e0b'],'day-14':['#fef2f2','#ef4444']
    };
    var dotBg = isStop?'#fef2f2':(dotColors[dc]||dotColors['day-14'])[0];
    var dotBorder = isStop?'#fca5a5':(dotColors[dc]||dotColors['day-14'])[1];
    var dotIcon = isStop?'🛑':days===0?'💬':days<=1?'1':days<=3?'3':days<=7?'7':'✓';
    return '<div class="sp44-step">'+
      '<div class="sp44-step-line">'+
        '<div class="sp44-step-dot" style="background:'+dotBg+';border:2px solid '+dotBorder+'">'+dotIcon+'</div>'+
        (isStop?'':'<div class="sp44-step-connector"></div>')+
      '</div>'+
      '<div class="sp44-step-card'+(isStop?' stop':'')+'">'+
        '<div class="sp44-step-meta">'+
          dayBadge+
          '<span class="sp44-step-name">'+(tpl.name||label)+'</span>'+
        '</div>'+
        '<div class="sp44-preview">'+previewText(tpl.content)+'</div>'+
        '<div class="sp44-media-badges">'+mediaHTML(tpl.media)+'</div>'+
        '<div class="sp44-step-btns">'+
          '<button class="sp44-sb sp44-sb-edit" data-tpl-id="'+tpl.id+'">✏️ Editar</button>'+
          '<button class="sp44-sb sp44-sb-use">📋 Ver plantilla</button>'+
          (isStop?'':'<button class="sp44-sb sp44-sb-add">⚡ Crear disparador</button>')+
          (isStop?'':'<button class="sp44-sb sp44-sb-rem" data-tpl-id="'+tpl.id+'">✕ Quitar</button>')+
        '</div>'+
      '</div>'+
    '</div>';
  }

  async function injectPanel(){
    var topbar=document.querySelector('.wbv5-topbar');
    if(!topbar||!topbar.innerText.includes('Disparadores')) return;
    if(document.getElementById('sp-disp-productos')) return;
    var content=document.querySelector('.wbv5-content');
    if(!content) return;
    var panel=document.createElement('div');
    panel.id='sp-disp-productos';
    panel.innerHTML='<div style="color:#475569;font-size:12px;padding:6px 0">⏳ Cargando flujos...</div>';
    content.insertBefore(panel,content.firstChild);
    var data=await loadData();
    render(data.products,data.templates);
  }

  function cleanup(){ var p=document.getElementById('sp-disp-productos'); if(p) // Restore opacity
      if(p.parentElement) p.parentElement.classList.remove('sp48-opaque');
      // Restore scroll
      var m48 = p.closest('.wbv5-main'); if(m48) m48.style.overflowY = '';
      p.remove(); }

  var _lastBar='';
  new MutationObserver(function(){
    var tb=document.querySelector('.wbv5-topbar');
    var cur=tb?tb.innerText.substring(0,50):'';
    if(cur===_lastBar) return; _lastBar=cur;
    if(cur.includes('Disparadores')) setTimeout(injectPanel,250);
    else cleanup();
  }).observe(document.body,{childList:true,subtree:true});

  setTimeout(injectPanel,400);
  console.info('[WA-OASIS] Fix 44 v2: Disparadores dropdown + +/× flujos + editable + etiquetas auto');
})();
// ═══════════════════════════════════════════════════════
// FIX 45 — Reparar panel de chat (sp-v34-css y sp-fix24-css rompían wbv5-cw-header/msgs/input-bar en desktop)
// ═══════════════════════════════════════════════════════
(function fix45(){
  if(window.__spFix45) return; window.__spFix45=true;

  function applyFix(){
    // 1. ELIMINAR sp-v34-css — ocultaba cw-header/msgs/input-bar siempre en desktop ≥901px (incorrecto)
    var v34 = document.getElementById('sp-v34-css');
    if(v34) v34.remove();

    // 2. LIMPIAR sp-fix24-css — solo debe afectar el background del chat-win, NO visibility de header/msgs/input
    var fix24 = document.getElementById('sp-fix24-css');
    if(fix24) {
      fix24.textContent = [
        // Solo background del chat-win (correcto)
        '.wbv5-chat-win{background:#f0f2f5!important;}',
        // Móvil: ocultar chat-win cuando no hay chat seleccionado
        '@media(max-width:900px){',
        '.wbv5-chat-win:not(.sp-chat-open){display:none!important;}',
        '.wbv5-inbox-list{width:100%!important;max-width:100%!important;flex:1 1 100%!important;min-width:0!important;}',
        '.wbv5-chat-wrap{display:block!important;}',
        '}'
      ].join('');
    }

    // 3. ASEGURAR que cw-header/msgs/input-bar son visibles cuando hay chat activo
    //    (fix15/fix30 ya manejan el modo iframe con sp-iframe-active, no tocar eso)
    var fix45restore = document.getElementById('sp-fix45-restore');
    if(!fix45restore){
      var s = document.createElement('style');
      s.id = 'sp-fix45-restore';
      s.textContent = [
        // Restaurar visibilidad de los elementos del chat en desktop
        '.wbv5-cw-header{visibility:visible!important;display:flex!important;}',
        '.wbv5-cw-msgs{visibility:visible!important;display:flex!important;flex-direction:column!important;}',
        '.wbv5-cw-input-bar{visibility:visible!important;display:flex!important;}',
        // Pero ocultarlos cuando NO hay chat seleccionado (sin clase sp-chat-active en el win)
        '.wbv5-chat-win:not(.sp-chat-active) .wbv5-cw-header{display:none!important;}',
        '.wbv5-chat-win:not(.sp-chat-active) .wbv5-cw-msgs{display:none!important;}',
        '.wbv5-chat-win:not(.sp-chat-active) .wbv5-cw-input-bar{display:none!important;}',
        // Cuando iframe activo, ocultar nativo (fix15/30 lo hacen pero por si acaso)
        '.wbv5-chat-win.sp-iframe-active .wbv5-cw-header{display:none!important;}',
        '.wbv5-chat-win.sp-iframe-active .wbv5-cw-msgs{display:none!important;}',
        '.wbv5-chat-win.sp-iframe-active .wbv5-cw-input-bar{display:none!important;}',
      ].join('');
      document.head.appendChild(s);
    }

    // 4. Asegurarnos de que al hacer clic en un chat, se añade sp-chat-active al wbv5-chat-win
    //    Observamos cambios en wbv5-cw-header para detectar cuándo React activa un chat
    var win = document.querySelector('.wbv5-chat-win');
    if(win && !win._fix45Patched) {
      win._fix45Patched = true;
      new MutationObserver(function(mutations){
        var header = win.querySelector('.wbv5-cw-header');
        if(!header) return;
        // Si React pone display != none en el header, significa que hay un chat activo
        var headerStyle = header.getAttribute('style') || '';
        var reactDisplay = headerStyle.includes('display') ? (headerStyle.includes('none') ? 'none' : 'flex') : 'flex';
        // También revisar si tiene contenido (chatId populated)
        var hasContent = header.innerText.trim().length > 0;
        if(hasContent){
          win.classList.add('sp-chat-active');
        } else {
          win.classList.remove('sp-chat-active');
        }
      }).observe(win, {childList: true, subtree: true, attributes: true, attributeFilter: ['style','class']});

      // Check estado actual
      var h = win.querySelector('.wbv5-cw-header');
      if(h && h.innerText.trim().length > 0) win.classList.add('sp-chat-active');
    }

    console.info('[WA-OASIS] Fix 45: Chat panel reparado — sp-v34-css eliminado, sp-fix24-css corregido');
  }

  // Aplicar inmediatamente y también después de que React monte
  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', applyFix);
  } else {
    applyFix();
    // Re-aplicar por si React re-renderiza los estilos
    setTimeout(applyFix, 1000);
    setTimeout(applyFix, 3000);
  }
})();

// ═══════════════════════════════════════════════════════
// FIX 46 — Pantalla blanca en Chats: eliminar CSS ofensivos sin lógica condicional nueva
// ═══════════════════════════════════════════════════════
(function fix46(){
  if(window.__spFix46) return; window.__spFix46=true;

  function applyFix(){
    // 1. Eliminar sp-v34-css (oculta cw-header/msgs/input-bar en desktop ≥901px)
    var v34 = document.getElementById('sp-v34-css');
    if(v34) v34.remove();

    // 2. Limpiar sp-fix24-css — solo background, sin visibility:hidden
    var fix24 = document.getElementById('sp-fix24-css');
    if(fix24) {
      fix24.textContent = '.wbv5-chat-win{background:#f0f2f5!important;}';
    }

    // 3. Eliminar sp-fix45-restore que tenía lógica condicional problemática
    var f45r = document.getElementById('sp-fix45-restore');
    if(f45r) f45r.remove();

    // 4. CSS simple: restaurar visibilidad sin condiciones
    var f46 = document.getElementById('sp-fix46-css');
    if(!f46){
      var s = document.createElement('style');
      s.id = 'sp-fix46-css';
      s.textContent = [
        '.wbv5-cw-header{visibility:visible!important;}',
        '.wbv5-cw-msgs{visibility:visible!important;}',
        '.wbv5-cw-input-bar{visibility:visible!important;}'
      ].join('');
      document.head.appendChild(s);
    }
  }

  // Aplicar varias veces para cubrir el ciclo de render de React
  applyFix();
  setTimeout(applyFix, 300);
  setTimeout(applyFix, 1000);
  setTimeout(applyFix, 3000);

  // Vigilar si sp-v34-css vuelve a aparecer (inyectado por otros fixes)
  new MutationObserver(function(){
    var v34 = document.getElementById('sp-v34-css');
    if(v34) v34.remove();
    var f45r = document.getElementById('sp-fix45-restore');
    if(f45r) f45r.remove();
  }).observe(document.head, {childList: true});

  console.info('[WA-OASIS] Fix 46: Chat panel restaurado — CSS ofensivos eliminados');
})();


/* ============================================================
   FIX 47 — Chat switching: click handler maestro (CRITICAL)
   Sentinel '__pending__' system + poll header for JID resolution
   TUNED: 60ms x 30 tries = 1.8s max (was 80ms x 50 = 4s)
   MutationObserver fallback kicks in sooner
   ============================================================ */
(function fix47(){
  if(window.__spFix47) return;
  window.__spFix47 = true;
  if(window.location.pathname.indexOf('/dashboard/whatsapp-bot') !== 0) return;

  /* ── 1. Override injectDesktopChatIframe — definitive version ── */
  function patchInject47(){
    window.injectDesktopChatIframe = function(){
      if(window.matchMedia('(max-width:900px)').matches) return;
      if(window.location.pathname.indexOf('whatsapp-bot') === -1) return;
      var cw = document.querySelector('.wbv5-chat-win');
      if(!cw) return;

      var jid = window.__lastClickedJid || null;
      if(jid === '__pending__') jid = null;

      if(!jid){
        if(window.__spShowPlaceholder) window.__spShowPlaceholder();
        return;
      }
      if(window.__spHidePlaceholder) window.__spHidePlaceholder();

      var existing = document.getElementById('sp-chat-iframe');
      if(existing){
        if(existing.dataset.jid !== jid){
          existing.dataset.jid = jid;
          /* Preconnect hint for faster iframe load */
          var link = document.querySelector('link[rel="preconnect"][href="/bot"]');
          if(!link){
            link = document.createElement('link');
            link.rel = 'preconnect';
            link.href = window.location.origin;
            document.head.appendChild(link);
          }
          existing.src = '/bot/chat.html?jid=' + encodeURIComponent(jid) + '&t=' + Date.now();
        }
        existing.style.display = 'block';
        existing.style.zIndex = '10';
        cw.classList.add('sp-iframe-active');
        return;
      }
      /* Preconnect hint before creating iframe */
      var preLink = document.querySelector('link[rel="preconnect"][href="' + window.location.origin + '"]');
      if(!preLink){
        preLink = document.createElement('link');
        preLink.rel = 'preconnect';
        preLink.href = window.location.origin;
        document.head.appendChild(preLink);
      }
      var iframe = document.createElement('iframe');
      iframe.id = 'sp-chat-iframe';
      iframe.dataset.jid = jid;
      iframe.src = '/bot/chat.html?jid=' + encodeURIComponent(jid) + '&t=' + Date.now();
      iframe.allow = 'microphone';
      iframe.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;border:none;z-index:10;background:#fff;display:block;';
      cw.style.position = 'relative';
      cw.style.overflow = 'hidden';
      cw.classList.add('sp-iframe-active');
      cw.appendChild(iframe);
    };
  }

  /* ── 2. Click handler maestro for desktop ── */
  function attachClick47(){
    var inbox = document.querySelector('.wbv5-inbox-list');
    if(!inbox || inbox.__sp47) return;
    inbox.__sp47 = true;

    inbox.addEventListener('click', function(e){
      var item = e.target.closest ? e.target.closest('.wbv5-conv-itm') : null;
      if(!item) return;

      window.__spUserPickedChat = true;

      /* Desktop only */
      if(window.innerWidth <= 900) return;

      /* Immediate attempt: data-jid, data-id, or numeric name */
      var jid = item.getAttribute('data-jid') || item.getAttribute('data-id') || '';
      if(!jid){
        var nameEl = item.querySelector('.wbv5-ci-name');
        if(nameEl){
          var raw = nameEl.textContent.replace(/⚡[^⚡]*/g,'').trim();
          var num = raw.replace(/\D/g,'');
          if(num.length >= 8) jid = num + '@s.whatsapp.net';
        }
      }

      if(jid){
        window.__lastClickedJid = jid;
        setTimeout(function(){ window.injectDesktopChatIframe(); }, 100);
        return;
      }

      /* No JID from item → sentinel + poll header */
      var oldIframeJid = '';
      var iframeEl = document.getElementById('sp-chat-iframe');
      if(iframeEl) oldIframeJid = iframeEl.dataset.jid || '';

      window.__lastClickedJid = '__pending__';

      var resolved = false;
      function tryResolve(){
        if(resolved) return false;
        if(window.__lastClickedJid !== '__pending__') { resolved = true; return false; }
        var sub = document.querySelector('.wbv5-cw-sub');
        if(!sub) return false;
        var digits = sub.textContent.replace(/[^0-9]/g,'');
        if(digits.length < 8) return false;
        var newJid = digits + '@s.whatsapp.net';
        if(newJid !== oldIframeJid || !oldIframeJid){
          resolved = true;
          window.__lastClickedJid = newJid;
          window.injectDesktopChatIframe();
          return true;
        }
        return false;
      }

      /* TUNED: 60ms x 30 = 1.8s max (was 80ms x 50 = 4s) */
      var tries = 0;
      function pollStep(){
        tries++;
        if(tryResolve()) return;
        if(tries < 30){
          setTimeout(pollStep, 60);
          return;
        }
        /* Last attempt: use whatever is in the header */
        var sub = document.querySelector('.wbv5-cw-sub');
        if(sub){
          var d = sub.textContent.replace(/[^0-9]/g,'');
          if(d.length >= 8){
            resolved = true;
            window.__lastClickedJid = d + '@s.whatsapp.net';
            window.injectDesktopChatIframe();
            return;
          }
        }
        /* Fallback: MutationObserver for when React creates .wbv5-cw-sub */
        if(!resolved){
          var mo = new MutationObserver(function(muts, obs){
            if(tryResolve()){ obs.disconnect(); }
          });
          mo.observe(document.body, {childList:true, subtree:true, characterData:true});
          setTimeout(function(){ mo.disconnect(); }, 5000);
        }
      }
      setTimeout(pollStep, 60);
    }, true);
  }

  /* ── Apply ── */
  patchInject47();
  [200, 2000, 5000, 9000].forEach(function(d){ setTimeout(patchInject47, d); });

  attachClick47();
  [300, 1200, 3000, 6000].forEach(function(d){ setTimeout(attachClick47, d); });

  /* Reconnect if React recreates inbox */
  setTimeout(function(){
    new MutationObserver(function(){
      var inbox = document.querySelector('.wbv5-inbox-list');
      if(inbox && !inbox.__sp47) attachClick47();
    }).observe(document.body, {childList:true, subtree:true});
  }, 1200);
})();
// ═══════════════════════════════════════════════════════
// FIX 48 v3 — Difusiones: Template selector, Lead filters, Live progress, History
// ═══════════════════════════════════════════════════════
(function fix48(){
  if(window.__spFix48) return;
  window.__spFix48 = true;

  var API = 'https://sanate-wa-bot.onrender.com/api/whatsapp';
  var HISTORY_KEY = 'sp48_broadcast_history';

  /* ── Load SheetJS for Excel parsing ── */
  if(!window.XLSX){
    var xlsxScript = document.createElement('script');
    xlsxScript.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    document.head.appendChild(xlsxScript);
  }

  /* ── CSS ── */
  var css = document.createElement('style');
  css.id = 'sp48-css';
  css.textContent = [
    '#sp-difusion-panel{padding:4px 0 8px 0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;position:relative;z-index:10;background:#f1f5f9;min-height:100%}',
    '.wbv5-main:has(#sp-difusion-panel){overflow-y:auto!important}',
    '.sp48-opaque{opacity:1!important;background:transparent!important}',
    '.sp48-card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:18px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,.05)}',
    '.sp48-title{font-size:16px;font-weight:700;color:#1e293b;margin-bottom:12px;display:flex;align-items:center;gap:8px}',
    '.sp48-subtitle{font-size:13px;color:#64748b;margin-bottom:12px}',
    '.sp48-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}',
    '.sp48-btn{padding:8px 16px;border-radius:8px;border:none;font-size:13px;font-weight:600;cursor:pointer;transition:all .15s}',
    '.sp48-btn:hover{opacity:.85}',
    '.sp48-btn-primary{background:#1d4ed8;color:#fff}',
    '.sp48-btn-success{background:#059669;color:#fff}',
    '.sp48-btn-danger{background:#dc2626;color:#fff}',
    '.sp48-btn-warning{background:#f59e0b;color:#fff}',
    '.sp48-btn-outline{background:#fff;color:#475569;border:1px solid #cbd5e1}',
    '.sp48-btn-outline:hover{background:#f1f5f9}',
    '.sp48-btn-outline.active{background:#dbeafe;color:#1d4ed8;border-color:#93c5fd}',
    '.sp48-btn-sm{padding:5px 10px;font-size:12px}',
    '.sp48-btn:disabled{opacity:.5;cursor:not-allowed}',
    '.sp48-input{width:100%;padding:9px 12px;background:#f8fafc;border:1px solid #cbd5e1;border-radius:8px;color:#1e293b;font-size:14px;outline:none;box-sizing:border-box;resize:vertical}',
    '.sp48-input:focus{border-color:#3b82f6;background:#fff}',
    '.sp48-label{display:block;font-size:12px;color:#475569;margin-bottom:4px;font-weight:600;text-transform:uppercase;letter-spacing:.04em}',
    '.sp48-select{padding:8px 12px;background:#fff;border:1px solid #cbd5e1;border-radius:8px;color:#1e293b;font-size:13px;outline:none;cursor:pointer}',
    '.sp48-chip-list{display:flex;flex-wrap:wrap;gap:6px;max-height:200px;overflow-y:auto;padding:8px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:10px}',
    '.sp48-chip{display:inline-flex;align-items:center;gap:4px;padding:4px 10px;background:#dbeafe;color:#1e40af;border:1px solid #93c5fd;border-radius:20px;font-size:12px;font-weight:600}',
    '.sp48-chip-num{background:#1e40af;color:#fff;border-radius:50%;width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex-shrink:0}',
    '.sp48-chip-x{cursor:pointer;font-size:14px;color:#dc2626;font-weight:700;line-height:1}',
    '.sp48-chip-x:hover{color:#991b1b}',
    '.sp48-chip.sp48-chip-sent{background:#dcfce7;color:#166534;border-color:#86efac}',
    '.sp48-chip.sp48-chip-fail{background:#fef2f2;color:#dc2626;border-color:#fca5a5}',
    '.sp48-chip.sp48-chip-pending{background:#f1f5f9;color:#475569;border-color:#cbd5e1}',
    '.sp48-chip.sp48-chip-sending{background:#fef3c7;color:#92400e;border-color:#fde68a;animation:sp48pulse 1s infinite}',
    '@keyframes sp48pulse{0%,100%{opacity:1}50%{opacity:.5}}',
    '@keyframes sp48spin{to{transform:rotate(360deg)}}',
    '.sp48-progress{width:100%;height:10px;background:#e2e8f0;border-radius:5px;overflow:hidden;margin:10px 0}',
    '.sp48-progress-bar{height:100%;background:linear-gradient(90deg,#059669,#34d399);border-radius:5px;transition:width .3s}',
    '.sp48-stats{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:12px}',
    '.sp48-stat{text-align:center;padding:10px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;min-width:80px}',
    '.sp48-stat-num{font-size:22px;font-weight:800;color:#1e293b}',
    '.sp48-stat-lbl{font-size:11px;color:#64748b;text-transform:uppercase;font-weight:600}',
    '.sp48-warn{background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:10px 14px;font-size:13px;color:#92400e;margin-bottom:12px;display:flex;align-items:flex-start;gap:8px}',
    '.sp48-warn-icon{font-size:16px;flex-shrink:0}',
    '.sp48-log{max-height:150px;overflow-y:auto;background:#0f172a;border-radius:8px;padding:10px 14px;font-size:12px;color:#94a3b8;font-family:"Fira Code",monospace;margin-top:8px}',
    '.sp48-log-entry{margin-bottom:2px;padding:2px 0;border-bottom:1px solid rgba(255,255,255,.05)}',
    '.sp48-log-ok{color:#34d399}',
    '.sp48-log-err{color:#f87171}',
    '.sp48-log-info{color:#60a5fa}',
    '.sp48-divider{border:none;border-top:1px solid #e2e8f0;margin:16px 0}',
    '.sp48-count-badge{background:#dbeafe;color:#1e40af;padding:2px 8px;border-radius:12px;font-size:12px;font-weight:700}',
    /* Tabs */
    '.sp48-tabs{display:flex;gap:0;margin-bottom:16px;border-bottom:2px solid #e2e8f0}',
    '.sp48-tab{padding:10px 20px;font-size:14px;font-weight:600;color:#64748b;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-2px;transition:all .15s}',
    '.sp48-tab:hover{color:#1e293b}',
    '.sp48-tab.active{color:#1d4ed8;border-bottom-color:#1d4ed8}',
    /* Main view tabs (Nueva Difusion vs Historial) */
    '.sp48-view-tabs{display:flex;gap:0;margin-bottom:0;background:#fff;border-radius:12px 12px 0 0;border-bottom:2px solid #e2e8f0}',
    '.sp48-view-tab{flex:1;padding:14px 20px;font-size:15px;font-weight:700;color:#64748b;cursor:pointer;text-align:center;border-bottom:3px solid transparent;margin-bottom:-2px;transition:all .15s}',
    '.sp48-view-tab:hover{color:#1e293b;background:#f8fafc}',
    '.sp48-view-tab.active{color:#1d4ed8;border-bottom-color:#1d4ed8;background:#eff6ff}',
    /* Template selector */
    '.sp48-tpl-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px;margin:10px 0}',
    '.sp48-tpl-card{border:2px solid #e2e8f0;border-radius:10px;padding:12px;cursor:pointer;transition:all .15s;background:#fff;position:relative}',
    '.sp48-tpl-card:hover{border-color:#93c5fd;background:#eff6ff}',
    '.sp48-tpl-card.selected{border-color:#1d4ed8;background:#dbeafe;box-shadow:0 0 0 3px rgba(29,78,216,.15)}',
    '.sp48-tpl-card .sp48-tpl-name{font-size:14px;font-weight:700;color:#1e293b;margin-bottom:4px}',
    '.sp48-tpl-card .sp48-tpl-cat{font-size:11px;color:#64748b;background:#f1f5f9;padding:2px 8px;border-radius:10px;display:inline-block}',
    '.sp48-tpl-card .sp48-tpl-preview{font-size:12px;color:#475569;margin-top:8px;line-height:1.5;max-height:60px;overflow:hidden;white-space:pre-wrap}',
    '.sp48-tpl-card .sp48-tpl-check{position:absolute;top:8px;right:8px;width:22px;height:22px;border-radius:50%;background:#1d4ed8;color:#fff;display:none;align-items:center;justify-content:center;font-size:13px;font-weight:700}',
    '.sp48-tpl-card.selected .sp48-tpl-check{display:flex}',
    '.sp48-tpl-full-preview{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:14px;margin:10px 0;font-size:13px;color:#166534;white-space:pre-wrap;line-height:1.6}',
    /* Lead filter chips */
    '.sp48-lead-filters{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}',
    '.sp48-lead-btn{padding:6px 14px;border-radius:20px;border:2px solid #e2e8f0;font-size:13px;font-weight:600;cursor:pointer;transition:all .15s;background:#fff;display:flex;align-items:center;gap:4px}',
    '.sp48-lead-btn:hover{background:#f1f5f9}',
    '.sp48-lead-btn.active{border-color:#1d4ed8;background:#dbeafe;color:#1d4ed8}',
    '.sp48-lead-btn .sp48-lead-count{background:#e2e8f0;color:#475569;padding:1px 6px;border-radius:10px;font-size:11px;font-weight:700}',
    '.sp48-lead-btn.active .sp48-lead-count{background:#1d4ed8;color:#fff}',
    /* Import zone */
    '.sp48-import-zone{border:2px dashed #cbd5e1;border-radius:12px;padding:20px;text-align:center;cursor:pointer;transition:all .2s;background:#f8fafc;margin-bottom:12px}',
    '.sp48-import-zone:hover,.sp48-import-zone.dragover{border-color:#3b82f6;background:#eff6ff}',
    '.sp48-import-zone-icon{font-size:32px;margin-bottom:6px}',
    '.sp48-import-zone-text{font-size:13px;color:#64748b}',
    /* Manual paste */
    '.sp48-manual-area{width:100%;min-height:100px;padding:10px 12px;background:#f8fafc;border:1px solid #cbd5e1;border-radius:8px;color:#1e293b;font-size:13px;font-family:monospace;outline:none;box-sizing:border-box;resize:vertical;line-height:1.8}',
    '.sp48-manual-area:focus{border-color:#3b82f6;background:#fff}',
    /* Modal popup */
    '.sp48-modal-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px}',
    '.sp48-modal{background:#fff;border-radius:16px;width:100%;max-width:600px;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.3)}',
    '.sp48-modal-header{padding:18px 20px;border-bottom:1px solid #e2e8f0;display:flex;align-items:center;justify-content:space-between}',
    '.sp48-modal-title{font-size:16px;font-weight:700;color:#1e293b}',
    '.sp48-modal-close{width:32px;height:32px;border-radius:8px;border:none;background:#f1f5f9;cursor:pointer;font-size:18px;display:flex;align-items:center;justify-content:center;color:#475569}',
    '.sp48-modal-close:hover{background:#e2e8f0}',
    '.sp48-modal-body{flex:1;overflow-y:auto;padding:16px 20px}',
    '.sp48-modal-footer{padding:14px 20px;border-top:1px solid #e2e8f0;display:flex;gap:10px;justify-content:flex-end}',
    '.sp48-modal-list{list-style:none;padding:0;margin:0}',
    '.sp48-modal-list li{display:flex;align-items:center;gap:10px;padding:8px 10px;border-bottom:1px solid #f1f5f9;font-size:13px;color:#1e293b}',
    '.sp48-modal-list li:last-child{border-bottom:none}',
    '.sp48-modal-list .sp48-ml-num{background:#1d4ed8;color:#fff;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0}',
    '.sp48-modal-list .sp48-ml-name{flex:1;font-weight:500}',
    '.sp48-modal-list .sp48-ml-phone{color:#64748b;font-size:12px;font-family:monospace}',
    /* Live sending panel */
    '.sp48-live-panel{background:linear-gradient(135deg,#0f172a,#1e293b);border-radius:12px;padding:20px;color:#fff;margin-bottom:16px}',
    '.sp48-live-title{font-size:18px;font-weight:800;margin-bottom:4px;display:flex;align-items:center;gap:10px}',
    '.sp48-live-subtitle{font-size:13px;color:#94a3b8;margin-bottom:16px}',
    '.sp48-live-stats{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px}',
    '.sp48-live-stat{background:rgba(255,255,255,.08);border-radius:10px;padding:12px 16px;flex:1;min-width:80px;text-align:center}',
    '.sp48-live-stat-num{font-size:28px;font-weight:800}',
    '.sp48-live-stat-lbl{font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em}',
    '.sp48-live-stat.sent .sp48-live-stat-num{color:#34d399}',
    '.sp48-live-stat.failed .sp48-live-stat-num{color:#f87171}',
    '.sp48-live-stat.pending .sp48-live-stat-num{color:#60a5fa}',
    '.sp48-live-stat.total .sp48-live-stat-num{color:#fbbf24}',
    '.sp48-live-current{background:rgba(255,255,255,.05);border-radius:8px;padding:10px 14px;font-size:13px;color:#e2e8f0;display:flex;align-items:center;gap:8px;margin-bottom:12px}',
    '.sp48-live-spinner{width:16px;height:16px;border:2px solid rgba(255,255,255,.2);border-top-color:#34d399;border-radius:50%;animation:sp48spin .6s linear infinite}',
    '.sp48-live-progress{width:100%;height:6px;background:rgba(255,255,255,.1);border-radius:3px;overflow:hidden;margin-bottom:8px}',
    '.sp48-live-progress-bar{height:100%;background:linear-gradient(90deg,#34d399,#059669);border-radius:3px;transition:width .3s}',
    '.sp48-live-pct{text-align:center;font-size:12px;color:#94a3b8;margin-bottom:12px}',
    /* History */
    '.sp48-history-item{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:14px;margin-bottom:10px;display:flex;align-items:center;gap:14px}',
    '.sp48-history-icon{width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0}',
    '.sp48-history-icon.ok{background:#dcfce7;color:#059669}',
    '.sp48-history-icon.partial{background:#fef3c7;color:#f59e0b}',
    '.sp48-history-icon.err{background:#fef2f2;color:#dc2626}',
    '.sp48-history-info{flex:1}',
    '.sp48-history-name{font-size:14px;font-weight:700;color:#1e293b}',
    '.sp48-history-meta{font-size:12px;color:#64748b;margin-top:2px}',
    '.sp48-history-stats{font-size:12px;color:#475569;display:flex;gap:12px;margin-top:4px}',
    '.sp48-history-stats span{display:flex;align-items:center;gap:3px}',
    '.sp48-empty{text-align:center;padding:40px 20px;color:#94a3b8;font-size:14px}',
    /* Anti-ban guide */
    '.sp48-guide{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:18px;margin-top:16px}',
    '.sp48-guide-title{font-size:15px;font-weight:700;color:#166534;margin-bottom:12px;display:flex;align-items:center;gap:8px}',
    '.sp48-guide-table{width:100%;border-collapse:collapse;font-size:13px}',
    '.sp48-guide-table th{background:#dcfce7;color:#166534;padding:8px 12px;text-align:left;font-weight:600;border:1px solid #bbf7d0}',
    '.sp48-guide-table td{padding:8px 12px;border:1px solid #bbf7d0;color:#1e293b}',
    '.sp48-guide-table tr:nth-child(even) td{background:#f0fdf4}',
    '.sp48-guide-tips{margin-top:12px;font-size:12px;color:#166534;line-height:1.7;padding-left:16px}',
    '.sp48-guide-tips li{margin-bottom:4px}'
  ].join('\n');
  document.head.appendChild(css);

  /* ── State ── */
  var state = {
    contacts: [],
    selectedIds: [],
    manualContacts: [],
    templates: [],
    selectedTemplate: null,
    message: '',
    sending: false,
    sent: 0,
    failed: 0,
    total: 0,
    log: [],
    delayMs: 5000,
    dailyLimit: 20,
    batchSize: 5,
    aborted: false,
    activeTab: 'api',
    activeView: 'nueva',
    activeLeadFilter: null,
    currentSendingIdx: -1,
    currentSendingName: '',
    _manualText: ''
  };

  /* ── Lead stages map ── */
  var LEADS = {
    'new':       {emoji: '🆕', label: 'Nuevo',     color: '#3b82f6'},
    'potential':  {emoji: '🔥', label: 'Potencial', color: '#f59e0b'},
    'customer':  {emoji: '😊', label: 'Cliente',   color: '#059669'},
    'lost':      {emoji: '❌',        label: 'Perdido',   color: '#dc2626'}
  };

  /* ── Helpers ── */
  function escHtml(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  function normalizePhone(raw){
    if(!raw) return '';
    var p = String(raw).replace(/[\s\-\(\)\+\.]/g,'');
    if(p.length > 10 && p.charAt(0) === '0') p = p.substring(1);
    return p;
  }

  async function loadContacts(){
    try {
      var r = await fetch(API + '/contacts');
      var data = await r.json();
      state.contacts = (data.clients||[]).filter(function(c){
        return c.jid && c.jid.indexOf('@lid') === -1 && c.jid.indexOf('@g.us') === -1;
      });
      return state.contacts;
    } catch(e){ console.error('[Fix48] loadContacts error:', e); return []; }
  }

  async function loadTemplates(){
    try {
      var r = await fetch(API + '/templates');
      state.templates = await r.json();
      return state.templates;
    } catch(e){ console.error('[Fix48] loadTemplates error:', e); return []; }
  }

  function getContactName(c){
    if(c.name && c.name !== c.phone && !/^\d+$/.test(c.name)) return c.name;
    var p = c.phone || c.jid || '';
    return '+' + p.replace(/\D/g,'');
  }

  function getLeadInfo(c){
    var stage = c.lifecycle_stage || 'new';
    return LEADS[stage] || LEADS['new'];
  }

  function filterByLead(contacts, stage){
    if(!stage) return contacts;
    return contacts.filter(function(c){ return (c.lifecycle_stage || 'new') === stage; });
  }

  function filterContacts(filter){
    var now = new Date();
    var base = state.activeLeadFilter ? filterByLead(state.contacts, state.activeLeadFilter) : state.contacts;
    return base.filter(function(c){
      if(filter === 'all') return true;
      var created = new Date(c.created_at || c.createdAt || 0);
      var diffDays = (now - created) / 86400000;
      if(filter === 'week') return diffDays <= 7;
      if(filter === 'month') return diffDays <= 30;
      if(filter === 'older') return diffDays > 30;
      return true;
    });
  }

  function personalizeMessage(msg, contact){
    var name = getContactName(contact);
    return msg.replace(/\{\{nombre\}\}/gi, name).replace(/\{\{name\}\}/gi, name);
  }

  function addLog(text, type){
    state.log.push({text: text, type: type || 'info', time: new Date().toLocaleTimeString()});
    var logEl = document.getElementById('sp48-log');
    if(logEl){
      logEl.innerHTML = state.log.map(function(l){
        return '<div class="sp48-log-entry sp48-log-'+l.type+'">['+l.time+'] '+l.text+'</div>';
      }).join('');
      logEl.scrollTop = logEl.scrollHeight;
    }
  }

  /* ── History management ── */
  function getHistory(){
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); }
    catch(e){ return []; }
  }

  function saveToHistory(entry){
    var hist = getHistory();
    hist.unshift(entry);
    if(hist.length > 50) hist = hist.slice(0, 50);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(hist));
  }

  function getContactsSentTemplate(tplId){
    var hist = getHistory();
    var sent = {};
    hist.forEach(function(h){
      if(h.templateId === tplId && h.sentPhones){
        h.sentPhones.forEach(function(p){ sent[p] = true; });
      }
    });
    return sent;
  }

  /* ── Get all selected contacts ── */
  function getSelectedContacts(){
    var result = [];
    state.selectedIds.forEach(function(id){
      var c = state.contacts.find(function(x){ return (x.jid||x.phone) === id; });
      if(c) result.push(c);
    });
    state.manualContacts.forEach(function(mc){
      var phone = normalizePhone(mc.phone);
      var exists = result.some(function(r){
        var rp = normalizePhone(r.phone || (r.jid||'').replace(/@.*/,''));
        return rp === phone;
      });
      if(!exists && phone.length >= 7){
        result.push({jid: phone + '@s.whatsapp.net', phone: phone, name: mc.name || '', lifecycle_stage: 'new'});
      }
    });
    return result;
  }

  /* ── Excel parsing ── */
  function parseExcelFile(file){
    return new Promise(function(resolve, reject){
      if(!window.XLSX){ reject(new Error('SheetJS no cargado. Recarga la pagina.')); return; }
      var reader = new FileReader();
      reader.onload = function(e){
        try {
          var wb = XLSX.read(e.target.result, {type:'array'});
          var ws = wb.Sheets[wb.SheetNames[0]];
          var rows = XLSX.utils.sheet_to_json(ws, {header:1, defval:''});
          var contacts = [];
          var phoneCol = -1, nameCol = -1;
          if(rows.length > 0){
            var header = rows[0].map(function(h){ return String(h).toLowerCase().trim(); });
            phoneCol = header.findIndex(function(h){ return /tel[eé]?f|phone|numero|n[uú]mero|celular|whatsapp|movil|m[oó]vil/.test(h); });
            nameCol = header.findIndex(function(h){ return /nombre|name|cliente|contact/.test(h); });
            var startRow = (phoneCol >= 0 || nameCol >= 0) ? 1 : 0;
            if(phoneCol < 0) phoneCol = 0;
            if(nameCol < 0) nameCol = phoneCol === 0 ? 1 : 0;
            for(var i = startRow; i < rows.length; i++){
              var phone = normalizePhone(rows[i][phoneCol]);
              var name = String(rows[i][nameCol]||'').trim();
              if(phone && phone.length >= 7){
                contacts.push({phone: phone, name: name !== phone ? name : ''});
              }
            }
          }
          resolve(contacts);
        } catch(err){ reject(err); }
      };
      reader.onerror = function(){ reject(new Error('Error leyendo archivo')); };
      reader.readAsArrayBuffer(file);
    });
  }

  /* ── Parse manual numbers (smart parser) ── */
  function parseManualNumbers(text){
    var chunks = text.split(/[\n\r,;\t|]+/);
    var contacts = [];
    var seen = {};
    chunks.forEach(function(chunk){
      chunk = chunk.trim();
      if(!chunk) return;
      var namePart = '';
      var numPart = chunk;
      var dashMatch = chunk.match(/^([\d\s\+\-().]{7,})\s*[\-–—]\s*(.+)$/);
      if(dashMatch){ numPart = dashMatch[1]; namePart = dashMatch[2].trim(); }
      var digitGroups = numPart.match(/\d{7,}/g);
      if(!digitGroups){
        var allDigits = numPart.replace(/\D/g, '');
        if(allDigits.length >= 7) digitGroups = [allDigits];
      }
      if(digitGroups){
        digitGroups.forEach(function(phone){
          if(phone.length > 10 && phone.charAt(0) === '0') phone = phone.substring(1);
          if(!seen[phone]){
            seen[phone] = true;
            contacts.push({phone: phone, name: namePart});
            namePart = '';
          }
        });
      }
    });
    return contacts;
  }

  /* ── Verification Modal ── */
  function showVerificationModal(contacts, tplName, onConfirm){
    var overlay = document.createElement('div');
    overlay.className = 'sp48-modal-overlay';
    overlay.id = 'sp48-verify-modal';

    var listItems = contacts.slice(0, 100).map(function(c, i){
      var name = getContactName(c);
      var phone = (c.phone || (c.jid||'').replace(/@.*/,''));
      var lead = getLeadInfo(c);
      return '<li><span class="sp48-ml-num">' + (i+1) + '</span><span style="font-size:14px">' + lead.emoji + '</span><span class="sp48-ml-name">' + escHtml(name) + '</span><span class="sp48-ml-phone">' + escHtml(phone) + '</span></li>';
    }).join('');
    if(contacts.length > 100) listItems += '<li style="color:#94a3b8;font-style:italic;justify-content:center">... y ' + (contacts.length-100) + ' mas</li>';

    var tplInfo = tplName ? '<div style="margin-bottom:12px;padding:10px;background:#eff6ff;border-radius:8px;font-size:13px"><strong>Plantilla:</strong> ' + escHtml(tplName) + '</div>' : '';

    overlay.innerHTML =
      '<div class="sp48-modal">' +
        '<div class="sp48-modal-header">' +
          '<span class="sp48-modal-title">Verificar Difusion (' + contacts.length + ' contactos)</span>' +
          '<button class="sp48-modal-close" id="sp48-modal-close-btn">&times;</button>' +
        '</div>' +
        '<div class="sp48-modal-body">' +
          tplInfo +
          '<div style="margin-bottom:12px;font-size:13px;color:#64748b">Verifica los contactos antes de enviar:</div>' +
          '<ul class="sp48-modal-list">' + listItems + '</ul>' +
        '</div>' +
        '<div class="sp48-modal-footer">' +
          '<button class="sp48-btn sp48-btn-outline" id="sp48-modal-cancel">Cancelar</button>' +
          '<button class="sp48-btn sp48-btn-success" id="sp48-modal-confirm">Confirmar y Enviar (' + contacts.length + ')</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);
    overlay.querySelector('#sp48-modal-close-btn').addEventListener('click', function(){ overlay.remove(); });
    overlay.querySelector('#sp48-modal-cancel').addEventListener('click', function(){ overlay.remove(); });
    overlay.querySelector('#sp48-modal-confirm').addEventListener('click', function(){
      overlay.remove();
      onConfirm();
    });
    overlay.addEventListener('click', function(e){ if(e.target === overlay) overlay.remove(); });
  }

  /* ── Sending engine ── */
  async function sendWithDelay(contact, idx){
    if(state.aborted) return false;
    var chatId = contact.jid || contact.phone;
    if(chatId.indexOf('@') === -1) chatId += '@s.whatsapp.net';
    var msg = personalizeMessage(state.message, contact);

    state.currentSendingIdx = idx;
    state.currentSendingName = getContactName(contact);
    updateChipStatus(contact.jid || contact.phone, 'sending');
    updateLivePanel();

    try {
      var r = await fetch(API + '/send', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({chatId: chatId, message: msg})
      });
      var data = await r.json();
      if(data.success){
        state.sent++;
        addLog('#' + (idx+1) + ' Enviado a ' + getContactName(contact), 'ok');
        updateChipStatus(contact.jid || contact.phone, 'sent');
        return true;
      } else {
        state.failed++;
        addLog('#' + (idx+1) + ' Error: ' + (data.error || 'desconocido') + ' -> ' + getContactName(contact), 'err');
        updateChipStatus(contact.jid || contact.phone, 'fail');
        return false;
      }
    } catch(e){
      state.failed++;
      addLog('#' + (idx+1) + ' Error de red -> ' + getContactName(contact), 'err');
      updateChipStatus(contact.jid || contact.phone, 'fail');
      return false;
    }
  }

  function updateChipStatus(id, status){
    var chip = document.querySelector('.sp48-chip[data-id="'+id+'"]');
    if(chip){
      chip.className = 'sp48-chip sp48-chip-' + status;
    }
    updateProgress();
  }

  function updateProgress(){
    var bar = document.getElementById('sp48-progress-bar');
    var txt = document.getElementById('sp48-progress-txt');
    var done = state.sent + state.failed;
    if(bar && state.total) bar.style.width = (done / state.total * 100) + '%';
    if(txt && state.total) txt.textContent = done + '/' + state.total + ' (' + state.sent + ' enviados, ' + state.failed + ' errores)';
  }

  function updateLivePanel(){
    var el = document.getElementById('sp48-live-panel');
    if(!el) return;
    var done = state.sent + state.failed;
    var pct = state.total ? Math.round(done / state.total * 100) : 0;

    var sentNum = el.querySelector('.sp48-live-stat.sent .sp48-live-stat-num');
    var failNum = el.querySelector('.sp48-live-stat.failed .sp48-live-stat-num');
    var pendNum = el.querySelector('.sp48-live-stat.pending .sp48-live-stat-num');
    if(sentNum) sentNum.textContent = state.sent;
    if(failNum) failNum.textContent = state.failed;
    if(pendNum) pendNum.textContent = Math.max(0, state.total - done);

    var progBar = el.querySelector('.sp48-live-progress-bar');
    if(progBar) progBar.style.width = pct + '%';

    var pctEl = el.querySelector('.sp48-live-pct');
    if(pctEl) pctEl.textContent = pct + '% completado (' + done + '/' + state.total + ')';

    var curEl = el.querySelector('.sp48-live-current');
    if(curEl && state.currentSendingName){
      curEl.innerHTML = '<div class="sp48-live-spinner"></div> Enviando a <strong>' + escHtml(state.currentSendingName) + '</strong> (#' + (state.currentSendingIdx+1) + ')';
    }
  }

  async function executeBroadcast(selected){
    state.sending = true;
    state.sent = 0;
    state.failed = 0;
    state.total = selected.length;
    state.log = [];
    state.aborted = false;
    state.currentSendingIdx = -1;
    render();

    var tplName = state.selectedTemplate ? (state.templates.find(function(t){ return t.id === state.selectedTemplate; })||{}).name || 'Personalizado' : 'Personalizado';
    addLog('Iniciando difusion "' + tplName + '" a ' + selected.length + ' contactos', 'info');
    addLog('Delay: ' + (state.delayMs/1000) + 's | Limite: ' + state.dailyLimit + '/dia | Pausa cada: ' + state.batchSize, 'info');

    var sentPhones = [];
    var sent = 0;
    for(var i = 0; i < selected.length; i++){
      if(state.aborted){ addLog('Difusion cancelada por el usuario', 'err'); break; }
      if(sent >= state.dailyLimit){
        addLog('Limite diario alcanzado (' + state.dailyLimit + '). Deteniendo.', 'err');
        break;
      }
      var ok = await sendWithDelay(selected[i], i);
      if(ok) sentPhones.push(normalizePhone(selected[i].phone || (selected[i].jid||'').replace(/@.*/,'')));
      sent++;
      updateProgress();
      updateLivePanel();

      if(i < selected.length - 1 && !state.aborted){
        var delay = state.delayMs + Math.random() * state.delayMs * 0.5;
        addLog('Esperando ' + (delay/1000).toFixed(1) + 's...', 'info');
        await new Promise(function(resolve){ setTimeout(resolve, delay); });
      }

      if(sent > 0 && sent % state.batchSize === 0 && !state.aborted){
        var pause = 10000 + Math.random() * 5000;
        addLog('Pausa anti-baneo de ' + (pause/1000).toFixed(0) + 's tras ' + sent + ' mensajes', 'info');
        await new Promise(function(resolve){ setTimeout(resolve, pause); });
      }
    }

    addLog('Difusion completada: ' + state.sent + ' enviados, ' + state.failed + ' errores', state.failed ? 'err' : 'ok');

    // Save to history
    saveToHistory({
      id: Date.now(),
      date: new Date().toISOString(),
      templateId: state.selectedTemplate || null,
      templateName: tplName,
      totalContacts: selected.length,
      sent: state.sent,
      failed: state.failed,
      sentPhones: sentPhones,
      aborted: state.aborted
    });

    state.sending = false;
    state.currentSendingIdx = -1;
    state.currentSendingName = '';
    render();
  }

  function startBroadcast(){
    if(state.sending) return;
    var selected = getSelectedContacts();
    if(!selected.length){ alert('Selecciona al menos 1 contacto'); return; }
    if(!state.message.trim()){ alert('Selecciona una plantilla o escribe un mensaje'); return; }

    // Check duplicate sends
    if(state.selectedTemplate){
      var alreadySent = getContactsSentTemplate(state.selectedTemplate);
      var dupes = selected.filter(function(c){
        var p = normalizePhone(c.phone || (c.jid||'').replace(/@.*/,''));
        return alreadySent[p];
      });
      if(dupes.length > 0){
        var keep = selected.filter(function(c){
          var p = normalizePhone(c.phone || (c.jid||'').replace(/@.*/,''));
          return !alreadySent[p];
        });
        if(!confirm(dupes.length + ' contacto(s) ya recibieron esta plantilla antes.\n\nEnviar solo a los ' + keep.length + ' nuevos?\n\nAceptar = solo nuevos | Cancelar = enviar a todos')) {
          // User wants to send to all
        } else {
          selected = keep;
          if(!selected.length){ alert('Todos los contactos ya recibieron esta plantilla.'); return; }
        }
      }
    }

    var tplName = state.selectedTemplate ? (state.templates.find(function(t){ return t.id === state.selectedTemplate; })||{}).name || '' : '';
    showVerificationModal(selected, tplName, function(){
      executeBroadcast(selected);
    });
  }

  /* ── Render: Live sending panel ── */
  function renderLivePanel(){
    if(!state.sending) return '';
    var done = state.sent + state.failed;
    var pct = state.total ? Math.round(done / state.total * 100) : 0;
    return '<div class="sp48-live-panel" id="sp48-live-panel">' +
      '<div class="sp48-live-title"><div class="sp48-live-spinner"></div> Difusion en curso</div>' +
      '<div class="sp48-live-subtitle">Enviando mensajes con proteccion anti-baneo</div>' +
      '<div class="sp48-live-stats">' +
        '<div class="sp48-live-stat sent"><div class="sp48-live-stat-num">' + state.sent + '</div><div class="sp48-live-stat-lbl">Enviados</div></div>' +
        '<div class="sp48-live-stat failed"><div class="sp48-live-stat-num">' + state.failed + '</div><div class="sp48-live-stat-lbl">Errores</div></div>' +
        '<div class="sp48-live-stat pending"><div class="sp48-live-stat-num">' + Math.max(0, state.total - done) + '</div><div class="sp48-live-stat-lbl">Pendientes</div></div>' +
        '<div class="sp48-live-stat total"><div class="sp48-live-stat-num">' + state.total + '</div><div class="sp48-live-stat-lbl">Total</div></div>' +
      '</div>' +
      '<div class="sp48-live-current">' +
        (state.currentSendingName ? '<div class="sp48-live-spinner"></div> Enviando a <strong>' + escHtml(state.currentSendingName) + '</strong> (#' + (state.currentSendingIdx+1) + ')' : 'Preparando...') +
      '</div>' +
      '<div class="sp48-live-progress"><div class="sp48-live-progress-bar" style="width:' + pct + '%"></div></div>' +
      '<div class="sp48-live-pct">' + pct + '% completado (' + done + '/' + state.total + ')</div>' +
      '<button class="sp48-btn sp48-btn-danger" id="sp48-abort-btn" style="width:100%">Cancelar Difusion</button>' +
    '</div>';
  }

  /* ── Render: Template selector ── */
  function renderTemplateSelector(){
    if(!state.templates.length) return '<div style="color:#94a3b8;font-size:13px;font-style:italic">Cargando plantillas...</div>';

    var categories = {};
    state.templates.forEach(function(t){
      var cat = t.category || 'otros';
      if(!categories[cat]) categories[cat] = [];
      categories[cat].push(t);
    });

    var catButtons = Object.keys(categories).map(function(cat){
      return '<span style="font-size:12px;color:#64748b;background:#f1f5f9;padding:3px 10px;border-radius:10px;font-weight:600;text-transform:capitalize">' + escHtml(cat) + ' (' + categories[cat].length + ')</span>';
    }).join(' ');

    var cards = state.templates.map(function(t){
      var isSelected = state.selectedTemplate === t.id;
      var preview = (t.content || '').substring(0, 80).replace(/\n/g, ' ');
      return '<div class="sp48-tpl-card' + (isSelected ? ' selected' : '') + '" data-tpl-id="' + escHtml(t.id) + '">' +
        '<div class="sp48-tpl-check">&#10003;</div>' +
        '<div class="sp48-tpl-name">' + escHtml(t.name) + '</div>' +
        '<div class="sp48-tpl-cat">' + escHtml(t.category || 'otros') + '</div>' +
        '<div class="sp48-tpl-preview">' + escHtml(preview) + '...</div>' +
      '</div>';
    }).join('');

    var fullPreview = '';
    if(state.selectedTemplate){
      var tpl = state.templates.find(function(t){ return t.id === state.selectedTemplate; });
      if(tpl){
        fullPreview = '<div class="sp48-tpl-full-preview"><strong>Vista previa:</strong>\n\n' + escHtml(tpl.content||'') + '</div>';
      }
    }

    return '<div style="margin-bottom:6px">' + catButtons + '</div>' +
      '<div class="sp48-tpl-grid">' + cards + '</div>' +
      fullPreview +
      '<div style="margin-top:8px;font-size:12px;color:#94a3b8">O escribe un mensaje personalizado abajo</div>' +
      '<textarea class="sp48-input" id="sp48-msg" rows="3" placeholder="Mensaje personalizado (opcional si ya seleccionaste plantilla)..." style="margin-top:6px">' + escHtml(state.message) + '</textarea>';
  }

  /* ── Render: Lead filters ── */
  function renderLeadFilters(){
    var counts = {new: 0, potential: 0, customer: 0, lost: 0};
    state.contacts.forEach(function(c){
      var s = c.lifecycle_stage || 'new';
      if(counts[s] !== undefined) counts[s]++;
    });

    var html = '<div class="sp48-lead-filters">';
    Object.keys(LEADS).forEach(function(key){
      var lead = LEADS[key];
      var isActive = state.activeLeadFilter === key;
      html += '<button class="sp48-lead-btn' + (isActive ? ' active' : '') + '" data-lead="' + key + '">' +
        lead.emoji + ' ' + lead.label + ' <span class="sp48-lead-count">' + counts[key] + '</span>' +
      '</button>';
    });
    html += '<button class="sp48-lead-btn' + (!state.activeLeadFilter ? ' active' : '') + '" data-lead="all">Todos <span class="sp48-lead-count">' + state.contacts.length + '</span></button>';
    html += '</div>';
    return html;
  }

  /* ── Render: Contact source tabs ── */
  function renderContactTabs(){
    var tabApi = state.activeTab === 'api' ? 'active' : '';
    var tabExcel = state.activeTab === 'excel' ? 'active' : '';
    var tabManual = state.activeTab === 'manual' ? 'active' : '';

    var html = '<div class="sp48-tabs">' +
      '<div class="sp48-tab ' + tabApi + '" data-tab="api">Contactos API</div>' +
      '<div class="sp48-tab ' + tabExcel + '" data-tab="excel">Importar Excel</div>' +
      '<div class="sp48-tab ' + tabManual + '" data-tab="manual">Pegar Numeros</div>' +
    '</div>';

    if(state.activeTab === 'api'){
      html += renderLeadFilters();
      html += '<div class="sp48-row">' +
        '<button class="sp48-btn sp48-btn-outline sp48-btn-sm sp48-filter" data-f="all">Todos <span class="sp48-count-badge">' + state.contacts.length + '</span></button>' +
        '<button class="sp48-btn sp48-btn-outline sp48-btn-sm sp48-filter" data-f="week">Ultima semana</button>' +
        '<button class="sp48-btn sp48-btn-outline sp48-btn-sm sp48-filter" data-f="month">Ultimo mes</button>' +
        '<button class="sp48-btn sp48-btn-outline sp48-btn-sm sp48-filter" data-f="older">Mas antiguos</button>' +
        '<button class="sp48-btn sp48-btn-danger sp48-btn-sm" id="sp48-clear-all">Limpiar</button>' +
      '</div>';
    } else if(state.activeTab === 'excel'){
      html += '<div class="sp48-label">Importar desde archivo Excel (.xlsx, .xls, .csv)</div>' +
        '<div class="sp48-import-zone" id="sp48-drop-zone">' +
          '<div class="sp48-import-zone-icon">📊</div>' +
          '<div class="sp48-import-zone-text">Arrastra un archivo aqui o haz clic para seleccionar</div>' +
          '<div style="font-size:11px;color:#94a3b8;margin-top:6px">El archivo debe tener una columna con numeros de telefono</div>' +
          '<input type="file" id="sp48-file-input" accept=".xlsx,.xls,.csv" style="display:none">' +
        '</div>' +
        (state.manualContacts.length > 0 ? '<div style="font-size:13px;color:#059669;font-weight:600;margin-bottom:8px">' + state.manualContacts.length + ' contactos cargados desde archivo</div>' : '');
    } else if(state.activeTab === 'manual'){
      html += '<div class="sp48-label">Pegar numeros de telefono (uno por linea)</div>' +
        '<div class="sp48-subtitle">Formato: <code>573001234567</code> o <code>573001234567 - Nombre</code>. Pega miles de numeros y se organizan automaticamente.</div>' +
        '<textarea class="sp48-manual-area" id="sp48-manual-input" placeholder="573001234567 - Juan Perez\n573009876543 - Maria Lopez\n573001112233\n...">' + escHtml(state._manualText || '') + '</textarea>' +
        '<div class="sp48-row" style="margin-top:8px">' +
          '<button class="sp48-btn sp48-btn-primary sp48-btn-sm" id="sp48-parse-manual">Cargar Numeros</button>' +
          '<span id="sp48-manual-count" style="font-size:12px;color:#64748b">' +
            (state.manualContacts.length > 0 ? state.manualContacts.length + ' numeros cargados' : '') +
          '</span>' +
        '</div>';
    }
    return html;
  }

  /* ── Render: History ── */
  function renderHistory(){
    var hist = getHistory();
    if(!hist.length) return '<div class="sp48-empty">No hay difusiones anteriores</div>';

    return hist.map(function(h){
      var d = new Date(h.date);
      var dateStr = d.toLocaleDateString('es-CO', {day:'2-digit',month:'short',year:'numeric'}) + ' ' + d.toLocaleTimeString('es-CO', {hour:'2-digit',minute:'2-digit'});
      var iconClass = h.failed === 0 ? 'ok' : (h.sent > 0 ? 'partial' : 'err');
      var iconEmoji = h.failed === 0 ? '&#10004;' : (h.sent > 0 ? '&#9888;' : '&#10006;');
      return '<div class="sp48-history-item">' +
        '<div class="sp48-history-icon ' + iconClass + '">' + iconEmoji + '</div>' +
        '<div class="sp48-history-info">' +
          '<div class="sp48-history-name">' + escHtml(h.templateName || 'Mensaje personalizado') + '</div>' +
          '<div class="sp48-history-meta">' + dateStr + (h.aborted ? ' (cancelada)' : '') + '</div>' +
          '<div class="sp48-history-stats">' +
            '<span style="color:#059669">&#10004; ' + h.sent + ' enviados</span>' +
            '<span style="color:#dc2626">&#10006; ' + h.failed + ' errores</span>' +
            '<span style="color:#64748b">Total: ' + h.totalContacts + '</span>' +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  /* ── Render: Anti-ban guide ── */
  function renderGuide(){
    return '<div class="sp48-guide">' +
      '<div class="sp48-guide-title">Recomendaciones Anti-Baneo</div>' +
      '<table class="sp48-guide-table">' +
        '<tr><th>Etapa</th><th>Mensajes/dia</th><th>Delay</th><th>Notas</th></tr>' +
        '<tr><td><strong>Nuevo</strong> (0-7 dias)</td><td>20</td><td>5-8 seg</td><td>Numero recien vinculado.</td></tr>' +
        '<tr><td><strong>Calentando</strong> (1-2 sem)</td><td>50</td><td>3-5 seg</td><td>Incrementar gradualmente.</td></tr>' +
        '<tr><td><strong>Establecido</strong> (2-4 sem)</td><td>100</td><td>2-4 seg</td><td>Numero con historial.</td></tr>' +
        '<tr><td><strong>Veterano</strong> (1+ mes)</td><td>200</td><td>2-3 seg</td><td>Maximo seguro.</td></tr>' +
      '</table>' +
      '<ul class="sp48-guide-tips">' +
        '<li><strong>Personaliza siempre:</strong> usa {{nombre}} para que cada mensaje sea unico.</li>' +
        '<li><strong>No envies links en los primeros dias</strong> — WhatsApp los detecta como spam.</li>' +
        '<li><strong>Varia el contenido:</strong> alterna plantillas para no repetir.</li>' +
        '<li><strong>Respeta las pausas:</strong> la pausa cada lote es crucial.</li>' +
        '<li><strong>Si te bloquean:</strong> para y espera 24-48h.</li>' +
      '</ul>' +
    '</div>';
  }

  /* ══════════ MAIN RENDER ══════════ */
  function render(){
    var panel = document.getElementById('sp-difusion-panel');
    if(!panel) return;

    var allSelected = getSelectedContacts();

    /* ── View tabs: Nueva Difusion | Historial ── */
    var viewTabs = '<div class="sp48-view-tabs">' +
      '<div class="sp48-view-tab' + (state.activeView === 'nueva' ? ' active' : '') + '" data-view="nueva">Nueva Difusion</div>' +
      '<div class="sp48-view-tab' + (state.activeView === 'historial' ? ' active' : '') + '" data-view="historial">Historial (' + getHistory().length + ')</div>' +
    '</div>';

    if(state.activeView === 'historial'){
      panel.innerHTML = viewTabs + '<div class="sp48-card">' + renderHistory() + '</div>';
      bindViewTabs(panel);
      return;
    }

    /* ── Sending in progress: show live panel ── */
    if(state.sending){
      var contactChips = allSelected.map(function(c, idx){
        var id = c.jid || c.phone;
        var name = getContactName(c);
        return '<span class="sp48-chip sp48-chip-pending" data-id="'+escHtml(id)+'">'
          + '<span class="sp48-chip-num">' + (idx+1) + '</span>'
          + escHtml(name)
          + '</span>';
      }).join('');

      panel.innerHTML = viewTabs +
        renderLivePanel() +
        '<div class="sp48-card">' +
          '<div class="sp48-label">Contactos</div>' +
          '<div class="sp48-chip-list" id="sp48-chips">' + contactChips + '</div>' +
          '<div class="sp48-log" id="sp48-log">' +
            state.log.map(function(l){ return '<div class="sp48-log-entry sp48-log-'+l.type+'">['+l.time+'] '+l.text+'</div>'; }).join('') +
          '</div>' +
        '</div>';

      bindViewTabs(panel);
      var abortBtn = panel.querySelector('#sp48-abort-btn');
      if(abortBtn) abortBtn.addEventListener('click', function(){ state.aborted = true; addLog('Cancelando...', 'err'); });
      return;
    }

    /* ── Normal view ── */
    var contactChips = allSelected.map(function(c, idx){
      var id = c.jid || c.phone;
      var name = getContactName(c);
      var lead = getLeadInfo(c);
      return '<span class="sp48-chip sp48-chip-pending" data-id="'+escHtml(id)+'">'
        + '<span class="sp48-chip-num">' + (idx+1) + '</span>'
        + '<span style="font-size:12px">' + lead.emoji + '</span> '
        + escHtml(name)
        + ' <span class="sp48-chip-x" data-id="'+escHtml(id)+'">x</span>'
        + '</span>';
    }).join('');

    panel.innerHTML = viewTabs +
      '<div class="sp48-card">' +
        '<div class="sp48-title">Nueva Difusion</div>' +
        '<div class="sp48-warn"><span class="sp48-warn-icon">&#9888;</span><span><strong>Proteccion Anti-Baneo activa.</strong> Delay de ' + (state.delayMs/1000) + 's entre mensajes, pausa cada ' + state.batchSize + ', limite diario de ' + state.dailyLimit + ' contactos.</span></div>' +

        '<div class="sp48-stats">' +
          '<div class="sp48-stat"><div class="sp48-stat-num">' + state.contacts.length + '</div><div class="sp48-stat-lbl">En API</div></div>' +
          '<div class="sp48-stat"><div class="sp48-stat-num">' + state.manualContacts.length + '</div><div class="sp48-stat-lbl">Importados</div></div>' +
          '<div class="sp48-stat"><div class="sp48-stat-num">' + allSelected.length + '</div><div class="sp48-stat-lbl">Total a Enviar</div></div>' +
          '<div class="sp48-stat"><div class="sp48-stat-num">' + state.dailyLimit + '</div><div class="sp48-stat-lbl">Limite/dia</div></div>' +
        '</div>' +

        '<div class="sp48-label">1. Fuente de contactos</div>' +
        renderContactTabs() +

        '<div class="sp48-chip-list" id="sp48-chips">' +
          (contactChips || '<span style="color:#94a3b8;font-size:12px;font-style:italic">Selecciona contactos desde las pestanas arriba</span>') +
        '</div>' +

        '<hr class="sp48-divider">' +

        '<div class="sp48-label">2. Seleccionar plantilla</div>' +
        renderTemplateSelector() +

        '<hr class="sp48-divider">' +

        '<div class="sp48-label">3. Configuracion anti-baneo</div>' +
        '<div class="sp48-row">' +
          '<label style="font-size:13px;color:#475569">Delay (s):</label>' +
          '<input type="number" class="sp48-input" id="sp48-delay" value="' + (state.delayMs/1000) + '" min="2" max="30" style="width:70px">' +
          '<label style="font-size:13px;color:#475569;margin-left:12px">Limite diario:</label>' +
          '<input type="number" class="sp48-input" id="sp48-limit" value="' + state.dailyLimit + '" min="1" max="500" style="width:70px">' +
          '<label style="font-size:13px;color:#475569;margin-left:12px">Pausa cada:</label>' +
          '<input type="number" class="sp48-input" id="sp48-batch" value="' + state.batchSize + '" min="2" max="20" style="width:70px">' +
        '</div>' +

        '<hr class="sp48-divider">' +

        '<div class="sp48-row">' +
          '<button class="sp48-btn sp48-btn-success" id="sp48-send-btn" style="flex:1;padding:12px;font-size:15px">Enviar Difusion (' + allSelected.length + ' contactos)</button>' +
        '</div>' +

        (state.log.length > 0 ? '<div class="sp48-log" id="sp48-log">' + state.log.map(function(l){ return '<div class="sp48-log-entry sp48-log-'+l.type+'">['+l.time+'] '+l.text+'</div>'; }).join('') + '</div>' : '') +
      '</div>' +

      renderGuide();

    // ── Bind all events ──
    bindViewTabs(panel);
    bindEvents(panel);
  }

  function bindViewTabs(panel){
    panel.querySelectorAll('.sp48-view-tab').forEach(function(tab){
      tab.addEventListener('click', function(){
        state.activeView = tab.dataset.view;
        render();
      });
    });
  }

  function bindEvents(panel){
    // Contact source tabs
    panel.querySelectorAll('.sp48-tab').forEach(function(tab){
      tab.addEventListener('click', function(){
        state.activeTab = tab.dataset.tab;
        render();
      });
    });

    // Lead filters
    panel.querySelectorAll('.sp48-lead-btn').forEach(function(btn){
      btn.addEventListener('click', function(){
        var lead = btn.dataset.lead;
        state.activeLeadFilter = (lead === 'all') ? null : lead;
        render();
      });
    });

    // Time filters
    panel.querySelectorAll('.sp48-filter').forEach(function(btn){
      btn.addEventListener('click', function(){
        var filtered = filterContacts(btn.dataset.f);
        filtered.forEach(function(c){
          var id = c.jid || c.phone;
          if(state.selectedIds.indexOf(id) === -1) state.selectedIds.push(id);
        });
        render();
      });
    });

    // Clear all
    var clearBtn = panel.querySelector('#sp48-clear-all');
    if(clearBtn) clearBtn.addEventListener('click', function(){
      state.selectedIds = [];
      render();
    });

    // Remove chip
    panel.querySelectorAll('.sp48-chip-x').forEach(function(btn){
      btn.addEventListener('click', function(){
        var removeId = btn.dataset.id;
        state.selectedIds = state.selectedIds.filter(function(id){ return id !== removeId; });
        state.manualContacts = state.manualContacts.filter(function(mc){
          return (mc.phone + '@s.whatsapp.net') !== removeId && mc.phone !== removeId;
        });
        render();
      });
    });

    // Excel drag & drop
    var dropZone = panel.querySelector('#sp48-drop-zone');
    var fileInput = panel.querySelector('#sp48-file-input');
    if(dropZone && fileInput){
      dropZone.addEventListener('click', function(){ fileInput.click(); });
      dropZone.addEventListener('dragover', function(e){ e.preventDefault(); dropZone.classList.add('dragover'); });
      dropZone.addEventListener('dragleave', function(){ dropZone.classList.remove('dragover'); });
      dropZone.addEventListener('drop', function(e){
        e.preventDefault(); dropZone.classList.remove('dragover');
        var file = e.dataTransfer.files[0];
        if(file) handleExcelFile(file);
      });
      fileInput.addEventListener('change', function(){
        if(fileInput.files[0]) handleExcelFile(fileInput.files[0]);
      });
    }

    // Manual paste
    var manualInput = panel.querySelector('#sp48-manual-input');
    if(manualInput){
      manualInput.addEventListener('input', function(){ state._manualText = manualInput.value; });
      manualInput.addEventListener('paste', function(){
        setTimeout(function(){
          var btn = document.getElementById('sp48-parse-manual');
          if(btn) btn.click();
        }, 500);
      });
    }
    var parseBtn = panel.querySelector('#sp48-parse-manual');
    if(parseBtn) parseBtn.addEventListener('click', function(){
      var txt = (panel.querySelector('#sp48-manual-input')||{}).value || '';
      var contacts = parseManualNumbers(txt);
      state.manualContacts = contacts;
      render();
    });

    // Template selector
    panel.querySelectorAll('.sp48-tpl-card').forEach(function(card){
      card.addEventListener('click', function(){
        var tplId = card.dataset.tplId;
        if(state.selectedTemplate === tplId){
          state.selectedTemplate = null;
          state.message = '';
        } else {
          state.selectedTemplate = tplId;
          var tpl = state.templates.find(function(t){ return t.id === tplId; });
          if(tpl) state.message = tpl.content || '';
        }
        render();
      });
    });

    // Custom message input
    var msgEl = panel.querySelector('#sp48-msg');
    if(msgEl) msgEl.addEventListener('input', function(){
      state.message = msgEl.value;
      if(msgEl.value.trim() && state.selectedTemplate){
        // User typed custom text, deselect template
        state.selectedTemplate = null;
        render();
      }
    });

    // Config inputs
    var delayEl = panel.querySelector('#sp48-delay');
    var limitEl = panel.querySelector('#sp48-limit');
    var batchEl = panel.querySelector('#sp48-batch');
    if(delayEl) delayEl.addEventListener('change', function(){ state.delayMs = Math.max(2, parseFloat(delayEl.value)||5) * 1000; });
    if(limitEl) limitEl.addEventListener('change', function(){ state.dailyLimit = Math.max(1, parseInt(limitEl.value)||20); });
    if(batchEl) batchEl.addEventListener('change', function(){ state.batchSize = Math.max(2, parseInt(batchEl.value)||5); });

    // Send
    var sendBtn = panel.querySelector('#sp48-send-btn');
    if(sendBtn) sendBtn.addEventListener('click', function(){ startBroadcast(); });
  }

  async function handleExcelFile(file){
    try {
      var contacts = await parseExcelFile(file);
      if(!contacts.length){ alert('No se encontraron numeros validos en el archivo'); return; }
      state.manualContacts = contacts;
      render();
    } catch(e){
      alert('Error al leer archivo: ' + e.message);
    }
  }

  /* ── Inject / Cleanup ── */
  async function injectPanel(){
    var topbar = document.querySelector('.wbv5-topbar');
    if(!topbar || topbar.innerText.indexOf('Difusiones') === -1) return;
    if(document.getElementById('sp-difusion-panel')) return;
    var main = document.querySelector('.wbv5-main');
    var content = main ? main.children[1] : null;
    if(!content) return;

    if(main) main.style.overflowY = 'auto';
    content.classList.add('sp48-opaque');
    Array.from(content.children).forEach(function(child){
      if(child.id !== 'sp-difusion-panel') child.style.display = 'none';
    });

    var panel = document.createElement('div');
    panel.id = 'sp-difusion-panel';
    panel.innerHTML = '<div style="color:#475569;font-size:13px;padding:6px 0">Cargando contactos y plantillas...</div>';
    content.insertBefore(panel, content.firstChild);

    await Promise.all([loadContacts(), loadTemplates()]);
    render();
  }

  function cleanup(){
    var p = document.getElementById('sp-difusion-panel');
    if(p){
      var m = p.closest('.wbv5-main');
      if(m) m.style.overflowY = '';
      var parent = p.parentElement;
      if(parent){
        parent.classList.remove('sp48-opaque');
        Array.from(parent.children).forEach(function(s){ if(s.id !== 'sp-difusion-panel') s.style.display = ''; });
      }
      p.remove();
    }
  }

  var _lastBar48 = '';
  new MutationObserver(function(){
    var tb = document.querySelector('.wbv5-topbar');
    var cur = tb ? tb.innerText.substring(0,50) : '';
    if(cur === _lastBar48) return; _lastBar48 = cur;
    if(cur.indexOf('Difusiones') !== -1) setTimeout(injectPanel, 300);
    else cleanup();
  }).observe(document.body, {childList:true, subtree:true});

})();
/* FIX 50 — Sort persistence + mobile tap + IA emoji + name sync
   Neutralizes Fix 41 (DOM appendChild sort) */
(function fix50(){
  if(window.__spFix50) return;
  window.__spFix50 = true;
  if(window.location.pathname.indexOf('/dashboard/whatsapp-bot') !== 0) return;

  window.__spFix41 = true; /* prevent Fix 41 re-entry */

  /* ═══ 0. PLACEHOLDER "Selecciona un chat" ═══ */
  /* ═══ 0. PLACEHOLDER "Selecciona un chat" + BLOCK AUTO-OPEN ═══ */
  (function initPlaceholder(){
    var css = document.createElement('style');
    css.id = 'sp50-ph-css';
    css.textContent = '#sp50-placeholder{position:absolute;top:0;left:0;width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#f0f2f5;z-index:15;pointer-events:none;}#sp50-placeholder .sp50-ph-ico{font-size:72px;margin-bottom:20px;opacity:0.55;}#sp50-placeholder .sp50-ph-title{font-size:19px;color:#41525d;font-weight:500;margin-bottom:6px;}#sp50-placeholder .sp50-ph-sub{font-size:14px;color:#8696a0;}@media(max-width:900px){#sp50-placeholder{display:none!important;}}';
    document.head.appendChild(css);

    function createPH(){
      if(document.getElementById('sp50-placeholder')) return;
      var cw = document.querySelector('.wbv5-chat-win') || document.querySelector('.wbv5-cw');
      if(!cw) return;
      cw.style.position = 'relative';
      var ph = document.createElement('div');
      ph.id = 'sp50-placeholder';
      ph.innerHTML = '<div class="sp50-ph-ico">💬</div><div class="sp50-ph-title">WhatsApp CRM</div><div class="sp50-ph-sub">Selecciona un chat para comenzar</div>';
      cw.appendChild(ph);
    }

    function showPH(){
      var ph = document.getElementById('sp50-placeholder');
      if(!ph){ createPH(); ph = document.getElementById('sp50-placeholder'); }
      if(ph) ph.style.display = 'flex';
    }
    function hidePH(){
      var ph = document.getElementById('sp50-placeholder');
      if(ph) ph.style.display = 'none';
    }

    /* Expose globally so Fix 47 click handler can call hidePH */
    window.__sp50ShowPH = showPH;
    window.__sp50HidePH = hidePH;

    /* Reset state on load — placeholder first, no auto-open */
    window.__lastClickedJid = null;
    window.__spUserPickedChat = false;
    createPH();
    setTimeout(createPH, 500);

    /* Block auto-open: override injectDesktopChatIframe */
    function patchAutoOpen(){
      var orig = window.injectDesktopChatIframe;
      if(typeof orig !== 'function') return;
      if(orig.__sp50Wrapped) return;
      var wrapped = function(){
        if(!window.__spUserPickedChat || !window.__lastClickedJid) return;
        hidePH();
        return orig.apply(this, arguments);
      };
      wrapped.__sp50Wrapped = true;
      window.injectDesktopChatIframe = wrapped;
    }
    /* Patch after Fix 15/47 define it */
    [1500,3000,5000].forEach(function(d){ setTimeout(patchAutoOpen, d); });

    /* Remove any iframe that Fix 15 creates before user clicks */
    function killAutoIframe(){
      if(window.__spUserPickedChat) return; /* user clicked — stop killing */
      var iframe = document.getElementById('sp-chat-iframe');
      if(iframe){ iframe.remove(); showPH(); }
    }
    [500,1200,2000,3500,5000].forEach(function(d){ setTimeout(killAutoIframe, d); });

    /* Monitor: once user picks a chat, hide placeholder permanently (until section change) */
    setInterval(function(){
      if(window.__spUserPickedChat && window.__lastClickedJid){
        hidePH();
        patchAutoOpen(); /* ensure patched */
      }
    }, 600);
  })();



  /* ═══ 1. SORT — SUPABASE-BACKED (cloud persistence) ═══ */
  var SB_URL = 'https://lvmeswlvszsmvgaasazs.supabase.co/rest/v1';
  var SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx2bWVzd2x2c3pzbXZnYWFzYXpzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE1MjYzMTEsImV4cCI6MjA4NzEwMjMxMX0.pKhuLjRLgpWMBsEUv1WhCytpbUUT6tKj3sacIGit2z4';
  var _cachedOrder = {};
  var _lastSBFetch = 0;

  /* Fetch chat order from Supabase oasis_wa_chats */
  function fetchSBOrder(cb) {
    fetch(SB_URL + '/oasis_wa_chats?select=phone,push_name,last_timestamp&order=last_timestamp.desc.nullslast&limit=200', {
      headers: { 'apikey': SB_ANON, 'Authorization': 'Bearer ' + SB_ANON }
    }).then(function(r){ return r.json(); })
      .then(function(rows){
        if (!Array.isArray(rows) || rows.length === 0) return;
        var map = {};
        rows.forEach(function(r){
          var phone = (r.phone || '').replace(/\D/g, '');
          var ts = r.last_timestamp ? new Date(r.last_timestamp).getTime() : 0;
          if (!phone || !ts) return;
          map[phone] = ts;
          if (phone.length > 10) map[phone.slice(-10)] = ts;
          if (phone.length > 9) map[phone.slice(-9)] = ts;
          var nm = (r.push_name || '').trim().toLowerCase();
          if (nm && nm.length > 1) map['name:' + nm] = ts;
        });
        _cachedOrder = map;
        _lastSBFetch = Date.now();
        try { localStorage.setItem('sna_chat_order', JSON.stringify(map)); localStorage.setItem('sna_chat_order_ts', String(Date.now())); } catch(e){}
        if (cb) cb();
      }).catch(function(e){ console.warn('[SNA] SB fetch error:', e); });
  }

  /* Load from localStorage as initial cache while SB fetches */
  try {
    var raw = localStorage.getItem('sna_chat_order');
    var ts = parseInt(localStorage.getItem('sna_chat_order_ts') || '0');
    if (raw && ts && (Date.now() - ts < 86400000)) _cachedOrder = JSON.parse(raw) || {};
  } catch(e){}

  /* Update Supabase last_timestamp when message sent from panel */
  function updateSBTimestamp(jidOrPhone) {
    if (!jidOrPhone) return;
    var phone = String(jidOrPhone).replace(/@.*/, '').replace(/\D/g, '');
    if (phone.length < 7) return;
    var now = new Date().toISOString();
    /* Update local cache immediately */
    _cachedOrder[phone] = Date.now();
    if (phone.length > 10) _cachedOrder[phone.slice(-10)] = Date.now();
    try { localStorage.setItem('sna_chat_order', JSON.stringify(_cachedOrder)); localStorage.setItem('sna_chat_order_ts', String(Date.now())); } catch(e){}
    sortWithOrder();
    /* Update Supabase in background */
    fetch(SB_URL + '/oasis_wa_chats?phone=eq.' + phone, {
      method: 'PATCH',
      headers: {
        'apikey': SB_ANON,
        'Authorization': 'Bearer ' + SB_ANON,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ last_timestamp: now })
    }).catch(function(){});
  }

  /* Intercept panel sends to update sort + Supabase timestamp */
  var _realFetch50 = window.fetch;
  window.fetch = function() {
    var url = arguments[0] || '';
    var opts = arguments[1] || {};
    var promise = _realFetch50.apply(this, arguments);
    if (typeof url === 'string') {
      /* When message sent from panel */
      if (url.indexOf('/send') !== -1 && opts.method && opts.method.toUpperCase() === 'POST') {
        var match = url.match(/\/chats\/([^\/]+)\/send/);
        if (match) {
          var sentTo = decodeURIComponent(match[1]);
          updateSBTimestamp(sentTo);
        }
      }
      /* When oasis_wa_chats PATCH (name edit from Clientes), reload names */
      if (url.indexOf('oasis_wa_chats') !== -1 && opts.method && opts.method.toUpperCase() === 'PATCH') {
        promise.then(function(){
          setTimeout(function(){
            if (window.__snaNameCache && typeof window.__snaNameCache.reload === 'function') window.__snaNameCache.reload();
            loadIAConfig();
          }, 1000);
        }).catch(function(){});
      }
    }
    return promise;
  };

  function getItemKey50(el) {
    var jid = el.getAttribute('data-jid') || el.getAttribute('data-id') || '';
    if (jid) return jid.replace(/\D/g, '');
    var nameEl = el.querySelector('.wbv5-ci-name');
    if (!nameEl) return '';
    var rawName = nameEl.textContent.replace(/⚡[^⚡]*/g, '').replace(/🤖.*/g, '').replace(/[^\w\s\+áéíóúñÁÉÍÓÚÑ]/g, '').trim();
    var nameNum = rawName.replace(/\D/g, '');
    if (nameNum.length >= 8) return nameNum;
    if (rawName.length > 1) return 'name:' + rawName.toLowerCase();
    return '';
  }

  function getRank50(el) {
    var key = getItemKey50(el);
    if (!key) return 0;
    var rank = _cachedOrder[key] || 0;
    if (!rank && key.indexOf('name:') === -1) {
      var short = key.slice(-10);
      for (var k in _cachedOrder) {
        if (k.indexOf('name:') === 0) continue;
        if (k.slice(-10) === short) { rank = _cachedOrder[k]; break; }
      }
    }
    if (rank) return rank;
    /* Fallback: parse time from DOM — but penalize vs Supabase entries */
    /* When Supabase data is loaded, DOM-only chats sort BELOW Supabase chats */
    var hasSBData = _lastSBFetch > 0;
    var timeEl = el.querySelector('.wbv5-ci-time,[class*=ci-time]');
    if (!timeEl) return 0;
    var t = timeEl.textContent.trim().toLowerCase();
    var domRank = 0;
    var m = t.match(/(\d{1,2}):(\d{2})\s*(a\.?\s*m\.?|p\.?\s*m\.?)/);
    if (m) {
      var h = parseInt(m[1]), mn = parseInt(m[2]);
      var isPM = m[3].indexOf('p') !== -1;
      if (isPM && h < 12) h += 12;
      if (!isPM && h === 12) h = 0;
      var d = new Date(); d.setHours(h, mn, 0, 0);
      domRank = d.getTime();
      if (domRank > Date.now() + 3600000) domRank -= 86400000;
    } else if (t.indexOf('ayer') !== -1) {
      var yd = new Date(); yd.setDate(yd.getDate()-1); yd.setHours(12,0,0,0);
      domRank = yd.getTime();
    } else {
      var dm = t.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
      if (dm) { var yr = parseInt(dm[3]); if(yr<100) yr+=2000; domRank = new Date(yr,parseInt(dm[2])-1,parseInt(dm[1])).getTime(); }
    }
    /* If we have Supabase data, push DOM-only chats 30 days into the past */
    /* This ensures Supabase-tracked chats always appear above stale cached chats */
    if (hasSBData && domRank > 0) {
      domRank -= 2592000000; /* 30 days in ms */
    }
    return domRank;
  }


  var _sortBusy50 = false;
  function hideNonDBItems() {
    var container = document.querySelector('.wbv5-il-convs');
    if (!container) return;
    var hidden = container.querySelectorAll('[data-sna-hide]');
    hidden.forEach(function(el) {
      el.style.setProperty('display', 'none', 'important');
    });
  }

  function sortWithOrder() {
    if (_sortBusy50) return;
    var container = document.querySelector('.wbv5-il-convs');
    if (!container) return;
    var items = Array.from(container.querySelectorAll(':scope > .wbv5-conv-itm'));
    if (items.length < 2) return;
    _sortBusy50 = true;
    try {
      var scored = items.filter(function(el) { return el.classList.contains('sna-in-db') || !container.classList.contains('sna-filter-active'); }).map(function(el) { return { el: el, rank: getRank50(el) }; });
      scored.sort(function(a, b) { return b.rank - a.rank; });
      scored.forEach(function(s, i) { s.el.style.order = i; });
    } finally { _sortBusy50 = false; }
  }

  /* Expose for hookPanelSend compatibility */
  window.__spUpdateChatRank = function(jidOrPhone) {
    updateSBTimestamp(jidOrPhone);
  };

  /* Initial fetch from Supabase + sort */
  fetchSBOrder(sortWithOrder);
  /* Periodic refresh from Supabase every 30s */
  setInterval(function() { fetchSBOrder(sortWithOrder); }, 30000);
  /* Also sort on DOM changes */
  [500, 1500, 3000, 5000].forEach(function(d) { setTimeout(function(){ syncNamesAndDedup(); sortWithOrder(); }, d); });

  function initSortObs50() {
    var c = document.querySelector('.wbv5-il-convs');
    if (!c || c.__sp50sortObs) return;
    c.__sp50sortObs = true;
    var _t = null;
    new MutationObserver(function() { clearTimeout(_t); _t = setTimeout(function(){ syncNamesAndDedup(); sortWithOrder(); }, 400); }).observe(c, { childList: true });
  }
  [1000, 3000, 5000].forEach(function(d) { setTimeout(initSortObs50, d); });
  setInterval(function() { var c = document.querySelector('.wbv5-il-convs'); if (c && !c.__sp50sortObs) initSortObs50(); }, 3000);

  /* ═══ 2. MOBILE CHAT TAP ═══ */
  function ensureMobileTapHandler(){
    var convs = document.querySelector('.wbv5-il-convs') || document.querySelector('.wbv5-inbox-list');
    if(!convs || convs.__sp50tap) return;
    convs.__sp50tap = true;
    convs.addEventListener('click', function(e){
      if(window.innerWidth > 900) return;
      var item = e.target.closest('.wbv5-conv-itm');
      if(!item) return;
      e.preventDefault(); e.stopPropagation();
      var jid = item.getAttribute('data-jid') || item.getAttribute('data-id') || '';
      if(!jid){
        var nameEl = item.querySelector('.wbv5-ci-name');
        if(nameEl){
          var raw = (nameEl.getAttribute('data-sna-name') || nameEl.textContent || '').replace(/⚡[^⚡]*/g,'').replace(/🤖.*/g,'').trim();
          var num = raw.replace(/\D/g,'');
          if(num.length >= 8) jid = num + '@s.whatsapp.net';
        }
      }
      if(!jid){
        var tries = 0;
        var poll = setInterval(function(){
          tries++;
          var sub = document.querySelector('.wbv5-cw-sub');
          if(sub){ var n = sub.textContent.replace(/[^0-9]/g,''); if(n && n.length >= 8){ clearInterval(poll); openMobile50(n + '@s.whatsapp.net'); } }
          if(tries >= 12) clearInterval(poll);
        }, 80);
        return;
      }
      window.__lastClickedJid = jid;
      window.__spUserPickedChat = true;
      openMobile50(jid);
    }, true);
  }

  function openMobile50(jid){
    if(!jid) return;
    var url = '/bot/chat.html?jid=' + encodeURIComponent(jid) + '&t=' + Date.now();
    var ov = document.getElementById('sp-mobile-chat-overlay');
    if(!ov){
      ov = document.createElement('div'); ov.id = 'sp-mobile-chat-overlay';
      ov.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:9999;background:#fff;display:flex;flex-direction:column;';
      var fr = document.createElement('iframe'); fr.id = 'sp-mobile-chat-frame'; fr.allow = 'microphone';
      fr.style.cssText = 'flex:1;width:100%;border:none;background:#fff;';
      ov.appendChild(fr); document.body.appendChild(ov);
    }
    var fr = document.getElementById('sp-mobile-chat-frame');
    if(fr) fr.src = url;
    ov.style.display = 'flex';
    if(fr) fr.onload = function(){
      setTimeout(function(){
        try {
          var doc = fr.contentDocument;
          var btn = doc && doc.getElementById('back-btn');
          if(btn && !btn.__sp50back){ btn.__sp50back = true; btn.addEventListener('click', function(){ ov.style.display = 'none'; }); }
        } catch(e){}
      }, 300);
    };
  }

  setInterval(ensureMobileTapHandler, 2000);
  [300, 800, 1500, 3000, 5000].forEach(function(d){ setTimeout(ensureMobileTapHandler, d); });

  var mobileCss = document.createElement('style'); mobileCss.id = 'sp-fix50-mobile-css';
  mobileCss.textContent = '@media(max-width:900px){#sp-mobile-chat-overlay{display:none;}#sp-mobile-chat-overlay[style*="display: flex"],#sp-mobile-chat-overlay[style*="display:flex"]{display:flex!important;position:fixed!important;top:0!important;left:0!important;width:100%!important;height:100%!important;z-index:9999!important;}}';
  document.head.appendChild(mobileCss);

  /* ═══ 3. IA INDICATOR (robot emoji) ═══ */
  var _contactMap = {}, _globalIAEnabled = false, _iaLoaded = false;

  function loadIAConfig(){
    var sb = window.__spCachedSB, sk = window.__spCachedSK;
    if(!sb || !sk){
      var f = document.getElementById('sp-chat-iframe') || document.getElementById('sp-cred-frame');
      try { if(f && f.contentWindow && f.contentWindow.SK){ sb = window.__spCachedSB = f.contentWindow.SB; sk = window.__spCachedSK = f.contentWindow.SK; } } catch(e){}
    }
    if(!sb || !sk) return;
    fetch(sb + '/rest/v1/oasis_wa_config?select=enabled,contact_map&id=eq.default&limit=1', {
      headers: {'apikey': sk, 'Authorization': 'Bearer ' + sk}
    }).then(function(r){ return r.json(); }).then(function(data){
      if(!Array.isArray(data) || !data[0]) return;
      _globalIAEnabled = !!data[0].enabled;
      _contactMap = data[0].contact_map || {};
      _iaLoaded = true;
      applyIABadges();
    }).catch(function(){});
  }

  function isIAActive(el){
    if(!_iaLoaded) return null;
    if(!_globalIAEnabled) return false;
    var key = getItemKey50(el); if(!key) return null;
    if(_contactMap[key] !== undefined) return !!_contactMap[key];
    if(_contactMap[key + '@s.whatsapp.net'] !== undefined) return !!_contactMap[key + '@s.whatsapp.net'];
    var short = key.slice(-10);
    for(var k in _contactMap){ var kNum = k.replace(/\D/g,''); if(kNum.slice(-10) === short) return !!_contactMap[k]; }
    return true;
  }

  var iaCss = document.createElement('style'); iaCss.id = 'sp-fix50-ia-css';
  iaCss.textContent = '.sp50-ia{display:inline-flex;align-items:center;font-size:12px;padding:0 4px;border-radius:4px;margin-left:4px;vertical-align:middle;line-height:1.4;pointer-events:none;}.sp50-ia-on{background:#dcfce7;color:#166534;}.sp50-ia-off{background:#fef2f2;color:#dc2626;}';
  document.head.appendChild(iaCss);

  function applyIABadges(){
    if(!_iaLoaded) return;
    document.querySelectorAll('.wbv5-conv-itm').forEach(function(item){
      var nameEl = item.querySelector('.wbv5-ci-name'); if(!nameEl) return;
      var existing = nameEl.querySelector('.sp50-ia');
      var iaOn = isIAActive(item); if(iaOn === null) return;
      if(existing){
        var wasOn = existing.classList.contains('sp50-ia-on');
        if(wasOn !== iaOn){ existing.className = 'sp50-ia ' + (iaOn ? 'sp50-ia-on' : 'sp50-ia-off'); existing.textContent = iaOn ? '🤖' : '🤖 off'; }
        return;
      }
      var old = nameEl.querySelector('span[style*="background"]');
      if(old && old.textContent.indexOf('⚡') !== -1) old.remove();
      var badge = document.createElement('span');
      badge.className = 'sp50-ia ' + (iaOn ? 'sp50-ia-on' : 'sp50-ia-off');
      badge.textContent = iaOn ? '🤖' : '🤖 off';
      nameEl.appendChild(badge);
    });
  }

  [3000, 6000, 12000].forEach(function(d){ setTimeout(loadIAConfig, d); });
  setInterval(loadIAConfig, 45000);
  setInterval(applyIABadges, 3000);

  /* ═══ 4. NAME SYNC FROM CLIENTES ═══ */
  var _lastSection = '';
  setInterval(function(){
    var topbar = document.querySelector('.wbv5-topbar');
    var section = topbar ? topbar.textContent.trim().substring(0, 20) : '';
    if(section !== _lastSection){
      var wasClientes = _lastSection.indexOf('Cliente') !== -1;
      _lastSection = section;
      if(wasClientes && !!document.querySelector('.wbv5-inbox-list')){
        if(window.__snaNameCache && typeof window.__snaNameCache.reload === 'function') window.__snaNameCache.reload();
        loadIAConfig(); setTimeout(sortWithOrder, 1500);
      }
    }
  }, 500);

  console.info('[WA-OASIS v9] Fix 50: sort+localStorage, mobile tap, IA badge, name sync');
})();

/* ================================================================
   Fix 51: NAME SYNC + DEDUP + NAME CACHE (Supabase-backed) v2
   - Actively syncs names from Supabase → sidebar via CSS overlay
   - When name edited in Clientes, sidebar updates on next refresh
   - Rebuilds __snaNameCache from Supabase when bot is disconnected
   - Replaces "Sánate" display names
   - Hides duplicate chat entries
   ================================================================ */
(function(){
  if (window.location.pathname.indexOf('/dashboard/whatsapp-bot') === -1) return;
  if (window.__snaFix51) return;
  window.__snaFix51 = true;

  var SB_URL = 'https://lvmeswlvszsmvgaasazs.supabase.co/rest/v1';
  var SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx2bWVzd2x2c3pzbXZnYWFzYXpzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE1MjYzMTEsImV4cCI6MjA4NzEwMjMxMX0.pKhuLjRLgpWMBsEUv1WhCytpbUUT6tKj3sacIGit2z4';
  var BUSINESS_NAME = 'Sánate';
  
  /* Phone → {name, push_name} map from Supabase */
  var _sbNames = {};
  var _sbLoaded = false;

  /* ── 51a: Supabase name cache + overlay names ── */
  function loadSBNames(cb) {
    fetch(SB_URL + '/oasis_wa_chats?select=phone,name,push_name&limit=500', {
      headers: { 'apikey': SB_ANON, 'Authorization': 'Bearer ' + SB_ANON }
    }).then(function(r){ return r.json(); })
      .then(function(rows){
        if (!Array.isArray(rows)) return;
        _sbNames = {};
        rows.forEach(function(c) {
          var phone = (c.phone || '').replace(/\D/g, '');
          if (!phone || phone.length < 7) return;
          var bestName = (c.name || c.push_name || '').trim();
          _sbNames[phone] = bestName;
          if (phone.length > 10) _sbNames[phone.slice(-10)] = bestName;
        });
        _sbLoaded = true;
        /* Also update __snaNameCache for header resolution */
        ensureNameCache();
        if (cb) cb();
      }).catch(function(e){ console.warn('[Fix51] SB fetch error:', e); });
  }

  function ensureNameCache() {
    var _cache = {};
    for (var p in _sbNames) {
      var name = _sbNames[p];
      if (!name || name.length < 2 || name === BUSINESS_NAME) continue;
      var nd = name.replace(/\D/g, '');
      if (nd.length >= 7 && nd.length === name.replace(/[\s+\-().]/g, '').length) continue;
      _cache[p] = name;
    }
    window.__snaNameCache = {
      resolve: function(d) {
        if (!d || d.length < 7) return null;
        return _cache[d] || _cache[d.slice(-10)] || _cache[d.slice(-9)] || null;
      },
      isLoaded: function() { return _sbLoaded; },
      reload: loadSBNames
    };
  }

  /* ── CSS for overlays ── */
  var nst = document.getElementById('sna-fix51-css');
  if (!nst) {
    nst = document.createElement('style');
    nst.id = 'sna-fix51-css';
    nst.textContent = [
      '[data-sna-realname]{color:transparent!important;position:relative!important;}',
      '[data-sna-realname]::after{content:attr(data-sna-realname);position:absolute;left:0;top:0;',
      'color:#1f2937;white-space:nowrap;pointer-events:none;',
      'font-size:inherit;font-weight:inherit;line-height:inherit;letter-spacing:inherit;}',
      '.sna-duplicate{display:none!important;}',
      '.wbv5-il-convs.sna-filter-active > .wbv5-conv-itm{max-height:0!important;overflow:hidden!important;padding:0!important;margin:0!important;border:0!important;min-height:0!important;opacity:0!important;pointer-events:none!important;}.wbv5-il-convs.sna-filter-active > .wbv5-conv-itm.sna-in-db{max-height:999px!important;overflow:visible!important;padding:0 10px 0 13px!important;margin:0!important;border:none!important;min-height:auto!important;opacity:1!important;pointer-events:auto!important;}'
    ].join('');
    document.head.appendChild(nst);
  }

  /* ── Get React chat state ── */
  function getReactChats() {
    var container = document.querySelector('.wbv5-il-convs');
    if (!container) return null;
    var fKey = Object.keys(container).find(function(k){ return k.indexOf('__reactFiber') === 0; });
    if (!fKey) return null;
    var node = container[fKey];
    for (var depth = 0; depth < 25 && node; depth++) {
      if (node.memoizedState) {
        var hs = node.memoizedState;
        var hi = 0;
        while (hs && hi < 15) {
          var val = hs.memoizedState;
          if (Array.isArray(val) && val.length > 5 && val[0] && val[0].id && val[0].name !== undefined) return val;
          hs = hs.next; hi++;
        }
      }
      node = node.return;
    }
    return null;
  }

  /* ── 51b: Apply name overlays + dedup ── */
  function syncNamesAndDedup() {
    var reactChats = getReactChats();
    if (!reactChats) return;
    var container = document.querySelector('.wbv5-il-convs');
    if (!container) return;
    var items = Array.from(container.querySelectorAll(':scope > .wbv5-conv-itm'));
    if (items.length === 0) return;

    var phoneFirstSeen = {};

    items.forEach(function(el, domIdx) {
      var nameEl = el.querySelector('.wbv5-ci-name');
      if (!nameEl) return;
      var displayName = nameEl.textContent.replace(/⚡[^⚡]*/g, '').replace(/🤖.*/g, '').trim();

      /* Match DOM item to React data */
      var reactChat = (domIdx < reactChats.length) ? reactChats[domIdx] : null;
      if (!reactChat || reactChat.name !== displayName) {
        for (var j = 0; j < reactChats.length; j++) {
          if (reactChats[j].name === displayName) { reactChat = reactChats[j]; break; }
        }
      }
      if (!reactChat) return;

      var phone = (reactChat.phone || '').replace(/\D/g, '');
      var chatId = reactChat.id || '';

      /* ── Dedup ── */
      if (phone && phone.length >= 7) {
        var phoneKey = phone.slice(-10);
        if (phoneFirstSeen[phoneKey]) {
          var first = phoneFirstSeen[phoneKey];
          if (reactChat._ts < first.react._ts) {
            el.classList.add('sna-duplicate');
            return;
          } else {
            first.el.classList.add('sna-duplicate');
            phoneFirstSeen[phoneKey] = { el: el, react: reactChat };
          }
        } else {
          phoneFirstSeen[phoneKey] = { el: el, react: reactChat };
        }
      }

      /* ── FILTER: Show only chats in Supabase DB ── */
      if (_sbLoaded && phone && phone.length >= 7) {
        var inDB = _sbNames[phone] !== undefined || _sbNames[phone.slice(-10)] !== undefined;
        if (inDB) {
          el.classList.add('sna-in-db');
        } else {
          el.classList.remove('sna-in-db');
        }
        /* Activate filter on container once we've processed items */
        if (container && !container.classList.contains('sna-filter-active')) {
          container.classList.add('sna-filter-active');
        }
      }

      /* ── Name sync from Supabase ── */
      if (!_sbLoaded) return;

      var sbName = null;
      if (phone && phone.length >= 7) {
        sbName = _sbNames[phone] || _sbNames[phone.slice(-10)] || null;
      }

      /* Case 1: Name is "Sánate" (business account name) → replace */
      if (displayName === BUSINESS_NAME || displayName === 'Sanate') {
        var betterName = sbName;
        if (!betterName || betterName === BUSINESS_NAME) {
          var digits = phone || chatId.replace(/\D/g, '');
          betterName = digits.length > 4 ? 'Contacto •' + digits.slice(-4) : 'Contacto';
        }
        nameEl.setAttribute('data-sna-realname', betterName);
        return;
      }

      /* Case 2: Supabase has a DIFFERENT name than React (user edited in Clientes) */
      if (sbName && sbName !== BUSINESS_NAME && sbName !== displayName) {
        /* Check it's meaningfully different (not just case/whitespace) */
        var sbClean = sbName.toLowerCase().trim();
        var dispClean = displayName.toLowerCase().trim();
        if (sbClean !== dispClean) {
          nameEl.setAttribute('data-sna-realname', sbName);
          return;
        }
      }

      /* Case 3: Name matches or no Supabase entry → remove overlay if stale */
      if (nameEl.hasAttribute('data-sna-realname')) {
        var cur = nameEl.getAttribute('data-sna-realname');
        if (sbName && cur !== sbName) {
          nameEl.setAttribute('data-sna-realname', sbName);
        } else if (!sbName && displayName !== BUSINESS_NAME) {
          nameEl.removeAttribute('data-sna-realname');
        }
      }
    });
  }

  /* ── 51c: Fix header name ── */
  function fixHeaderName() {
    var headerName = document.querySelector('.wbv5-cw-name');
    if (!headerName) return;
    var text = (headerName.textContent || '').trim();
    if (text === 'Cargando...' || text === '') return;
    var digits = text.replace(/\D/g, '');
    /* Phone number in header → resolve from cache */
    if (digits.length >= 7 && digits.length === text.replace(/[\s+\-().]/g, '').length) {
      if (!_sbLoaded) return;
      var name = _sbNames[digits] || _sbNames[digits.slice(-10)] || null;
      if (name && name !== BUSINESS_NAME) {
        headerName.setAttribute('data-sna-name', name);
      }
      return;
    }
    /* "Sánate" in header → resolve */
    if (text === BUSINESS_NAME) {
      var sub = document.querySelector('.wbv5-cw-sub');
      if (sub) {
        var subDigits = sub.textContent.replace(/\D/g, '');
        if (subDigits.length >= 7) {
          var nm = _sbNames[subDigits] || _sbNames[subDigits.slice(-10)] || null;
          if (nm && nm !== BUSINESS_NAME) {
            headerName.setAttribute('data-sna-name', nm);
          }
        }
      }
    }
  }

  /* ── 51d: Watch for Clientes→Chats navigation ── */
  /* When user navigates from Clientes back to Chats, force Supabase refresh */
  var _lastNav = '';
  function watchNavigation() {
    var topbar = document.querySelector('.wbv5-topbar,.sp-topbar,[class*=topbar]');
    var section = topbar ? topbar.textContent.trim().substring(0, 20) : '';
    var sidebar = document.querySelector('.sp-sidebar-active,.wbv5-sidebar-active');
    var active = sidebar ? sidebar.textContent.trim().substring(0, 15) : section;
    if (active !== _lastNav) {
      var wasClientes = _lastNav.indexOf('Cliente') !== -1;
      _lastNav = active;
      if (wasClientes) {
        /* User just left Clientes → force refresh from Supabase */
        loadSBNames(function() {
          syncNamesAndDedup();
        });
      }
    }
  }

  /* Also intercept PATCH to oasis_wa_chats (name edits) */
  var _realFetch51 = window.fetch;
  window.fetch = function() {
    var url = arguments[0] || '';
    var opts = arguments[1] || {};
    var promise = _realFetch51.apply(this, arguments);
    if (typeof url === 'string' && url.indexOf('oasis_wa_chats') !== -1 && opts.method && opts.method.toUpperCase() === 'PATCH') {
      promise.then(function() {
        /* Name was edited in Clientes → refresh names after a short delay */
        setTimeout(function() {
          loadSBNames(function() {
            syncNamesAndDedup();
          });
        }, 800);
      }).catch(function(){});
    }
    return promise;
  };

  /* ── Schedule everything ── */
  loadSBNames(function() {
    syncNamesAndDedup();
  });
  setTimeout(function(){ syncNamesAndDedup(); }, 3000);
  setTimeout(function(){ syncNamesAndDedup(); }, 6000);
  setInterval(function(){ syncNamesAndDedup(); fixHeaderName(); }, 4000);
  setInterval(function(){ loadSBNames(syncNamesAndDedup); }, 30000);
  setInterval(watchNavigation, 500);

  console.info('[WA-OASIS] Fix 51 v2: name sync + dedup + name cache');
})();


/* ============================================================
   FIX 101 v2 — Reset chat state on Chats sidebar click
   BUG: __spUserPickedChat persists when user navigates away
   from Chats (e.g. to Clientes) and back. The sidebar uses
   .wbv5-nav-item divs inside .wbv5-sidebar — NO URL changes,
   so pushState/popstate interception does not work.
   FIX: Intercept clicks on the "Chats" nav-item directly.
   When clicked, reset all state so placeholder shows and
   user must manually pick a chat.
   ============================================================ */
(function fix101(){
  if(window.__spFix101) return;
  window.__spFix101 = true;

  var _guard101 = null;

  function resetChatState(){
    /* Reset completo: forzar placeholder al entrar a Chats */
    window.__spUserPickedChat = false;
    window.__lastClickedJid = null;

    /* Eliminar iframe auto-creado */
    var iframe = document.getElementById('sp-chat-iframe');
    if(iframe) iframe.remove();

    /* Limpiar chat-win y forzar placeholder via CSS class */
    var cw = document.querySelector('.wbv5-chat-win');
    if(cw){
      cw.classList.remove('sp-iframe-active');
      cw.classList.add('sp-no-chat');
    }

    /* Ocultar overlay movil */
    var ov = document.getElementById('sp-mobile-chat-overlay');
    if(ov) ov.style.display = 'none';

    /* Mostrar placeholder */
    if(window.__spShowPlaceholder) window.__spShowPlaceholder();
    if(window.__sp50ShowPH) window.__sp50ShowPH();

    /* Guard temporal: matar iframes auto-creados por otros fixes */
    if(_guard101) clearInterval(_guard101);
    _guard101 = setInterval(function(){
      if(window.__spUserPickedChat){ clearInterval(_guard101); _guard101 = null; return; }
      var f = document.getElementById('sp-chat-iframe');
      if(f) f.remove();
      window.__lastClickedJid = null;
      var cw2 = document.querySelector('.wbv5-chat-win');
      if(cw2){ cw2.classList.remove('sp-iframe-active'); cw2.classList.add('sp-no-chat'); }
      if(window.__spShowPlaceholder) window.__spShowPlaceholder();
      if(window.__sp50ShowPH) window.__sp50ShowPH();
    }, 300);
    setTimeout(function(){ if(_guard101){ clearInterval(_guard101); _guard101 = null; } }, 8000);

    console.info('[Fix101v2] Chats nav clicked - state reset, placeholder shown');
  }

  /* Attach click listener on sidebar — capture phase so we run BEFORE React */
  function attachSidebarListener(){
    var sidebar = document.querySelector('.wbv5-sidebar');
    if(!sidebar || sidebar.__sp101) return;
    sidebar.__sp101 = true;

    sidebar.addEventListener('click', function(e){
      /* Find the clicked nav-item */
      var item = e.target.closest ? e.target.closest('.wbv5-nav-item') : null;
      if(!item) return;

      var text = item.textContent || '';
      /* Only reset when clicking the "Chats" nav item */
      if(text.indexOf('Chat') === -1) return;

      /* Only reset if user had a chat open (otherwise no-op) */
      if(!window.__spUserPickedChat && !window.__lastClickedJid) return;

      /* Small delay to let React swap the view first */
      setTimeout(resetChatState, 80);
    }, true); /* capture phase */
  }

  /* Try attaching now and retry if sidebar not yet rendered */
  attachSidebarListener();
  [500, 1500, 3000, 6000].forEach(function(d){ setTimeout(attachSidebarListener, d); });

  /* MutationObserver fallback: if React re-creates sidebar, re-attach */
  setTimeout(function(){
    new MutationObserver(function(){
      var sb = document.querySelector('.wbv5-sidebar');
      if(sb && !sb.__sp101) attachSidebarListener();
    }).observe(document.body, {childList: true, subtree: true});
  }, 2000);

  console.info('[WA-OASIS] Fix 101 v2: reset chat on sidebar Chats click');
})();

/* ================================================================
   Fix 102: ARCHIVE / DELETE BUTTONS on chat items
   ================================================================ */
(function(){
  if(window.location.pathname.indexOf('/dashboard/whatsapp-bot')!==0) return;
  if(window.__snaFix102) return;
  window.__snaFix102 = true;

  var SB_URL = 'https://lvmeswlvszsmvgaasazs.supabase.co/rest/v1';
  var SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx2bWVzd2x2c3pzbXZnYWFzYXpzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE1MjYzMTEsImV4cCI6MjA4NzEwMjMxMX0.pKhuLjRLgpWMBsEUv1WhCytpbUUT6tKj3sacIGit2z4';

  /* CSS */
  var css = document.createElement('style');
  css.id = 'sp-fix102-css';
  css.textContent = [
    '.sp102-btn{position:absolute;right:6px;top:50%;transform:translateY(-50%);width:28px;height:28px;border-radius:50%;background:rgba(255,255,255,0.92);border:1px solid #e2e8f0;display:none;align-items:center;justify-content:center;cursor:pointer;z-index:20;font-size:16px;color:#64748b;box-shadow:0 1px 3px rgba(0,0,0,0.1);transition:background 0.15s;}',
    '.sp102-btn:hover{background:#f1f5f9;color:#334155;}',
    '.wbv5-conv-itm{position:relative!important;}',
    '.wbv5-conv-itm:hover .sp102-btn{display:flex!important;}',
    '.sp102-menu{position:absolute;right:6px;top:calc(50% + 18px);background:#fff;border:1px solid #e2e8f0;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.12);z-index:50;min-width:140px;overflow:hidden;animation:sp102fade 0.12s ease;}',
    '@keyframes sp102fade{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}',
    '.sp102-opt{display:flex;align-items:center;gap:8px;padding:9px 14px;cursor:pointer;font-size:13px;color:#334155;transition:background 0.1s;white-space:nowrap;}',
    '.sp102-opt:hover{background:#f1f5f9;}',
    '.sp102-opt.sp102-danger{color:#dc2626;}',
    '.sp102-opt.sp102-danger:hover{background:#fef2f2;}',
    '.sp102-opt .sp102-ico{font-size:15px;width:18px;text-align:center;}'
  ].join('\n');
  document.head.appendChild(css);

  var _openMenu = null;

  /* Close any open menu */
  function closeMenu(){
    if(_openMenu){ _openMenu.remove(); _openMenu = null; }
  }
  document.addEventListener('click', function(e){
    if(_openMenu && !_openMenu.contains(e.target) && !e.target.classList.contains('sp102-btn')){
      closeMenu();
    }
  });

  /* Get phone from chat item */
  function getPhone(item){
    var jid = item.getAttribute('data-jid') || item.getAttribute('data-id') || '';
    if(jid) return jid.replace(/@.*/, '').replace(/\D/g, '');
    var nameEl = item.querySelector('.wbv5-ci-name');
    if(!nameEl) return '';
    var raw = (nameEl.getAttribute('data-sna-name') || nameEl.textContent || '').replace(/🤖.*/g,'').replace(/⚡.*/g,'').trim();
    var num = raw.replace(/\D/g, '');
    return num.length >= 7 ? num : '';
  }

  /* Archive chat */
  function archiveChat(phone, item){
    if(!phone) return;
    var jid = phone + '@s.whatsapp.net';
    fetch(SB_URL + '/oasis_wa_chats?or=(phone.eq.' + phone + ',jid.eq.' + jid + ')', {
      method: 'PATCH',
      headers: {
        'apikey': SB_KEY,
        'Authorization': 'Bearer ' + SB_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ tags: '["archived"]', archived: true })
    }).then(function(r){
      if(r.ok){
        item.style.transition = 'opacity 0.3s, max-height 0.3s';
        item.style.opacity = '0';
        item.style.maxHeight = '0';
        item.style.overflow = 'hidden';
        setTimeout(function(){ item.remove(); }, 350);
        console.info('[Fix102] Archived:', phone);
      } else { alert('Error archivando chat'); }
    }).catch(function(e){ alert('Error: ' + e.message); });
  }

  /* Delete chat */
  function deleteChat(phone, item){
    if(!phone) return;
    if(!confirm('¿Eliminar este chat permanentemente?\nSe borrarán los mensajes asociados.')) return;
    var jid = phone + '@s.whatsapp.net';
    /* Delete messages first */
    fetch(SB_URL + '/oasis_wa_messages?chat_id=eq.' + jid, {
      method: 'DELETE',
      headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY, 'Prefer': 'return=minimal' }
    }).then(function(){
      /* Then delete chat */
      return fetch(SB_URL + '/oasis_wa_chats?or=(phone.eq.' + phone + ',jid.eq.' + jid + ')', {
        method: 'DELETE',
        headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY, 'Prefer': 'return=minimal' }
      });
    }).then(function(r){
      if(r.ok){
        item.style.transition = 'opacity 0.3s, max-height 0.3s';
        item.style.opacity = '0';
        item.style.maxHeight = '0';
        item.style.overflow = 'hidden';
        setTimeout(function(){ item.remove(); }, 350);
        console.info('[Fix102] Deleted:', phone);
      } else { alert('Error eliminando chat'); }
    }).catch(function(e){ alert('Error: ' + e.message); });
  }

  /* Show context menu */
  function showMenu(btn, item){
    closeMenu();
    var phone = getPhone(item);
    if(!phone) return;
    var menu = document.createElement('div');
    menu.className = 'sp102-menu';
    menu.innerHTML = '<div class="sp102-opt sp102-archive"><span class="sp102-ico">📦</span>Archivar</div>' +
                     '<div class="sp102-opt sp102-danger sp102-delete"><span class="sp102-ico">🗑️</span>Eliminar</div>';
    item.appendChild(menu);
    _openMenu = menu;

    menu.querySelector('.sp102-archive').addEventListener('click', function(e){
      e.stopPropagation();
      closeMenu();
      archiveChat(phone, item);
    });
    menu.querySelector('.sp102-delete').addEventListener('click', function(e){
      e.stopPropagation();
      closeMenu();
      deleteChat(phone, item);
    });
  }

  /* Inject ⋮ button on chat items */
  function injectButtons(){
    var items = document.querySelectorAll('.wbv5-conv-itm');
    items.forEach(function(item){
      if(item.querySelector('.sp102-btn')) return;
      var btn = document.createElement('div');
      btn.className = 'sp102-btn';
      btn.textContent = '⋮';
      btn.title = 'Opciones';
      btn.addEventListener('click', function(e){
        e.stopPropagation();
        e.preventDefault();
        showMenu(btn, item);
      });
      item.appendChild(btn);
    });
  }

  /* Run periodically to catch new items */
  setInterval(injectButtons, 2000);
  setTimeout(injectButtons, 1500);
  setTimeout(injectButtons, 3000);

  console.info('[WA-OASIS] Fix 102: Archive/Delete buttons on chat items');
})();
electorAll('.wbv5-conv-itm');
    items.forEach(function(item){
      if(item.querySelector('.sp102-btn')) return;
      var btn = document.createElement('div');
      btn.className = 'sp102-btn';
      btn.textContent = '⋮';
      btn.title = 'Opciones';
      btn.addEventListener('click', function(e){
        e.stopPropagation();
        e.preventDefault();
        showMenu(btn, item);
      });
      item.appendChild(btn);
    });
  }

  /* Run periodically to catch new items */
  setInterval(injectButtons, 2000);
  setTimeout(injectButtons, 1500);
  setTimeout(injectButtons, 3000);

  console.info('[WA-OASIS] Fix 102: Archive/Delete buttons on chat items');
})();
