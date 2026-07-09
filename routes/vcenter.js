const express = require('express');
const router = express.Router();
const db = require('../database');
const collector = require('../vcenter-collector');
const actions = require('../vcenter-actions');
const registry = require('../vcenter-registry');
const { requirePermission, logActivity } = require('../auth');

// password is a credential — never returned to the client, same treatment as
// servers.ipmi_password.
function sanitizeCluster(c) {
  if (!c) return c;
  const { password, ...rest } = c;
  return rest;
}

async function requireClusterId(req, res) {
  const clusterId = Number(req.query.cluster_id || req.body?.clusterId);
  if (!clusterId) { res.status(400).json({ error: 'Thiếu cluster_id — chọn 1 cụm vCenter trước' }); return null; }
  return clusterId;
}

// Looks up a VM by internal id (not moref — moref is only unique within its own cluster) and
// resolves which cluster it belongs to, for every VM-action route below.
async function getVmForAction(req, res) {
  const vm = await db.prepare('SELECT * FROM vcenter_vms WHERE id = ?').get(req.params.id);
  if (!vm) { res.status(404).json({ error: 'Không tìm thấy VM' }); return null; }
  return vm;
}

router.get('/vms', async (req, res) => {
  const { search, power_state, cluster_id } = req.query;
  let query = `
    SELECT v.*, c.name as cluster_name
    FROM vcenter_vms v LEFT JOIN vcenter_clusters c ON c.id = v.vcenter_cluster_id
    WHERE 1=1
  `;
  const params = [];
  if (search) { query += ' AND v.name LIKE ?'; params.push(`%${search}%`); }
  if (power_state) { query += ' AND v.power_state = ?'; params.push(power_state); }
  if (cluster_id) { query += ' AND v.vcenter_cluster_id = ?'; params.push(cluster_id); }
  // Critical (any metric >=90%) first, then high (>=70%), so VMs under real resource pressure
  // surface at the top instead of being buried alphabetically among 100+ healthy VMs.
  query += `
    ORDER BY
      CASE WHEN v.cpu_pct >= 90 OR v.mem_pct >= 90 OR v.disk_pct >= 90 THEN 0
           WHEN v.cpu_pct >= 70 OR v.mem_pct >= 70 OR v.disk_pct >= 70 THEN 1
           ELSE 2 END,
      v.name ASC
  `;
  res.json(await db.prepare(query).all(...params));
});

router.get('/stats', async (req, res) => {
  const total = (await db.prepare('SELECT COUNT(*) as cnt FROM vcenter_vms').get()).cnt;
  const on = (await db.prepare("SELECT COUNT(*) as cnt FROM vcenter_vms WHERE power_state='POWERED_ON'").get()).cnt;
  const off = (await db.prepare("SELECT COUNT(*) as cnt FROM vcenter_vms WHERE power_state='POWERED_OFF'").get()).cnt;
  const lastSync = (await db.prepare('SELECT MAX(last_synced_at) as t FROM vcenter_vms').get()).t;
  const clusterCount = (await db.prepare('SELECT COUNT(*) as cnt FROM vcenter_clusters WHERE enabled=1').get()).cnt;
  res.json({ total, on, off, unknown: total - on - off, lastSync, configured: clusterCount > 0, clusterCount });
});

