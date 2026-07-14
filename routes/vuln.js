const express = require('express');
const router = express.Router();
const db = require('../database');
const { requirePermission, logActivity } = require('../auth');
const vulnScanner = require('../vuln-scanner');

// VM list for the "Quản lý quét" tab: which are eligible (have an SSH credential + IP — assigned on
// the "Giám sát bất thường" → "Quản lý VM giám sát" tab, reused as-is, no separate credential picker
// here) and which are currently opted into vulnerability scanning, mirrors routes/waf.js's /vms.
router.get('/vms', async (req, res) => {
  const vms = await db.prepare(`
    SELECT id, moref, name, power_state, ip_address, guest_family, ssh_credential_id, ssh_user, ssh_port,
           vuln_scan_enabled, vuln_last_scanned_at, vuln_scan_status, vuln_scan_error, vuln_package_count
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
  await db.prepare('UPDATE vcenter_vms SET vuln_scan_enabled = ? WHERE id = ?').run(enabled, vm.id);
  // Clear stale status when turning off — an old "error"/"unsupported_os" from a prior scan
  // shouldn't linger and confuse the row once scanning is disabled.
  if (!enabled) await db.prepare('UPDATE vcenter_vms SET vuln_scan_status = NULL, vuln_scan_error = NULL WHERE id = ?').run(vm.id);
  await logActivity(req.user, 'UPDATE', 'vcenter_vm', vm.id, vm.name, enabled ? 'Bật quét lỗ hổng (CVE)' : 'Tắt quét lỗ hổng (CVE)');
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
