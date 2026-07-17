const express = require('express');
const router = express.Router();
const db = require('../database');
const { requirePermission, logActivity } = require('../auth');
const trivyScanner = require('../trivy-scanner');
const vulnEnrichment = require('../vuln-enrichment');

// VM list for the "Quét mã nguồn (Trivy)" tab — mirrors routes/vuln.js's /vms shape.
router.get('/vms', async (req, res) => {
  const vms = await db.prepare(`
    SELECT id, moref, name, power_state, ip_address, guest_family, ssh_credential_id, ssh_user, ssh_port,
           trivy_scan_enabled, trivy_scan_path, trivy_scan_mode, trivy_last_scanned_at,
           trivy_scan_status, trivy_scan_error, trivy_package_count,
           trivy_docker_enabled, trivy_docker_mode, trivy_docker_last_scanned_at,
           trivy_docker_scan_status, trivy_docker_scan_error, trivy_docker_image_count
    FROM vcenter_vms ORDER BY name ASC
  `).all();
  res.json(vms);
});

router.patch('/vms/:id', requirePermission('trivy.scan.manage'), async (req, res) => {
  const vm = await db.prepare('SELECT id, name, ssh_credential_id, ip_address FROM vcenter_vms WHERE id = ?').get(req.params.id);
  if (!vm) return res.status(404).json({ error: 'Không tìm thấy VM' });
  const enabled = req.body?.enabled ? 1 : 0;
  const scanPath = String(req.body?.scanPath || '').trim();
  if (enabled && (!vm.ssh_credential_id || !vm.ip_address)) {
    return res.status(400).json({ error: 'VM này chưa có tài khoản kết nối SSH — cần cấu hình trước (trang Giám sát bất thường → Quản lý VM giám sát)' });
  }
  if (enabled && !scanPath) {
    return res.status(400).json({ error: 'Cần nhập đường dẫn thư mục mã nguồn cần quét' });
  }
  if (scanPath && !scanPath.startsWith('/')) {
    return res.status(400).json({ error: 'Đường dẫn phải là đường dẫn tuyệt đối (bắt đầu bằng /)' });
  }
  const mode = req.body?.mode === 'manual' ? 'manual' : 'auto';
  await db.prepare('UPDATE vcenter_vms SET trivy_scan_enabled = ?, trivy_scan_path = ?, trivy_scan_mode = ? WHERE id = ?')
    .run(enabled, scanPath || null, mode, vm.id);
  if (!enabled) await db.prepare('UPDATE vcenter_vms SET trivy_scan_status = NULL, trivy_scan_error = NULL WHERE id = ?').run(vm.id);
  await logActivity(req.user, 'UPDATE', 'vcenter_vm', vm.id, vm.name,
    enabled ? `Bật quét mã nguồn (Trivy) — đường dẫn ${scanPath}, chế độ ${mode === 'manual' ? 'thủ công' : 'tự động'}` : 'Tắt quét mã nguồn (Trivy)');
  res.json({ message: 'OK' });
});

// Separate config from the filesystem scan above — a VM may have containers without any app source
// checked out on it, or vice versa, so these two scan types are independently toggled.
router.patch('/vms/:id/docker', requirePermission('trivy.scan.manage'), async (req, res) => {
  const vm = await db.prepare('SELECT id, name, ssh_credential_id, ip_address FROM vcenter_vms WHERE id = ?').get(req.params.id);
  if (!vm) return res.status(404).json({ error: 'Không tìm thấy VM' });
  const enabled = req.body?.enabled ? 1 : 0;
  if (enabled && (!vm.ssh_credential_id || !vm.ip_address)) {
    return res.status(400).json({ error: 'VM này chưa có tài khoản kết nối SSH — cần cấu hình trước (trang Giám sát bất thường → Quản lý VM giám sát)' });
  }
  const mode = req.body?.mode === 'manual' ? 'manual' : 'auto';
  await db.prepare('UPDATE vcenter_vms SET trivy_docker_enabled = ?, trivy_docker_mode = ? WHERE id = ?').run(enabled, mode, vm.id);
  if (!enabled) await db.prepare('UPDATE vcenter_vms SET trivy_docker_scan_status = NULL, trivy_docker_scan_error = NULL WHERE id = ?').run(vm.id);
  await logActivity(req.user, 'UPDATE', 'vcenter_vm', vm.id, vm.name,
    enabled ? `Bật quét Docker image — chế độ ${mode === 'manual' ? 'thủ công' : 'tự động'}` : 'Tắt quét Docker image');
  res.json({ message: 'OK' });
});

