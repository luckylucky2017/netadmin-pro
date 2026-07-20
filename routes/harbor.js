const express = require('express');
const router = express.Router();
const db = require('../database');
const { requirePermission, logActivity } = require('../auth');
const { getSettings, invalidate } = require('../settings');
const harborScanner = require('../harbor-scanner');
const vulnEnrichment = require('../vuln-enrichment');

// Connection config is Admin-gated (reuses trivy.scan.manage rather than a new permission — this
// is scan configuration, same tier as trivy-scanner.js's host-status/install-host) — never returns
// the real password, only whether one is already set, same pattern as routes/settings.js.
router.get('/settings', requirePermission('trivy.scan.manage'), async (req, res) => {
  const s = await getSettings();
  res.json({ url: s.harbor_url || '', username: s.harbor_username || '', insecure: !!s.harbor_insecure, has_password: !!s.harbor_password });
});

router.put('/settings', requirePermission('trivy.scan.manage'), async (req, res) => {
  const { url, username, password, insecure } = req.body || {};
  if (url && !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'URL Harbor phải bắt đầu bằng http:// hoặc https://' });
  await db.prepare(`
    UPDATE app_settings SET harbor_url=?, harbor_username=?, harbor_password=COALESCE(NULLIF(?, ''), harbor_password), harbor_insecure=?, updated_at=CURRENT_TIMESTAMP WHERE id=1
  `).run(url || null, username || null, password || '', insecure ? 1 : 0);
  invalidate();
  await logActivity(req.user, 'UPDATE', 'app_settings', 1, 'Kết nối Harbor', 'Cập nhật cấu hình kết nối Harbor registry');
  res.json({ message: 'Đã lưu' });
});

