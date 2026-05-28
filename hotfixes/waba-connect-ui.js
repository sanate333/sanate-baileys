/* ═══════════════════════════════════════════════════════════════
   SANATE HOTFIX v6.5 — Fix Encuesta → Texto plano
   Soporta FormData (campo "text") y JSON (campo "message")
   Redirige al proxy Supabase v2 con chatId en body
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.__sanateHotfixV65) return;
  window.__sanateHotfixV65 = true;

  var PROXY_URL = 'https://lvmeswlvszsmvgaasazs.supabase.co/functions/v1/send-proxy';

  /* ── FETCH INTERCEPTOR: soporta FormData + JSON ── */
  var _origFetch = window.fetch.bind(window);
  window.fetch = function (url, opts) {
    try {
      if (typeof url === 'string' && /\/chats\/([^\/]+)\/send/.test(url) &&
          opts && opts.method === 'POST') {
        var chatId = url.match(/\/chats\/([^\/]+)\/send/)[1];
        var msg = '';

        if (opts.body instanceof FormData) {
          /* Dashboard envía FormData con campo "text" */
          opts.body.forEach(function (v, k) {
            if (k === 'text' || k === 'message') msg = String(v);
          });
        } else {
          /* JSON body */
          try {
            var parsed = JSON.parse(opts.body || '{}');
            msg = parsed.message || parsed.text || '';
          } catch (pe) {}
        }

        if (msg) {
          /* Redirigir al proxy Supabase — convierte a text_fallback */
          return _origFetch(PROXY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chatId: chatId, message: msg })
          });
        }
      }
    } catch (e) { /* fall through */ }
    return _origFetch(url, opts);
  };

  /* ── CSS VISUAL v2: ticks grandes, Respondiendo, Escribiendo ── */
  var css = document.createElement('style');
  css.id = 'sanate-visual-v2';
  css.textContent = [
    'svg[data-icon="msg-check"],svg[data-icon="msg-dblcheck"]{width:20px!important;height:20px!important;min-width:20px!important}',
    '.sanate-tick-svg{width:19px!important;height:19px!important;vertical-align:middle}',
    'span.sanate-tick-text{font-size:15px!important;font-weight:600!important;vertical-align:middle}',
    '.sanate-status-sent svg path,.sanate-status-sent svg polyline,.sanate-status-sent svg line{stroke:#aaa!important}',
    '.sanate-status-delivered svg path,.sanate-status-delivered svg polyline,.sanate-status-delivered svg line{stroke:#aaa!important}',
    '.sanate-status-read svg path,.sanate-status-read svg polyline,.sanate-status-read svg line{stroke:#53bdeb!important}',
    '.sanate-status-sent .sanate-tick-text,.sanate-status-delivered .sanate-tick-text{color:#aaa!important}',
    '.sanate-status-read .sanate-tick-text{color:#53bdeb!important}',
    '.sanate-typing-label{display:block;font-size:11.5px;margin-top:2px;font-style:italic;line-height:1.3;pointer-events:none}',
    '.sanate-typing-respondiendo{color:#25d366!important;animation:sanate-pulse 1.2s ease-in-out infinite}',
    '.sanate-typing-escribiendo{color:#00bcd4!important;animation:sanate-pulse 0.9s ease-in-out infinite}',
    '@keyframes sanate-pulse{0%,100%{opacity:1}50%{opacity:0.45}}'
  ].join('\n');
  document.head.appendChild(css);

  /* ── SSE + INDICADORES DE ESCRITURA ── */
  var BOT_SSE = 'https://sanate-wa-bot.onrender.com/api/whatsapp/events';
  var typingTimeouts = new Map();
  var botTypingChats = new Set();
  var msgStatusMap   = new Map();

  var _sseRetries = 0;
  var _sseMaxRetries = 5;
  var _sseCurrentES = null;

  function conectarSSE() {
    if (_sseRetries >= _sseMaxRetries) {
      console.warn('[WABA-UI] SSE: max reintentos alcanzado, detenido');
      return;
    }
    try {
      if (_sseCurrentES) { try { _sseCurrentES.close(); } catch(e){} }
      var es = new EventSource(BOT_SSE);
      _sseCurrentES = es;
      es.onopen = function() { _sseRetries = 0; };
      es.onmessage = function (evt) { try { manejarEvento(JSON.parse(evt.data)); } catch (e) {} };
      es.onerror = function () {
        es.close(); _sseCurrentES = null;
        _sseRetries++;
        var delay = Math.min(6000 * Math.pow(2, _sseRetries - 1), 60000);
        setTimeout(conectarSSE, delay);
      };
    } catch (e) {
      _sseRetries++;
      setTimeout(conectarSSE, 15000);
    }
  }

  function manejarEvento(data) {
    if (!data || !data.type) return;
    if (data.type === 'bot_typing') {
      var d = data.data || {};
      if (!d.chatId) return;
      if (d.typing) { botTypingChats.add(d.chatId); actualizarSidebar(d.chatId, 'respondiendo'); }
      else          { botTypingChats.delete(d.chatId); actualizarSidebar(d.chatId, null); }
    }
    if (data.type === 'presence') {
      var d1 = data.data || {};
      var chatId = (d1.id || '').split('@')[0];
      if (!chatId) return;
      var p = ((d1.presences || {})[d1.id]) || {};
      if (p.lastKnownPresence === 'composing') {
        if (!botTypingChats.has(chatId)) actualizarSidebar(chatId, 'escribiendo');
        clearTimeout(typingTimeouts.get(chatId));
        typingTimeouts.set(chatId, setTimeout(function () {
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
      var d2 = data.data || {};
      if (d2.fromMe && d2.messageId && d2.statusName) {
        msgStatusMap.set(d2.messageId, d2.statusName);
        aplicarTickEnDOM(d2.messageId, d2.statusName);
      }
    }
  }

  function actualizarSidebar(chatId, estado) {
    var digits = chatId.replace(/\D/g, '').slice(-9);
    if (!digits) return;
    document.querySelectorAll(
      '[class*="chat-item"],[class*="conversation-item"],[class*="contact-item"],' +
      '[class*="ChatItem"],[class*="ConversationItem"],[class*="chat-row"],' +
      '[class*="chat_item"],[class*="list-item"]'
    ).forEach(function (el) {
      if ((el.innerText || el.textContent || '').replace(/\D/g, '').includes(digits)) {
        setEtiqueta(el, estado);
      }
    });
  }

  function setEtiqueta(item, estado) {
    var etiqueta = item.querySelector('.sanate-typing-label');
    if (!estado) { if (etiqueta) etiqueta.remove(); return; }
    if (!etiqueta) {
      etiqueta = document.createElement('span');
      etiqueta.className = 'sanate-typing-label';
      var nombre = item.querySelector('[class*="name"],[class*="title"],strong,b') || item.firstElementChild;
      if (nombre && nombre.parentNode) nombre.parentNode.insertBefore(etiqueta, nombre.nextSibling);
      else item.appendChild(etiqueta);
    }
    etiqueta.className = 'sanate-typing-label ' + (estado === 'respondiendo' ? 'sanate-typing-respondiendo' : 'sanate-typing-escribiendo');
    etiqueta.textContent = estado === 'respondiendo' ? '\uD83E\uDD16 Respondiendo...' : '\u270D\uFE0F Escribiendo...';
  }

  function aplicarTickEnDOM(messageId, statusName) {
    var el = document.querySelector(
      '[data-message-id="' + messageId + '"],[data-id="' + messageId + '"],[id="' + messageId + '"],[data-key="' + messageId + '"]'
    );
    if (el) aplicarClaseTick(el, statusName);
  }

  function aplicarClaseTick(el, statusName) {
    el.classList.remove('sanate-status-sent','sanate-status-delivered','sanate-status-read','sanate-status-pending','sanate-status-error');
    var map = {sent:'sanate-status-sent',delivered:'sanate-status-delivered',read:'sanate-status-read',played:'sanate-status-read'};
    if (map[statusName]) el.classList.add(map[statusName]);
  }

  function reescanearTicks() {
    msgStatusMap.forEach(function (sn, mid) { aplicarTickEnDOM(mid, sn); });
    document.querySelectorAll('svg').forEach(function (svg) {
      var vb = svg.getAttribute('viewBox') || '';
      if (vb === '0 0 16 15' || vb === '0 0 18 18' || vb === '0 0 18 15') svg.classList.add('sanate-tick-svg');
    });
  }

  var _st = null;
  new MutationObserver(function () { clearTimeout(_st); _st = setTimeout(reescanearTicks, 250); })
    .observe(document.body, { childList: true, subtree: true, attributes: false });

  setTimeout(function () { conectarSSE(); reescanearTicks(); }, 1500);
  console.log('[Sánate v6.5] ✅ proxy v2 activo — FormData+JSON soportados, sin encuestas');
})();

/* ═══════════════════════════════════════════════════════════════
   WABA CONNECT UI v1.0 — Botones Reales por Número WABA
   ═══════════════════════════════════════════════════════════════ */
(function(){
'use strict';
if(window.__wabaConnectOK) return;
window.__wabaConnectOK = true;

var API = 'https://sanate-wa-bot.onrender.com/api/whatsapp/waba';

var style = document.createElement('style');
style.textContent = `
#waba-connect-card {
  background:#fff; border-radius:12px; padding:24px; margin:16px 0;
  box-shadow:0 2px 12px rgba(0,0,0,.08); border:1px solid #e8f4fd;
}
#waba-connect-card h3 { margin:0 0 4px; font-size:17px; font-weight:700; color:#1a1a2e; display:flex; align-items:center; gap:8px; }
#waba-connect-card .waba-subtitle { font-size:13px; color:#666; margin:0 0 16px; }
.waba-number-list { display:flex; flex-direction:column; gap:10px; margin-bottom:16px; }
.waba-number-item { display:flex; align-items:center; justify-content:space-between; background:#f8fff8; border:1px solid #d4edda; border-radius:8px; padding:10px 14px; }
.waba-number-item .waba-num-info { display:flex; flex-direction:column; }
.waba-number-item .waba-num-name { font-weight:600; font-size:14px; color:#1a1a2e; }
.waba-number-item .waba-num-phone { font-size:12px; color:#28a745; margin-top:2px; }
.waba-number-item .waba-num-badge { font-size:10px; padding:2px 7px; border-radius:10px; font-weight:600; background:#d4edda; color:#155724; }
.waba-number-item .waba-num-actions { display:flex; gap:6px; align-items:center; }
.waba-btn-test { background:#007bff; color:#fff; border:none; border-radius:6px; padding:5px 10px; font-size:12px; cursor:pointer; font-weight:600; }
.waba-btn-test:hover { background:#0056b3; }
.waba-btn-del { background:#fff; color:#dc3545; border:1px solid #dc3545; border-radius:6px; padding:5px 10px; font-size:12px; cursor:pointer; font-weight:600; }
.waba-btn-del:hover { background:#dc3545; color:#fff; }
.waba-btn-add { display:flex; align-items:center; gap:6px; background:linear-gradient(135deg,#0a66c2,#00a4e4); color:#fff; border:none; border-radius:8px; padding:10px 18px; font-size:14px; font-weight:700; cursor:pointer; width:100%; justify-content:center; margin-top:4px; }
.waba-btn-add:hover { opacity:.9; }
.waba-empty { text-align:center; color:#999; font-size:13px; padding:16px 0; }
#waba-modal-overlay { position:fixed; inset:0; background:rgba(0,0,0,.5); z-index:99999; display:flex; align-items:center; justify-content:center; padding:16px; }
#waba-modal { background:#fff; border-radius:16px; padding:28px; max-width:480px; width:100%; box-shadow:0 20px 60px rgba(0,0,0,.3); max-height:90vh; overflow-y:auto; }
#waba-modal h3 { margin:0 0 6px; font-size:18px; color:#1a1a2e; }
#waba-modal .waba-modal-sub { font-size:13px; color:#666; margin:0 0 20px; }
.waba-field { margin-bottom:14px; }
.waba-field label { display:block; font-size:12px; font-weight:700; color:#444; margin-bottom:5px; text-transform:uppercase; letter-spacing:.4px; }
.waba-field input { width:100%; box-sizing:border-box; border:1.5px solid #ddd; border-radius:8px; padding:10px 12px; font-size:14px; outline:none; transition:border-color .2s; }
.waba-field input:focus { border-color:#0a66c2; }
.waba-field .waba-hint { font-size:11px; color:#888; margin-top:4px; }
.waba-verify-result { background:#f0f7ff; border:1px solid #bee3f8; border-radius:8px; padding:10px 14px; margin-bottom:14px; font-size:13px; }
.waba-verify-result.error { background:#fff5f5; border-color:#fed7d7; color:#c53030; }
.waba-modal-actions { display:flex; gap:10px; margin-top:20px; }
.waba-btn-primary { flex:1; background:#0a66c2; color:#fff; border:none; border-radius:8px; padding:12px; font-size:14px; font-weight:700; cursor:pointer; }
.waba-btn-primary:hover { background:#0052a3; }
.waba-btn-secondary { background:#f0f0f0; color:#444; border:none; border-radius:8px; padding:12px 20px; font-size:14px; cursor:pointer; font-weight:600; }
.waba-btn-verify { background:#28a745; color:#fff; border:none; border-radius:6px; padding:8px 14px; font-size:12px; font-weight:700; cursor:pointer; margin-top:6px; }
.waba-divider { text-align:center; color:#ccc; margin:16px 0; font-size:12px; position:relative; }
.waba-divider::before,.waba-divider::after { content:''; position:absolute; top:50%; width:42%; height:1px; background:#eee; }
.waba-divider::before { left:0; } .waba-divider::after { right:0; }
.waba-btn-fb { display:flex; align-items:center; justify-content:center; gap:8px; background:#1877f2; color:#fff; border:none; border-radius:8px; padding:11px; font-size:14px; font-weight:700; cursor:pointer; width:100%; }
.waba-btn-fb:hover { background:#166fe5; }
#waba-test-modal { position:fixed; inset:0; background:rgba(0,0,0,.5); z-index:99999; display:flex; align-items:center; justify-content:center; padding:16px; }
#waba-test-modal .waba-test-box { background:#fff; border-radius:16px; padding:24px; max-width:380px; width:100%; }
#waba-test-modal h4 { margin:0 0 14px; font-size:16px; }
.waba-spinner { display:inline-block; width:18px; height:18px; border:3px solid #fff; border-top-color:transparent; border-radius:50%; animation:spin .7s linear infinite; }
@keyframes spin { to { transform:rotate(360deg); } }
`;
document.head.appendChild(style);

function apiGet(path){ return fetch(API+path).then(r=>r.json()); }
function apiPost(path,body){ return fetch(API+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json()); }
function apiDel(path){ return fetch(API+path,{method:'DELETE'}).then(r=>r.json()); }

function renderCard(){
  var existing = document.getElementById('waba-connect-card');
  if(existing) existing.remove();
  var card = document.createElement('div');
  card.id = 'waba-connect-card';
  card.innerHTML = `<h3>🔵 Botones WhatsApp WABA</h3><p class="waba-subtitle">Conecta números con Meta Cloud API para enviar botones tapeables reales</p><div class="waba-number-list" id="waba-numbers-list"><div class="waba-empty">⏳ Cargando...</div></div><button class="waba-btn-add" onclick="window.__wabaOpenModal()">➕ Conectar número con botones WABA</button>`;
  var page = document.querySelector('.wabotPage') || document.body;
  var allDivs = page.querySelectorAll('div');
  var connSection = null;
  for(var i=0;i<allDivs.length;i++){
    if(allDivs[i].textContent.includes('Escanea el QR') && allDivs[i].textContent.includes('Configuración n8n')){ connSection=allDivs[i]; break; }
  }
  if(connSection) connSection.appendChild(card);
  else { var m=page.querySelector('div'); if(m) m.appendChild(card); }
  loadNumbers();
}

function loadNumbers(){
  var list=document.getElementById('waba-numbers-list');
  if(!list) return;
  apiGet('/numbers').then(function(data){
    if(!data.numbers||data.numbers.length===0){ list.innerHTML='<div class="waba-empty">Sin números WABA conectados aún.</div>'; return; }
    list.innerHTML=data.numbers.map(function(n){
      return `<div class="waba-number-item"><div class="waba-num-info"><span class="waba-num-name">${n.display_name||n.phone_number}</span><span class="waba-num-phone">📱 ${n.phone_number} ${n.meta_verified?'✅':'⚠️'}</span></div><div class="waba-num-actions"><span class="waba-num-badge">${n.status==='connected'?'● Activo':'○ Inactivo'}</span><button class="waba-btn-test" onclick="window.__wabaTest('${n.phone_number_id}','${n.display_name||n.phone_number}')">🧪 Test</button><button class="waba-btn-del" onclick="window.__wabaDelete('${n.phone_number_id}','${n.display_name||n.phone_number}')">✕</button></div></div>`;
    }).join('');
  }).catch(function(){ list.innerHTML='<div class="waba-empty" style="color:#dc3545">Error cargando números</div>'; });
}

window.__wabaOpenModal = function(){
  var existing=document.getElementById('waba-modal-overlay'); if(existing) existing.remove();
  var overlay=document.createElement('div'); overlay.id='waba-modal-overlay';
  overlay.innerHTML=`<div id="waba-modal"><h3>🔵 Conectar número WABA</h3><p class="waba-modal-sub">Ingresa tus credenciales de Meta Cloud API.</p><div class="waba-field"><label>📛 Nombre</label><input id="waba-f-name" type="text" placeholder="Mi Tienda"></div><div class="waba-field"><label>📱 Phone Number ID *</label><input id="waba-f-phoneid" type="text" placeholder="971830362687604"><div class="waba-hint">Meta for Developers → WhatsApp → Phone Number ID</div></div><div class="waba-field"><label>🔑 Access Token *</label><input id="waba-f-token" type="password" placeholder="EAAXQhbZC7..."><button class="waba-btn-verify" id="waba-verify-btn" onclick="window.__wabaVerify()">🔍 Verificar</button></div><div id="waba-verify-result" style="display:none"></div><div class="waba-field"><label>🏢 WABA ID (opcional)</label><input id="waba-f-wabaid" type="text" placeholder="207326706219633"></div><div class="waba-divider">o</div><button class="waba-btn-fb" onclick="window.__wabaEmbeddedSignup()"><svg width="18" height="18" viewBox="0 0 24 24" fill="white"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>Conectar con Facebook</button><div class="waba-modal-actions"><button class="waba-btn-secondary" onclick="document.getElementById('waba-modal-overlay').remove()">Cancelar</button><button class="waba-btn-primary" id="waba-save-btn" onclick="window.__wabaSave()">💾 Guardar</button></div></div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', function(e){ if(e.target===overlay) overlay.remove(); });
};

window.__wabaVerify = function(){
  var phoneId=document.getElementById('waba-f-phoneid').value.trim();
  var token=document.getElementById('waba-f-token').value.trim();
  var resultDiv=document.getElementById('waba-verify-result');
  var btn=document.getElementById('waba-verify-btn');
  if(!phoneId||!token){ alert('Ingresa Phone Number ID y Token'); return; }
  btn.innerHTML='<span class="waba-spinner"></span> Verificando...'; btn.disabled=true;
  apiPost('/verify',{phone_number_id:phoneId,access_token:token}).then(function(data){
    resultDiv.style.display='block';
    if(data.ok){ resultDiv.className='waba-verify-result'; resultDiv.innerHTML=`✅ <b>Válidas</b><br>📱 ${data.phone_number}<br>🏢 ${data.verified_name}`; if(!document.getElementById('waba-f-name').value) document.getElementById('waba-f-name').value=data.verified_name||''; }
    else { resultDiv.className='waba-verify-result error'; resultDiv.innerHTML=`❌ ${data.error||'Inválidas'}`; }
    btn.innerHTML='🔍 Verificar'; btn.disabled=false;
  }).catch(function(){ resultDiv.style.display='block'; resultDiv.className='waba-verify-result error'; resultDiv.innerHTML='❌ Error de conexión'; btn.innerHTML='🔍 Verificar'; btn.disabled=false; });
};

window.__wabaSave = function(){
  var name=document.getElementById('waba-f-name').value.trim();
  var phoneId=document.getElementById('waba-f-phoneid').value.trim();
  var token=document.getElementById('waba-f-token').value.trim();
  var wabaId=document.getElementById('waba-f-wabaid').value.trim();
  if(!phoneId||!token){ alert('Phone Number ID y Token son obligatorios'); return; }
  var btn=document.getElementById('waba-save-btn'); btn.innerHTML='<span class="waba-spinner"></span> Conectando...'; btn.disabled=true;
  apiPost('/connect',{display_name:name,phone_number_id:phoneId,access_token:token,waba_id:wabaId}).then(function(data){
    if(data.ok){ document.getElementById('waba-modal-overlay').remove(); loadNumbers(); }
    else { alert('Error: '+(data.error||'No se pudo conectar')); btn.innerHTML='💾 Guardar'; btn.disabled=false; }
  }).catch(function(){ alert('Error de conexión'); btn.innerHTML='💾 Guardar'; btn.disabled=false; });
};

window.__wabaEmbeddedSignup=function(){
  if(!window.FB){ var s=document.createElement('script'); s.src='https://connect.facebook.net/en_US/sdk.js'; s.onload=function(){ FB.init({appId:'1636647753686628',version:'v19.0',cookie:true,xfbml:false}); window.__wabaLaunchFBLogin(); }; document.head.appendChild(s); } else window.__wabaLaunchFBLogin();
};
window.__wabaLaunchFBLogin=function(){
  FB.login(function(r){ if(r.authResponse){ var t=r.authResponse.accessToken; FB.api('/me/businesses',{access_token:t,fields:'id,name'},function(b){ if(b.data&&b.data.length){ var bid=b.data[0].id; FB.api('/'+bid+'/owned_whatsapp_business_accounts',{access_token:t},function(w){ if(w.data&&w.data.length){ var wid=w.data[0].id; FB.api('/'+wid+'/phone_numbers',{access_token:t,fields:'id,display_phone_number,verified_name'},function(p){ if(p.data&&p.data.length){ var ph=p.data[0]; document.getElementById('waba-f-phoneid').value=ph.id; document.getElementById('waba-f-token').value=t; document.getElementById('waba-f-name').value=ph.verified_name||''; document.getElementById('waba-f-wabaid').value=wid; window.__wabaVerify(); } else alert('Sin números en tu WABA'); }); } else alert('Sin WABA encontrado'); }); } else alert('Sin negocios Meta encontrados'); }); } },{scope:'whatsapp_business_management,whatsapp_business_messaging,business_management',return_scopes:true});
};

window.__wabaTest=function(pid,name){
  var to=prompt('Número destino (con código país, ej: 573227461878):'); if(!to) return;
  var cleanTo=to.replace(/[^0-9]/g,'');
  var overlay=document.createElement('div'); overlay.id='waba-test-modal'; overlay.innerHTML=`<div class="waba-test-box"><h4>🧪 Enviando test desde "${name}"...</h4><div style="text-align:center;padding:12px"><span class="waba-spinner" style="border-color:#0a66c2;border-top-color:transparent"></span></div></div>`; document.body.appendChild(overlay);
  apiPost('/test/'+pid,{to:cleanTo}).then(function(data){ overlay.remove(); if(data.ok) alert('✅ Enviado!\nWAMID: '+data.wamid); else alert('❌ Error: '+(data.error||'No se pudo enviar')); }).catch(function(){ overlay.remove(); alert('Error de conexión'); });
};

window.__wabaDelete=function(pid,name){
  if(!confirm('¿Desconectar "'+name+'"?')) return;
  apiDel('/disconnect/'+pid).then(function(data){ if(data.ok) loadNumbers(); else alert('Error: '+(data.error||'No se pudo eliminar')); });
};

function tryInject(){
  var txt=document.body.innerText||'';
  if(txt.includes('Escanea el QR')&&txt.includes('Configuración n8n')&&!document.getElementById('waba-connect-card')) renderCard();
}
var obs=new MutationObserver(function(){ tryInject(); });
obs.observe(document.body,{childList:true,subtree:true});
setTimeout(tryInject,800); setTimeout(tryInject,2000);
console.log('[WABA+Sánate v6.5] cargado — FormData+JSON, sin encuestas');
})();


/* ── triggerBotResponse PATCH v2 ── calls /trigger-reply after enabling contactMap ── */
(function patchTriggerBot() {
  function tryPatch() {
    if (typeof window.triggerBotResponse !== 'function' || typeof window.BU === 'undefined') {
      return setTimeout(tryPatch, 300);
    }
    if (window.triggerBotResponse._v2) return;

    window.triggerBotResponse = function triggerBotResponseV2() {
      var btn = document.getElementById('bot-trigger-btn');
      if (btn && btn.dataset.busy === '1') return;
      if (btn) btn.dataset.busy = '1';

      /* Get last incoming message text */
      var inMsgs = Array.from(document.querySelectorAll('.msg-row.in .bubble'));
      if (!inMsgs.length) {
        window.showToast && showToast('No hay mensajes del cliente');
        if (btn) btn.dataset.busy = '';
        return;
      }
      var lastMsgText = (inMsgs[inMsgs.length - 1].innerText || '').trim();
      if (!lastMsgText) {
        window.showToast && showToast('Mensaje vacío — sin texto legible');
        if (btn) btn.dataset.busy = '';
        return;
      }

      if (btn) { btn.classList.add('loading'); btn.style.opacity = '0.7'; }
      window.showToast && showToast('\u{1F916} Activando IA para responder...');

      var jid = window.chatJid || '';
      var rn  = window.rawNum  || '';

      /* 1. Enable contactMap for this JID */
      fetch(BU + '/ai-config')
        .then(function(r) { return r.json(); })
        .then(function(cfg) {
          var m = Object.assign({}, cfg.contactMap || {});
          var n9 = rn.slice(-9);
          m[jid] = true;
          m[rn]  = true;
          return fetch(BU + '/ai-config', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({contactMap: m})
          }).then(function() { return {map: m, n9: n9}; });
        })
        /* 2. Force bot to process last message */
        .then(function(ctx) {
          return fetch(BU + '/trigger-reply', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({jid: jid, messageText: lastMsgText, pushName: rn})
          }).then(function(r) { return r.json(); })
            .then(function() { return ctx; });
        })
        /* 3. Wait for Gemini to reply */
        .then(function(ctx) {
          window.showToast && showToast('\u{1F916} Bot procesando — espera...');
          return new Promise(function(res) { setTimeout(res, 4000, ctx); });
        })
        /* 4. Disable contactMap again */
        .then(function(ctx) {
          var rm = Object.assign({}, ctx.map);
          rm[jid] = false;
          rm[rn]  = false;
          Object.keys(rm).forEach(function(k) {
            if (k.replace(/\D/g,'').slice(-9) === ctx.n9) rm[k] = false;
          });
          return fetch(BU + '/ai-config', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({contactMap: rm})
          });
        })
        .then(function() {
          window.showToast && showToast('\u{1F916} IA respondio - pausada de nuevo');
          if (btn) { btn.classList.remove('loading'); btn.style.opacity = ''; btn.dataset.busy = ''; }
          setTimeout(function() { window.loadMessages && loadMessages(); }, 300);
        })
        .catch(function(err) {
          window.showToast && showToast('\u274C Error: ' + (err.message || 'sin conexion'));
          if (btn) { btn.classList.remove('loading'); btn.style.opacity = ''; btn.dataset.busy = ''; }
        });
    };
    window.triggerBotResponse._v2 = true;
  }
  tryPatch();
})();
