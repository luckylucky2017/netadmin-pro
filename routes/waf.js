const express = require('express');
const router = express.Router();
const db = require('../database');
const { requirePermission, logActivity } = require('../auth');
const wafManager = require('../waf-manager');
const fail2banConfig = require('../fail2ban-config');
const wafScheduledBlock = require('../waf-scheduled-ip-block');

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
  // top_ips (JSON, see database.js's waf_events comment) is parsed here rather than left as a raw
  // string — a malformed/legacy-null value degrades to an empty array instead of the frontend
  // having to defensively JSON.parse untrusted DB content itself.
  const ddosListRaw = await db.prepare(`
    SELECT vm_name, domain, hit_count, occurred_at, top_ips FROM waf_events
    WHERE event_type='ddos' AND occurred_at >= ${since} ORDER BY occurred_at DESC LIMIT 50
  `).all();
  const ddosList = ddosListRaw.map((r) => {
    let topIps = [];
    try { topIps = r.top_ips ? JSON.parse(r.top_ips) : []; } catch { /* legacy/malformed row — treat as no data */ }
    return { vm_name: r.vm_name, domain: r.domain, hit_count: r.hit_count, occurred_at: r.occurred_at, topIps };
  });
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
           waf_enabled, waf_log_path, waf_auto_block, waf_trust_xff, waf_jail_status, waf_jail_checked_at, waf_jail_error,
           crowdsec_machine_id, crowdsec_auto_block
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
  const vm = await db.prepare(`
    SELECT id, name, waf_enabled, waf_log_path, waf_auto_block, waf_trust_xff, crowdsec_machine_id, crowdsec_auto_block
    FROM vcenter_vms WHERE id = ?
  `).get(req.params.id);
  if (!vm) return res.status(404).json({ error: 'Không tìm thấy VM' });
  // Every field falls back to the VM's CURRENT value when the request body omits it — this route is
  // shared by 2 different save actions in the UI (the main "Quản lý giám sát" row, which always sends
  // every waf_* field, and the CrowdSec-only modal, which only ever sends crowdsecMachineId/
  // crowdsecAutoBlock) — without this fallback, saving from the CrowdSec modal would silently reset
  // waf_enabled/waf_auto_block/waf_log_path/waf_trust_xff back to off/default.
  const enabled = req.body?.enabled != null ? (req.body.enabled ? 1 : 0) : vm.waf_enabled;
  const logPath = req.body?.logPath != null ? String(req.body.logPath).trim() : (vm.waf_log_path || '/var/log/nginx/access.log');
  const autoBlock = req.body?.autoBlock != null ? (req.body.autoBlock ? 1 : 0) : vm.waf_auto_block;
  const trustXff = req.body?.trustXff != null ? (req.body.trustXff ? 1 : 0) : vm.waf_trust_xff;
  // CrowdSec fields are independent of the waf_* ones above (a VM can run the old detector, the
  // CrowdSec agent, both, or neither) — crowdsecMachineId is set once, by hand, after registering the
  // VM's agent on the hub (see crowdsec-collector.js's header comment); '' clears it back to unmapped.
  const crowdsecMachineId = req.body?.crowdsecMachineId != null ? String(req.body.crowdsecMachineId).trim().slice(0, 64) : vm.crowdsec_machine_id;
  const crowdsecAutoBlock = req.body?.crowdsecAutoBlock != null ? (req.body.crowdsecAutoBlock ? 1 : 0) : vm.crowdsec_auto_block;
  if (enabled && !SAFE_LOG_PATH_RE.test(logPath)) {
    return res.status(400).json({ error: 'Đường dẫn log không hợp lệ — phải là đường dẫn tuyệt đối, chỉ gồm chữ/số/_-./ ' });
  }
  await db.prepare('UPDATE vcenter_vms SET waf_enabled = ?, waf_log_path = ?, waf_auto_block = ?, waf_trust_xff = ?, crowdsec_machine_id = ?, crowdsec_auto_block = ? WHERE id = ?')
    .run(enabled, logPath, autoBlock, trustXff, crowdsecMachineId || null, crowdsecAutoBlock, vm.id);
  await logActivity(req.user, 'UPDATE', 'vcenter_vm', vm.id, vm.name,
    enabled
      ? `Bật giám sát WAF (log dự phòng: ${logPath}, tự động chặn: ${autoBlock ? 'bật' : 'tắt'}, tin X-Forwarded-For: ${trustXff ? 'bật' : 'tắt'})`
      : 'Tắt giám sát WAF');
  res.json({ message: 'OK' });
});

