/* Fix 102 — Audio Settings Enhancement: Voice Previews + Processing Time (v1)
 * Adds play buttons to preview each voice before selecting
 * Shows estimated processing time
 * Fixes audio playback in chat panel
 */
(function fix102_audioSettings(){
  'use strict';
  if(window.__fix102_applied) return;
  window.__fix102_applied = true;
  if(window.location.pathname.indexOf('/dashboard/whatsapp-bot') !== 0) return;

  var API = 'https://sanate-wa-bot.onrender.com/api/whatsapp';
  var previewCache = {}; // voice → {audio, mimeType}
  var currentAudio = null;

  /* ── CSS ── */
  var css = document.createElement('style');
  css.id = 'fix102-css';
  css.textContent = [
    '.fix102-voice-row { display:flex; align-items:center; gap:10px; padding:8px 12px; border-radius:10px; transition:background 0.15s; cursor:pointer; }',
    '.fix102-voice-row:hover { background:#f0f9f0; }',
    '.fix102-voice-row.active { background:#e8f5e9; border:2px solid #10b981; }',
    '.fix102-voice-row:not(.active) { border:2px solid transparent; }',
    '.fix102-play-btn { width:36px; height:36px; border-radius:50%; border:none; background:#10b981; color:#fff; cursor:pointer; display:flex; align-items:center; justify-content:center; flex-shrink:0; transition:all 0.15s; font-size:14px; }',
    '.fix102-play-btn:hover { background:#059669; transform:scale(1.08); }',
    '.fix102-play-btn.loading { background:#6ee7b7; cursor:wait; }',
    '.fix102-play-btn.playing { background:#ef4444; }',
    '.fix102-voice-info { flex:1; min-width:0; }',
    '.fix102-voice-name { font-size:14px; font-weight:600; color:#111827; }',
    '.fix102-voice-desc { font-size:12px; color:#6b7280; margin-top:1px; }',
    '.fix102-voice-grid { display:flex; flex-direction:column; gap:6px; margin-top:0; max-height:0; overflow:hidden; transition:max-height 0.35s ease, opacity 0.25s ease, margin-top 0.3s ease; opacity:0; }',
    '.fix102-voice-grid.open { max-height:600px; opacity:1; margin-top:12px; }',
    '.fix102-toggle { display:flex; align-items:center; justify-content:space-between; padding:12px 16px; background:#f0fdf4; border:2px solid #d1fae5; border-radius:12px; cursor:pointer; user-select:none; transition:all 0.2s; margin-top:10px; }',
    '.fix102-toggle:hover { background:#e8f5e9; border-color:#10b981; }',
    '.fix102-toggle-left { display:flex; align-items:center; gap:10px; }',
    '.fix102-toggle-voice { font-size:15px; font-weight:600; color:#111827; }',
    '.fix102-toggle-desc { font-size:12px; color:#6b7280; }',
    '.fix102-toggle-arrow { font-size:18px; color:#10b981; transition:transform 0.3s ease; font-weight:700; }',
    '.fix102-toggle-arrow.open { transform:rotate(180deg); }',
    '.fix102-timing-bar { margin-top:16px; padding:14px 16px; background:linear-gradient(135deg,#f0fdf4,#ecfdf5); border-radius:12px; border:1px solid #d1fae5; }',
    '.fix102-timing-title { font-size:13px; font-weight:600; color:#065f46; margin-bottom:6px; }',
    '.fix102-timing-row { display:flex; justify-content:space-between; font-size:12px; color:#047857; padding:3px 0; }',
    '.fix102-timing-row span:last-child { font-weight:600; }',
    '.fix102-progress { height:3px; background:#d1fae5; border-radius:2px; margin-top:8px; overflow:hidden; }',
    '.fix102-progress-fill { height:100%; background:#10b981; border-radius:2px; transition:width 0.3s; }',
    '@keyframes fix102-spin { to{transform:rotate(360deg)} }',
    '.fix102-spinner { animation:fix102-spin 0.8s linear infinite; display:inline-block; }',
  ].join('\n');
  document.head.appendChild(css);

  var VOICES = [
    {id:'Kore',   emoji:'👩', name:'Kore',   desc:'voz femenina clara (recomendada)'},
    {id:'Aoede',  emoji:'🎵', name:'Aoede',  desc:'voz femenina cálida'},
    {id:'Puck',   emoji:'🤴', name:'Puck',   desc:'voz masculina jovial'},
    {id:'Charon', emoji:'🌊', name:'Charon', desc:'voz masculina profunda'},
    {id:'Fenrir', emoji:'🐺', name:'Fenrir', desc:'voz masculina enérgica'},
    {id:'Zephyr', emoji:'🌸', name:'Zephyr', desc:'voz femenina suave'},
    {id:'Leda',   emoji:'🌟', name:'Leda',   desc:'voz femenina expresiva'},
    {id:'Orus',   emoji:'🔴', name:'Orus',   desc:'voz masculina firme'},
  ];

  function stopCurrentAudio(){
    if(currentAudio){ try{ currentAudio.pause(); currentAudio.currentTime=0; }catch(e){} currentAudio=null; }
    document.querySelectorAll('.fix102-play-btn.playing').forEach(function(b){ b.classList.remove('playing'); b.innerHTML='▶'; });
  }

  function playPreview(voiceId, btn){
    stopCurrentAudio();

    if(previewCache[voiceId]){
      playFromCache(voiceId, btn);
      return;
    }

    btn.classList.add('loading');
    btn.innerHTML = '<span class="fix102-spinner">↻</span>';

    fetch(API + '/voice-preview', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({voice:voiceId})
    })
    .then(function(r){ return r.json(); })
    .then(function(d){
      btn.classList.remove('loading');
      if(!d.ok) { btn.innerHTML='▶'; alert('Error: '+d.error); return; }
      previewCache[voiceId] = d;
      playFromCache(voiceId, btn);
      updateTimingDisplay(d.timing);
    })
    .catch(function(e){
      btn.classList.remove('loading');
      btn.innerHTML='▶';
      console.error('[Fix102] Preview error:', e);
    });
  }

  function playFromCache(voiceId, btn){
    var d = previewCache[voiceId];
    var blob = b64toBlob(d.audio, d.mimeType);
    var url = URL.createObjectURL(blob);
    currentAudio = new Audio(url);
    btn.classList.add('playing');
    btn.innerHTML = '⏹';
    currentAudio.play().catch(function(e){ console.warn('Play error:',e); });
    currentAudio.onended = function(){
      btn.classList.remove('playing');
      btn.innerHTML = '▶';
      currentAudio = null;
      URL.revokeObjectURL(url);
    };
    btn.onclick = function(e){
      e.stopPropagation();
      if(currentAudio){
        stopCurrentAudio();
      } else {
        playPreview(voiceId, btn);
      }
    };
  }

  function b64toBlob(b64, mime){
    var binary = atob(b64);
    var bytes = new Uint8Array(binary.length);
    for(var i=0;i<binary.length;i++) bytes[i]=binary.charCodeAt(i);
    return new Blob([bytes], {type:mime});
  }

  var lastTiming = null;
  function updateTimingDisplay(timing){
    lastTiming = timing;
    var el = document.getElementById('fix102-timing');
    if(!el) return;
    el.innerHTML = [
      '<div class="fix102-timing-title">⚡ Rendimiento de voz (última prueba)</div>',
      '<div class="fix102-timing-row"><span>Generación de voz</span><span>'+(timing.ttsMs/1000).toFixed(1)+'s</span></div>',
      '<div class="fix102-timing-row"><span>Conversión PCM → OGG</span><span>'+(timing.conversionMs/1000).toFixed(1)+'s</span></div>',
      '<div class="fix102-timing-row" style="border-top:1px solid #a7f3d0;padding-top:6px;margin-top:4px;font-size:13px;"><span>Total procesamiento</span><span style="color:#059669;font-size:14px;">'+(timing.totalMs/1000).toFixed(1)+'s</span></div>',
      '<div class="fix102-progress"><div class="fix102-progress-fill" style="width:'+Math.min(100,timing.totalMs/300)+'%"></div></div>',
      '<div style="font-size:11px;color:#6b7280;margin-top:6px;text-align:center;">',
      timing.totalMs < 15000 ? '✅ Velocidad óptima — respuesta en <25s total' :
      timing.totalMs < 25000 ? '⚠️ Velocidad aceptable — respuesta en ~30s' :
      '🔴 Lento — considere reducir longitud de texto',
      '</div>'
    ].join('');
  }

  /* ── Enhance Audio tab when it appears ── */
  function enhanceAudioTab(){
    // Find the voice select dropdown
    var selects = document.querySelectorAll('select');
    var voiceSelect = null;
    selects.forEach(function(sel){
      var opts = sel.querySelectorAll('option');
      opts.forEach(function(o){
        if(o.textContent.indexOf('Kore')!==-1 || o.textContent.indexOf('Aoede')!==-1 || o.textContent.indexOf('Leda')!==-1){
          voiceSelect = sel;
        }
      });
    });
    if(!voiceSelect || voiceSelect.__fix102) return;
    voiceSelect.__fix102 = true;

    var currentVoice = voiceSelect.value || '';
    // Find which voice is selected by checking option text
    if(!currentVoice){
      var selOpt = voiceSelect.querySelector('option:checked');
      if(selOpt){
        VOICES.forEach(function(v){
          if(selOpt.textContent.indexOf(v.name)!==-1) currentVoice = v.id;
        });
      }
    }

    // Hide "Gemini TTS" label text — SCOPED to audio section only (never touch other sections)
    var container = voiceSelect.parentElement;
    var audioSection = voiceSelect.closest('[class*=audio], [class*=Audio], [data-tab], fieldset') || container.parentElement;
    audioSection.querySelectorAll('label, small, p, .sp-field-desc').forEach(function(el){
      if(el.children.length > 0) return; // only leaf text nodes
      var t = el.textContent || '';
      if(t.indexOf('Gemini') !== -1 || t.indexOf('gemini') !== -1){
        el.textContent = t.replace(/\s*\(?\s*Gemini\s+TTS\s*\)?\s*/gi, '').replace(/Gemini\s*/gi, '').trim();
        if(!el.textContent) el.textContent = 'Selecciona la voz del asistente';
      }
    });

    // Find current voice info for toggle display
    var currentVoiceObj = VOICES.find(function(v){ return v.id === currentVoice; }) || VOICES[0];

    // Create toggle header showing current voice
    var toggle = document.createElement('div');
    toggle.className = 'fix102-toggle';
    toggle.id = 'fix102-voice-toggle';
    toggle.innerHTML = '<div class="fix102-toggle-left"><span class="fix102-toggle-voice">' + currentVoiceObj.emoji + ' ' + currentVoiceObj.name + '</span><span class="fix102-toggle-desc">' + currentVoiceObj.desc + '</span></div><span class="fix102-toggle-arrow">▼</span>';
    container.appendChild(toggle);

    // Create collapsible voice grid
    var grid = document.createElement('div');
    grid.className = 'fix102-voice-grid';
    grid.id = 'fix102-voice-grid';

    // Toggle open/close on click
    toggle.addEventListener('click', function(){
      var isOpen = grid.classList.toggle('open');
      toggle.querySelector('.fix102-toggle-arrow').classList.toggle('open', isOpen);
    });

    VOICES.forEach(function(v){
      var row = document.createElement('div');
      row.className = 'fix102-voice-row' + (v.id === currentVoice ? ' active' : '');
      row.dataset.voice = v.id;

      var playBtn = document.createElement('button');
      playBtn.className = 'fix102-play-btn';
      playBtn.type = 'button';
      playBtn.innerHTML = '▶';
      playBtn.title = 'Escuchar ' + v.name;
      playBtn.onclick = function(e){
        e.stopPropagation();
        e.preventDefault();
        playPreview(v.id, playBtn);
      };

      var info = document.createElement('div');
      info.className = 'fix102-voice-info';
      info.innerHTML = '<div class="fix102-voice-name">' + v.emoji + ' ' + v.name + '</div><div class="fix102-voice-desc">' + v.desc + '</div>';

      row.appendChild(playBtn);
      row.appendChild(info);

      row.addEventListener('click', function(e){
        if(e.target.closest('.fix102-play-btn')) return;
        // Select this voice
        stopCurrentAudio();
        document.querySelectorAll('.fix102-voice-row.active').forEach(function(r){ r.classList.remove('active'); });
        row.classList.add('active');

        // Update the toggle header with selected voice
        var tgl = document.getElementById('fix102-voice-toggle');
        if(tgl){
          tgl.querySelector('.fix102-toggle-voice').textContent = v.emoji + ' ' + v.name;
          tgl.querySelector('.fix102-toggle-desc').textContent = v.desc;
        }

        // Collapse the grid after selection
        grid.classList.remove('open');
        var arrow = document.querySelector('.fix102-toggle-arrow');
        if(arrow) arrow.classList.remove('open');

        // Update the hidden select
        var opts = voiceSelect.querySelectorAll('option');
        for(var i=0;i<opts.length;i++){
          if(opts[i].textContent.indexOf(v.name) !== -1){
            voiceSelect.value = opts[i].value;
            voiceSelect.dispatchEvent(new Event('change', {bubbles:true}));
            break;
          }
        }
      });

      grid.appendChild(row);
    });

    // Hide select, add grid (collapsed by default)
    voiceSelect.style.display = 'none';
    container.appendChild(grid);

    // Add timing display
    var timingEl = document.createElement('div');
    timingEl.id = 'fix102-timing';
    timingEl.className = 'fix102-timing-bar';
    timingEl.innerHTML = [
      '<div class="fix102-timing-title">⚡ Rendimiento de voz</div>',
      '<div style="font-size:12px;color:#6b7280;">Presiona ▶ en cualquier voz para medir el tiempo de procesamiento</div>'
    ].join('');
    container.appendChild(timingEl);

    console.log('[Fix102] Audio settings enhanced with voice previews');
  }

  /* ── Fix audio playback in chat.html iframe ── */
  function fixAudioPlayback(){
    var iframe = document.getElementById('sp-chat-iframe');
    if(!iframe || iframe.__fix102audio) return;
    iframe.__fix102audio = true;

    iframe.addEventListener('load', function(){
      try {
        var iDoc = iframe.contentDocument || iframe.contentWindow.document;
        if(!iDoc) return;

        // Inject audio playback fix into iframe
        var script = iDoc.createElement('script');
        script.textContent = '(' + (function(){
          // Fix audio elements that fail to play
          function fixAudioElements(){
            var audios = document.querySelectorAll('audio');
            audios.forEach(function(a){
              if(a.__fixed) return;
              a.__fixed = true;
              // Ensure controls are visible
              a.controls = true;
              a.preload = 'auto';
              // Fix play button click
              var parent = a.closest('.sp-msg-audio, .msg-audio, [class*=audio]');
              if(parent){
                var playBtn = parent.querySelector('button, .play-btn, [class*=play]');
                if(playBtn){
                  playBtn.addEventListener('click', function(e){
                    e.preventDefault();
                    if(a.paused){ a.play().catch(function(){}); }
                    else { a.pause(); }
                  });
                }
              }
            });
          }
          fixAudioElements();
          new MutationObserver(function(){ fixAudioElements(); }).observe(document.body, {childList:true, subtree:true});
        }).toString() + ')();';
        iDoc.head.appendChild(script);
      } catch(e) { /* cross-origin, skip */ }
    });
  }

  /* ── Observer to apply when Audio tab opens ── */
  function startObserver(){
    var lastCheck = 0;
    function check(){
      var now = Date.now();
      if(now - lastCheck < 500) return;
      lastCheck = now;
      enhanceAudioTab();
      fixAudioPlayback();
    }

    check();
    new MutationObserver(check).observe(document.body, {childList:true, subtree:true});
    // Also check periodically for React re-renders
    setInterval(check, 2000);
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', function(){ setTimeout(startObserver, 500); });
  } else {
    setTimeout(startObserver, 500);
  }

  console.info('[WA-OASIS] Fix 102: Audio settings with voice previews loaded');
})();
