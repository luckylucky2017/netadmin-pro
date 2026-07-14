const express = require('express');
const router = express.Router();
const db = require('../database');
const { requirePermission, logActivity } = require('../auth');
const wafManager = require('../waf-manager');

router.get('/events', async (req, res) => {
  const { vmId, eventType, search, limit } = req.query;
  let query = 'SELECT * FROM waf_events WHERE 1=1';
  const params = [];
  if (vmId) { query += ' AND vm_id = ?'; params.push(vmId); }
  if (eventType) { query += ' AND event_type = ?'; params.push(eventType); }
  if (search) { query += ' AND (vm_name LIKE ? OR src_ip LIKE ? OR path LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  query += ' ORDER BY occurred_at DESC LIMIT ?';
  params.push(Math.min(Number(limit) || 200, 1000));
  res.json(await db.prepare(query).all(...params));
});

router.get('/stats', async (req, res) => {
  const since = 'DATE_SUB(NOW(), INTERVAL 24 HOUR)';
  const scan = (await db.prepare(`SELECT COUNT(*) as cnt FROM waf_events WHERE event_type='scan' AND occurred_at >= ${since}`).get()).cnt;
  const dos = (await db.prepare(`SELECT COUNT(*) as cnt FROM waf_events WHERE event_type='dos' AND occurred_at >= ${since}`).get()).cnt;
  const ddos = (await db.prepare(`SELECT COUNT(*) as cnt FROM waf_events WHERE event_type='ddos' AND occurred_at >= ${since}`).get()).cnt;
  // COUNT(DISTINCT vm_id, src_ip), not COUNT(*) — the same IP can get a fresh blocked=1 event logged
  // on a later poll (still detected in the log for a beat after the real fail2ban ban lands), which
  // would otherwise double-count 1 blocked IP as 2+ toward this stat.
  const blocked = (await db.prepare(`SELECT COUNT(DISTINCT vm_id, src_ip) as cnt FROM waf_events WHERE blocked=1 AND occurred_at >= ${since}`).get()).cnt;
  const monitored = (await db.prepare('SELECT COUNT(*) as cnt FROM vcenter_vms WHERE waf_enabled = 1').get()).cnt;

  // Backs the DoS/DDoS/IP đã chặn/VM đang giám sát stat cards' hover lists on the frontend — same
  // underlying condition as each count above, just the actual rows instead of only a number. Each
  // capped at 50 (a hover list isn't meant to replace the "Sự kiện"/"Quản lý giám sát" tabs, which
  // already cover the full data) — the *count* fields above stay their own separate COUNT(*)/GROUP
  // BY queries, never derived from list.length, so none of the headline numbers silently cap at 50.
  const dosList = await db.prepare(`
    SELECT vm_name, domain, src_ip, country, hit_count, occurred_at FROM waf_events
    WHERE event_type='dos' AND occurred_at >= ${since} ORDER BY occurred_at DESC LIMIT 50
  `).all();
  const ddosList = await db.prepare(`
    SELECT vm_name, domain, hit_count, occurred_at FROM waf_events
    WHERE event_type='ddos' AND occurred_at >= ${since} ORDER BY occurred_at DESC LIMIT 50
  `).all();
  // MAX(vm_name)/MAX(country) here is safe per (vm_id, src_ip) group, same reasoning as
  // routes/reports.js's equivalent — both are deterministic given the group key, never genuinely
  // mixed within one bucket; just needed to satisfy ONLY_FULL_GROUP_BY.
  const blockedList = await db.prepare(`
    SELECT vm_id, MAX(vm_name) as vm_name, src_ip, MAX(country) as country, MAX(occurred_at) as last_seen
    FROM waf_events WHERE blocked=1 AND occurred_at >= ${since}
    GROUP BY vm_id, src_ip ORDER BY last_seen DESC LIMIT 50
  `).all();
  const monitoredList = await db.prepare(`
    SELECT name, waf_auto_block, waf_jail_status FROM vcenter_vms WHERE waf_enabled = 1 ORDER BY name ASC LIMIT 50
  `).all();

  res.json({ scan, dos, ddos, blocked, monitored, dosList, ddosList, blockedList, monitoredList });
});

// VMs list for "Quản lý giám sát": which are eligible (have an SSH credential + IP — assigned on
// the "Giám sát bất thường" → "Quản lý VM giám sát" tab, reused as-is here, no separate credential
// picker on this page) and which are currently opted into WAF.
router.get('/vms', async (req, res) => {
  const vms = await db.prepare(`
    SELECT id, moref, name, power_state, ip_address, guest_family, ssh_credential_id, ssh_user, ssh_port,
           waf_enabled, waf_log_path, waf_auto_block, waf_trust_xff, waf_jail_status, waf_jail_checked_at, waf_jail_error
    FROM vcenter_vms ORDER BY name ASC
  `).all();
  res.json(vms);
});

// Domains/log files discovered from this VM's /etc/nginx config by the last collector poll — for
// the "Quản lý giám sát" tab to show what's actually being tailed, since one VM commonly serves
// several domains each with its own access_log.
router.get('/vms/:id/domains', async (req, res) => {
  const rows = await db.prepare(`
    SELECT id, domain, log_path, conf_file, discovered_at FROM waf_domain_logs WHERE vm_id = ? ORDER BY domain ASC
  `).all(req.params.id);
  res.json(rows);
});

// Same MySQL time_zone=SYSTEM=Asia/Ho_Chi_Minh reasoning as routes/reports.js — the `day` column in
// waf_traffic_daily/waf_traffic_top is stamped by nginx-waf-collector.js from each batch's own
// VN-local wall-clock date (toSqlDatetime().slice(0,10)), so the report's own date-range boundary
// must use the same VN-local "today", not UTC (Date.prototype.toISOString() would land on the wrong
// calendar day for anyone querying before 07:00 local time).
function toVnDate(date) { return date.toLocaleString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' }).slice(0, 10); }

const TRAFFIC_MAX_DAYS = 90;
const TRAFFIC_TOP_LIMIT = 15;

// Read-only rollup over waf_traffic_daily/waf_traffic_top (see database.js/nginx-waf-collector.js
// for how these are populated) — a lightweight, Webalizer-style traffic report scoped to what's
// actionable for infra/security admins: request/bandwidth trend, top pages/IPs/countries, grouped
// browser/OS breakdown, error rate. Not a full analytics clone (no session/path-through-site
// tracking, no per-browser-version breakdown) — see the plan discussion for why that scope was
// deliberately dropped.
router.get('/traffic', async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 7, 1), TRAFFIC_MAX_DAYS);
  const vmId = req.query.vmId ? Number(req.query.vmId) : null;
  const domain = req.query.domain != null ? req.query.domain : null; // '' is a valid value (the no-domain-discovered fallback)
  const now = new Date();
  const untilDate = toVnDate(now);
  const sinceDate = toVnDate(new Date(now.getTime() - (days - 1) * 86400000));

  const scope = ['day >= ?', 'day <= ?'];
  const scopeParams = [sinceDate, untilDate];
  if (vmId) { scope.push('vm_id = ?'); scopeParams.push(vmId); }
  if (domain !== null) { scope.push('domain = ?'); scopeParams.push(domain); }
  const whereClause = scope.join(' AND ');

  const dailyRows = await db.prepare(`
    SELECT day, SUM(request_count) as request_count, SUM(bytes_sum) as bytes_sum,
           SUM(status_2xx) as status_2xx, SUM(status_3xx) as status_3xx, SUM(status_4xx) as status_4xx, SUM(status_5xx) as status_5xx
    FROM waf_traffic_daily WHERE ${whereClause} GROUP BY day ORDER BY day ASC
  `).all(...scopeParams);

  const dateRange = [];
  for (let i = 0; i < days; i++) dateRange.push(toVnDate(new Date(new Date(sinceDate).getTime() + i * 86400000)));
  const byDay = new Map(dailyRows.map(r => [String(r.day).slice(0, 10), r]));
  const timeline = {
    dates: dateRange,
    requests: dateRange.map(d => Number(byDay.get(d)?.request_count) || 0),
    bytes: dateRange.map(d => Number(byDay.get(d)?.bytes_sum) || 0),
    errors4xx: dateRange.map(d => Number(byDay.get(d)?.status_4xx) || 0),
    errors5xx: dateRange.map(d => Number(byDay.get(d)?.status_5xx) || 0),
  };

  const summary = dailyRows.reduce((acc, r) => ({
    requests: acc.requests + Number(r.request_count),
    bytes: acc.bytes + Number(r.bytes_sum),
    status2xx: acc.status2xx + Number(r.status_2xx),
    status3xx: acc.status3xx + Number(r.status_3xx),
    status4xx: acc.status4xx + Number(r.status_4xx),
    status5xx: acc.status5xx + Number(r.status_5xx),
  }), { requests: 0, bytes: 0, status2xx: 0, status3xx: 0, status4xx: 0, status5xx: 0 });

  const topFor = async (statType) => (await db.prepare(`
    SELECT stat_key as \`key\`, SUM(hit_count) as hits, SUM(bytes_sum) as bytes
    FROM waf_traffic_top WHERE ${whereClause} AND stat_type = ?
    GROUP BY stat_key ORDER BY hits DESC LIMIT ${TRAFFIC_TOP_LIMIT}
  `).all(...scopeParams, statType)).map(r => ({ key: r.key, hits: Number(r.hits), bytes: Number(r.bytes) }));

  const [topPaths, topIps, topCountries, topBrowsers, topOs] = await Promise.all(
    ['path', 'ip', 'country', 'browser', 'os'].map(topFor)
  );

  res.json({
    range: { days, since: sinceDate, until: untilDate },
    summary, timeline,
    topPaths, topIps, topCountries, topBrowsers, topOs,
  });
});

