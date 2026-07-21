const express = require('express');
const router = express.Router();
const db = require('../database');
const client = require('../mikrotik-client');
const collector = require('../mikrotik-collector');
const { requirePermission, logActivity } = require('../auth');

// password is a credential — never returned to the client, same treatment as
// pfsense_firewalls.password/vcenter_clusters.password. if_bandwidth_snapshot is internal
// bookkeeping (raw byte counters for bps deltas), same treatment as pfSense's equivalent column.
function sanitizeFirewall(fw) {
  if (!fw) return fw;
  const { password, if_bandwidth_snapshot, ...rest } = fw;
  return { ...rest, has_password: !!password };
}

async function requireFirewall(req, res) {
  const fw = await db.prepare('SELECT * FROM mikrotik_firewalls WHERE id = ?').get(req.params.id);
  if (!fw) { res.status(404).json({ error: 'Không tìm thấy firewall MikroTik' }); return null; }
  return fw;
}

// Read access open to any authenticated role (same convention as GET /pfsense/firewalls) —
// sanitizeFirewall() strips the password regardless of who's asking.
router.get('/firewalls', async (req, res) => {
  const firewalls = await db.prepare('SELECT * FROM mikrotik_firewalls ORDER BY name ASC').all();
  res.json(firewalls.map(sanitizeFirewall));
});