// Trivy is installed ONCE, locally on the netadmin-pro host itself — NOT per VM (see trivy-scanner.js
// header comment for the full architecture). These two routes replace the old per-VM install/status.
router.get('/host-status', requirePermission('trivy.scan.manage'), async (req, res) => {
  res.json({ installed: await trivyScanner.isLocalTrivyInstalled() });
});

router.post('/install-host', requirePermission('trivy.scan.manage'), async (req, res) => {
  const result = await trivyScanner.installLocalTrivy();
  await logActivity(req.user, 'UPDATE', 'trivy_host', 1, 'Trivy (máy chủ netadmin-pro)',
    result.ok ? 'Cài đặt Trivy trên máy chủ netadmin-pro thành công' : `Cài đặt Trivy trên máy chủ netadmin-pro thất bại: ${result.error}`);
  res.json(result);
});

// Read-only listing (no DB write, no logActivity — same reasoning as GET /findings/:id/nvd) so the
// path picker can suggest real directories under /opt and /data instead of making the admin type one.
router.post('/vms/:id/discover-paths', requirePermission('trivy.scan.manage'), async (req, res) => {
  const vm = await db.prepare('SELECT id, name, ip_address, ssh_credential_id, ssh_port FROM vcenter_vms WHERE id = ?').get(req.params.id);
  if (!vm) return res.status(404).json({ error: 'Không tìm thấy VM' });
  if (!vm.ssh_credential_id || !vm.ip_address) {
    return res.status(400).json({ error: 'VM này chưa có tài khoản kết nối SSH — cần cấu hình trước' });
  }
  try {
    const result = await trivyScanner.discoverPaths(vm);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/vms/:id/scan-now', requirePermission('trivy.scan.manage'), async (req, res) => {
  const vm = await db.prepare(`
    SELECT id, name, ip_address, ssh_credential_id, ssh_port, trivy_scan_path FROM vcenter_vms WHERE id = ?
  `).get(req.params.id);
  if (!vm) return res.status(404).json({ error: 'Không tìm thấy VM' });
  if (!vm.ssh_credential_id || !vm.ip_address) {
    return res.status(400).json({ error: 'VM này chưa có tài khoản kết nối SSH — cần cấu hình trước' });
  }
  if (!vm.trivy_scan_path) return res.status(400).json({ error: 'Chưa cấu hình đường dẫn quét' });
  await trivyScanner.scanFilesystem(vm);
  await logActivity(req.user, 'UPDATE', 'vcenter_vm', vm.id, vm.name, 'Quét mã nguồn (Trivy) ngay');
  const fresh = await db.prepare(`
    SELECT trivy_scan_status, trivy_scan_error, trivy_last_scanned_at, trivy_package_count FROM vcenter_vms WHERE id = ?
  `).get(vm.id);
  res.json(fresh);
});

router.post('/vms/:id/scan-docker-now', requirePermission('trivy.scan.manage'), async (req, res) => {
  const vm = await db.prepare(`
    SELECT id, name, ip_address, ssh_credential_id, ssh_port FROM vcenter_vms WHERE id = ?
  `).get(req.params.id);
  if (!vm) return res.status(404).json({ error: 'Không tìm thấy VM' });
  if (!vm.ssh_credential_id || !vm.ip_address) {
    return res.status(400).json({ error: 'VM này chưa có tài khoản kết nối SSH — cần cấu hình trước' });
  }
  await trivyScanner.scanDocker(vm);
  await logActivity(req.user, 'UPDATE', 'vcenter_vm', vm.id, vm.name, 'Quét Docker image ngay');
  const fresh = await db.prepare(`
    SELECT trivy_docker_scan_status, trivy_docker_scan_error, trivy_docker_last_scanned_at, trivy_docker_image_count FROM vcenter_vms WHERE id = ?
  `).get(vm.id);
  res.json(fresh);
});

router.get('/findings', async (req, res) => {
  const { vmId, scanType, severity, search, includeResolved, limit } = req.query;
  let query = 'SELECT * FROM trivy_findings WHERE 1=1';
  const params = [];
  if (!includeResolved || includeResolved === 'false') query += ' AND resolved_at IS NULL';
  if (vmId) { query += ' AND vm_id = ?'; params.push(vmId); }
  if (scanType) { query += ' AND scan_type = ?'; params.push(scanType); }
  if (severity) { query += ' AND severity = ?'; params.push(severity); }
  if (search) {
    query += ' AND (vm_name LIKE ? OR package_name LIKE ? OR vuln_id LIKE ? OR target_file LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }
  query += `
    ORDER BY (resolved_at IS NULL) DESC, in_kev DESC,
      CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 WHEN 'negligible' THEN 4 ELSE 5 END,
      last_seen DESC
    LIMIT ?
  `;
  params.push(Math.min(Number(limit) || 500, 2000));
  res.json(await db.prepare(query).all(...params));
});

// Live, on-demand only (same reasoning as routes/vuln.js's GET /findings/:id/nvd — NVD's rate limit
// is too low for bulk use). Trivy's own vuln_id IS already the canonical CVE (confirmed against a
// real scan), no separate cve_id column/lookup needed the way OS-package findings require.
router.get('/findings/:id/nvd', async (req, res) => {
  const finding = await db.prepare('SELECT vuln_id FROM trivy_findings WHERE id = ?').get(req.params.id);
  if (!finding) return res.status(404).json({ error: 'Không tìm thấy' });
  if (!/^CVE-\d{4}-\d+/.test(finding.vuln_id)) return res.json({ available: false, reason: 'Mã lỗ hổng này không phải định dạng CVE chuẩn' });
  const nvd = await vulnEnrichment.fetchNvdDetail(finding.vuln_id);
  if (!nvd) return res.json({ available: false, reason: 'Không lấy được dữ liệu từ NVD (có thể do giới hạn tần suất truy vấn hoặc CVE chưa có trên NVD) — thử lại sau' });
  res.json({ available: true, ...nvd });
});

router.get('/stats', async (req, res) => {
  const bySeverity = await db.prepare(`
    SELECT severity, COUNT(*) as cnt FROM trivy_findings WHERE resolved_at IS NULL GROUP BY severity
  `).all();
  const counts = { critical: 0, high: 0, medium: 0, low: 0, negligible: 0, unknown: 0 };
  for (const row of bySeverity) if (row.severity in counts) counts[row.severity] = row.cnt;
  const totalOpen = bySeverity.reduce((sum, r) => sum + r.cnt, 0);
  const vmsScanned = (await db.prepare("SELECT COUNT(*) as cnt FROM vcenter_vms WHERE trivy_scan_enabled = 1 OR trivy_docker_enabled = 1").get()).cnt;
  const vmsWithError = (await db.prepare(`
    SELECT COUNT(*) as cnt FROM vcenter_vms
    WHERE (trivy_scan_enabled = 1 AND trivy_scan_status = 'error') OR (trivy_docker_enabled = 1 AND trivy_docker_scan_status = 'error')
  `).get()).cnt;
  const inKevCount = (await db.prepare("SELECT COUNT(*) as cnt FROM trivy_findings WHERE resolved_at IS NULL AND in_kev = 1").get()).cnt;
  res.json({ totalOpen, counts, vmsScanned, vmsWithError, inKevCount });
});

module.exports = router;