const SAFE_LOG_PATH_RE = wafManager.SAFE_LOG_PATH_RE;

router.patch('/vms/:id', requirePermission('waf.manage'), async (req, res) => {
  const vm = await db.prepare('SELECT id, name FROM vcenter_vms WHERE id = ?').get(req.params.id);
  if (!vm) return res.status(404).json({ error: 'Không tìm thấy VM' });
  const enabled = req.body?.enabled ? 1 : 0;
  const logPath = String(req.body?.logPath || '/var/log/nginx/access.log').trim();
  const autoBlock = req.body?.autoBlock ? 1 : 0;
  const trustXff = req.body?.trustXff ? 1 : 0;
  if (enabled && !SAFE_LOG_PATH_RE.test(logPath)) {
    return res.status(400).json({ error: 'Đường dẫn log không hợp lệ — phải là đường dẫn tuyệt đối, chỉ gồm chữ/số/_-./ ' });
  }
  await db.prepare('UPDATE vcenter_vms SET waf_enabled = ?, waf_log_path = ?, waf_auto_block = ?, waf_trust_xff = ? WHERE id = ?')
    .run(enabled, logPath, autoBlock, trustXff, vm.id);
  await logActivity(req.user, 'UPDATE', 'vcenter_vm', vm.id, vm.name,
    enabled
      ? `Bật giám sát WAF (log dự phòng: ${logPath}, tự động chặn: ${autoBlock ? 'bật' : 'tắt'}, tin X-Forwarded-For: ${trustXff ? 'bật' : 'tắt'})`
      : 'Tắt giám sát WAF');
  res.json({ message: 'OK' });
});

