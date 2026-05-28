/**
 * Plantilla Pro Fix v1.0
 * Fixes: images and buttons not sending through Plantillas Pro
 * - Intercepts send calls from Plantilla Pro modal
 * - Adds mediaUrl from template data when available
 * - Sets type: 'template_pro' so backend handles image + text properly
 */
(function() {
  'use strict';
  const TAG = '[PPF]';
  console.log(TAG, 'Plantilla Pro Fix v1.0 loading...');

  // Store media URL from template preview when modal opens
  let currentTemplateMedia = null;
  let isProTemplate = false;

  // Watch for Plantilla Pro modal opening via MutationObserver
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        const text = node.textContent || '';
        // Detect "Enviar plantilla Pro" modal
        if (text.includes('Enviar plantilla Pro') || text.includes('plantilla Pro')) {
          isProTemplate = true;
          currentTemplateMedia = null;
          // Look for image in the preview
          setTimeout(() => {
            const imgs = node.querySelectorAll ? node.querySelectorAll('img') : [];
            for (const img of imgs) {
              const src = img.src || '';
              // Skip UI icons, logos, small images
              if (src && !src.includes('icon') && !src.includes('logo') && !src.includes('svg') &&
                  !src.includes('emoji') && img.naturalWidth > 50) {
                currentTemplateMedia = src;
                console.log(TAG, 'Media detected in template preview:', src.substring(0, 80));
                break;
              }
            }
            // Also check for background images
            if (!currentTemplateMedia) {
              const divs = node.querySelectorAll ? node.querySelectorAll('[style*="background-image"]') : [];
              for (const div of divs) {
                const bg = div.style.backgroundImage;
                const match = bg && bg.match(/url\(["']?([^"')]+)["']?\)/);
                if (match && match[1]) {
                  currentTemplateMedia = match[1];
                  console.log(TAG, 'Media from background:', match[1].substring(0, 80));
                  break;
                }
              }
            }
            if (!currentTemplateMedia) {
              console.log(TAG, 'No media found in template preview (text-only template)');
            }
          }, 300);
        }
        // Detect modal closing
        if (text.includes('Cancelar') && node.querySelector && !node.querySelector('[class*="modal"]')) {
          // Don't reset here, wait for send
        }
      }
      for (const node of m.removedNodes) {
        if (node.nodeType === 1 && (node.textContent || '').includes('Enviar plantilla Pro')) {
          // Modal closed - reset after a short delay to allow send to complete
          setTimeout(() => {
            isProTemplate = false;
            currentTemplateMedia = null;
          }, 2000);
        }
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Also capture media from template data stored in React state
  // Look for plantillasPro in localStorage
  function getStoredTemplates() {
    try {
      for (const key of Object.keys(localStorage)) {
        if (key.includes('plantilla') || key.includes('template')) {
          const val = localStorage.getItem(key);
          if (val) {
            try {
              const parsed = JSON.parse(val);
              if (Array.isArray(parsed)) return parsed;
              if (parsed && typeof parsed === 'object') return [parsed];
            } catch(e) {}
          }
        }
      }
    } catch(e) {}
    return [];
  }

  // Intercept fetch to add template_pro type and mediaUrl
  const origFetch = window.fetch;
  window.fetch = function(url, opts) {
    if (typeof url === 'string' && url.includes('/send') && opts && opts.method === 'POST' && isProTemplate) {
      try {
        let body = opts.body;
        if (typeof body === 'string') {
          const parsed = JSON.parse(body);
          // Check if this looks like a Plantilla Pro message
          if (parsed.message && typeof parsed.message === 'string' && parsed.message.includes('â¸')) {
            console.log(TAG, 'Intercepted Plantilla Pro send');
            parsed.type = 'template_pro';
            if (currentTemplateMedia) {
              parsed.mediaUrl = currentTemplateMedia;
              console.log(TAG, 'Adding mediaUrl to request:', currentTemplateMedia.substring(0, 60));
            }
            const newOpts = { ...opts, body: JSON.stringify(parsed) };
            isProTemplate = false;
            return origFetch.call(this, url, newOpts);
          }
        }
      } catch(e) {
        console.log(TAG, 'Parse error:', e.message);
      }
    }
    return origFetch.call(this, url, opts);
  };

  console.log(TAG, 'Plantilla Pro Fix v1.0 ready');
})();
