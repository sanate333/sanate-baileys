/* ═══════════════════════════════════════════════════════════════
   WABA CONNECT UI v1.0 — Botones Reales por Número WABA
   Sánate Dashboard — Conexión WhatsApp → sección WABA
   ═══════════════════════════════════════════════════════════════ */
(function(){
'use strict';
if(window.__wabaConnectOK) return;
window.__wabaConnectOK = true;

var API = 'https://sanate-wa-bot.onrender.com/api/whatsapp/waba';

/* ── ESTILOS ── */
var style = document.createElement('style');
style.textContent = `
#waba-connect-card {
  background:#fff; border-radius:12px; padding:24px; margin:16px 0;
  box-shadow:0 2px 12px rgba(0,0,0,.08); border:1px solid #e8f4fd;
}
#waba-connect-card h3 {
  margin:0 0 4px; font-size:17px; font-weight:700; color:#1a1a2e;
  display:flex; align-items:center; gap:8px;
}
#waba-connect-card .waba-subtitle {
  font-size:13px; color:#666; margin:0 0 16px;
}
.waba-number-list { display:flex; flex-direction:column; gap:10px; margin-bottom:16px; }
.waba-number-item {
  display:flex; align-items:center; justify-content:space-between;
  background:#f8fff8; border:1px solid #d4edda; border-radius:8px; padding:10px 14px;
}
.waba-number-item .waba-num-info { display:flex; flex-direction:column; }
.waba-number-item .waba-num-name { font-weight:600; font-size:14px; color:#1a1a2e; }
.waba-number-item .waba-num-phone { font-size:12px; color:#28a745; margin-top:2px; }
.waba-number-item .waba-num-badge {
  font-size:10px; padding:2px 7px; border-radius:10px; font-weight:600;
  background:#d4edda; color:#155724;
}
.waba-number-item .waba-num-actions { display:flex; gap:6px; align-items:center; }
.waba-btn-test {
  background:#007bff; color:#fff; border:none; border-radius:6px;
  padding:5px 10px; font-size:12px; cursor:pointer; font-weight:600;
}
.waba-btn-test:hover { background:#0056b3; }
.waba-btn-del {
  background:#fff; color:#dc3545; border:1px solid #dc3545; border-radius:6px;
  padding:5px 10px; font-size:12px; cursor:pointer; font-weight:600;
}
.waba-btn-del:hover { background:#dc3545; color:#fff; }
.waba-btn-add {
  display:flex; align-items:center; gap:6px; background:linear-gradient(135deg,#0a66c2,#00a4e4);
  color:#fff; border:none; border-radius:8px; padding:10px 18px;
  font-size:14px; font-weight:700; cursor:pointer; width:100%;
  justify-content:center; margin-top:4px;
}
.waba-btn-add:hover { opacity:.9; }
.waba-empty { text-align:center; color:#999; font-size:13px; padding:16px 0; }

/* Modal */
#waba-modal-overlay {
  position:fixed; inset:0; background:rgba(0,0,0,.5); z-index:99999;
  display:flex; align-items:center; justify-content:center; padding:16px;
}
#waba-modal {
  background:#fff; border-radius:16px; padding:28px; max-width:480px; width:100%;
  box-shadow:0 20px 60px rgba(0,0,0,.3); max-height:90vh; overflow-y:auto;
}
#waba-modal h3 { margin:0 0 6px; font-size:18px; color:#1a1a2e; }
#waba-modal .waba-modal-sub { font-size:13px; color:#666; margin:0 0 20px; }
.waba-field { margin-bottom:14px; }
.waba-field label { display:block; font-size:12px; font-weight:700; color:#444; margin-bottom:5px; text-transform:uppercase; letter-spacing:.4px; }
.waba-field input {
  width:100%; box-sizing:border-box; border:1.5px solid #ddd; border-radius:8px;
  padding:10px 12px; font-size:14px; outline:none; transition:border-color .2s;
}
.waba-field input:focus { border-color:#0a66c2; }
.waba-field .waba-hint { font-size:11px; color:#888; margin-top:4px; }
.waba-verify-result {
  background:#f0f7ff; border:1px solid #bee3f8; border-radius:8px;
  padding:10px 14px; margin-bottom:14px; font-size:13px;
}
.waba-verify-result.error { background:#fff5f5; border-color:#fed7d7; color:#c53030; }
.waba-modal-actions { display:flex; gap:10px; margin-top:20px; }
.waba-btn-primary {
  flex:1; background:#0a66c2; color:#fff; border:none; border-radius:8px;
  padding:12px; font-size:14px; font-weight:700; cursor:pointer;
}
.waba-btn-primary:hover { background:#0052a3; }
.waba-btn-secondary {
  background:#f0f0f0; color:#444; border:none; border-radius:8px;
  padding:12px 20px; font-size:14px; cursor:pointer; font-weight:600;
}
.waba-btn-verify {
  background:#28a745; color:#fff; border:none; border-radius:6px;
  padding:8px 14px; font-size:12px; font-weight:700; cursor:pointer; margin-top:6px;
}
.waba-divider { text-align:center; color:#ccc; margin:16px 0; font-size:12px; position:relative; }
.waba-divider::before,.waba-divider::after {
  content:''; position:absolute; top:50%; width:42%; height:1px; background:#eee;
}
.waba-divider::before { left:0; }
.waba-divider::after { right:0; }
.waba-btn-fb {
  display:flex; align-items:center; justify-content:center; gap:8px;
  background:#1877f2; color:#fff; border:none; border-radius:8px;
  padding:11px; font-size:14px; font-weight:700; cursor:pointer; width:100%;
}
.waba-btn-fb:hover { background:#166fe5; }
#waba-test-modal {
  position:fixed; inset:0; background:rgba(0,0,0,.5); z-index:99999;
  display:flex; align-items:center; justify-content:center; padding:16px;
}
#waba-test-modal .waba-test-box {
  background:#fff; border-radius:16px; padding:24px; max-width:380px; width:100%;
}
#waba-test-modal h4 { margin:0 0 14px; font-size:16px; }
.waba-spinner { display:inline-block; width:18px; height:18px; border:3px solid #fff; border-top-color:transparent; border-radius:50%; animation:spin .7s linear infinite; }
@keyframes spin { to { transform:rotate(360deg); } }
`;
document.head.appendChild(style);

/* ── API HELPERS ── */
function apiGet(path){ return fetch(API+path).then(r=>r.json()); }
function apiPost(path,body){ return fetch(API+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json()); }
function apiDel(path){ return fetch(API+path,{method:'DELETE'}).then(r=>r.json()); }

/* ── RENDER CARD ── */
function renderCard(){
  var existing = document.getElementById('waba-connect-card');
  if(existing) existing.remove();

  var card = document.createElement('div');
  card.id = 'waba-connect-card';
  card.innerHTML = `
    <h3>🔵 Botones WhatsApp WABA</h3>
    <p class="waba-subtitle">Conecta números con Meta Cloud API para enviar botones tapeables reales desde tu número</p>
    <div class="waba-number-list" id="waba-numbers-list">
      <div class="waba-empty">⏳ Cargando números...</div>
    </div>
    <button class="waba-btn-add" onclick="window.__wabaOpenModal()">
      ➕ Conectar número con botones WABA
    </button>
  `;

  // Inject after the QR connection card
  var page = document.querySelector('.wabotPage') || document.body;
  var mainDiv = page.querySelector('div');
  if(mainDiv){
    var connSection = null;
    // Find the "Conexión WhatsApp" content view
    var allDivs = page.querySelectorAll('div');
    for(var i=0;i<allDivs.length;i++){
      if(allDivs[i].textContent.includes('Escanea el QR') && allDivs[i].textContent.includes('Configuración n8n')){
        connSection = allDivs[i];
        break;
      }
    }
    if(connSection){
      connSection.appendChild(card);
    } else {
      // Fallback: append to first main div
      mainDiv.appendChild(card);
    }
  }
  loadNumbers();
}

/* ── LOAD NUMBERS ── */
function loadNumbers(){
  var list = document.getElementById('waba-numbers-list');
  if(!list) return;
  apiGet('/numbers').then(function(data){
    if(!data.numbers || data.numbers.length===0){
      list.innerHTML = '<div class="waba-empty">Sin números WABA conectados aún.<br>Agrega uno para enviar botones reales desde tu número.</div>';
      return;
    }
    list.innerHTML = data.numbers.map(function(n){
      return `<div class="waba-number-item">
        <div class="waba-num-info">
          <span class="waba-num-name">${n.display_name||n.phone_number}</span>
          <span class="waba-num-phone">📱 ${n.phone_number} ${n.meta_verified?'✅':'⚠️'}</span>
        </div>
        <div class="waba-num-actions">
          <span class="waba-num-badge">${n.status==='connected'?'● Activo':'○ Inactivo'}</span>
          <button class="waba-btn-test" onclick="window.__wabaTest('${n.phone_number_id}','${n.display_name||n.phone_number}')">🧪 Test</button>
          <button class="waba-btn-del" onclick="window.__wabaDelete('${n.phone_number_id}','${n.display_name||n.phone_number}')">✕</button>
        </div>
      </div>`;
    }).join('');
  }).catch(function(){
    list.innerHTML = '<div class="waba-empty" style="color:#dc3545">Error cargando números</div>';
  });
}

/* ── MODAL AGREGAR ── */
window.__wabaOpenModal = function(){
  var existing = document.getElementById('waba-modal-overlay');
  if(existing) existing.remove();
  var overlay = document.createElement('div');
  overlay.id = 'waba-modal-overlay';
  overlay.innerHTML = `
    <div id="waba-modal">
      <h3>🔵 Conectar número WABA</h3>
      <p class="waba-modal-sub">Ingresa tus credenciales de Meta Cloud API. Puedes obtenerlas en <a href="https://developers.facebook.com" target="_blank">developers.facebook.com</a></p>

      <div class="waba-field">
        <label>📛 Nombre para mostrar</label>
        <input id="waba-f-name" type="text" placeholder="Ej: Mi Tienda Principal">
      </div>
      <div class="waba-field">
        <label>📱 Phone Number ID <span style="color:#dc3545">*</span></label>
        <input id="waba-f-phoneid" type="text" placeholder="Ej: 971830362687604">
        <div class="waba-hint">En Meta for Developers → WhatsApp → Configuración de API → Phone Number ID</div>
      </div>
      <div class="waba-field">
        <label>🔑 Access Token <span style="color:#dc3545">*</span></label>
        <input id="waba-f-token" type="password" placeholder="EAAXQhbZC7...">
        <div class="waba-hint">Token permanente de usuario del sistema. <a href="https://developers.facebook.com/tools/explorer/" target="_blank">Obtener en Graph Explorer</a></div>
        <button class="waba-btn-verify" id="waba-verify-btn" onclick="window.__wabaVerify()">🔍 Verificar credenciales</button>
      </div>
      <div id="waba-verify-result" style="display:none"></div>
      <div class="waba-field">
        <label>🏢 WABA ID (opcional)</label>
        <input id="waba-f-wabaid" type="text" placeholder="Ej: 207326706219633">
        <div class="waba-hint">WhatsApp Business Account ID (opcional, se detecta automáticamente)</div>
      </div>

      <div class="waba-divider">o</div>
      <button class="waba-btn-fb" onclick="window.__wabaEmbeddedSignup()">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="white"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
        Conectar con Facebook / Meta (Embedded Signup)
      </button>

      <div class="waba-modal-actions">
        <button class="waba-btn-secondary" onclick="document.getElementById('waba-modal-overlay').remove()">Cancelar</button>
        <button class="waba-btn-primary" id="waba-save-btn" onclick="window.__wabaSave()">💾 Guardar y conectar</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', function(e){ if(e.target===overlay) overlay.remove(); });
};

/* ── VERIFICAR CREDENCIALES ── */
window.__wabaVerify = function(){
  var phoneId = document.getElementById('waba-f-phoneid').value.trim();
  var token = document.getElementById('waba-f-token').value.trim();
  var resultDiv = document.getElementById('waba-verify-result');
  var btn = document.getElementById('waba-verify-btn');
  if(!phoneId||!token){ alert('Ingresa Phone Number ID y Access Token primero'); return; }
  btn.innerHTML = '<span class="waba-spinner"></span> Verificando...';
  btn.disabled = true;
  apiPost('/verify',{phone_number_id:phoneId,access_token:token}).then(function(data){
    resultDiv.style.display = 'block';
    if(data.ok){
      resultDiv.className = 'waba-verify-result';
      resultDiv.innerHTML = `✅ <b>Credenciales válidas</b><br>📱 Número: ${data.phone_number}<br>🏢 Nombre: ${data.verified_name}<br>⭐ Calidad: ${data.quality_rating||'—'}`;
      if(!document.getElementById('waba-f-name').value) document.getElementById('waba-f-name').value = data.verified_name||'';
    } else {
      resultDiv.className = 'waba-verify-result error';
      resultDiv.innerHTML = `❌ <b>Error:</b> ${data.error||'Credenciales inválidas'}`;
    }
    btn.innerHTML = '🔍 Verificar credenciales';
    btn.disabled = false;
  }).catch(function(){
    resultDiv.style.display='block';
    resultDiv.className='waba-verify-result error';
    resultDiv.innerHTML='❌ Error de conexión al verificar';
    btn.innerHTML='🔍 Verificar'; btn.disabled=false;
  });
};

/* ── GUARDAR CONEXIÓN ── */
window.__wabaSave = function(){
  var name = document.getElementById('waba-f-name').value.trim();
  var phoneId = document.getElementById('waba-f-phoneid').value.trim();
  var token = document.getElementById('waba-f-token').value.trim();
  var wabaId = document.getElementById('waba-f-wabaid').value.trim();
  if(!phoneId||!token){ alert('Phone Number ID y Access Token son obligatorios'); return; }
  var btn = document.getElementById('waba-save-btn');
  btn.innerHTML = '<span class="waba-spinner"></span> Conectando...';
  btn.disabled = true;
  apiPost('/connect',{display_name:name,phone_number_id:phoneId,access_token:token,waba_id:wabaId}).then(function(data){
    if(data.ok){
      document.getElementById('waba-modal-overlay').remove();
      loadNumbers();
      // Toast de éxito
      var toast = document.createElement('div');
      toast.style.cssText='position:fixed;bottom:24px;right:24px;background:#28a745;color:#fff;padding:14px 20px;border-radius:10px;font-weight:700;z-index:999999;box-shadow:0 4px 16px rgba(0,0,0,.2)';
      toast.innerHTML = '✅ Número WABA conectado: ' + (data.phone_number||phoneId);
      document.body.appendChild(toast);
      setTimeout(function(){toast.remove();},4000);
    } else {
      alert('Error: ' + (data.error||'No se pudo conectar'));
      btn.innerHTML='💾 Guardar y conectar'; btn.disabled=false;
    }
  }).catch(function(){ alert('Error de conexión'); btn.innerHTML='💾 Guardar y conectar'; btn.disabled=false; });
};

/* ── EMBEDDED SIGNUP (Meta SDK) ── */
window.__wabaEmbeddedSignup = function(){
  // Load Facebook SDK if not loaded
  if(!window.FB){
    var script = document.createElement('script');
    script.src='https://connect.facebook.net/en_US/sdk.js';
    script.onload = function(){
      FB.init({ appId:'1636647753686628', version:'v19.0', cookie:true, xfbml:false });
      window.__wabaLaunchFBLogin();
    };
    document.head.appendChild(script);
  } else {
    window.__wabaLaunchFBLogin();
  }
};

window.__wabaLaunchFBLogin = function(){
  FB.login(function(response){
    if(response.authResponse){
      var accessToken = response.authResponse.accessToken;
      // Get user's WABA phone numbers
      FB.api('/me/businesses', {access_token:accessToken, fields:'id,name'}, function(bizData){
        if(bizData.data && bizData.data.length>0){
          // Show business selector or auto-select first
          var bizId = bizData.data[0].id;
          FB.api('/'+bizId+'/owned_whatsapp_business_accounts', {access_token:accessToken}, function(wabaData){
            if(wabaData.data && wabaData.data.length>0){
              var wabaId = wabaData.data[0].id;
              FB.api('/'+wabaId+'/phone_numbers', {access_token:accessToken, fields:'id,display_phone_number,verified_name'}, function(phoneData){
                if(phoneData.data && phoneData.data.length>0){
                  var phone = phoneData.data[0];
                  document.getElementById('waba-f-phoneid').value = phone.id;
                  document.getElementById('waba-f-token').value = accessToken;
                  document.getElementById('waba-f-name').value = phone.verified_name||'';
                  document.getElementById('waba-f-wabaid').value = wabaId;
                  window.__wabaVerify();
                } else {
                  alert('No se encontraron números de teléfono en tu WABA. Agrega uno en Meta Business Manager.');
                }
              });
            } else {
              alert('No se encontraron WABA en tu cuenta de negocio Meta.');
            }
          });
        } else {
          alert('No se encontraron negocios en tu cuenta de Meta. Crea un negocio en business.facebook.com primero.');
        }
      });
    }
  }, {
    scope: 'whatsapp_business_management,whatsapp_business_messaging,business_management',
    return_scopes: true
  });
};

/* ── TEST ENVÍO ── */
window.__wabaTest = function(phoneNumberId, name){
  var to = prompt('Número de destino para la prueba (con código país, ej: 573227461878):');
  if(!to) return;
  var cleanTo = to.replace(/[^0-9]/g,'');
  var overlay = document.createElement('div');
  overlay.id='waba-test-modal';
  overlay.innerHTML=`<div class="waba-test-box"><h4>🧪 Enviando test desde "${name}"...</h4><div style="text-align:center;padding:12px"><span class="waba-spinner" style="border-color:#0a66c2;border-top-color:transparent"></span></div></div>`;
  document.body.appendChild(overlay);
  apiPost('/test/'+phoneNumberId,{to:cleanTo}).then(function(data){
    overlay.remove();
    if(data.ok){
      alert('✅ Botones enviados!\nWAMID: '+data.wamid+'\nRevisa el teléfono '+cleanTo);
    } else {
      alert('❌ Error: '+(data.error||'No se pudo enviar'));
    }
  }).catch(function(){ overlay.remove(); alert('Error de conexión'); });
};

/* ── ELIMINAR ── */
window.__wabaDelete = function(phoneNumberId, name){
  if(!confirm('¿Desconectar "'+name+'"?\nSe eliminará el número WABA de esta tienda.')) return;
  apiDel('/disconnect/'+phoneNumberId).then(function(data){
    if(data.ok){ loadNumbers(); }
    else { alert('Error: '+(data.error||'No se pudo eliminar')); }
  });
};

/* ── OBSERVER: inyecta cuando se navega a la sección ── */
function tryInject(){
  var txt = document.body.innerText||'';
  if(txt.includes('Escanea el QR') && txt.includes('Configuración n8n') && !document.getElementById('waba-connect-card')){
    renderCard();
  }
}

// MutationObserver para SPAs
var obs = new MutationObserver(function(){ tryInject(); });
obs.observe(document.body, { childList:true, subtree:true });
// Initial check
setTimeout(tryInject, 800);
setTimeout(tryInject, 2000);

console.log('[WABA Connect UI] v1.0 cargado');
})();