async function getWafVm(req, res) {
  // ssh_credential_id is what waf-manager.js's connect()/sshCredentials.buildConnectOptions actually
  // resolves the SSH connection from — mirrors routes/security.js's getMonitoredVm reasoning.
  // ssh_port MUST be selected too — buildConnectOptions() falls back to port 22 whenever
  // row.ssh_port is undefined, which silently broke every jail action for any VM configured with a
  // non-default SSH port (this row was missing it; caught via a real "not_installed"/timeout report
  // on a VM using port 6565).
  const vm = await db.prepare(`
    SELECT id, name, ip_address, ssh_credential_id, ssh_port, waf_log_path, waf_auto_block
    FROM vcenter_vms WHERE id = ?
  `).get(req.params.id);
  if (!vm) { res.status(404).json({ error: 'Không tìm thấy VM' }); return null; }
  if (!vm.ssh_credential_id || !vm.ip_address) { res.status(400).json({ error: 'VM này chưa có tài khoản kết nối SSH — cần cấu hình trước' }); return null; }
  return vm;
}

router.post('/vms/:id/jail/check', requirePermission('waf.jail.check'), async (req, res) => {
  const vm = await getWafVm(req, res);
  if (!vm) return;
  res.json(await wafManager.checkStatus(vm));
});

