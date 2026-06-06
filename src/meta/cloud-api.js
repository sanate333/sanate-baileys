/**
 * src/meta/cloud-api.js
 *
 * Cliente WhatsApp Cloud API (Meta Graph API v22.0)
 * Funciones para enviar mensajes, plantillas, media, botones interactivos.
 *
 * Docs: https://developers.facebook.com/documentation/business-messaging/whatsapp/cloud-api/reference
 */

const META_GRAPH = 'https://graph.facebook.com/v22.0';

class CloudAPIError extends Error {
  constructor(msg, code, details) {
    super(msg);
    this.code = code;
    this.details = details;
  }
}

async function _post(url, body, token) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok || json.error) {
    throw new CloudAPIError(
      json.error?.message || `HTTP ${res.status}`,
      json.error?.code,
      json.error
    );
  }
  return json;
}

async function _get(url, token) {
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const json = await res.json();
  if (!res.ok || json.error) {
    throw new CloudAPIError(
      json.error?.message || `HTTP ${res.status}`,
      json.error?.code,
      json.error
    );
  }
  return json;
}

/**
 * Envía mensaje de texto simple.
 * Solo válido en ventana de 24h del cliente o como respuesta a service window.
 */
async function sendText(phoneNumberId, to, text, token, options = {}) {
  return _post(`${META_GRAPH}/${phoneNumberId}/messages`, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: String(to).replace(/\D/g, ''),
    type: 'text',
    text: {
      preview_url: options.preview_url || false,
      body: text,
    },
  }, token);
}

/**
 * Envía plantilla aprobada por Meta (para iniciar conversaciones fuera de ventana 24h).
 */
async function sendTemplate(phoneNumberId, to, templateName, langCode, components, token) {
  return _post(`${META_GRAPH}/${phoneNumberId}/messages`, {
    messaging_product: 'whatsapp',
    to: String(to).replace(/\D/g, ''),
    type: 'template',
    template: {
      name: templateName,
      language: { code: langCode || 'es_CO' },
      components: components || [],
    },
  }, token);
}

/**
 * Envía imagen (con caption opcional).
 */
async function sendImage(phoneNumberId, to, imageUrl, caption, token) {
  return _post(`${META_GRAPH}/${phoneNumberId}/messages`, {
    messaging_product: 'whatsapp',
    to: String(to).replace(/\D/g, ''),
    type: 'image',
    image: {
      link: imageUrl,
      ...(caption ? { caption } : {}),
    },
  }, token);
}

/**
 * Envía botones interactivos (CTA, quick reply).
 */
async function sendInteractiveButtons(phoneNumberId, to, bodyText, buttons, token) {
  return _post(`${META_GRAPH}/${phoneNumberId}/messages`, {
    messaging_product: 'whatsapp',
    to: String(to).replace(/\D/g, ''),
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: buttons.map((b, i) => ({
          type: 'reply',
          reply: {
            id: b.id || `btn_${i}`,
            title: (b.text || b.title || `Opción ${i + 1}`).slice(0, 20),
          },
        })),
      },
    },
  }, token);
}

/**
 * Envía lista interactiva (hasta 10 secciones, 10 items cada una).
 */
async function sendInteractiveList(phoneNumberId, to, bodyText, buttonText, sections, token) {
  return _post(`${META_GRAPH}/${phoneNumberId}/messages`, {
    messaging_product: 'whatsapp',
    to: String(to).replace(/\D/g, ''),
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: bodyText },
      action: {
        button: buttonText.slice(0, 20),
        sections: sections.map(s => ({
          title: s.title.slice(0, 24),
          rows: (s.rows || []).map((r, i) => ({
            id: r.id || `row_${i}`,
            title: (r.title || '').slice(0, 24),
            description: (r.description || '').slice(0, 72),
          })),
        })),
      },
    },
  }, token);
}

/**
 * Marca mensaje como leído (mejor delivery patterns para anti-spam Meta).
 */
async function markAsRead(phoneNumberId, messageId, token) {
  return _post(`${META_GRAPH}/${phoneNumberId}/messages`, {
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: messageId,
  }, token);
}

/**
 * Información del WhatsApp Business Account.
 */
async function getWABAInfo(token) {
  return _get(
    `${META_GRAPH}/me/businesses?fields=id,name,whatsapp_business_accounts{id,name,owner_business_info,phone_numbers{id,display_phone_number,verified_name,quality_rating,messaging_limit}}`,
    token
  );
}

/**
 * Información del número específico.
 */
async function getPhoneInfo(phoneNumberId, token) {
  return _get(
    `${META_GRAPH}/${phoneNumberId}?fields=id,display_phone_number,verified_name,quality_rating,name_status,messaging_limit,certificate`,
    token
  );
}

/**
 * Lista plantillas aprobadas por Meta para el WABA.
 */
async function listTemplates(wabaId, token) {
  return _get(
    `${META_GRAPH}/${wabaId}/message_templates?fields=name,status,category,language,components&limit=100`,
    token
  );
}

/**
 * Crea plantilla para aprobación de Meta.
 */
async function createTemplate(wabaId, name, language, category, components, token) {
  return _post(`${META_GRAPH}/${wabaId}/message_templates`, {
    name,
    language,
    category, // MARKETING | UTILITY | AUTHENTICATION
    components,
  }, token);
}

/**
 * Intercambia code OAuth por access_token de larga duración (60 días).
 */
async function exchangeCodeForToken(code, appId, appSecret, redirectUri) {
  const params = new URLSearchParams({
    client_id: appId,
    client_secret: appSecret,
    redirect_uri: redirectUri,
    code,
  });
  const res = await fetch(`${META_GRAPH}/oauth/access_token?${params}`);
  const json = await res.json();
  if (!res.ok || json.error) {
    throw new CloudAPIError(
      json.error?.message || `OAuth exchange failed`,
      json.error?.code,
      json.error
    );
  }
  return json; // { access_token, token_type, expires_in }
}

/**
 * Convierte short-lived token en long-lived (~60 días).
 */
async function extendToken(shortToken, appId, appSecret) {
  const params = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: shortToken,
  });
  const res = await fetch(`${META_GRAPH}/oauth/access_token?${params}`);
  const json = await res.json();
  if (!res.ok) {
    throw new CloudAPIError(json.error?.message, json.error?.code, json.error);
  }
  return json;
}

/**
 * Registra número en Cloud API (necesario después de Embedded Signup).
 */
async function registerPhoneNumber(phoneNumberId, pin, token) {
  return _post(`${META_GRAPH}/${phoneNumberId}/register`, {
    messaging_product: 'whatsapp',
    pin: pin || '000000',
  }, token);
}

/**
 * Configura webhook subscription en WABA.
 */
async function subscribeWebhook(wabaId, token) {
  return _post(`${META_GRAPH}/${wabaId}/subscribed_apps`, {}, token);
}

module.exports = {
  CloudAPIError,
  sendText,
  sendTemplate,
  sendImage,
  sendInteractiveButtons,
  sendInteractiveList,
  markAsRead,
  getWABAInfo,
  getPhoneInfo,
  listTemplates,
  createTemplate,
  exchangeCodeForToken,
  extendToken,
  registerPhoneNumber,
  subscribeWebhook,
};
