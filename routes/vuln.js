const express = require('express');
const router = express.Router();
const db = require('../database');
const { requirePermission, logActivity } = require('../auth');
const vulnScanner = require('../vuln-scanner');
const aptUpdateManager = require('../apt-update-manager');

// VM list for the "Quản lý quét" tab: which are eligible (have an SSH credential + IP — assigned on
// the "Giám sát bất thường" → "Quản lý VM giám sát" tab, reused as-is, no separate credential picker
// here) and which are currently opted into vulnerability scanning, mirrors routes/waf.js's /vms.
router.get('/vms', async (req, res) => {
  const vms = await db.prepare(`
    SELECT id, moref, name, power_state, ip_address, guest_family, ssh_credential_id, ssh_user, ssh_port,
           vuln_scan_enabled, vuln_scan_mode, vuln_last_scanned_at, vuln_scan_status, vuln_scan_error, vuln_package_count,
           update_checked_at
    FROM vcenter_vms ORDER BY name ASC
  `).all();
  res.json(vms);
});

router.patch('/vms/:id', requirePermission('vuln.scan.manage'), async (req, res) => {
  const vm = await db.prepare('SELECT id, name, ssh_credential_id, ip_address FROM vcenter_vms WHERE id = ?').get(req.params.id);
  if (!vm) return res.status(404).json({ error: 'Không tìm thấy VM' });
  const enabled = req.body?.enabled ? 1 : 0;
  if (enabled && (!vm.ssh_credential_id || !vm.ip_address)) {
    return res.status(400).json({ error: 'VM này chưa có tài khoản kết nối SSH — cần cấu hình trước (trang Giám sát bất thường → Quản lý VM giám sát)' });
  }
  // 'auto' (default — rescanned automatically every 12h) or 'manual' (opted into monitoring, but only
  // ever scanned when the admin explicitly clicks "Quét ngay" — see vuln-scanner.js's collectAll).
  const mode = req.body?.mode === 'manual' ? 'manual' : 'auto';
  await db.prepare('UPDATE vcenter_vms SET vuln_scan_enabled = ?, vuln_scan_mode = ? WHERE id = ?').run(enabled, mode, vm.id);
  // Clear stale status when turning off — an old "error"/"unsupported_os" from a prior scan
  // shouldn't linger and confuse the row once scanning is disabled.
  if (!enabled) await db.prepare('UPDATE vcenter_vms SET vuln_scan_status = NULL, vuln_scan_error = NULL WHERE id = ?').run(vm.id);
  await logActivity(req.user, 'UPDATE', 'vcenter_vm', vm.id, vm.name,
    enabled ? `Bật quét lỗ hổng (CVE) — chế độ ${mode === 'manual' ? 'thủ công' : 'tự động'}` : 'Tắt quét lỗ hổng (CVE)');
  res.json({ message: 'OK' });
});

// On-demand immediate scan (bypasses the 12h due-check in collectAll) — a fresh Map() per call is
// fine here: this is a single-VM, user-triggered action, not the batch tick where sharing one cache
// across many VMs in the same run actually saves redundant OSV.dev detail fetches.
router.post('/vms/:id/scan-now', requirePermission('vuln.scan.manage'), async (req, res) => {
  const vm = await db.prepare(`
    SELECT id, name, ip_address, ssh_credential_id, ssh_port FROM vcenter_vms WHERE id = ?
  `).get(req.params.id);
  if (!vm) return res.status(404).json({ error: 'Không tìm thấy VM' });
  if (!vm.ssh_credential_id || !vm.ip_address) {
    return res.status(400).json({ error: 'VM này chưa có tài khoản kết nối SSH — cần cấu hình trước' });
  }
  await vulnScanner.scanVm(vm, new Map());
  await logActivity(req.user, 'UPDATE', 'vcenter_vm', vm.id, vm.name, 'Quét lỗ hổng (CVE) ngay');
  const fresh = await db.prepare(`
    SELECT vuln_scan_status, vuln_scan_error, vuln_last_scanned_at, vuln_package_count FROM vcenter_vms WHERE id = ?
  `).get(vm.id);
  res.json(fresh);
});