router.post('/vms/:id/jail/install', requirePermission('waf.jail.manage'), async (req, res) => {
  const vm = await getWafVm(req, res);
  if (!vm) return;
  res.json(await wafManager.installJail(vm, req.user));
});

router.post('/vms/:id/jail/stop', requirePermission('waf.jail.manage'), async (req, res) => {
  const vm = await getWafVm(req, res);
  if (!vm) return;
  res.json(await wafManager.stopJail(vm, req.user));
});

// Aggregated "IP đang bị chặn" tab — DB-backed (waf_banned_ips, synced every collector poll), not a
// live SSH call, so this stays fast regardless of how many VMs are monitored. The "reason blocked"
// context (event_types, total_hits, sample_paths) is aggregated across EVERY waf_events row ever
// recorded for that (vm, ip) — not just the latest — so a repeat offender's full pattern is visible,
// not just its most recent hit. Best-effort: all null if the IP was blocked manually with no prior
// detected event. sample_paths caps at 8 distinct paths via SUBSTRING_INDEX-on-GROUP_CONCAT (the
// standard MySQL "top N of a GROUP_CONCAT" trick — avoids an unbounded string for a long-running
// repeat offender with hundreds of distinct probed URLs).
router.get('/banned-ips', async (req, res) => {
  const rows = await db.prepare(`
    SELECT b.vm_id, v.name AS vm_name, b.ip, b.first_seen, b.last_seen,
           agg.country, agg.event_types, agg.attack_categories, agg.total_hits, agg.event_count, agg.sample_paths
    FROM waf_banned_ips b
    JOIN vcenter_vms v ON v.id = b.vm_id
    LEFT JOIN (
      SELECT vm_id, src_ip,
        SUBSTRING_INDEX(GROUP_CONCAT(country ORDER BY occurred_at DESC SEPARATOR ','), ',', 1) AS country,
        GROUP_CONCAT(DISTINCT event_type ORDER BY event_type SEPARATOR ', ') AS event_types,
        GROUP_CONCAT(DISTINCT attack_category ORDER BY attack_category SEPARATOR ', ') AS attack_categories,
        SUM(hit_count) AS total_hits,
        COUNT(*) AS event_count,
        SUBSTRING_INDEX(GROUP_CONCAT(DISTINCT path ORDER BY occurred_at DESC SEPARATOR '|||'), '|||', 8) AS sample_paths
      FROM waf_events
      GROUP BY vm_id, src_ip
    ) agg ON agg.vm_id = b.vm_id AND agg.src_ip = b.ip
    ORDER BY b.last_seen DESC
  `).all();
  res.json(rows);
});

router.get('/vms/:id/banned-ips', requirePermission('waf.jail.check'), async (req, res) => {
  const vm = await getWafVm(req, res);
  if (!vm) return;
  res.json(await wafManager.listBannedIps(vm));
});

router.post('/vms/:id/block-ip', requirePermission('waf.block'), async (req, res) => {
  const vm = await getWafVm(req, res);
  if (!vm) return;
  const ip = String(req.body?.ip || '').trim();
  if (!ip) return res.status(400).json({ error: 'Thiếu địa chỉ IP' });
  const result = await wafManager.banIp(vm, ip);
  if (result.ok) {
    await db.prepare(`
      INSERT INTO waf_events (vm_id, vm_name, event_type, src_ip, blocked, occurred_at)
      VALUES (?, ?, 'manual_block', ?, 1, CURRENT_TIMESTAMP)
    `).run(vm.id, vm.name, ip);
    await logActivity(req.user, 'UPDATE', 'vcenter_vm', vm.id, vm.name, `Chặn thủ công IP ${ip} qua WAF`);
  }
  res.json(result);
});

router.post('/vms/:id/unblock-ip', requirePermission('waf.block'), async (req, res) => {
  const vm = await getWafVm(req, res);
  if (!vm) return;
  const ip = String(req.body?.ip || '').trim();
  if (!ip) return res.status(400).json({ error: 'Thiếu địa chỉ IP' });
  const result = await wafManager.unbanIp(vm, ip);
  if (result.ok) await logActivity(req.user, 'UPDATE', 'vcenter_vm', vm.id, vm.name, `Gỡ chặn IP ${ip} khỏi WAF`);
  res.json(result);
});

