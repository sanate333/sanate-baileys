/**
 * routes-transfers.js — Endpoints para panel de Transferencias
 *
 * Mounted under /api/whatsapp.
 *
 * Endpoints:
 *   GET  /transfers/list?limit=50&offset=0&status=pending|approved|fraud|blocked|invalid_image
 *   GET  /transfers/stats/today          — counts + sum total del día (UTC -5 Colombia)
 *   POST /transfers/:id/approve          — aprobación desde panel (alternativa a botones WA)
 *   POST /transfers/:id/reject?reason=fraud|invalid|block — rechazo desde panel
 *   GET  /transfers/export.csv?days=30   — CSV de últimos N días
 *   GET  /transfers/engagement           — métricas: msgs enviados/recibidos hoy/semana, tasa respuesta
 */

const express = require('express');
const router = express.Router();
const transferHandler = require('./transfer-handler');

function getSupabase(req) { return req.app.get('supabase'); }

router.get('/transfers/list', async (req, res) => {
  try {
    const supabase = getSupabase(req);
    if (!supabase) return res.status(503).json({ error: 'Supabase no disponible' });
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    let q = supabase.from('oasis_wa_transfers').select('*', { count: 'exact' }).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
    if (req.query.status) q = q.eq('status', req.query.status);
    const { data, error, count } = await q;
    if (error) throw error;
    res.json({ ok: true, transfers: data || [], total: count || 0, limit, offset });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/transfers/stats/today', async (req, res) => {
  try {
    const supabase = getSupabase(req);
    if (!supabase) return res.status(503).json({ error: 'Supabase no disponible' });
    // Colombia: UTC-5
    const now = new Date();
    const offsetMs = -5 * 60 * 60 * 1000;
    const localNow = new Date(now.getTime() + offsetMs);
    const todayStart = new Date(Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate(), 5, 0, 0)); // 00:00 Bogotá = 05:00 UTC
    const { data, error } = await supabase
      .from('oasis_wa_transfers')
      .select('id,status,total,created_at')
      .gte('created_at', todayStart.toISOString());
    if (error) throw error;
    const stats = { pending: 0, approved: 0, fraud: 0, blocked: 0, invalid_image: 0, total_revenue: 0 };
    (data || []).forEach(t => {
      if (stats[t.status] !== undefined) stats[t.status]++;
      if (t.status === 'approved') stats.total_revenue += Number(t.total) || 0;
    });
    res.json({ ok: true, date: todayStart.toISOString().slice(0,10), total: data?.length || 0, ...stats });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/transfers/:id/approve', async (req, res) => {
  try {
    // Delegate to handler logic by simulating button text
    const ok = await transferHandler.handleReviewerResponse(null, 'transfer_approve_' + req.params.id);
    res.json({ ok, transferId: req.params.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/transfers/:id/reject', async (req, res) => {
  try {
    const reason = (req.query.reason || 'fraud').toLowerCase();
    const action = reason === 'block' ? 'block' : (reason === 'invalid' ? 'fraud' : 'fraud');
    const ok = await transferHandler.handleReviewerResponse(null, 'transfer_' + action + '_' + req.params.id);
    res.json({ ok, transferId: req.params.id, action });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/transfers/export.csv', async (req, res) => {
  try {
    const supabase = getSupabase(req);
    if (!supabase) return res.status(503).json({ error: 'Supabase no disponible' });
    const days = Math.min(parseInt(req.query.days) || 30, 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('oasis_wa_transfers')
      .select('id,chat_jid,phone,push_name,total,payment_method,status,created_at,reviewed_at,order_summary')
      .gte('created_at', since)
      .order('created_at', { ascending: false });
    if (error) throw error;
    const headers = ['id','chat_jid','phone','push_name','total','payment_method','status','created_at','reviewed_at','order_summary'];
    const escapeCsv = v => {
      if (v === null || v === undefined) return '';
      const s = String(v).replace(/"/g, '""');
      return /[",\n]/.test(s) ? '"' + s + '"' : s;
    };
    const csv = [headers.join(',')].concat((data || []).map(r => headers.map(h => escapeCsv(r[h])).join(','))).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="transferencias-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/transfers/engagement', async (req, res) => {
  try {
    const supabase = getSupabase(req);
    if (!supabase) return res.status(503).json({ error: 'Supabase no disponible' });
    const since24h = new Date(Date.now() - 24*60*60*1000).toISOString();
    const since7d = new Date(Date.now() - 7*24*60*60*1000).toISOString();
    const [msgs24h, msgs7d, transfers7d] = await Promise.all([
      supabase.from('oasis_wa_messages').select('id,direction', { count: 'exact', head: false }).gte('timestamp', Math.floor(Date.parse(since24h)/1000)),
      supabase.from('oasis_wa_messages').select('id,direction', { count: 'exact', head: false }).gte('timestamp', Math.floor(Date.parse(since7d)/1000)),
      supabase.from('oasis_wa_transfers').select('status', { count: 'exact' }).gte('created_at', since7d)
    ]);
    function countByDir(arr) {
      const r = { sent: 0, received: 0 };
      (arr || []).forEach(m => { if (m.direction === 's') r.sent++; else r.received++; });
      return r;
    }
    const c24 = countByDir(msgs24h.data);
    const c7 = countByDir(msgs7d.data);
    const responseRate24h = c24.received > 0 ? Math.round((c24.sent / c24.received) * 100) : 0;
    const transfers = transfers7d.data || [];
    const approved = transfers.filter(t => t.status === 'approved').length;
    const conversionRate7d = transfers.length > 0 ? Math.round((approved / transfers.length) * 100) : 0;
    res.json({
      ok: true,
      last_24h: { sent: c24.sent, received: c24.received, response_rate_pct: responseRate24h },
      last_7d:  { sent: c7.sent,  received: c7.received,  transfers: transfers.length, approved, conversion_pct: conversionRate7d }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


router.get('/chats/export.csv', async (req, res) => {
  try {
    const supabase = getSupabase(req);
    if (!supabase) return res.status(503).json({ error: 'Supabase no disponible' });
    const days = Math.min(parseInt(req.query.days) || 30, 365);
    const since = Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 1000);
    const { data, error } = await supabase
      .from('oasis_wa_messages')
      .select('id,chat_jid,chat_name,message_id,direction,content,media_type,timestamp')
      .gte('timestamp', since)
      .order('timestamp', { ascending: false })
      .limit(5000);
    if (error) throw error;
    const headers = ['id','chat_jid','chat_name','message_id','direction','content','media_type','timestamp'];
    const escapeCsv = v => {
      if (v === null || v === undefined) return '';
      const s = String(v).replace(/"/g, '""');
      return /[",\n]/.test(s) ? '"' + s + '"' : s;
    };
    const csv = [headers.join(',')].concat((data || []).map(r => headers.map(h => escapeCsv(r[h])).join(','))).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="chats-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/chats/stats', async (req, res) => {
  try {
    const supabase = getSupabase(req);
    if (!supabase) return res.status(503).json({ error: 'Supabase no disponible' });
    const since24 = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
    const since7d = Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000);
    const { count: chatsCount } = await supabase.from('oasis_wa_chats').select('id', { count: 'exact', head: true });
    const { count: msgs24 } = await supabase.from('oasis_wa_messages').select('id', { count: 'exact', head: true }).gte('timestamp', since24);
    const { count: msgs7d } = await supabase.from('oasis_wa_messages').select('id', { count: 'exact', head: true }).gte('timestamp', since7d);
    res.json({ ok: true, total_chats: chatsCount || 0, messages_24h: msgs24 || 0, messages_7d: msgs7d || 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