router.get('/findings', async (req, res) => {
  const { vmId, severity, search, includeResolved, limit } = req.query;
  let query = 'SELECT * FROM vuln_findings WHERE 1=1';
  const params = [];
  if (!includeResolved || includeResolved === 'false') query += ' AND resolved_at IS NULL';
  if (vmId) { query += ' AND vm_id = ?'; params.push(vmId); }
  if (severity) { query += ' AND severity = ?'; params.push(severity); }
  if (search) { query += ' AND (vm_name LIKE ? OR package_name LIKE ? OR vuln_id LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  // Worst-first: open findings before resolved, critical/high before the noisier low/medium bulk,
  // most-recently-seen first within a severity tier.
  query += `
    ORDER BY (resolved_at IS NULL) DESC,
      CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 WHEN 'negligible' THEN 4 ELSE 5 END,
      last_seen DESC
    LIMIT ?
  `;
  params.push(Math.min(Number(limit) || 500, 2000));
  res.json(await db.prepare(query).all(...params));
});

// ── Package update management ("Cập nhật gói" tab) ──────────────────────────────────────────

// Last check-updates snapshot for a VM — pure DB read, backs the tab on page load/refresh (never
// re-runs the live apt-get update itself; that's only POST /check-updates, an explicit button click).
router.get('/vms/:id/pending-updates', async (req, res) => {
  const rows = await db.prepare(`
    SELECT package_name, current_version, candidate_version, checked_at
    FROM vuln_pending_updates WHERE vm_id = ? ORDER BY package_name ASC
  `).all(req.params.id);
  const exceptions = await aptUpdateManager.getExceptionSet();
  res.json(rows.map((r) => ({ ...r, excepted: exceptions.has(r.package_name) })));
});

router.get('/vms/:id/update-history', async (req, res) => {
  const rows = await db.prepare(`
    SELECT * FROM vuln_update_history WHERE vm_id = ? ORDER BY applied_at DESC LIMIT 200
  `).all(req.params.id);
  res.json(rows);
});

router.post('/vms/:id/check-updates', requirePermission('vuln.update.manage'), async (req, res) => {
  const vm = await db.prepare(`
    SELECT id, name, ip_address, ssh_credential_id, ssh_port FROM vcenter_vms WHERE id = ?
  `).get(req.params.id);
  if (!vm) return res.status(404).json({ error: 'Không tìm thấy VM' });
  if (!vm.ssh_credential_id || !vm.ip_address) {
    return res.status(400).json({ error: 'VM này chưa có tài khoản kết nối SSH — cần cấu hình trước' });
  }
  try {
    const { packages, updateError } = await aptUpdateManager.checkUpdates(vm);
    await logActivity(req.user, 'UPDATE', 'vcenter_vm', vm.id, vm.name, `Kiểm tra update — tìm thấy ${packages.length} gói có bản cập nhật`);
    res.json({ packages, updateError });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/vms/:id/apply-updates', requirePermission('vuln.update.manage'), async (req, res) => {
  const vm = await db.prepare(`
    SELECT id, name, ip_address, ssh_credential_id, ssh_port FROM vcenter_vms WHERE id = ?
  `).get(req.params.id);
  if (!vm) return res.status(404).json({ error: 'Không tìm thấy VM' });
  if (!vm.ssh_credential_id || !vm.ip_address) {
    return res.status(400).json({ error: 'VM này chưa có tài khoản kết nối SSH — cần cấu hình trước' });
  }
  const packages = Array.isArray(req.body?.packages) ? req.body.packages.map(String) : [];
  if (!packages.length) return res.status(400).json({ error: 'Chưa chọn gói nào để cập nhật' });
  try {
    const { results, skipped } = await aptUpdateManager.applyUpdates(vm, packages, req.user);
    const updatedCount = results.filter((r) => r.status === 'updated').length;
    await logActivity(req.user, 'UPDATE', 'vcenter_vm', vm.id, vm.name,
      `Cập nhật gói: ${updatedCount}/${results.length} thành công${skipped ? ` (${skipped} gói bị loại vì nằm trong ngoại lệ)` : ''}`);
    res.json({ results, skipped });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/update-exceptions', async (req, res) => {
  res.json(await db.prepare('SELECT * FROM vuln_update_exceptions ORDER BY created_at DESC').all());
});

router.post('/update-exceptions', requirePermission('vuln.update.manage'), async (req, res) => {
  const packageName = String(req.body?.packageName || '').trim();
  const note = String(req.body?.note || '').trim().slice(0, 255) || null;
  if (!aptUpdateManager.PACKAGE_NAME_RE.test(packageName)) {
    return res.status(400).json({ error: 'Tên gói không hợp lệ' });
  }
  try {
    await db.prepare('INSERT INTO vuln_update_exceptions (package_name, note, created_by) VALUES (?, ?, ?)')
      .run(packageName, note, req.user.name || req.user.email);
  } catch (e) {
    if (e.errno === 1062) return res.status(400).json({ error: 'Gói này đã có trong danh sách ngoại lệ' });
    throw e;
  }
  await logActivity(req.user, 'CREATE', 'vuln_update_exception', null, packageName, `Thêm ngoại lệ cập nhật gói: ${packageName}${note ? ' — ' + note : ''}`);
  res.json({ message: 'OK' });
});

router.delete('/update-exceptions/:id', requirePermission('vuln.update.manage'), async (req, res) => {
  const row = await db.prepare('SELECT * FROM vuln_update_exceptions WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Không tìm thấy' });
  await db.prepare('DELETE FROM vuln_update_exceptions WHERE id = ?').run(row.id);
  await logActivity(req.user, 'DELETE', 'vuln_update_exception', row.id, row.package_name, `Xóa ngoại lệ cập nhật gói: ${row.package_name}`);
  res.json({ message: 'OK' });
});

router.get('/stats', async (req, res) => {
  const bySeverity = await db.prepare(`
    SELECT severity, COUNT(*) as cnt FROM vuln_findings WHERE resolved_at IS NULL GROUP BY severity
  `).all();
  const counts = { critical: 0, high: 0, medium: 0, low: 0, negligible: 0, unknown: 0 };
  for (const row of bySeverity) if (row.severity in counts) counts[row.severity] = row.cnt;
  const totalOpen = bySeverity.reduce((sum, r) => sum + r.cnt, 0);
  const vmsScanned = (await db.prepare("SELECT COUNT(*) as cnt FROM vcenter_vms WHERE vuln_scan_enabled = 1").get()).cnt;
  const vmsWithError = (await db.prepare("SELECT COUNT(*) as cnt FROM vcenter_vms WHERE vuln_scan_enabled = 1 AND vuln_scan_status IN ('error', 'unsupported_os')").get()).cnt;
  res.json({ totalOpen, counts, vmsScanned, vmsWithError });
});

module.exports = router;