router.post('/firewalls', requirePermission('mikrotik.manage'), async (req, res) => {
  const { name, host, port, username, password, enabled } = req.body;
  if (!name || !host || !username || !password) return res.status(400).json({ error: 'Thiếu name/host/username/password' });
  const result = await db.prepare(`
    INSERT INTO mikrotik_firewalls (name, host, port, username, password, enabled)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(name, host, port || 8728, username, password, enabled === false ? 0 : 1);
  await logActivity(req.user, 'CREATE', 'mikrotik_firewall', result.lastInsertRowid, name);
  res.status(201).json({ id: result.lastInsertRowid, message: 'Đã tạo kết nối MikroTik' });
});

router.put('/firewalls/:id', requirePermission('mikrotik.manage'), async (req, res) => {
  const fw = await requireFirewall(req, res); if (!fw) return;
  const { name, host, port, username, password, enabled } = req.body;
  if (!name || !host || !username) return res.status(400).json({ error: 'Thiếu name/host/username' });
  // Blank password = keep existing — same COALESCE/NULLIF pattern as pfsense_firewalls.password.
  await db.prepare(`
    UPDATE mikrotik_firewalls SET name=?, host=?, port=?, username=?,
      password=COALESCE(NULLIF(?, ''), password), enabled=?, updated_at=CURRENT_TIMESTAMP WHERE id=?
  `).run(name, host, port || 8728, username, password || '', enabled === false ? 0 : 1, req.params.id);
  await logActivity(req.user, 'UPDATE', 'mikrotik_firewall', req.params.id, name);
  res.json({ message: 'Đã cập nhật' });
});

router.delete('/firewalls/:id', requirePermission('mikrotik.manage'), async (req, res) => {
  const fw = await requireFirewall(req, res); if (!fw) return;
  if (req.body?.confirmName !== fw.name) return res.status(400).json({ error: 'Tên xác nhận không khớp' });
  const run = db.transaction(async () => {
    await db.prepare('DELETE FROM mikrotik_interfaces WHERE firewall_id = ?').run(req.params.id);
    await db.prepare('DELETE FROM mikrotik_firewall_rules WHERE firewall_id = ?').run(req.params.id);
    await db.prepare('DELETE FROM mikrotik_firewalls WHERE id = ?').run(req.params.id);
  });
  await run();
  await logActivity(req.user, 'DELETE', 'mikrotik_firewall', req.params.id, fw.name);
  res.json({ message: 'Đã xóa kết nối' });
});

// Test chưa lưu (đang điền form thêm mới) — không ghi DB.
router.post('/firewalls/test', requirePermission('mikrotik.manage'), async (req, res) => {
  const { host, port, username, password } = req.body;
  if (!host || !username) return res.status(400).json({ error: 'Thiếu host/username' });
  const result = await client.testConnection({ host, port: port || 8728, username, password });
  res.json(result);
});

router.post('/firewalls/:id/test', requirePermission('mikrotik.manage'), async (req, res) => {
  const fw = await requireFirewall(req, res); if (!fw) return;
  const result = await client.testConnection(fw);
  res.json(result);
});

router.post('/firewalls/:id/sync', requirePermission('mikrotik.sync'), async (req, res) => {
  const fw = await requireFirewall(req, res); if (!fw) return;
  const result = await collector.syncOneFirewall(fw);
  if (!result.ok) return res.status(502).json({ error: result.error });
  res.json({ message: 'Đã đồng bộ', result });
});

// ── Interface — chỉ đọc (giám sát traffic), không có hành động ghi ──

router.get('/firewalls/:id/interfaces', async (req, res) => {
  const fw = await requireFirewall(req, res); if (!fw) return;
  const rows = await db.prepare('SELECT ros_id, name, type, running, disabled, in_bps, out_bps, updated_at FROM mikrotik_interfaces WHERE firewall_id = ? ORDER BY name ASC').all(fw.id);
  res.json(rows);
});

// ── Rule tường lửa — đọc từ cache, ghi trực tiếp lên MikroTik thật rồi đồng bộ lại. RouterOS áp
// dụng thay đổi filter rule ngay lập tức (không có bước "apply" riêng như pfSense). ──

router.get('/firewalls/:id/rules', async (req, res) => {
  const fw = await requireFirewall(req, res); if (!fw) return;
  const rows = await db.prepare('SELECT id, ros_id, chain, action, protocol, src_address, dst_address, dst_port, comment, disabled, sort_order FROM mikrotik_firewall_rules WHERE firewall_id = ? ORDER BY sort_order ASC').all(fw.id);
  res.json(rows);
});

router.post('/firewalls/:id/rules', requirePermission('mikrotik.rules.write'), async (req, res) => {
  const fw = await requireFirewall(req, res); if (!fw) return;
  const { chain, action, protocol, src_address, dst_address, dst_port, comment, disabled } = req.body;
  if (!chain || !action) return res.status(400).json({ error: 'Thiếu chain/action' });
  try {
    const params = [`=chain=${chain}`, `=action=${action}`];
    if (protocol) params.push(`=protocol=${protocol}`);
    if (src_address) params.push(`=src-address=${src_address}`);
    if (dst_address) params.push(`=dst-address=${dst_address}`);
    if (dst_port) params.push(`=dst-port=${dst_port}`);
    if (comment) params.push(`=comment=${comment}`);
    params.push(`=disabled=${disabled ? 'yes' : 'no'}`);
    await client.withConnection(fw, (conn) => conn.write('/ip/firewall/filter/add', params));
    await collector.syncOneFirewall(fw);
    await logActivity(req.user, 'CREATE', 'mikrotik_rule', fw.id, comment || `${chain}/${action}`);
    res.status(201).json({ message: 'Đã tạo rule' });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.put('/firewalls/:id/rules/:rosId', requirePermission('mikrotik.rules.write'), async (req, res) => {
  const fw = await requireFirewall(req, res); if (!fw) return;
  const { chain, action, protocol, src_address, dst_address, dst_port, comment, disabled } = req.body;
  try {
    const params = [`=.id=${req.params.rosId}`];
    if (chain) params.push(`=chain=${chain}`);
    if (action) params.push(`=action=${action}`);
    // Explicit "" clears the field on RouterOS (vs. omitting it, which leaves the existing value)
    // — protocol/addresses/port/comment are all optional-to-clear, unlike chain/action.
    if (protocol !== undefined) params.push(`=protocol=${protocol}`);
    if (src_address !== undefined) params.push(`=src-address=${src_address}`);
    if (dst_address !== undefined) params.push(`=dst-address=${dst_address}`);
    if (dst_port !== undefined) params.push(`=dst-port=${dst_port}`);
    if (comment !== undefined) params.push(`=comment=${comment}`);
    if (disabled !== undefined) params.push(`=disabled=${disabled ? 'yes' : 'no'}`);
    await client.withConnection(fw, (conn) => conn.write('/ip/firewall/filter/set', params));
    await collector.syncOneFirewall(fw);
    await logActivity(req.user, 'UPDATE', 'mikrotik_rule', fw.id, comment || req.params.rosId);
    res.json({ message: 'Đã cập nhật rule' });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.patch('/firewalls/:id/rules/:rosId/toggle', requirePermission('mikrotik.rules.write'), async (req, res) => {
  const fw = await requireFirewall(req, res); if (!fw) return;
  try {
    await client.withConnection(fw, (conn) => conn.write('/ip/firewall/filter/set', [
      `=.id=${req.params.rosId}`, `=disabled=${req.body.disabled ? 'yes' : 'no'}`
    ]));
    await collector.syncOneFirewall(fw);
    await logActivity(req.user, 'UPDATE', 'mikrotik_rule', fw.id, `${req.body.disabled ? 'tắt' : 'bật'} rule ${req.params.rosId}`);
    res.json({ message: 'Đã cập nhật' });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.delete('/firewalls/:id/rules/:rosId', requirePermission('mikrotik.rules.delete'), async (req, res) => {
  const fw = await requireFirewall(req, res); if (!fw) return;
  try {
    await client.withConnection(fw, (conn) => conn.write('/ip/firewall/filter/remove', [`=.id=${req.params.rosId}`]));
    await collector.syncOneFirewall(fw);
    await logActivity(req.user, 'DELETE', 'mikrotik_rule', fw.id, req.params.rosId);
    res.json({ message: 'Đã xóa rule' });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

module.exports = router;
