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
      'SELECT checked_at as t, response_ms, status, status_code, error FROM monitor_checks WHERE monitor_id=? AND checked_at >= ? ORDER BY checked_at ASC'
    ).all(req.params.id, fromSql);
    // severity: 1=up (2xx/3xx, or up with no code at all for tcp/ping), 2=warn (4xx — reached but
    // rejected), 3=down (5xx, or down with no code — connection failure/timeout). The chart
    // (renderStatusCodeChart) colors purely off this, not response_ms — see routes/monitors.js's
    // own header comment on why: an admin asked for "200 = alive, 50x = dead", not a latency graph.
    const severityOf = (r) => {
      if (r.status_code != null) return r.status_code >= 500 ? 3 : r.status_code >= 400 ? 2 : 1;
      return r.status === 'up' ? 1 : 3;
    };
    return res.json({
      points: rows.map(r => ({ t: r.t, response_ms: r.response_ms, up: r.status === 'up' ? 1 : 0, status_code: r.status_code, severity: severityOf(r), error: r.error })),
      uptime_pct, bucketed: false,
    });
  }

  const bucketSeconds = Math.max(60, Math.floor(rangeSeconds / 150));
  // severity aggregate mirrors severityOf() above but as a SQL CASE/MAX — worst-case wins per bucket
  // (same reasoning as the pre-existing MIN(status='up'): one 5xx in a bucket should show the bucket
  // as down, not get averaged away).
  const rows = await db.prepare(`
    SELECT FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(checked_at)/?)*?) as t, AVG(response_ms) as response_ms, MIN(status='up') as up,
      MAX(CASE WHEN status_code >= 500 THEN 3 WHEN status_code >= 400 THEN 2 WHEN status_code IS NULL AND status != 'up' THEN 3 ELSE 1 END) as severity,
      COUNT(*) as cnt
    FROM monitor_checks WHERE monitor_id=? AND checked_at >= ?
    GROUP BY t ORDER BY t ASC
  `).all(bucketSeconds, bucketSeconds, req.params.id, fromSql);
  res.json({ points: rows.map(r => ({ t: r.t, response_ms: r.response_ms != null ? Math.round(r.response_ms) : null, up: r.up, severity: r.severity })), uptime_pct, bucketed: true });
});

// Hostnames, IPv4, IPv6 only — rejects shell metacharacters as defense-in-depth. Not strictly
// required for safety (uptime-collector.js's net.createConnection and the `ping` package's
// array-based child_process.spawn both take host as a plain argument, never shell-interpolated),
// but matches this app's established discipline of validating anything that flows toward a network
// operation against a strict charset before it's ever stored.
const SAFE_HOST_RE = /^[A-Za-z0-9.\-:_]+$/;
const MONITOR_TYPES = new Set(['http', 'tcp', 'ping']);

// expected_status_code is HTTP-only and optional — empty/undefined means "keep the default 2xx/3xx
// range" (stored as null), not an error. Returns { value } on success or { error } on a genuinely
// invalid (non-empty, out-of-range) input.
function validateExpectedStatusCode(raw) {
  if (raw === undefined || raw === null || raw === '') return { value: null };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 100 || n > 599) return { error: 'Mã trạng thái mong đợi không hợp lệ — phải từ 100 đến 599' };
  return { value: n };
}

// Shared by POST/PUT — type determines which fields are actually required. url stays '' (not null)
// for non-http types since the column is NOT NULL (see database.js's comment on why it wasn't
// relaxed). Returns { clean } on success or { error } on the first validation failure.
function validateMonitorInput(body) {
  const type = MONITOR_TYPES.has(body.type) ? body.type : 'http';
  if (type === 'http') {
    if (!body.url) return { error: 'Thiếu URL' };
    try { new URL(body.url); } catch { return { error: 'URL không hợp lệ' }; }
    const { value: expected_status_code, error } = validateExpectedStatusCode(body.expected_status_code);
    if (error) return { error };
    return { clean: { type, url: body.url, host: null, port: null, expected_status_code } };
  }
  const host = typeof body.host === 'string' ? body.host.trim() : '';
  if (!host || !SAFE_HOST_RE.test(host)) return { error: 'Host không hợp lệ (chỉ gồm chữ, số, dấu chấm, gạch ngang, hai chấm)' };
  if (type === 'tcp') {
    const port = Number(body.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'Cổng (port) không hợp lệ — phải từ 1 đến 65535' };
    return { clean: { type, url: '', host, port, expected_status_code: null } };
  }
  return { clean: { type, url: '', host, port: null, expected_status_code: null } }; // ping
}

router.post('/', requirePermission('monitors.write'), async (req, res) => {
  const { name, keyword, keyword_type, check_interval_sec, timeout_sec, ignore_tls_errors, enabled } = req.body;
  if (!name) return res.status(400).json({ error: 'Thiếu tên' });
  const { clean, error } = validateMonitorInput(req.body);
  if (error) return res.status(400).json({ error });
  const result = await db.prepare(`
    INSERT INTO monitors (name, type, url, host, port, expected_status_code, keyword, keyword_type, check_interval_sec, timeout_sec, ignore_tls_errors, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, clean.type, clean.url, clean.host, clean.port, clean.expected_status_code, keyword || null, keyword_type || 'contains', check_interval_sec || 300, timeout_sec || 10, ignore_tls_errors ? 1 : 0, enabled === false ? 0 : 1);
  res.status(201).json({ id: result.lastInsertRowid, message: 'Monitor created' });
});

router.put('/:id', requirePermission('monitors.write'), async (req, res) => {
  const monitor = await db.prepare('SELECT id FROM monitors WHERE id=?').get(req.params.id);
  if (!monitor) return res.status(404).json({ error: 'Not found' });
  const { name, keyword, keyword_type, check_interval_sec, timeout_sec, ignore_tls_errors, enabled } = req.body;
  const { clean, error } = validateMonitorInput(req.body);
  if (error) return res.status(400).json({ error });
  await db.prepare(`
    UPDATE monitors SET name=?, type=?, url=?, host=?, port=?, expected_status_code=?, keyword=?, keyword_type=?, check_interval_sec=?, timeout_sec=?, ignore_tls_errors=?, enabled=?, updated_at=CURRENT_TIMESTAMP WHERE id=?
  `).run(name, clean.type, clean.url, clean.host, clean.port, clean.expected_status_code, keyword || null, keyword_type || 'contains', check_interval_sec || 300, timeout_sec || 10, ignore_tls_errors ? 1 : 0, enabled === false ? 0 : 1, req.params.id);
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