router.post('/sync', requirePermission('vcenter.sync'), async (req, res) => {
  try {
    const r = await collector.syncVMs();
    res.json({ message: 'Đã đồng bộ', ...r });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── Cụm vCenter (kết nối) — CRUD, Admin-only vì chạm mật khẩu hạ tầng ──

// Read access is open to any authenticated role (same convention as GET /vms, GET /servers, etc.
// — list endpoints are ungated, only writes are permission-gated) since host/username/status isn't
// sensitive on its own; sanitizeCluster() still strips password regardless of who's asking. Needed
// unguarded so the VM list's cluster filter and the "Tạo VM" wizard's cluster picker work for any
// role that can already see/create VMs, not just Admins.
router.get('/clusters', async (req, res) => {
  const clusters = await db.prepare(`
    SELECT c.*, COUNT(v.id) as vm_count
    FROM vcenter_clusters c LEFT JOIN vcenter_vms v ON v.vcenter_cluster_id = c.id
    GROUP BY c.id ORDER BY c.name ASC
  `).all();
  res.json(clusters.map(sanitizeCluster));
});

router.post('/clusters', requirePermission('vcenter.cluster.manage'), async (req, res) => {
  const { name, host, username, password, insecure, enabled } = req.body;
  if (!name || !host || !username || !password) return res.status(400).json({ error: 'Thiếu name/host/username/password' });
  const result = await db.prepare(`
    INSERT INTO vcenter_clusters (name, host, username, password, insecure, enabled)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(name, host, username, password, insecure === false ? 0 : 1, enabled === false ? 0 : 1);
  await logActivity(req.user, 'CREATE', 'vcenter_cluster', result.lastInsertRowid, name);
  res.status(201).json({ id: result.lastInsertRowid, message: 'Đã tạo cụm vCenter' });
});

router.put('/clusters/:id', requirePermission('vcenter.cluster.manage'), async (req, res) => {
  const cluster = await db.prepare('SELECT id, name FROM vcenter_clusters WHERE id = ?').get(req.params.id);
  if (!cluster) return res.status(404).json({ error: 'Không tìm thấy cụm' });
  const { name, host, username, password, insecure, enabled } = req.body;
  if (!name || !host || !username) return res.status(400).json({ error: 'Thiếu name/host/username' });
  // Blank password means "keep the existing one" — same COALESCE/NULLIF pattern routes/servers.js
  // uses for ipmi_password, so the edit form never needs to round-trip the real password.
  await db.prepare(`
    UPDATE vcenter_clusters SET name=?, host=?, username=?, password=COALESCE(NULLIF(?, ''), password),
      insecure=?, enabled=?, updated_at=CURRENT_TIMESTAMP WHERE id=?
  `).run(name, host, username, password || '', insecure === false ? 0 : 1, enabled === false ? 0 : 1, req.params.id);
  registry.invalidate(Number(req.params.id));
  await logActivity(req.user, 'UPDATE', 'vcenter_cluster', req.params.id, name);
  res.json({ message: 'Đã cập nhật' });
});

router.delete('/clusters/:id', requirePermission('vcenter.cluster.manage'), async (req, res) => {
  const cluster = await db.prepare('SELECT id, name FROM vcenter_clusters WHERE id = ?').get(req.params.id);
  if (!cluster) return res.status(404).json({ error: 'Không tìm thấy cụm' });
  if (req.body?.confirmName !== cluster.name) return res.status(400).json({ error: 'Tên xác nhận không khớp' });
  // No FK CASCADE in this schema (same convention as routes/monitors.js's monitor delete) —
  // manually clean up the VMs + their metric history that belonged to this cluster.
  const run = db.transaction(async () => {
    await db.prepare('DELETE FROM vm_metrics_history WHERE vm_id IN (SELECT id FROM vcenter_vms WHERE vcenter_cluster_id = ?)').run(req.params.id);
    await db.prepare('DELETE FROM vcenter_vms WHERE vcenter_cluster_id = ?').run(req.params.id);
    await db.prepare('DELETE FROM vcenter_clusters WHERE id = ?').run(req.params.id);
  });
  await run();
  registry.invalidate(Number(req.params.id));
  await logActivity(req.user, 'DELETE', 'vcenter_cluster', req.params.id, cluster.name);
  res.json({ message: 'Đã xóa cụm' });
});

// Test chưa lưu (đang điền form thêm mới) — không cache, không ghi DB.
router.post('/clusters/test', requirePermission('vcenter.cluster.manage'), async (req, res) => {
  const { host, username, password, insecure } = req.body;
  if (!host || !username || !password) return res.status(400).json({ error: 'Thiếu host/username/password' });
  const vcenterClient = require('../vcenter-client');
  try {
    await vcenterClient.run({ host, username, password, insecure: insecure !== false, restToken: null, soapCookie: null }, async () => {
      await vcenterClient.rest('GET', '/api/vcenter/vm');
    });
    res.json({ ok: true, message: 'Kết nối thành công' });
  } catch (e) {
    res.json({ ok: false, message: e.message });
  }
});

// Test lại 1 cụm đã lưu — luôn login mới, không dùng session cache.
router.post('/clusters/:id/test', requirePermission('vcenter.cluster.manage'), async (req, res) => {
  const cluster = await db.prepare('SELECT * FROM vcenter_clusters WHERE id = ?').get(req.params.id);
  if (!cluster) return res.status(404).json({ error: 'Không tìm thấy cụm' });
  registry.invalidate(Number(req.params.id));
  try {
    await registry.withClient(Number(req.params.id), async () => {
      const client = require('../vcenter-client');
      await client.rest('GET', '/api/vcenter/vm');
    });
    res.json({ ok: true, message: 'Kết nối thành công' });
  } catch (e) {
    res.json({ ok: false, message: e.message });
  }
});

router.post('/clusters/:id/sync', requirePermission('vcenter.sync'), async (req, res) => {
  const cluster = await db.prepare('SELECT * FROM vcenter_clusters WHERE id = ?').get(req.params.id);
  if (!cluster) return res.status(404).json({ error: 'Không tìm thấy cụm' });
  const r = await collector.syncOneCluster(cluster);
  res.json({ message: 'Đã đồng bộ', result: r });
});

// ── Đặt chỗ tạo VM (host/datastore/network/folder/template) — luôn thuộc 1 cụm cụ thể ──

router.get('/placement', async (req, res) => {
  const clusterId = await requireClusterId(req, res); if (!clusterId) return;
  try { res.json(await registry.withClient(clusterId, () => actions.listPlacement())); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

router.get('/templates', async (req, res) => {
  const clusterId = await requireClusterId(req, res); if (!clusterId) return;
  try { res.json(await registry.withClient(clusterId, () => actions.listTemplates())); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

router.get('/templates/:moref/spec', async (req, res) => {
  const clusterId = await requireClusterId(req, res); if (!clusterId) return;
  try { res.json(await registry.withClient(clusterId, () => actions.getVmSpec(req.params.moref))); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

router.get('/guest-os', (req, res) => {
  res.json(actions.listGuestOsOptions());
});

router.get('/datastore/:moref/isos', async (req, res) => {
  const clusterId = await requireClusterId(req, res); if (!clusterId) return;
  try { res.json(await registry.withClient(clusterId, () => actions.listDatastoreIsos(req.params.moref))); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

router.post('/vms', requirePermission('vcenter.vm.create'), async (req, res) => {
  const b = req.body;
  const clusterId = await requireClusterId(req, res); if (!clusterId) return;
  try {
    let result;
    if (b.mode === 'clone') {
      if (!b.templateMoref || !b.name || !b.hostId || !b.datastoreId || !b.folderId) {
        return res.status(400).json({ error: 'Thiếu templateMoref/name/hostId/datastoreId/folderId' });
      }
      result = await registry.withClient(clusterId, () => actions.cloneVM(b, req.user));
    } else {
      if (!b.name || !b.hostId || !b.datastoreId || !b.folderId) {
        return res.status(400).json({ error: 'Thiếu name/hostId/datastoreId/folderId' });
      }
      result = await registry.withClient(clusterId, () => actions.createEmptyVM(b, req.user));
    }
    await collector.syncVMs();
    res.status(201).json(result);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── Hành động trên 1 VM đã có — khóa theo id nội bộ (không phải moref, vốn chỉ duy nhất trong 1 cụm) ──

router.post('/vms/:id/console', requirePermission('vcenter.vm.console'), async (req, res) => {
  const vm = await getVmForAction(req, res); if (!vm) return;
  try {
    res.json(await registry.withClient(vm.vcenter_cluster_id, () => actions.getConsoleTicket(vm.moref)));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.post('/vms/:id/power', requirePermission('vcenter.vm.power'), async (req, res) => {
  const vm = await getVmForAction(req, res); if (!vm) return;
  try {
    await registry.withClient(vm.vcenter_cluster_id, () => actions.powerAction(vm.moref, req.body.action, req.user));
    await collector.syncVMs();
    res.json({ message: 'OK' });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.patch('/vms/:id/hardware', requirePermission('vcenter.vm.edit'), async (req, res) => {
  const vm = await getVmForAction(req, res); if (!vm) return;
  try {
    await registry.withClient(vm.vcenter_cluster_id, () => actions.updateHardware(vm.moref, req.body, req.user));
    await collector.syncVMs();
    res.json({ message: 'OK' });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.patch('/vms/:id/rename', requirePermission('vcenter.vm.edit'), async (req, res) => {
  const vm = await getVmForAction(req, res); if (!vm) return;
  try {
    await registry.withClient(vm.vcenter_cluster_id, () => actions.renameVM(vm.moref, req.body.name, req.user));
    await collector.syncVMs();
    res.json({ message: 'OK' });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.delete('/vms/:id', requirePermission('vcenter.vm.delete'), async (req, res) => {
  const vm = await getVmForAction(req, res); if (!vm) return;
  if (req.body?.confirmName !== vm.name) {
    return res.status(400).json({ error: 'Tên xác nhận không khớp' });
  }
  try {
    await registry.withClient(vm.vcenter_cluster_id, () => actions.deleteVM(vm.moref, req.user));
    res.json({ message: 'Đã xóa' });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

module.exports = router;
