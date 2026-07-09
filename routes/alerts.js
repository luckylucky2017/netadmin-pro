const express = require('express');
const router = express.Router();
const db = require('../database');
const { requirePermission, logActivity } = require('../auth');

router.get('/', async (req, res) => {
  const { search, severity, category, status } = req.query;
  let query = 'SELECT * FROM alerts WHERE 1=1';
  const params = [];
  if (search) { query += ' AND (title LIKE ? OR message LIKE ? OR source_name LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  if (severity) { query += ' AND severity = ?'; params.push(severity); }
  if (category) { query += ' AND category = ?'; params.push(category); }
  if (status) { query += ' AND status = ?'; params.push(status); }
  query += " ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, created_at DESC";
  res.json(await db.prepare(query).all(...params));
});

router.get('/stats', async (req, res) => {
  const total = (await db.prepare('SELECT COUNT(*) as cnt FROM alerts').get()).cnt;
  const open = (await db.prepare("SELECT COUNT(*) as cnt FROM alerts WHERE status='open'").get()).cnt;
  const acknowledged = (await db.prepare("SELECT COUNT(*) as cnt FROM alerts WHERE status='acknowledged'").get()).cnt;
  const resolved = (await db.prepare("SELECT COUNT(*) as cnt FROM alerts WHERE status='resolved'").get()).cnt;
  const bySeverity = await db.prepare("SELECT severity, COUNT(*) as cnt FROM alerts WHERE status != 'resolved' GROUP BY severity").all();
  res.json({ total, open, acknowledged, resolved, bySeverity });
});

// Bulk endpoints — separate paths (not /:id/ack with id="bulk") so there's no route-matching
// ambiguity with the single-alert routes below. One activity_logs row per alert (not one summary
// row) — same per-entity granularity every other action in the app already logs at.
function parseIds(body) {
  const raw = Array.isArray(body?.ids) ? body.ids : [];
  return [...new Set(raw.map(Number).filter(n => Number.isInteger(n) && n > 0))];
}

router.post('/bulk-ack', requirePermission('alerts.write'), async (req, res) => {
  const ids = parseIds(req.body);
  if (!ids.length) return res.status(400).json({ error: 'Chưa chọn cảnh báo nào' });
  const placeholders = ids.map(() => '?').join(',');
  const alerts = await db.prepare(`SELECT id, title FROM alerts WHERE id IN (${placeholders}) AND status='open'`).all(...ids);
  if (alerts.length) {
    await db.prepare(`UPDATE alerts SET status='acknowledged', acked_at=CURRENT_TIMESTAMP WHERE id IN (${alerts.map(() => '?').join(',')})`).run(...alerts.map(a => a.id));
    for (const a of alerts) await logActivity(req.user, 'UPDATE', 'alert', a.id, a.title, 'Ghi nhận cảnh báo (hàng loạt)');
  }
  res.json({ message: 'OK', count: alerts.length });
});

router.post('/bulk-resolve', requirePermission('alerts.write'), async (req, res) => {
  const ids = parseIds(req.body);
  if (!ids.length) return res.status(400).json({ error: 'Chưa chọn cảnh báo nào' });
  const placeholders = ids.map(() => '?').join(',');
  const alerts = await db.prepare(`SELECT id, title FROM alerts WHERE id IN (${placeholders}) AND status != 'resolved'`).all(...ids);
  if (alerts.length) {
    await db.prepare(`UPDATE alerts SET status='resolved', resolved_at=CURRENT_TIMESTAMP WHERE id IN (${alerts.map(() => '?').join(',')})`).run(...alerts.map(a => a.id));
    for (const a of alerts) await logActivity(req.user, 'UPDATE', 'alert', a.id, a.title, 'Xử lý cảnh báo (hàng loạt)');
  }
  res.json({ message: 'OK', count: alerts.length });
});

router.post('/:id/ack', requirePermission('alerts.write'), async (req, res) => {
  const alert = await db.prepare('SELECT * FROM alerts WHERE id=?').get(req.params.id);
  if (!alert) return res.status(404).json({ error: 'Not found' });
  await db.prepare("UPDATE alerts SET status='acknowledged', acked_at=CURRENT_TIMESTAMP WHERE id=?").run(req.params.id);
  await logActivity(req.user, 'UPDATE', 'alert', req.params.id, alert.title, 'Ghi nhận cảnh báo');
  res.json({ message: 'Acknowledged' });
});

router.post('/:id/resolve', requirePermission('alerts.write'), async (req, res) => {
  const alert = await db.prepare('SELECT * FROM alerts WHERE id=?').get(req.params.id);
  if (!alert) return res.status(404).json({ error: 'Not found' });
  await db.prepare("UPDATE alerts SET status='resolved', resolved_at=CURRENT_TIMESTAMP WHERE id=?").run(req.params.id);
  await logActivity(req.user, 'UPDATE', 'alert', req.params.id, alert.title, 'Xử lý cảnh báo');
  res.json({ message: 'Resolved' });
});

router.delete('/:id', requirePermission('alerts.delete'), async (req, res) => {
  const alert = await db.prepare('SELECT title FROM alerts WHERE id=?').get(req.params.id);
  if (!alert) return res.status(404).json({ error: 'Not found' });
  await db.prepare('DELETE FROM alerts WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

module.exports = router;
