const { createClient } = require('@supabase/supabase-js');
const { DEFAULT_STORE_ID } = require('./store-context');
let supabase = null;

function initSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.warn('SUPABASE_URL o SUPABASE_SERVICE_KEY no configurados.');
    return null;
  }
  supabase = createClient(url, key, { auth: { persistSession: false } });
  const projectRef = url.split('//')[1]?.split('.')[0] || 'unknown';
  console.log('Supabase conectado: ' + projectRef);
  return supabase;
}

function getSupabase() { return supabase; }

async function saveMessage(chatJid, chatName, msgData, storeId) {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase.from('oasis_wa_messages').upsert({
      chat_jid: chatJid,
      chat_name: chatName || chatJid.split('@')[0],
      message_id: msgData.messageId,
      direction: msgData.fromMe ? 's' : 'r',
      content: msgData.text || null,
      media_type: msgData.type !== 'text' ? msgData.type : null,
      media_url: msgData.mediaUrl || null,
      status: msgData.fromMe ? 'sent' : null,
      timestamp: msgData.timestamp
        ? new Date(typeof msgData.timestamp === 'number' && msgData.timestamp < 1e12 ? msgData.timestamp * 1000 : msgData.timestamp).toISOString()
        : new Date().toISOString(),
      device_id: 'default',
      store_id: storeId || DEFAULT_STORE_ID
    }, { onConflict: 'message_id', ignoreDuplicates: true });
    if (error) throw error;
    return data;
  } catch (err) { console.error('Error guardando mensaje:', err.message); return null; }
}

async function upsertChat(chatJid, chatName, lastMessage, lastTimestamp, source, storeId) {
  if (!supabase) return null;
  const sid = storeId || DEFAULT_STORE_ID;
  try {
    /* Skip @lid self-references (business profile "Sánate") and unresolved lids */
    if (chatJid.includes('@lid')) {
      const nm = (chatName || '').trim();
      if (/^s[aá]nate$/i.test(nm) || !nm || /^\d+$/.test(nm)) return null;
    }
    const phone = chatJid.includes('@') ? chatJid.split('@')[0] : chatJid;
    const ts = lastTimestamp
      ? new Date(typeof lastTimestamp === 'number' && lastTimestamp < 1e12 ? lastTimestamp * 1000 : lastTimestamp).toISOString()
      : new Date().toISOString();

    /* Primero intentar insertar (nuevo contacto) — filtrar por store_id */
    const { data: existing } = await supabase.from('oasis_wa_chats').select('jid,push_name').eq('jid', chatJid).eq('store_id', sid).maybeSingle();

    if (!existing) {
      /* Nuevo contacto: insertar con todos los campos */
      const row = {
        jid: chatJid, name: chatName || phone, phone: phone,
        push_name: chatName || null, last_message: lastMessage,
        last_timestamp: ts, unread: 0, device_id: 'default',
        tags: '[]', lifecycle_stage: 'new', updated_at: new Date().toISOString(),
        store_id: sid
      };
      if (source) row.source = source;
      const { error } = await supabase.from('oasis_wa_chats').insert(row);
      if (error && error.code !== '23505') throw error; /* 23505 = duplicate, race condition */
    } else {
      /* Contacto existente: actualizar según la fuente */
      if (source === 'sync') {
        /* SYNC (reconexión QR): NUNCA sobreescribir last_timestamp ni last_message.
           Baileys' conversationTimestamp es unreliable y destruye el orden real.
           Solo actualizar push_name si hay uno mejor. */
        const syncUpdates = {};
        if (chatName && chatName !== phone && !existing.push_name) {
          syncUpdates.push_name = chatName;
        }
        if (Object.keys(syncUpdates).length > 0) {
          const { error } = await supabase.from('oasis_wa_chats').update(syncUpdates).eq('jid', chatJid).eq('store_id', sid);
          if (error) throw error;
        }
      } else {
        /* incoming/outgoing: actualizar normalmente con timestamp real */
        const updates = {
          last_message: lastMessage,
          last_timestamp: ts,
          updated_at: new Date().toISOString()
        };
        /* Solo actualizar push_name si hay un nombre real */
        if (chatName && chatName !== phone) {
          updates.push_name = chatName;
        }
        if (source) updates.source = source;
        const { error } = await supabase.from('oasis_wa_chats').update(updates).eq('jid', chatJid).eq('store_id', sid);
        if (error) throw error;
      }
    }

    /* Si ya existía como 'sync' y ahora es 'incoming', promover a incoming */
    if (source === 'incoming') {
      await supabase.from('oasis_wa_chats').update({ source: 'incoming' }).eq('jid', chatJid).eq('store_id', sid).eq('source', 'sync');
    }
    return true;
  } catch (err) { console.error('Error guardando chat:', err.message); return null; }
}

async function getChats(limit = 100, storeId) {
  if (!supabase) return [];
  try {
    let query = supabase.from('oasis_wa_chats').select('*');
    if (storeId) query = query.eq('store_id', storeId);
    query = query.order('last_timestamp', { ascending: false }).limit(limit);
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  } catch (err) { console.error('Error obteniendo chats:', err.message); return []; }
}

async function getMessages(chatJid, limit = 50, before = null, storeId) {
  if (!supabase) return [];
  try {
    let query = supabase.from('oasis_wa_messages').select('*').eq('chat_jid', chatJid);
    if (storeId) query = query.eq('store_id', storeId);
    query = query.order('timestamp', { ascending: false }).limit(limit);
    if (before) query = query.lt('timestamp', before);
    const { data, error } = await query;
    if (error) throw error;
    return (data || []).reverse();
  } catch (err) { console.error('Error obteniendo mensajes:', err.message); return []; }
}

async function syncInitialChats(chatsData, storeId) {
  if (!supabase) return { synced: 0, errors: 0 };
  let synced = 0, errors = 0;
  const sid = storeId || DEFAULT_STORE_ID;
  console.log('Sincronizando ' + chatsData.length + ' chats (store: ' + sid.slice(0, 8) + ')...');

  for (const chat of chatsData) {
    try {
      await upsertChat(chat.jid, chat.name, chat.lastMessage, chat.lastTimestamp, 'sync', sid);
      if (chat.messages && chat.messages.length > 0) {
        for (const msg of chat.messages) { await saveMessage(chat.jid, chat.name, msg, sid); }
      }
      synced++;
    } catch (err) { errors++; console.error('Error ' + chat.jid + ': ' + err.message); }
  }
  console.log('[SYNC] Completado: ' + synced + ' OK, ' + errors + ' errores');
  return { synced, errors };
}

async function updateMessageStatus(messageId, status) {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase.from('oasis_wa_messages')
      .update({ status })
      .eq('message_id', messageId)
      .select();
    if (error) console.error('[Supabase] updateMessageStatus error:', error.message);
    return data;
  } catch (e) {
    console.error('[Supabase] updateMessageStatus exception:', e.message);
    return null;
  }
}

module.exports = { initSupabase, getSupabase, saveMessage, updateMessageStatus, upsertChat, getChats, getMessages, syncInitialChats };
