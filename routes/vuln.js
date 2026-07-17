const express = require('express');
const router = express.Router();
const db = require('../database');
const { requirePermission, logActivity } = require('../auth');
const vulnScanner = require('../vuln-scanner');
const aptUpdateManager = require('../apt-update-manager');
const vulnEnrichment = require('../vuln-enrichment');

// VM list for the "Quản lý quét" tab: which are eligible (have an SSH credential + IP — assigned on
// the "Giám sát bất thường" → "Quản lý VM giám sát" tab, reused as-is, no separate credential picker
// here) and which are currently opted into vulnerability scanning, mirrors routes/waf.js's /vms.
router.get('/vms', async (req, res) => {
  const vms = await db.prepare(`
    SELECT id, moref, name, power_state, ip_address, guest_family, ssh_credential_id, ssh_user, ssh_port,
           vuln_scan_enabled, vuln_scan_mode, vuln_last_scanned_at, vuln_scan_status, vuln_scan_error, vuln_package_count,
           update_checked_at, reboot_required, reboot_required_packages
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
  // Worst-first: open findings before resolved, CISA KEV (actively exploited right now) before even
  // critical severity, then critical/high before the noisier low/medium bulk, most-recently-seen
  // first within a tier.
  query += `
    ORDER BY (resolved_at IS NULL) DESC, in_kev DESC,
      CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 WHEN 'negligible' THEN 4 ELSE 5 END,
      last_seen DESC
    LIMIT ?
  `;
  params.push(Math.min(Number(limit) || 500, 2000));
  res.json(await db.prepare(query).all(...params));
});

// Live, on-demand only (see vuln-enrichment.js's header comment for why NOT during the bulk scan) —
// fetches NVD's own CVSS score/vector + CWE classification for the finding's canonical CVE ID.
// cve_id can be null (e.g. OSV had no `upstream` entry for this advisory) — reported as a normal
// "no NVD data" response, not an error, so the frontend can show a clear message either way.
router.get('/findings/:id/nvd', async (req, res) => {
  const finding = await db.prepare('SELECT cve_id FROM vuln_findings WHERE id = ?').get(req.params.id);
  if (!finding) return res.status(404).json({ error: 'Không tìm thấy' });
  if (!finding.cve_id) return res.json({ available: false, reason: 'Không xác định được mã CVE gốc cho lỗ hổng này' });
  const nvd = await vulnEnrichment.fetchNvdDetail(finding.cve_id);
  if (!nvd) return res.json({ available: false, reason: 'Không lấy được dữ liệu từ NVD (có thể do giới hạn tần suất truy vấn hoặc CVE chưa có trên NVD) — thử lại sau' });
  res.json({ available: true, ...nvd });
});

// One-click remediation directly from a specific finding — fixing a CVE shouldn't require manually
// navigating to the "Cập nhật gói" tab, reselecting the VM, and re-finding the same package there.
// Reuses apt-update-manager.js's existing checkUpdates (refreshes the apt index so the install below
// sees the real latest candidate, not a stale cached one) + applyUpdates (installs exactly this one
// package) — no new SSH/apt logic, just the existing two-step flow scoped to one package.
router.post('/findings/:id/update-now', requirePermission('vuln.update.manage'), async (req, res) => {
  const finding = await db.prepare('SELECT vm_id, package_name FROM vuln_findings WHERE id = ?').get(req.params.id);
  if (!finding) return res.status(404).json({ error: 'Không tìm thấy' });
  const vm = await db.prepare(`
    SELECT id, name, ip_address, ssh_credential_id, ssh_port FROM vcenter_vms WHERE id = ?
  `).get(finding.vm_id);
  if (!vm) return res.status(404).json({ error: 'Không tìm thấy VM' });
  if (!vm.ssh_credential_id || !vm.ip_address) {
    return res.status(400).json({ error: 'VM này chưa có tài khoản kết nối SSH — cần cấu hình trước' });
  }
  try {
    await aptUpdateManager.checkUpdates(vm);
    const { results, skipped } = await aptUpdateManager.applyUpdates(vm, [finding.package_name], req.user);
    if (skipped) {
      return res.status(400).json({ error: `Gói "${finding.package_name}" nằm trong danh sách Ngoại lệ cập nhật — xóa ngoại lệ trước nếu muốn cập nhật` });
    }
    await logActivity(req.user, 'UPDATE', 'vcenter_vm', vm.id, vm.name, `Cập nhật ngay gói "${finding.package_name}" từ trang lỗ hổng`);
    res.json({ result: results[0] || null });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Same one-click remediation as above, but for a batch of findings selected via checkboxes on the
// findings table — can span multiple VMs at once. Groups by VM and runs ONE checkUpdates +
// ONE applyUpdates per VM (covering every selected package on that VM together), not one round trip
// per finding — a user selecting 5 findings on the same VM shouldn't trigger 5 separate apt-get
// update runs. VMs are processed sequentially (not in parallel) — same reasoning as every other
// multi-VM batch in this app (e.g. vuln-scanner.js's collectAll): several concurrent SSH+apt sessions
// against different VMs is fine for reads, but piling up concurrent package-install actions has more
// blast-radius if something goes wrong, and there's no time-sensitivity here that needs parallelism.
router.post('/findings/bulk-update-now', requirePermission('vuln.update.manage'), async (req, res) => {
  const findingIds = Array.isArray(req.body?.findingIds) ? req.body.findingIds.map(Number).filter(Number.isInteger) : [];
  if (!findingIds.length) return res.status(400).json({ error: 'Chưa chọn lỗ hổng nào' });
  const findings = await db.prepare(`
    SELECT id, vm_id, package_name FROM vuln_findings WHERE id IN (${findingIds.map(() => '?').join(',')})
  `).all(...findingIds);
  if (!findings.length) return res.status(404).json({ error: 'Không tìm thấy lỗ hổng nào khớp' });

  const packagesByVm = new Map();
  for (const f of findings) {
    if (!packagesByVm.has(f.vm_id)) packagesByVm.set(f.vm_id, new Set());
    packagesByVm.get(f.vm_id).add(f.package_name);
  }

  const results = [];
  const vmErrors = [];
  for (const [vmId, packageSet] of packagesByVm) {
    const vm = await db.prepare(`
      SELECT id, name, ip_address, ssh_credential_id, ssh_port FROM vcenter_vms WHERE id = ?
    `).get(vmId);
    if (!vm) { vmErrors.push({ vmName: `VM #${vmId}`, error: 'Không tìm thấy VM' }); continue; }
    if (!vm.ssh_credential_id || !vm.ip_address) {
      vmErrors.push({ vmName: vm.name, error: 'Chưa có tài khoản kết nối SSH' });
      continue;
    }
    try {
      await aptUpdateManager.checkUpdates(vm);
      const { results: vmResults, skipped } = await aptUpdateManager.applyUpdates(vm, [...packageSet], req.user);
      results.push(...vmResults.map((r) => ({ ...r, vmName: vm.name, vmId: vm.id })));
      if (skipped) vmErrors.push({ vmName: vm.name, error: `${skipped} gói bị loại vì nằm trong danh sách Ngoại lệ` });
      await logActivity(req.user, 'UPDATE', 'vcenter_vm', vm.id, vm.name, `Cập nhật hàng loạt ${vmResults.length} gói từ trang lỗ hổng`);
    } catch (e) {
      vmErrors.push({ vmName: vm.name, error: e.message });
    }
  }
  res.json({ results, vmErrors });
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
    const { packages, updateError, rebootRequired, rebootPackages } = await aptUpdateManager.checkUpdates(vm);
    await logActivity(req.user, 'UPDATE', 'vcenter_vm', vm.id, vm.name,
      `Kiểm tra update — tìm thấy ${packages.length} gói có bản cập nhật${rebootRequired ? ', VM cần khởi động lại' : ''}`);
    res.json({ packages, updateError, rebootRequired, rebootPackages });
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
  const inKevCount = (await db.prepare("SELECT COUNT(*) as cnt FROM vuln_findings WHERE resolved_at IS NULL AND in_kev = 1").get()).cnt;
  res.json({ totalOpen, counts, vmsScanned, vmsWithError, inKevCount });
});

module.exports = router;
