/* Connection Stabilizer v2.1 - SANATE */
(function() {
  'use strict';
  if (window.__sanateConnStabilizer) return;
  window.__sanateConnStabilizer = true;

  var GRACE_PERIOD = 30000;
  var lastConnectedAt = 0;
  var wasEverConnected = false;

  function isTransient(s) {
    return s === 'disconnected' || s === 'reconnecting' || s === 'qr_timeout';
  }
  function inGrace() {
    return wasEverConnected && (Date.now() - lastConnectedAt < GRACE_PERIOD);
  }
  function markConnected() {
    lastConnectedAt = Date.now();
    wasEverConnected = true;
  }

  /* == Detect user click on Conectar button → flag next /connect as force == */
  window.__forceNextConnect = false;
  document.addEventListener('click', function(e) {
    var btn = e.target.closest && e.target.closest('button, [role="button"], .btn');
    if (!btn) btn = e.target;
    var txt = (btn.textContent || '').trim().toLowerCase();
    if (txt.includes('conectar') || txt.includes('escanea') || txt.includes('generar qr') || txt.includes('vincular')) {
      window.__forceNextConnect = true;
      console.log('[ConnStab] User clicked connect button — next /connect will have force=true');
    }
  }, true);

  /* == Patch fetch for /connect (add force only on user click) + /status responses == */
  var _origFetch = window.fetch;
  window.fetch = function(url, opts) {
    var u = typeof url === 'string' ? url : (url && url.url ? url.url : '');

    // Interceptar POST /connect — solo agregar force=true si fue un click del usuario
    if (u.indexOf('/api/whatsapp/connect') !== -1 && opts && opts.method && opts.method.toUpperCase() === 'POST') {
      if (window.__forceNextConnect) {
        window.__forceNextConnect = false;
        var separator = u.indexOf('?') === -1 ? '?' : '&';
        console.log('[ConnStab] POST /connect with force=true (user click)');
        return _origFetch.call(this, u + separator + 'force=true', opts);
      }
      console.log('[ConnStab] POST /connect without force (auto-reconnect)');
    }

    if (u.indexOf('/api/whatsapp/status') === -1) return _origFetch.apply(this, arguments);
    return _origFetch.apply(this, arguments).then(function(r) {
      var clone = r.clone();
      return clone.json().then(function(d) {
        if (d.status === 'connected' && d.connected === true) markConnected();
        if (isTransient(d.status) && inGrace()) {
          var fake = JSON.parse(JSON.stringify(d));
          fake.status = 'connected'; fake.connected = true; fake._stabilized = true;
          return new Response(JSON.stringify(fake), {status:r.status, statusText:r.statusText, headers:r.headers});
        }
        return r;
      }).catch(function(){return r;});
    });
  };

  /* == Patch EventSource - use native addEventListener approach == */
  var _origES = window.EventSource;
  if (!_origES) return;

  window.EventSource = function(url) {
    var es = new _origES(url);
    var isWA = url && url.indexOf('/api/whatsapp/events') !== -1;
    if (!isWA) return es;

    /* Save native addEventListener/removeEventListener */
    var nativeAEL = EventTarget.prototype.addEventListener.bind(es);
    var nativeREL = EventTarget.prototype.removeEventListener.bind(es);

    /* Track user handlers mapped to wrapped handlers */
    var handlerMap = new WeakMap();

    function filterMsg(evt, cb) {
      try {
        var d = JSON.parse(evt.data);
        if (d.type === 'connection' && d.data) {
          var st = d.data.status;
          if (st === 'connected') { markConnected(); }
          else if (isTransient(st) && inGrace()) {
            console.log('[ConnStab] suppressed:', st);
            return; /* swallow */
          }
        }
      } catch(e) {}
      if (cb) cb.call(es, evt);
    }

    /* Override addEventListener */
    es.addEventListener = function(type, listener, opts) {
      if (type === 'message' && listener) {
        var wrapped = function(evt) { filterMsg(evt, listener); };
        handlerMap.set(listener, wrapped);
        return nativeAEL('message', wrapped, opts);
      }
      if (type === 'error' && listener) {
        var wrappedErr = function(evt) {
          if (inGrace()) { console.log('[ConnStab] suppressed error'); return; }
          listener.call(es, evt);
        };
        handlerMap.set(listener, wrappedErr);
        return nativeAEL('error', wrappedErr, opts);
      }
      return nativeAEL(type, listener, opts);
    };

    es.removeEventListener = function(type, listener, opts) {
      var wrapped = handlerMap.get(listener);
      return nativeREL(type, wrapped || listener, opts);
    };

    /* Override onmessage via defineProperty + native addEventListener */
    var _msgListener = null;
    var _msgWrapped = null;
    Object.defineProperty(es, 'onmessage', {
      get: function() { return _msgListener; },
      set: function(h) {
        if (_msgWrapped) nativeREL('message', _msgWrapped);
        if (h) {
          _msgWrapped = function(evt) { filterMsg(evt, h); };
          nativeAEL('message', _msgWrapped);
        } else {
          _msgWrapped = null;
        }
        _msgListener = h;
      },
      configurable: true
    });

    /* Override onerror */
    var _errListener = null;
    var _errWrapped = null;
    Object.defineProperty(es, 'onerror', {
      get: function() { return _errListener; },
      set: function(h) {
        if (_errWrapped) nativeREL('error', _errWrapped);
        if (h) {
          _errWrapped = function(evt) {
            if (inGrace()) return;
            h.call(es, evt);
          };
          nativeAEL('error', _errWrapped);
        } else {
          _errWrapped = null;
        }
        _errListener = h;
      },
      configurable: true
    });

    return es;
  };
  window.EventSource.prototype = _origES.prototype;
  window.EventSource.CONNECTING = _origES.CONNECTING;
  window.EventSource.OPEN = _origES.OPEN;
  window.EventSource.CLOSED = _origES.CLOSED;

  /* CSS delay for disconnect flash */
  var style = document.createElement('style');
  style.id = 'sanate-conn-stabilizer';
  style.textContent = '.si-disconnected{transition:opacity 0.5s ease 2s!important}.wbv5-connect-page{animation:fadeIn 0.5s ease 2s both!important}.si-connected{transition:none!important}';
  document.head.appendChild(style);

  console.log('[ConnStab] v2.1 active - grace:', GRACE_PERIOD/1000, 's');
})();