// Where crowdsec-collector.js reaches the CrowdSec LAPI hub — see database.js's crowdsec_settings
// comment. machine_password never leaves the server (redacted to its last 4 chars), same convention
// as ssh_credentials.password elsewhere in this app.
router.get('/crowdsec/settings', requirePermission('waf.manage'), async (req, res) => {
  const row = await db.prepare('SELECT lapi_url, machine_id, machine_password, last_alert_id FROM crowdsec_settings WHERE id = 1').get();
  res.json({
    lapiUrl: row?.lapi_url || '',
    machineId: row?.machine_id || '',
    machinePasswordSet: !!row?.machine_password,
    machinePasswordPreview: row?.machine_password ? `••••${row.machine_password.slice(-4)}` : '',
    lastAlertId: row?.last_alert_id || 0,
  });
});

router.patch('/crowdsec/settings', requirePermission('waf.manage'), async (req, res) => {
  const lapiUrl = String(req.body?.lapiUrl || '').trim().replace(/\/+$/, '');
  const machineId = String(req.body?.machineId || '').trim();
  const machinePassword = req.body?.machinePassword != null ? String(req.body.machinePassword) : undefined;
  if (lapiUrl && !/^https?:\/\//.test(lapiUrl)) {
    return res.status(400).json({ error: 'LAPI URL phải bắt đầu bằng http:// hoặc https://' });
  }
  if (machinePassword !== undefined) {
    await db.prepare('UPDATE crowdsec_settings SET lapi_url = ?, machine_id = ?, machine_password = ? WHERE id = 1')
      .run(lapiUrl || null, machineId || null, machinePassword || null);
  } else {
    // Password field left blank in the form — keep whatever's already stored, only update url/id.
    await db.prepare('UPDATE crowdsec_settings SET lapi_url = ?, machine_id = ? WHERE id = 1').run(lapiUrl || null, machineId || null);
  }
  await logActivity(req.user, 'UPDATE', 'crowdsec_settings', 1, 'CrowdSec', `Cập nhật cấu hình CrowdSec LAPI (${lapiUrl || 'trống'})`);
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
           agg.country, agg.event_types, agg.attack_categories, agg.total_hits, agg.event_count, agg.domains, agg.sample_paths
    FROM waf_banned_ips b
    JOIN vcenter_vms v ON v.id = b.vm_id
    LEFT JOIN (
      SELECT vm_id, src_ip,
        SUBSTRING_INDEX(GROUP_CONCAT(country ORDER BY occurred_at DESC SEPARATOR ','), ',', 1) AS country,
        GROUP_CONCAT(DISTINCT event_type ORDER BY event_type SEPARATOR ', ') AS event_types,
        GROUP_CONCAT(DISTINCT attack_category ORDER BY attack_category SEPARATOR ', ') AS attack_categories,
        SUM(hit_count) AS total_hits,
        COUNT(*) AS event_count,
        GROUP_CONCAT(DISTINCT COALESCE(NULLIF(domain, ''), '(không rõ domain)') ORDER BY domain SEPARATOR ', ') AS domains,
        SUBSTRING_INDEX(GROUP_CONCAT(DISTINCT path ORDER BY occurred_at DESC SEPARATOR '|||'), '|||', 8) AS sample_paths
      FROM waf_events
      GROUP BY vm_id, src_ip
    ) agg ON agg.vm_id = b.vm_id AND agg.src_ip = b.ip
    ORDER BY b.last_seen DESC
  `).all();
  // Same "permanent vs temporary" derivation as routes/security.js's GET /banned-ips — see comment
  // there. waf_bantime_sec = -1 means permanent.
  const vmIds = [...new Set(rows.map((r) => r.vm_id))];
  const configs = new Map(await Promise.all(vmIds.map(async (id) => [id, await fail2banConfig.getEffectiveConfig(id)])));
  for (const r of rows) {
    const bantimeSec = configs.get(r.vm_id)?.waf_bantime_sec ?? -1;
    r.bantime_sec = bantimeSec;
    r.permanent = bantimeSec === -1;
  }
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

// Bulk "temporary unblock" for VN-country banned IPs, scoped to the "IP đang bị chặn" tab. Same
// unbanIp semantics as the single-IP button above (fail2ban unbanip — not an exception, so a VN IP
// that re-triggers real detection gets re-banned normally). One SSH connection per affected VM
// (not per IP) via unbanIpViaSsh, since a VM can have dozens of VN IPs banned at once.
router.post('/banned-ips/unblock-vn', requirePermission('waf.block'), async (req, res) => {
  const rows = await db.prepare(`
    SELECT b.vm_id, v.name AS vm_name, b.ip, agg.country
    FROM waf_banned_ips b
    JOIN vcenter_vms v ON v.id = b.vm_id
    LEFT JOIN (
      SELECT vm_id, src_ip,
        SUBSTRING_INDEX(GROUP_CONCAT(country ORDER BY occurred_at DESC SEPARATOR ','), ',', 1) AS country
      FROM waf_events
      GROUP BY vm_id, src_ip
    ) agg ON agg.vm_id = b.vm_id AND agg.src_ip = b.ip
    WHERE agg.country = 'VN'
  `).all();

  if (!rows.length) return res.json({ message: 'Không có IP Việt Nam nào đang bị chặn', count: 0, total: 0, results: [] });

  const byVm = new Map();
  for (const r of rows) {
    if (!byVm.has(r.vm_id)) byVm.set(r.vm_id, { vm_name: r.vm_name, ips: [] });
    byVm.get(r.vm_id).ips.push(r.ip);
  }
  const vmIds = [...byVm.keys()];
  const vms = await db.prepare(`
    SELECT id, name, ip_address, ssh_credential_id, ssh_port FROM vcenter_vms
    WHERE id IN (${vmIds.map(() => '?').join(',')})
  `).all(...vmIds);

  const results = [];
  for (const vm of vms) {
    const { ips } = byVm.get(vm.id);
    let ssh;
    try {
      ssh = await wafManager.connect(vm);
      for (const ip of ips) {
        const r = await wafManager.unbanIpViaSsh(ssh, ip).catch((e) => ({ ok: false, error: e.message }));
        results.push({ vm_id: vm.id, vm_name: vm.name, ip, ok: r.ok, error: r.error });
      }
    } catch (e) {
      for (const ip of ips) results.push({ vm_id: vm.id, vm_name: vm.name, ip, ok: false, error: `Không kết nối được SSH: ${e.message}` });
    } finally {
      if (ssh) ssh.dispose();
    }
  }

  const successCount = results.filter((r) => r.ok).length;
  for (const vm of vms) {
    const okIps = results.filter((r) => r.vm_id === vm.id && r.ok).map((r) => r.ip);
    if (okIps.length) await logActivity(req.user, 'UPDATE', 'vcenter_vm', vm.id, vm.name, `Gỡ chặn tạm thời ${okIps.length} IP Việt Nam khỏi WAF: ${okIps.join(', ')}`);
  }
  res.json({ message: 'OK', count: successCount, total: rows.length, results });
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
  const enabled = req.body?.enabled !== false;
  if (!isValidExceptionIp(ip)) {
    return res.status(400).json({ error: 'IP/CIDR không hợp lệ — dùng dạng "203.0.113.5" hoặc "203.0.113.0/24" (IPv4) hoặc địa chỉ IPv6 đầy đủ' });
  }
  try {
    await db.prepare('INSERT INTO waf_ip_exceptions (ip, note, enabled, created_by) VALUES (?, ?, ?, ?)').run(ip, note, enabled ? 1 : 0, req.user.name || req.user.email);
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

router.patch('/exceptions/:id', requirePermission('waf.block'), async (req, res) => {
  const row = await db.prepare('SELECT * FROM waf_ip_exceptions WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Không tìm thấy' });

  // Partial update: only touch fields actually provided, so a pure enable/disable toggle (from the
  // tab's switch, or waf-scheduled-ip-block.js's automation) doesn't also require re-sending ip/note.
  const fields = {};
  let ip = row.ip;
  if (req.body?.ip !== undefined) {
    ip = String(req.body.ip).trim();
    if (!isValidExceptionIp(ip)) {
      return res.status(400).json({ error: 'IP/CIDR không hợp lệ — dùng dạng "203.0.113.5" hoặc "203.0.113.0/24" (IPv4) hoặc địa chỉ IPv6 đầy đủ' });
    }
    fields.ip = ip;
  }
  if (req.body?.note !== undefined) fields.note = String(req.body.note || '').trim().slice(0, 255) || null;
  if (req.body?.enabled !== undefined) fields.enabled = req.body.enabled ? 1 : 0;

  const cols = Object.keys(fields);
  if (!cols.length) return res.status(400).json({ error: 'Không có trường nào để cập nhật' });
  try {
    await db.prepare(`UPDATE waf_ip_exceptions SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`)
      .run(...cols.map(c => fields[c]), row.id);
  } catch (e) {
    if (e.errno === 1062) return res.status(400).json({ error: 'IP/CIDR này đã có trong danh sách ngoại lệ' });
    throw e;
  }
  const detail = fields.enabled !== undefined
    ? `${fields.enabled ? 'Bật' : 'Tắt'} ngoại lệ IP WAF: ${row.ip}`
    : `Sửa ngoại lệ IP WAF: ${row.ip} → ${ip}${fields.note !== undefined ? ' — ' + (fields.note || '(xóa ghi chú)') : ''}`;
  await logActivity(req.user, 'UPDATE', 'waf_ip_exception', row.id, ip, detail);

  const vms = await db.prepare(`
    SELECT id, name, ip_address, ssh_credential_id, ssh_port FROM vcenter_vms
    WHERE waf_jail_status = 'running' AND ssh_credential_id IS NOT NULL
  `).all();
  // Unban now if: the IP text itself changed (a false positive being re-typed shouldn't wait for the
  // next ban attempt to clear), OR the exception was just turned back on (re-enabling should restore
  // access immediately, same as a brand-new exception would). A note-only edit or a disable skips this.
  if (fields.ip !== undefined && ip !== row.ip) await Promise.allSettled(vms.map(vm => wafManager.unbanIp(vm, ip)));
  else if (fields.enabled === 1) await Promise.allSettled(vms.map(vm => wafManager.unbanIp(vm, ip)));
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

// ── Scheduled per-IP time-of-day access windows ("Chặn theo giờ" tab) — see
// waf-scheduled-ip-block.js's header comment for the important VM-wide (not domain-scoped)
// enforcement caveat: fail2ban bans at the jail/VM level, so a VM hosting multiple domains blocks
// the IP from ALL of them, not just the one named in `domain` (a label, not an enforced scope).
function isValidTimeOfDay(value) {
  return /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(value || '');
}
function normalizeTimeOfDay(value) {
  return value.length === 5 ? `${value}:00` : value;
}
// Accepts an array of ISO weekday numbers (1=Mon..7=Sun) from the frontend's checkboxes, validates
// and normalizes to the sorted, deduped CSV string the DB column stores. null = not provided
// (leave unchanged on PATCH); empty array is rejected outright — a rule that applies on zero days
// would just silently never do anything, almost certainly a UI mistake rather than intent.
function parseDaysOfWeek(value) {
  if (!Array.isArray(value)) return { error: 'Chưa chọn ngày nào' };
  const days = [...new Set(value.map(Number))].filter((d) => Number.isInteger(d) && d >= 1 && d <= 7).sort();
  if (!days.length) return { error: 'Chưa chọn ngày nào' };
  return { csv: days.join(',') };
}

router.get('/scheduled-ip-blocks', async (req, res) => {
  const rows = await db.prepare(`
    SELECT b.*, v.name AS vm_name FROM waf_scheduled_ip_blocks b
    JOIN vcenter_vms v ON v.id = b.vm_id
    ORDER BY b.created_at DESC
  `).all();
  const now = wafScheduledBlock.currentTimeOfDay();
  const todayAllowed = wafScheduledBlock.isDayAllowed;
  for (const r of rows) {
    r.currentlyAllowed = todayAllowed(r.days_of_week) && wafScheduledBlock.isWithinWindow(now, r.allowed_start, r.allowed_end);
  }
  res.json(rows);
});

router.post('/scheduled-ip-blocks', requirePermission('waf.block'), async (req, res) => {
  const vmId = Number(req.body?.vmId);
  const domain = String(req.body?.domain || '').trim().slice(0, 255) || null;
  const ip = String(req.body?.ip || '').trim();
  const allowedStart = String(req.body?.allowedStart || '').trim();
  const allowedEnd = String(req.body?.allowedEnd || '').trim();
  const enabled = req.body?.enabled !== false;
  const days = parseDaysOfWeek(req.body?.daysOfWeek);

  if (!vmId) return res.status(400).json({ error: 'Thiếu VM' });
  const vm = await db.prepare('SELECT id, name FROM vcenter_vms WHERE id = ?').get(vmId);
  if (!vm) return res.status(400).json({ error: 'VM không tồn tại' });
  if (!isValidExceptionIp(ip)) return res.status(400).json({ error: 'IP/CIDR không hợp lệ' });
  if (!isValidTimeOfDay(allowedStart) || !isValidTimeOfDay(allowedEnd)) {
    return res.status(400).json({ error: 'Khung giờ không hợp lệ (định dạng HH:MM)' });
  }
  if (days.error) return res.status(400).json({ error: days.error });

  const result = await db.prepare(`
    INSERT INTO waf_scheduled_ip_blocks (vm_id, domain, ip, allowed_start, allowed_end, days_of_week, enabled, created_by_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(vmId, domain, ip, normalizeTimeOfDay(allowedStart), normalizeTimeOfDay(allowedEnd), days.csv, enabled ? 1 : 0, req.user?.name || null);
  await logActivity(req.user, 'CREATE', 'waf_scheduled_ip_block', result.lastInsertRowid, ip,
    `Thêm lịch chặn theo giờ: IP ${ip} trên VM "${vm.name}"${domain ? ` (${domain})` : ''} — cho phép ${allowedStart}-${allowedEnd}, ngày ${days.csv}`);
  res.json({ message: 'OK', id: result.lastInsertRowid });
});

router.patch('/scheduled-ip-blocks/:id', requirePermission('waf.block'), async (req, res) => {
  const row = await db.prepare('SELECT * FROM waf_scheduled_ip_blocks WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Không tìm thấy' });

  const fields = {};
  if (req.body?.domain !== undefined) fields.domain = String(req.body.domain || '').trim().slice(0, 255) || null;
  if (req.body?.ip !== undefined) {
    const ip = String(req.body.ip).trim();
    if (!isValidExceptionIp(ip)) return res.status(400).json({ error: 'IP/CIDR không hợp lệ' });
    fields.ip = ip;
  }
  if (req.body?.allowedStart !== undefined) {
    if (!isValidTimeOfDay(req.body.allowedStart)) return res.status(400).json({ error: 'Giờ bắt đầu không hợp lệ' });
    fields.allowed_start = normalizeTimeOfDay(req.body.allowedStart);
  }
  if (req.body?.allowedEnd !== undefined) {
    if (!isValidTimeOfDay(req.body.allowedEnd)) return res.status(400).json({ error: 'Giờ kết thúc không hợp lệ' });
    fields.allowed_end = normalizeTimeOfDay(req.body.allowedEnd);
  }
  if (req.body?.enabled !== undefined) fields.enabled = req.body.enabled ? 1 : 0;
  if (req.body?.daysOfWeek !== undefined) {
    const days = parseDaysOfWeek(req.body.daysOfWeek);
    if (days.error) return res.status(400).json({ error: days.error });
    fields.days_of_week = days.csv;
  }
  if (req.body?.vmId !== undefined) {
    const vm = await db.prepare('SELECT id FROM vcenter_vms WHERE id = ?').get(Number(req.body.vmId));
    if (!vm) return res.status(400).json({ error: 'VM không tồn tại' });
    fields.vm_id = vm.id;
  }

  const cols = Object.keys(fields);
  if (!cols.length) return res.status(400).json({ error: 'Không có trường nào để cập nhật' });
  // A rule edit invalidates whatever was last applied — force the scheduler to re-evaluate (and,
  // if needed, actually flip fail2ban state) on its next tick rather than trusting the old
  // last_state against a possibly-changed IP/window/VM.
  await db.prepare(`UPDATE waf_scheduled_ip_blocks SET ${cols.map(c => `${c} = ?`).join(', ')}, last_state = NULL WHERE id = ?`)
    .run(...cols.map(c => fields[c]), row.id);
  await logActivity(req.user, 'UPDATE', 'waf_scheduled_ip_block', row.id, row.ip, `Cập nhật lịch chặn theo giờ #${row.id}: ${cols.join(', ')}`);
  res.json({ message: 'OK' });
});

router.delete('/scheduled-ip-blocks/:id', requirePermission('waf.block'), async (req, res) => {
  const row = await db.prepare('SELECT * FROM waf_scheduled_ip_blocks WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Không tìm thấy' });
  await db.prepare('DELETE FROM waf_scheduled_ip_blocks WHERE id = ?').run(row.id);
  await logActivity(req.user, 'DELETE', 'waf_scheduled_ip_block', row.id, row.ip, `Xóa lịch chặn theo giờ: IP ${row.ip}`);
  // If the rule was currently enforcing a block, that ban is deliberately left in place rather than
  // auto-unbanned — deleting a schedule shouldn't silently restore access; unban explicitly from the
  // "IP đang bị chặn" tab if that's actually what's wanted.
  res.json({ message: 'OK' });
});

module.exports = router;