router.post('/test-connection', requirePermission('trivy.scan.manage'), async (req, res) => {
  try {
    res.json(await harborScanner.testConnection());
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Live enumeration of every project/repository Harbor currently has, marked against what's already
// tracked — feeds the "Dò tìm project/repository" picker so the admin can select from what's
// actually there instead of typing names by hand. Not stored — same reasoning as trivy-scanner.js's
// discover-paths (a live lookup, re-run each time the picker opens).
router.get('/discover', requirePermission('trivy.scan.manage'), async (req, res) => {
  try {
    const repos = await harborScanner.discoverRepos();
    const tracked = await db.prepare('SELECT project_name, repo_name FROM harbor_repos').all();
    const trackedSet = new Set(tracked.map((t) => `${t.project_name}/${t.repo_name}`));
    res.json(repos.map((r) => ({ ...r, tracked: trackedSet.has(`${r.project_name}/${r.repo_name}`) })));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Tracked repos + their scan status — mirrors routes/trivy.js's GET /vms (viewable by any
// authenticated user, not gated, since it's just showing results/status, not configuration).
router.get('/repos', async (req, res) => {
  res.json(await db.prepare('SELECT * FROM harbor_repos ORDER BY project_name ASC, repo_name ASC').all());
});

router.post('/repos', requirePermission('trivy.scan.manage'), async (req, res) => {
  const project_name = String(req.body?.project_name || '').trim();
  const repo_name = String(req.body?.repo_name || '').trim();
  if (!project_name || !repo_name) return res.status(400).json({ error: 'Thiếu project_name/repo_name' });
  try {
    const result = await db.prepare('INSERT INTO harbor_repos (project_name, repo_name) VALUES (?, ?)').run(project_name, repo_name);
    await logActivity(req.user, 'CREATE', 'harbor_repo', result.lastInsertRowid, `${project_name}/${repo_name}`, 'Bật quét Harbor cho repository');
    res.status(201).json({ id: result.lastInsertRowid, message: 'OK' });
  } catch (e) {
    if (/Duplicate entry/.test(e.message)) return res.status(400).json({ error: 'Repository này đã được theo dõi' });
    res.status(500).json({ error: e.message });
  }
});

router.patch('/repos/:id', requirePermission('trivy.scan.manage'), async (req, res) => {
  const repo = await db.prepare('SELECT id FROM harbor_repos WHERE id=?').get(req.params.id);
  if (!repo) return res.status(404).json({ error: 'Không tìm thấy' });
  const mode = req.body?.mode === 'manual' ? 'manual' : 'auto';
  await db.prepare('UPDATE harbor_repos SET scan_mode=? WHERE id=?').run(mode, repo.id);
  res.json({ message: 'OK' });
});

router.delete('/repos/:id', requirePermission('trivy.scan.manage'), async (req, res) => {
  const repo = await db.prepare('SELECT project_name, repo_name FROM harbor_repos WHERE id=?').get(req.params.id);
  if (!repo) return res.status(404).json({ error: 'Không tìm thấy' });
  await db.prepare("DELETE FROM trivy_findings WHERE vm_id=? AND scan_type='harbor'").run(req.params.id);
  await db.prepare('DELETE FROM harbor_repos WHERE id=?').run(req.params.id);
  await logActivity(req.user, 'DELETE', 'harbor_repo', req.params.id, `${repo.project_name}/${repo.repo_name}`, 'Tắt quét Harbor cho repository');
  res.json({ message: 'Deleted' });
});

router.post('/repos/:id/scan-now', requirePermission('trivy.scan.manage'), async (req, res) => {
  const repo = await db.prepare('SELECT * FROM harbor_repos WHERE id=?').get(req.params.id);
  if (!repo) return res.status(404).json({ error: 'Không tìm thấy' });
  await harborScanner.scanRepo(repo);
  await logActivity(req.user, 'UPDATE', 'harbor_repo', repo.id, `${repo.project_name}/${repo.repo_name}`, 'Quét Harbor ngay');
  const fresh = await db.prepare('SELECT scan_status, scan_error, last_tag, package_count, last_scanned_at FROM harbor_repos WHERE id=?').get(repo.id);
  res.json(fresh);
});

// scan_type is hardcoded to 'harbor' here (unlike routes/trivy.js's GET /findings, which takes
// scanType as a query param for fs vs docker) — this route only ever serves Harbor findings, kept as
// its own endpoint rather than folding into routes/trivy.js since Harbor findings aren't tied to any
// vcenter_vms row at all (vm_id here is really a harbor_repos.id — see harbor-scanner.js's scanRepo).
router.get('/findings', async (req, res) => {
  const { repoId, severity, search, includeResolved, limit } = req.query;
  let query = "SELECT * FROM trivy_findings WHERE scan_type = 'harbor'";
  const params = [];
  if (!includeResolved || includeResolved === 'false') query += ' AND resolved_at IS NULL';
  if (repoId) { query += ' AND vm_id = ?'; params.push(repoId); }
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

router.get('/findings/:id/nvd', async (req, res) => {
  const finding = await db.prepare("SELECT vuln_id FROM trivy_findings WHERE id = ? AND scan_type = 'harbor'").get(req.params.id);
  if (!finding) return res.status(404).json({ error: 'Không tìm thấy' });
  if (!/^CVE-\d{4}-\d+/.test(finding.vuln_id)) return res.json({ available: false, reason: 'Mã lỗ hổng này không phải định dạng CVE chuẩn' });
  const nvd = await vulnEnrichment.fetchNvdDetail(finding.vuln_id);
  if (!nvd) return res.json({ available: false, reason: 'Không lấy được dữ liệu từ NVD (có thể do giới hạn tần suất truy vấn hoặc CVE chưa có trên NVD) — thử lại sau' });
  res.json({ available: true, ...nvd });
});

router.get('/stats', async (req, res) => {
  const bySeverity = await db.prepare("SELECT severity, COUNT(*) as cnt FROM trivy_findings WHERE scan_type='harbor' AND resolved_at IS NULL GROUP BY severity").all();
  const counts = { critical: 0, high: 0, medium: 0, low: 0, negligible: 0, unknown: 0 };
  for (const row of bySeverity) if (row.severity in counts) counts[row.severity] = row.cnt;
  const totalOpen = bySeverity.reduce((sum, r) => sum + r.cnt, 0);
  const reposTracked = (await db.prepare('SELECT COUNT(*) as cnt FROM harbor_repos').get()).cnt;
  const reposWithError = (await db.prepare("SELECT COUNT(*) as cnt FROM harbor_repos WHERE scan_status='error'").get()).cnt;
  const inKevCount = (await db.prepare("SELECT COUNT(*) as cnt FROM trivy_findings WHERE scan_type='harbor' AND resolved_at IS NULL AND in_kev=1").get()).cnt;
  res.json({ totalOpen, counts, reposTracked, reposWithError, inKevCount });
});

module.exports = router;
