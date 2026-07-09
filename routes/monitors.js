const express = require('express');
const router = express.Router();
const db = require('../database');
const { requirePermission } = require('../auth');
const uptimeCollector = require('../uptime-collector');

async function computeUptimePct(monitorId, days) {
  const row = await db.prepare(`
    SELECT AVG(status='up') * 100 as pct, COUNT(*) as cnt FROM monitor_checks
    WHERE monitor_id = ? AND checked_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
  `).get(monitorId, days);
  return row.cnt > 0 ? Math.round(row.pct * 10) / 10 : null;
}

// cert_days_remaining is computed at read time (not stored) so it's never stale — a monitor
// checked yesterday still shows the correct "N days left" today.
async function withComputedFields(monitor) {
  const [uptime_24h, uptime_7d] = await Promise.all([
    computeUptimePct(monitor.id, 1),
    computeUptimePct(monitor.id, 7),
  ]);
  const cert_days_remaining = monitor.cert_expires_at
    ? Math.ceil((new Date(monitor.cert_expires_at).getTime() - Date.now()) / 86400000)
    : null;
  return { ...monitor, uptime_24h, uptime_7d, cert_days_remaining };
}

router.get('/', async (req, res) => {
  const monitors = await db.prepare('SELECT * FROM monitors ORDER BY name ASC').all();
  res.json(await Promise.all(monitors.map(withComputedFields)));
});

// Recent check history, oldest-first. Two response shapes depending on the query:
//  - `?limit=N` (or nothing) — plain array, unchanged from before. Feeds the Kuma-style heartbeat
//    bar (renderMonitorList()/loadHeartbeat()), which expects exactly this shape.
//  - `?hours=N` or `?from=..&to=..` — {points, uptime_pct, bucketed} for the response-time chart
//    (openMonitorDetail()/renderTimeSeriesChart()). Ranges over ~4h are bucketed server-side —
//    30 days at a 60s check interval is 43200 raw rows, far more than an SVG line chart should
//    ever try to plot — targeting ~150 points keeps the chart readable regardless of range length.
router.get('/:id/history', async (req, res) => {
  const { hours, from, to } = req.query;
  if (!hours && !from && !to) {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const history = await db.prepare(
      'SELECT status, status_code, response_ms, error, checked_at FROM monitor_checks WHERE monitor_id = ? ORDER BY checked_at DESC LIMIT ?'
    ).all(req.params.id, limit);
    return res.json(history.reverse());
  }

  const toDate = to ? new Date(to) : new Date();
  const fromDate = from ? new Date(from) : new Date(toDate.getTime() - Number(hours) * 3600000);
  if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) return res.status(400).json({ error: 'Khoảng thời gian không hợp lệ' });
  const rangeSeconds = Math.max(1, Math.round((toDate.getTime() - fromDate.getTime()) / 1000));
  // MySQL's time_zone=SYSTEM=Asia/Ho_Chi_Minh, so checked_at is stored as GMT+7 wall-clock strings,
  // not UTC — toISOString() would give UTC and silently include ~7h more data than requested (the
  // exact bug already fixed once in the frontend/collectors; same fix here: format in Vietnam time).
  const fromSql = fromDate.toLocaleString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' });

  const uptimeRow = await db.prepare(
    "SELECT AVG(status='up') * 100 as pct, COUNT(*) as cnt FROM monitor_checks WHERE monitor_id=? AND checked_at >= ?"
  ).get(req.params.id, fromSql);
  const uptime_pct = uptimeRow.cnt > 0 ? Math.round(uptimeRow.pct * 10) / 10 : null;

  if (rangeSeconds <= 4 * 3600) {
    const rows = await db.prepare(
      'SELECT checked_at as t, response_ms, status, error FROM monitor_checks WHERE monitor_id=? AND checked_at >= ? ORDER BY checked_at ASC'
    ).all(req.params.id, fromSql);
    return res.json({ points: rows.map(r => ({ t: r.t, response_ms: r.response_ms, up: r.status === 'up' ? 1 : 0, error: r.error })), uptime_pct, bucketed: false });
  }

  const bucketSeconds = Math.max(60, Math.floor(rangeSeconds / 150));
  const rows = await db.prepare(`
    SELECT FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(checked_at)/?)*?) as t, AVG(response_ms) as response_ms, MIN(status='up') as up, COUNT(*) as cnt
    FROM monitor_checks WHERE monitor_id=? AND checked_at >= ?
    GROUP BY t ORDER BY t ASC
  `).all(bucketSeconds, bucketSeconds, req.params.id, fromSql);
  res.json({ points: rows.map(r => ({ t: r.t, response_ms: r.response_ms != null ? Math.round(r.response_ms) : null, up: r.up })), uptime_pct, bucketed: true });
});

router.post('/', requirePermission('monitors.write'), async (req, res) => {
  const { name, url, keyword, keyword_type, check_interval_sec, timeout_sec, ignore_tls_errors, enabled } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'Thiếu tên hoặc URL' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'URL không hợp lệ' }); }
  const result = await db.prepare(`
    INSERT INTO monitors (name, url, keyword, keyword_type, check_interval_sec, timeout_sec, ignore_tls_errors, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, url, keyword || null, keyword_type || 'contains', check_interval_sec || 300, timeout_sec || 10, ignore_tls_errors ? 1 : 0, enabled === false ? 0 : 1);
  res.status(201).json({ id: result.lastInsertRowid, message: 'Monitor created' });
});

router.put('/:id', requirePermission('monitors.write'), async (req, res) => {
  const monitor = await db.prepare('SELECT id FROM monitors WHERE id=?').get(req.params.id);
  if (!monitor) return res.status(404).json({ error: 'Not found' });
  const { name, url, keyword, keyword_type, check_interval_sec, timeout_sec, ignore_tls_errors, enabled } = req.body;
  if (url) { try { new URL(url); } catch { return res.status(400).json({ error: 'URL không hợp lệ' }); } }
  await db.prepare(`
    UPDATE monitors SET name=?, url=?, keyword=?, keyword_type=?, check_interval_sec=?, timeout_sec=?, ignore_tls_errors=?, enabled=?, updated_at=CURRENT_TIMESTAMP WHERE id=?
  `).run(name, url, keyword || null, keyword_type || 'contains', check_interval_sec || 300, timeout_sec || 10, ignore_tls_errors ? 1 : 0, enabled === false ? 0 : 1, req.params.id);
  res.json({ message: 'Updated' });
});

router.delete('/:id', requirePermission('monitors.delete'), async (req, res) => {
  const monitor = await db.prepare('SELECT name FROM monitors WHERE id=?').get(req.params.id);
  if (!monitor) return res.status(404).json({ error: 'Not found' });
  await db.prepare('DELETE FROM monitor_checks WHERE monitor_id=?').run(req.params.id);
  await db.prepare('DELETE FROM monitors WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

router.post('/:id/check', requirePermission('monitors.write'), async (req, res) => {
  const monitor = await db.prepare('SELECT * FROM monitors WHERE id=?').get(req.params.id);
  if (!monitor) return res.status(404).json({ error: 'Not found' });
  const result = await uptimeCollector.checkMonitor(monitor);
  res.json(result);
});

module.exports = router;
