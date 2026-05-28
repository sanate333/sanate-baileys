/* Panel Extras v1.4 — Horarios + Copia de Seguridad + Numero Vinculado */
(function() {
  'use strict';
  if (window.__panelExtrasLoaded) return;
  window.__panelExtrasLoaded = true;

  var BU = 'https://sanate-wa-bot.onrender.com/api/whatsapp';

  function api(method, path, body) {
    var opts = { method: method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    return fetch(BU + path, opts).then(function(r) { return r.json(); });
  }

  /* ============================================================
     1) NUMERO VINCULADO — Muestra el telefono al lado del QR
     ============================================================ */
  var _lastPhone = null;

  function injectPhoneDisplay() {
    if (window.location.pathname !== '/dashboard/whatsapp-bot') return;
    var existing = document.getElementById('sanate-phone-badge');
    if (existing) return;

    var scanHeader = null;
    /* Search H3 first (most specific), then H2, then others — skip large containers */
    var allH = document.querySelectorAll('h3, h2, p, span');
    for (var i = 0; i < allH.length; i++) {
      var t = allH[i].textContent || '';
      if (t.length < 60 && (t.indexOf('Escanea con WhatsApp') !== -1 || t.indexOf('Escanea el c') !== -1)) {
        scanHeader = allH[i];
        break;
      }
    }
    if (!scanHeader) return;

    var badge = document.createElement('div');
    badge.id = 'sanate-phone-badge';
    badge.style.cssText = 'margin-top:8px;padding:6px 14px;background:#e8f5e9;border:1px solid #4caf50;border-radius:8px;display:inline-flex;align-items:center;gap:8px;font-size:14px;color:#2e7d32;font-weight:500;';
    badge.innerHTML = '<span style="font-size:18px">📱</span><span id="sanate-phone-text">Cargando...</span>';
    scanHeader.parentNode.insertBefore(badge, scanHeader.nextSibling);
    updatePhoneBadge();
  }

  function updatePhoneBadge() {
    var el = document.getElementById('sanate-phone-text');
    if (!el) return;
    api('GET', '/status').then(function(d) {
      if (d.connectedPhone) {
        _lastPhone = d.connectedPhone;
        var formatted = '+' + d.connectedPhone.replace(/(\d{2})(\d{3})(\d{3})(\d{4})/, '$1 $2 $3 $4');
        el.textContent = formatted + ' vinculado';
        el.parentNode.style.background = '#e8f5e9';
        el.parentNode.style.borderColor = '#4caf50';
        el.parentNode.style.color = '#2e7d32';
      } else if (d.status === 'qr' || d.status === 'disconnected') {
        el.textContent = 'Sin numero vinculado';
        el.parentNode.style.background = '#fff3e0';
        el.parentNode.style.borderColor = '#ff9800';
        el.parentNode.style.color = '#e65100';
      } else {
        el.textContent = 'Conectando...';
        el.parentNode.style.background = '#e3f2fd';
        el.parentNode.style.borderColor = '#2196f3';
        el.parentNode.style.color = '#1565c0';
      }
    }).catch(function() {
      el.textContent = 'Error de conexion';
    });
  }

  setInterval(function() {
    if (window.location.pathname === '/dashboard/whatsapp-bot') {
      if (!document.getElementById('sanate-phone-badge')) injectPhoneDisplay();
      else updatePhoneBadge();
    }
  }, 5000);

  /* ============================================================
     2) HORARIOS — Menu en Ajustes debajo de Etiquetas
     ============================================================ */
  var DAY_NAMES = { mon: 'Lunes', tue: 'Martes', wed: 'Miercoles', thu: 'Jueves', fri: 'Viernes', sat: 'Sabado', sun: 'Domingo' };
  var DAY_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

  function injectHorariosMenu() {
    if (window.location.pathname !== '/dashboard/whatsapp-bot') return;
    if (document.getElementById('sanate-horarios-nav')) return;

    /* Try by ID first (oasis-nav-injector), then fallback to text search */
    var etiquetasNav = document.getElementById('sp-etiquetas-nav');
    if (!etiquetasNav || etiquetasNav.offsetParent === null) {
      etiquetasNav = null;
      var navItems = document.querySelectorAll('a, div, span, li, button');
      for (var i = 0; i < navItems.length; i++) {
        var txt = (navItems[i].textContent || '').trim();
        if (txt.indexOf('Etiquetas') !== -1 && txt.length < 30 && navItems[i].offsetParent !== null) {
          etiquetasNav = navItems[i];
          break;
        }
      }
    }
    if (!etiquetasNav) return;

    function createNavItem(id, text, onClick) {
      var nav = document.createElement('div');
      nav.id = id;
      nav.className = etiquetasNav.className;
      nav.textContent = text;
      nav.style.cssText = 'cursor:pointer;display:flex!important;';
      nav.removeAttribute('data-sp-hide');
      nav.onclick = function(e) { e.preventDefault(); e.stopPropagation(); onClick(); };
      /* Defend against other hotfixes re-hiding this item */
      new MutationObserver(function() {
        if (nav.hasAttribute('data-sp-hide')) nav.removeAttribute('data-sp-hide');
        if (getComputedStyle(nav).display === 'none') nav.style.setProperty('display', 'flex', 'important');
      }).observe(nav, { attributes: true });
      return nav;
    }

    var horariosNav = createNavItem('sanate-horarios-nav', '\u{1F552} Horarios', showHorariosPanel);
    etiquetasNav.parentNode.insertBefore(horariosNav, etiquetasNav.nextSibling);

    var backupNav = createNavItem('sanate-backup-nav', '\u{1F4BE} Copia de Seguridad', showBackupPanel);
    horariosNav.parentNode.insertBefore(backupNav, horariosNav.nextSibling);
  }

  function showHorariosPanel() {
    var existingPanel = document.getElementById('sanate-horarios-panel');
    if (existingPanel) { existingPanel.style.display = 'block'; return; }

    var panel = document.createElement('div');
    panel.id = 'sanate-horarios-panel';
    panel.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;';
    panel.innerHTML = '<div style="background:#fff;border-radius:16px;padding:24px 28px;max-width:520px;width:95%;max-height:85vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,0.15);">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">' +
        '<h2 style="margin:0;font-size:20px;color:#1a1a2e;">&#128338; Horarios de Atencion</h2>' +
        '<button onclick="document.getElementById(\'sanate-horarios-panel\').remove()" style="background:none;border:none;font-size:22px;cursor:pointer;color:#666;">&#10005;</button>' +
      '</div>' +
      '<p style="color:#666;font-size:13px;margin-bottom:16px;">Configura en que dias y horas el bot responde automaticamente.</p>' +
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:20px;padding:12px;background:#f0fdf4;border-radius:10px;">' +
        '<label style="font-weight:600;font-size:14px;color:#333;">Horarios</label>' +
        '<span id="sanate-sched-label" style="font-size:13px;color:#999;margin-left:4px;">Desactivado</span>' +
        '<label class="sanate-switch" style="position:relative;display:inline-block;width:44px;height:24px;margin-left:auto;cursor:pointer;">' +
          '<input type="checkbox" id="sanate-sched-enabled" style="opacity:0;width:0;height:0;">' +
          '<span style="position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background:#ccc;border-radius:24px;transition:.3s;" id="sanate-sched-slider"></span>' +
        '</label>' +
      '</div>' +
      '<p style="color:#666;font-size:12px;margin-bottom:12px;">Cuando esta activo, el bot solo responde en los horarios configurados. Fuera de horario NO envia mensajes, plantillas ni disparadores.</p>' +
      '<div id="sanate-sched-days"></div>' +
      '<button id="sanate-sched-save" style="width:100%;padding:12px;background:#22c55e;color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;margin-top:16px;">Guardar horarios</button>' +
      '<div id="sanate-sched-status" style="text-align:center;margin-top:8px;font-size:13px;color:#666;"></div>' +
    '</div>';

    document.body.appendChild(panel);
    panel.addEventListener('click', function(e) { if (e.target === panel) panel.remove(); });

    var toggle = document.getElementById('sanate-sched-enabled');
    var slider = document.getElementById('sanate-sched-slider');
    var schedLabel = document.getElementById('sanate-sched-label');
    function updateSchedUI() {
      slider.style.background = toggle.checked ? '#22c55e' : '#ccc';
      schedLabel.textContent = toggle.checked ? 'Activado' : 'Desactivado';
      schedLabel.style.color = toggle.checked ? '#22c55e' : '#999';
    }
    toggle.addEventListener('change', updateSchedUI);

    api('GET', '/schedule').then(function(sched) {
      toggle.checked = sched.enabled;
      updateSchedUI();
      renderScheduleDays(sched.days || {});
    });

    document.getElementById('sanate-sched-save').onclick = function() {
      var btn = this;
      btn.textContent = 'Guardando...';
      btn.disabled = true;
      var days = {};
      DAY_ORDER.forEach(function(d) {
        days[d] = {
          active: document.getElementById('sched-' + d + '-active').checked,
          start: document.getElementById('sched-' + d + '-start').value,
          end: document.getElementById('sched-' + d + '-end').value
        };
      });
      var schedData = { enabled: toggle.checked, timezone: 'America/Bogota', days: days };
      api('POST', '/schedule', schedData).then(function(r) {
        btn.textContent = 'Guardar horarios';
        btn.disabled = false;
        var st = document.getElementById('sanate-sched-status');
        st.textContent = r.ok ? 'Horarios guardados' : 'Error: ' + (r.error || 'desconocido');
        st.style.color = r.ok ? '#22c55e' : '#dc3545';
        setTimeout(function() { st.textContent = ''; }, 3000);
      });
    };
  }

  function renderScheduleDays(days) {
    var container = document.getElementById('sanate-sched-days');
    if (!container) return;
    var html = '';
    DAY_ORDER.forEach(function(d) {
      var day = days[d] || { active: false, start: '08:00', end: '18:00' };
      html += '<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid #f0f0f0;">' +
        '<input type="checkbox" id="sched-' + d + '-active" ' + (day.active ? 'checked' : '') + ' style="width:18px;height:18px;accent-color:#22c55e;">' +
        '<span style="width:80px;font-size:14px;font-weight:500;color:#333;">' + DAY_NAMES[d] + '</span>' +
        '<input type="time" id="sched-' + d + '-start" value="' + day.start + '" style="padding:4px 8px;border:1px solid #ddd;border-radius:6px;font-size:13px;">' +
        '<span style="color:#999;font-size:13px;">a</span>' +
        '<input type="time" id="sched-' + d + '-end" value="' + day.end + '" style="padding:4px 8px;border:1px solid #ddd;border-radius:6px;font-size:13px;">' +
      '</div>';
    });
    container.innerHTML = html;
  }

  /* ============================================================
     3) COPIA DE SEGURIDAD — Panel completo
     ============================================================ */
  function showBackupPanel() {
    var existing = document.getElementById('sanate-backup-panel');
    if (existing) existing.remove();

    var panel = document.createElement('div');
    panel.id = 'sanate-backup-panel';
    panel.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;';
    panel.innerHTML = '<div style="background:#fff;border-radius:16px;padding:24px 28px;max-width:560px;width:95%;max-height:85vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,0.15);">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">' +
        '<h2 style="margin:0;font-size:20px;color:#1a1a2e;">&#128190; Copia de Seguridad</h2>' +
        '<button onclick="document.getElementById(\'sanate-backup-panel\').remove()" style="background:none;border:none;font-size:22px;cursor:pointer;color:#666;">&#10005;</button>' +
      '</div>' +
      '<p style="color:#666;font-size:13px;margin-bottom:16px;">Cuando cambias de numero de WhatsApp, los datos se guardan automaticamente. Restaura una copia para recuperar chats, clientes y pedidos de ese numero.</p>' +
      '<div id="sanate-backup-current" style="padding:12px;background:#f0fdf4;border-radius:10px;margin-bottom:16px;font-size:13px;">Cargando estado...</div>' +
      '<div style="display:flex;gap:8px;margin-bottom:16px;">' +
        '<button id="sanate-backup-create-btn" style="flex:1;padding:10px;background:#3b82f6;color:#fff;border:none;border-radius:10px;font-size:14px;font-weight:500;cursor:pointer;">&#128190; Crear copia ahora</button>' +
      '</div>' +
      '<p style="color:#999;font-size:12px;margin-bottom:12px;">Los datos se ocultan y restauran automaticamente al desvincular/vincular WhatsApp.</p>' +
      '<h3 style="font-size:16px;margin-bottom:12px;color:#333;">Copias guardadas</h3>' +
      '<div id="sanate-backup-list" style="min-height:60px;">Cargando...</div>' +
      '<div id="sanate-backup-status" style="text-align:center;margin-top:12px;font-size:13px;color:#666;"></div>' +
    '</div>';

    document.body.appendChild(panel);
    panel.addEventListener('click', function(e) { if (e.target === panel) panel.remove(); });

    document.getElementById('sanate-backup-create-btn').onclick = createBackup;

    loadBackupState();
    loadBackupList();
  }

  function loadBackupState() {
    var el = document.getElementById('sanate-backup-current');
    if (!el) return;
    api('GET', '/backup/active-phone').then(function(d) {
      if (d.hidden) {
        el.innerHTML = '<span style="color:#f59e0b;">&#128064; Datos ocultos</span> — Los paneles estan vacios. Restaura una copia o conecta un WhatsApp.';
        el.style.background = '#fff7ed';
      } else if (d.activePhone) {
        el.innerHTML = '<span style="color:#22c55e;">&#9989; Numero activo: +' + d.activePhone + '</span> — Los paneles muestran datos de este numero.';
        el.style.background = '#f0fdf4';
      } else {
        el.innerHTML = '<span style="color:#6b7280;">&#9898; Sin filtro activo</span> — Se muestran todos los datos.';
        el.style.background = '#f9fafb';
      }
    });
  }

  function loadBackupList() {
    var el = document.getElementById('sanate-backup-list');
    if (!el) return;
    api('GET', '/backup/list').then(function(d) {
      if (!d.ok || !d.backups || d.backups.length === 0) {
        el.innerHTML = '<div style="text-align:center;padding:20px;color:#999;font-size:13px;">No hay copias de seguridad aun.<br>Se crean automaticamente al desvincular WhatsApp.</div>';
        return;
      }
      var html = '';
      d.backups.forEach(function(b) {
        var date = new Date(b.backup_date).toLocaleString('es-CO', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        html += '<div style="display:flex;align-items:center;gap:12px;padding:12px;border:1px solid #e5e7eb;border-radius:10px;margin-bottom:8px;">' +
          '<div style="width:40px;height:40px;border-radius:50%;background:#e0f2fe;display:flex;align-items:center;justify-content:center;font-size:18px;">&#128241;</div>' +
          '<div style="flex:1;">' +
            '<div style="font-weight:600;font-size:14px;color:#1a1a2e;">+' + b.phone_number + '</div>' +
            '<div style="font-size:12px;color:#6b7280;">' + date + ' &middot; ' + b.chats_count + ' chats &middot; ' + b.messages_count + ' msgs</div>' +
          '</div>' +
          '<button onclick="window.__sanateRestore(\'' + b.phone_number + '\')" style="padding:8px 14px;background:#22c55e;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:500;cursor:pointer;">Restablecer</button>' +
        '</div>';
      });
      el.innerHTML = html;
    }).catch(function() {
      el.innerHTML = '<div style="color:#dc3545;text-align:center;">Error cargando copias</div>';
    });
  }

  function createBackup() {
    var btn = document.getElementById('sanate-backup-create-btn');
    if (!btn) return;
    btn.textContent = 'Creando...';
    btn.disabled = true;
    api('POST', '/backup/create').then(function(r) {
      btn.innerHTML = '&#128190; Crear copia ahora';
      btn.disabled = false;
      var st = document.getElementById('sanate-backup-status');
      if (r.ok) {
        st.textContent = 'Copia creada: +' + r.backup.phone_number + ' (' + r.backup.chats_count + ' chats)';
        st.style.color = '#22c55e';
        loadBackupList();
        loadBackupState();
      } else {
        st.textContent = 'Error: ' + (r.error || 'No se pudo crear');
        st.style.color = '#dc3545';
      }
      setTimeout(function() { st.textContent = ''; }, 5000);
    });
  }

  function hideBackupData() {
    var btn = document.getElementById('sanate-backup-hide-btn');
    if (!btn) return;
    if (!confirm('Ocultar todos los datos de los paneles? Los datos no se borran, solo se ocultan.')) return;
    btn.textContent = 'Ocultando...';
    btn.disabled = true;
    api('POST', '/backup/hide').then(function(r) {
      btn.innerHTML = '&#128064; Ocultar datos';
      btn.disabled = false;
      if (r.ok) {
        loadBackupState();
        var st = document.getElementById('sanate-backup-status');
        st.textContent = 'Datos ocultos. Restaura una copia para verlos de nuevo.';
        st.style.color = '#f59e0b';
      }
    });
  }

  window.__sanateRestore = function(phone) {
    if (!confirm('Restablecer datos del numero +' + phone + '? Los paneles mostraran solo los datos de este numero.')) return;
    api('POST', '/backup/restore/' + phone).then(function(r) {
      if (r.ok) {
        loadBackupState();
        loadBackupList();
        var st = document.getElementById('sanate-backup-status');
        if (st) {
          st.textContent = 'Datos de +' + phone + ' restablecidos. Recarga la pagina para ver cambios.';
          st.style.color = '#22c55e';
        }
      }
    });
  };

  /* ============================================================
     4) AUTO-BACKUP al desconectar — interceptar evento SSE
     ============================================================ */
  function monitorDisconnect() {
    var _origES = window._origEventSource || window.EventSource;
    var _patchedES = window.EventSource;
    if (!_patchedES) return;

    var origAddEL = EventTarget.prototype.addEventListener;
    var origRemoveEL = EventTarget.prototype.removeEventListener;

    document.addEventListener('sanate-wa-disconnected', function() {
      if (_lastPhone) {
        console.log('[PanelExtras] Auto-backup para', _lastPhone);
        api('POST', '/backup/create').then(function(r) {
          if (r.ok) console.log('[PanelExtras] Backup auto-creado:', r.backup);
        }).catch(function() {});
      }
    });

    var _origFetch2 = window.fetch;
    window.fetch = function(url, opts) {
      var u = typeof url === 'string' ? url : (url && url.url ? url.url : '');
      if (u.indexOf('/api/whatsapp/disconnect') !== -1 && opts && opts.method && opts.method.toUpperCase() === 'POST') {
        if (_lastPhone) {
          console.log('[PanelExtras] Detectada desvinculacion, creando backup para', _lastPhone);
          api('POST', '/backup/create').catch(function() {});
        }
      }
      return _origFetch2.apply(this, arguments);
    };
  }

  /* ============================================================
     5) INIT — Observar cambios de pagina e inyectar
     ============================================================ */
  function checkAndInject() {
    if (window.location.pathname === '/dashboard/whatsapp-bot') {
      injectPhoneDisplay();
    }
    if (window.location.pathname === '/dashboard/whatsapp-bot') {
      injectHorariosMenu();
    }
  }

  var obs = new MutationObserver(function() { checkAndInject(); });
  obs.observe(document.body, { childList: true, subtree: true });
  setTimeout(checkAndInject, 1000);
  setTimeout(checkAndInject, 3000);
  setTimeout(checkAndInject, 6000);
  monitorDisconnect();

  console.log('[PanelExtras v1.4] Horarios + Backup + Numero Vinculado cargado');
})();
