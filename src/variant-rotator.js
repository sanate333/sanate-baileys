/* variant-rotator.js — Anti-spam: rota variantes de plantillas para Difusiones
 * Uso: pegar en /src/ del bot Render, importar en broadcastSender / sendTemplate.
 * Lee oasis_wa_config.wa_templates y elige aleatoriamente original o una variante.
 *
 * Integración minima:
 *   const { pickTemplateVariant } = require('./variant-rotator');
 *   const payload = pickTemplateVariant(template);
 *   await sock.sendMessage(jid, { text: payload.content });
 *   if (payload.media_urls_versioned) for (const u of payload.media_urls_versioned) {
 *     await sock.sendMessage(jid, { image: { url: u } });
 *   }
 */

function pickTemplateVariant(template) {
  if (!template) return template;
  if (!template.use_variants_rotation || !Array.isArray(template.variants) || template.variants.length === 0) {
    return {
      content: template.content,
      followUp: template.followUp,
      media: template.media,
      media_urls_versioned: (template.media || []).map(m => m.url),
      _source: 'original'
    };
  }

  // Pool: original + all variants
  const pool = [
    {
      content: template.content,
      followUp: template.followUp,
      media_urls_versioned: (template.media || []).map(m => m.url),
      _source: 'original'
    },
    ...template.variants.map(v => ({
      content: v.content,
      followUp: v.followUp,
      media_urls_versioned: v.media_urls_versioned || [],
      _source: v.variant_id
    }))
  ];

  // Random pick (uniform)
  const choice = pool[Math.floor(Math.random() * pool.length)];

  // Telemetry: log which variant was used (for analytics)
  if (process.env.LOG_VARIANT_ROTATION === '1') {
    console.log(`[variant-rotator] template=${template.id} chose=${choice._source}`);
  }

  return choice;
}

/* Get a fresh template from Supabase by id */
async function getTemplateById(supabase, templateId) {
  const { data, error } = await supabase
    .from('oasis_wa_config')
    .select('system_prompt')
    .eq('id', 'wa_templates')
    .single();
  if (error || !data) return null;
  const templates = JSON.parse(data.system_prompt || '[]');
  return templates.find(t => t.id === templateId) || null;
}

module.exports = { pickTemplateVariant, getTemplateById };