// ── IP exceptions (global allowlist — see waf-manager.js's banIp, checked before every ban) ────
function isValidExceptionIp(value) {
  const cidrM = /^(.+)\/(\d{1,3})$/.exec(value);
  const base = cidrM ? cidrM[1] : value;
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(base)) {
    if (!base.split('.').every(o => Number(o) <= 255)) return false;
    if (cidrM && (Number(cidrM[2]) < 0 || Number(cidrM[2]) > 32)) return false;
    return true;
  }
  // Bare IPv6 only — no CIDR support for v6 (matchesException treats it as exact-match anyway).
  if (!cidrM && /^[0-9a-fA-F:]+$/.test(value) && value.includes(':')) return true;
  return false;
}

router.get('/exceptions', async (req, res) => {
  res.json(await db.prepare('SELECT * FROM waf_ip_exceptions ORDER BY created_at DESC').all());
});

router.post('/exceptions', requirePermission('waf.block'), async (req, res) => {
  const ip = String(req.body?.ip || '').trim();
  const note = String(req.body?.note || '').trim().slice(0, 255) || null;
  if (!isValidExceptionIp(ip)) {
    return res.status(400).json({ error: 'IP/CIDR không hợp lệ — dùng dạng "203.0.113.5" hoặc "203.0.113.0/24" (IPv4) hoặc địa chỉ IPv6 đầy đủ' });
  }
  try {
    await db.prepare('INSERT INTO waf_ip_exceptions (ip, note, created_by) VALUES (?, ?, ?)').run(ip, note, req.user.name || req.user.email);
  } catch (e) {
    if (e.errno === 1062) return res.status(400).json({ error: 'IP/CIDR này đã có trong danh sách ngoại lệ' });
    throw e;
  }
  await logActivity(req.user, 'CREATE', 'waf_ip_exception', null, ip, `Thêm ngoại lệ IP WAF: ${ip}${note ? ' — ' + note : ''}`);
  // Best-effort: proactively unban this IP on every VM whose jail is currently running, so adding
  // an exception for an already-banned false positive takes effect immediately rather than only
  // preventing future bans. One VM's SSH failure must never block the others. Also pushes the
  // updated exceptions list into fail2ban's own `ignoreip` on each VM (see waf-manager.js's
  // pushIgnoreIp) — real defense-in-depth value is limited for this particular jail (its filter
  // never matches anything, so every ban is this app's own explicit banip call, which bypasses
  // ignoreip — confirmed live), kept for consistency with the sshd jail where it does matter.
  const vms = await db.prepare(`
    SELECT id, name, ip_address, ssh_credential_id, ssh_port FROM vcenter_vms
    WHERE waf_jail_status = 'running' AND ssh_credential_id IS NOT NULL
  `).all();
  await Promise.allSettled(vms.map(vm => wafManager.unbanIp(vm, ip)));
  await Promise.allSettled(vms.map(vm => wafManager.pushIgnoreIp(vm)));
  res.json({ message: 'OK' });
});

router.delete('/exceptions/:id', requirePermission('waf.block'), async (req, res) => {
  const row = await db.prepare('SELECT * FROM waf_ip_exceptions WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Không tìm thấy' });
  await db.prepare('DELETE FROM waf_ip_exceptions WHERE id = ?').run(row.id);
  await logActivity(req.user, 'DELETE', 'waf_ip_exception', row.id, row.ip, `Xóa ngoại lệ IP WAF: ${row.ip}`);
  // Push the updated (now-shorter) exceptions list to every running WAF jail so the removed IP
  // stops being ignored — see the POST handler's comment above.
  const vms = await db.prepare(`
    SELECT id, name, ip_address, ssh_credential_id, ssh_port FROM vcenter_vms
    WHERE waf_jail_status = 'running' AND ssh_credential_id IS NOT NULL
  `).all();
  await Promise.allSettled(vms.map(vm => wafManager.pushIgnoreIp(vm)));
  res.json({ message: 'OK' });
});

module.exports = router;
