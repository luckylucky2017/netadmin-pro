const express = require('express');
const router = express.Router();
const db = require('../database');
const client = require('../pfsense-client');
const collector = require('../pfsense-collector');
const { requirePermission, logActivity } = require('../auth');

// password/api_key are credentials — never returned to the client, same treatment as
// vcenter_clusters.password. if_bandwidth_snapshot/vpn_bandwidth_snapshot are internal bookkeeping
// (raw byte counters used to compute bps deltas between polls) — same treatment as
// servers.snmp_if_prev_snapshot, no UI ever needs the raw snapshot.
function sanitizeFirewall(fw) {
  if (!fw) return fw;
  const { password, api_key, if_bandwidth_snapshot, vpn_bandwidth_snapshot, ...rest } = fw;
  return { ...rest, has_password: !!password, has_api_key: !!api_key };
}

async function requireFirewall(req, res) {
  const fw = await db.prepare('SELECT * FROM pfsense_firewalls WHERE id = ?').get(req.params.id);
  if (!fw) { res.status(404).json({ error: 'Không tìm thấy firewall pfSense' }); return null; }
  return fw;
}

// The API's /firewall/rule id param is the rule's array index in pfSense's config — it can drift
// whenever another rule is added/removed/reordered. rule_tracker is stable, so before any
// edit/delete we re-fetch the live rule list and resolve the CURRENT id from the tracker, instead
// of trusting whatever index was cached at last sync.
async function resolveLiveRuleId(fw, tracker) {
  const res = await client.request(fw, 'GET', '/firewall/rules?limit=0');
  const rule = (res?.data || []).find(r => String(r.tracker) === String(tracker));
  if (!rule) throw Object.assign(new Error('Rule không còn tồn tại trên pfSense (có thể đã bị xóa/thay đổi bên ngoài)'), { statusCode: 404 });
  return rule.id;
}

// ── Kết nối pfSense — CRUD, Admin-only vì chạm mật khẩu hạ tầng ──

// Read access open to any authenticated role (same convention as GET /vcenter/clusters) —
// sanitizeFirewall() strips password/api_key regardless of who's asking.
router.get('/firewalls', async (req, res) => {
  const firewalls = await db.prepare('SELECT * FROM pfsense_firewalls ORDER BY name ASC').all();
  res.json(firewalls.map(sanitizeFirewall));
});

router.post('/firewalls', requirePermission('pfsense.manage'), async (req, res) => {
  const { name, host, port, auth_type, username, password, api_key, insecure, enabled } = req.body;
  if (!name || !host) return res.status(400).json({ error: 'Thiếu name/host' });
  if (auth_type === 'api_key' && !api_key) return res.status(400).json({ error: 'Thiếu api_key' });
  if (auth_type !== 'api_key' && (!username || !password)) return res.status(400).json({ error: 'Thiếu username/password' });
  const result = await db.prepare(`
    INSERT INTO pfsense_firewalls (name, host, port, auth_type, username, password, api_key, insecure, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, host, port || 443, auth_type === 'api_key' ? 'api_key' : 'basic', username || null, password || null, api_key || null, insecure === false ? 0 : 1, enabled === false ? 0 : 1);
  await logActivity(req.user, 'CREATE', 'pfsense_firewall', result.lastInsertRowid, name);
  res.status(201).json({ id: result.lastInsertRowid, message: 'Đã tạo kết nối pfSense' });
});

router.put('/firewalls/:id', requirePermission('pfsense.manage'), async (req, res) => {
  const fw = await requireFirewall(req, res); if (!fw) return;
  const { name, host, port, auth_type, username, password, api_key, insecure, enabled } = req.body;
  if (!name || !host) return res.status(400).json({ error: 'Thiếu name/host' });
  // Blank password/api_key = keep existing — same COALESCE/NULLIF pattern as vcenter_clusters.password.
  await db.prepare(`
    UPDATE pfsense_firewalls SET name=?, host=?, port=?, auth_type=?, username=?,
      password=COALESCE(NULLIF(?, ''), password), api_key=COALESCE(NULLIF(?, ''), api_key),
      insecure=?, enabled=?, updated_at=CURRENT_TIMESTAMP WHERE id=?
  `).run(name, host, port || 443, auth_type === 'api_key' ? 'api_key' : 'basic', username || null,
    password || '', api_key || '', insecure === false ? 0 : 1, enabled === false ? 0 : 1, req.params.id);
  await logActivity(req.user, 'UPDATE', 'pfsense_firewall', req.params.id, name);
  res.json({ message: 'Đã cập nhật' });
});

router.delete('/firewalls/:id', requirePermission('pfsense.manage'), async (req, res) => {
  const fw = await requireFirewall(req, res); if (!fw) return;
  if (req.body?.confirmName !== fw.name) return res.status(400).json({ error: 'Tên xác nhận không khớp' });
  const run = db.transaction(async () => {
    await db.prepare('DELETE FROM pfsense_interfaces WHERE firewall_id = ?').run(req.params.id);
    await db.prepare('DELETE FROM pfsense_firewall_rules WHERE firewall_id = ?').run(req.params.id);
    await db.prepare('DELETE FROM pfsense_vpn_status WHERE firewall_id = ?').run(req.params.id);
    await db.prepare('DELETE FROM pfsense_firewalls WHERE id = ?').run(req.params.id);
  });
  await run();
  await logActivity(req.user, 'DELETE', 'pfsense_firewall', req.params.id, fw.name);
  res.json({ message: 'Đã xóa kết nối' });
});

// Test chưa lưu (đang điền form thêm mới) — không ghi DB.
router.post('/firewalls/test', requirePermission('pfsense.manage'), async (req, res) => {
  const { host, port, auth_type, username, password, api_key, insecure } = req.body;
  if (!host) return res.status(400).json({ error: 'Thiếu host' });
  try {
    const sys = await client.testConnection({ host, port: port || 443, auth_type: auth_type === 'api_key' ? 'api_key' : 'basic', username, password, api_key, insecure: insecure !== false });
    res.json({ ok: true, message: 'Kết nối thành công', platform: sys?.platform, uptime: sys?.uptime });
  } catch (e) {
    res.json({ ok: false, message: e.message });
  }
});

router.post('/firewalls/:id/test', requirePermission('pfsense.manage'), async (req, res) => {
  const fw = await requireFirewall(req, res); if (!fw) return;
  try {
    const sys = await client.testConnection(fw);
    res.json({ ok: true, message: 'Kết nối thành công', platform: sys?.platform, uptime: sys?.uptime });
  } catch (e) {
    res.json({ ok: false, message: e.message });
  }
});

router.post('/firewalls/:id/sync', requirePermission('pfsense.sync'), async (req, res) => {
  const fw = await requireFirewall(req, res); if (!fw) return;
  const result = await collector.syncOneFirewall(fw);
  if (result.error) return res.status(502).json({ error: result.error });
  res.json({ message: 'Đã đồng bộ', result });
});

// ── Trạng thái (system/interfaces/gateways) — đọc mở cho mọi role đã đăng nhập ──

router.get('/firewalls/:id/status', async (req, res) => {
  const fw = await requireFirewall(req, res); if (!fw) return;
  try {
    const sys = await client.testConnection(fw);
    const interfaces = await db.prepare('SELECT if_name, description, status, ip_address, gateway_status, in_bytes, out_bytes, in_bps, out_bps, updated_at FROM pfsense_interfaces WHERE firewall_id = ? ORDER BY if_name ASC').all(fw.id);
    res.json({ system: sys, interfaces });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.get('/firewalls/:id/vpn', async (req, res) => {
  const fw = await requireFirewall(req, res); if (!fw) return;
  const rows = await db.prepare('SELECT vpn_type, tunnel_name, status, remote_info, connected_since, bytes_recv, bytes_sent, rate_recv_bps, rate_sent_bps, updated_at FROM pfsense_vpn_status WHERE firewall_id = ? ORDER BY vpn_type ASC, tunnel_name ASC').all(fw.id);
  res.json(rows);
});

// ── Rule tường lửa — đọc từ cache, ghi trực tiếp lên pfSense thật rồi đồng bộ lại ──

router.get('/firewalls/:id/rules', async (req, res) => {
  const fw = await requireFirewall(req, res); if (!fw) return;
  const rows = await db.prepare('SELECT id, rule_tracker, interface, action, protocol, source, destination, description, enabled, sort_order FROM pfsense_firewall_rules WHERE firewall_id = ? ORDER BY sort_order ASC').all(fw.id);
  res.json(rows);
});

router.post('/firewalls/:id/rules', requirePermission('pfsense.rules.write'), async (req, res) => {
  const fw = await requireFirewall(req, res); if (!fw) return;
  const { type, interface: iface, ipprotocol, protocol, source, destination, source_port, destination_port, descr, disabled, log } = req.body;
  if (!type || !iface || !ipprotocol || !source || !destination) {
    return res.status(400).json({ error: 'Thiếu type/interface/ipprotocol/source/destination' });
  }
  try {
    await client.request(fw, 'POST', '/firewall/rule', {
      type, interface: Array.isArray(iface) ? iface : [iface], ipprotocol,
      protocol: protocol || undefined, source, destination,
      source_port: source_port || null, destination_port: destination_port || null,
      descr: descr || '', disabled: !!disabled, log: !!log
    });
    await collector.syncOneFirewall(fw);
    await logActivity(req.user, 'CREATE', 'pfsense_rule', fw.id, descr || `${type} ${source}->${destination}`);
    res.status(201).json({ message: 'Đã tạo rule — nhớ bấm "Áp dụng thay đổi" để có hiệu lực' });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.put('/firewalls/:id/rules/:tracker', requirePermission('pfsense.rules.write'), async (req, res) => {
  const fw = await requireFirewall(req, res); if (!fw) return;
  const { type, interface: iface, ipprotocol, protocol, source, destination, source_port, destination_port, descr, disabled, log } = req.body;
  try {
    const id = await resolveLiveRuleId(fw, req.params.tracker);
    await client.request(fw, 'PATCH', '/firewall/rule', {
      id,
      ...(type ? { type } : {}),
      ...(iface ? { interface: Array.isArray(iface) ? iface : [iface] } : {}),
      ...(ipprotocol ? { ipprotocol } : {}),
      ...(protocol ? { protocol } : {}),
      ...(source ? { source } : {}),
      ...(destination ? { destination } : {}),
      source_port: source_port ?? null, destination_port: destination_port ?? null,
      ...(descr !== undefined ? { descr } : {}),
      ...(disabled !== undefined ? { disabled: !!disabled } : {}),
      ...(log !== undefined ? { log: !!log } : {})
    });
    await collector.syncOneFirewall(fw);
    await logActivity(req.user, 'UPDATE', 'pfsense_rule', fw.id, descr || req.params.tracker);
    res.json({ message: 'Đã cập nhật rule — nhớ bấm "Áp dụng thay đổi" để có hiệu lực' });
  } catch (e) {
    res.status(e.statusCode === 404 ? 404 : 502).json({ error: e.message });
  }
});

router.patch('/firewalls/:id/rules/:tracker/toggle', requirePermission('pfsense.rules.write'), async (req, res) => {
  const fw = await requireFirewall(req, res); if (!fw) return;
  try {
    const id = await resolveLiveRuleId(fw, req.params.tracker);
    await client.request(fw, 'PATCH', '/firewall/rule', { id, disabled: !!req.body.disabled });
    await collector.syncOneFirewall(fw);
    await logActivity(req.user, 'UPDATE', 'pfsense_rule', fw.id, `${req.body.disabled ? 'tắt' : 'bật'} rule ${req.params.tracker}`);
    res.json({ message: 'Đã cập nhật — nhớ bấm "Áp dụng thay đổi" để có hiệu lực' });
  } catch (e) {
    res.status(e.statusCode === 404 ? 404 : 502).json({ error: e.message });
  }
});

router.delete('/firewalls/:id/rules/:tracker', requirePermission('pfsense.rules.delete'), async (req, res) => {
  const fw = await requireFirewall(req, res); if (!fw) return;
  try {
    const id = await resolveLiveRuleId(fw, req.params.tracker);
    // id sent both via query string (per the documented `in: query` param) AND JSON body — this
    // pfSense-pkg-API version's DELETE handler rejected a query-string-only id with "Field `id` is
    // required" in live testing, so both are included for compatibility.
    await client.request(fw, 'DELETE', `/firewall/rule?id=${id}`, { id });
    await collector.syncOneFirewall(fw);
    await logActivity(req.user, 'DELETE', 'pfsense_rule', fw.id, req.params.tracker);
    res.json({ message: 'Đã xóa rule — nhớ bấm "Áp dụng thay đổi" để có hiệu lực' });
  } catch (e) {
    res.status(e.statusCode === 404 ? 404 : 502).json({ error: e.message });
  }
});

router.post('/firewalls/:id/apply', requirePermission('pfsense.rules.write'), async (req, res) => {
  const fw = await requireFirewall(req, res); if (!fw) return;
  try {
    await client.request(fw, 'POST', '/firewall/apply');
    await logActivity(req.user, 'UPDATE', 'pfsense_firewall', fw.id, `${fw.name} (áp dụng thay đổi)`);
    res.json({ message: 'Đã áp dụng thay đổi' });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── OpenVPN — chỉ xem + sửa server đã tồn tại, không tạo mới từ đầu (rủi ro PKI) ──

router.get('/firewalls/:id/openvpn/servers', async (req, res) => {
  const fw = await requireFirewall(req, res); if (!fw) return;
  try {
    const res2 = await client.request(fw, 'GET', '/vpn/openvpn/servers?limit=0');
    res.json(res2?.data || []);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.put('/firewalls/:id/openvpn/servers/:vpnid', requirePermission('pfsense.vpn.manage'), async (req, res) => {
  const fw = await requireFirewall(req, res); if (!fw) return;
  const { description, maxclients, disable } = req.body;
  try {
    await client.request(fw, 'PATCH', '/vpn/openvpn/server', {
      id: Number(req.params.vpnid),
      ...(description !== undefined ? { description } : {}),
      ...(maxclients !== undefined ? { maxclients } : {}),
      ...(disable !== undefined ? { disable: !!disable } : {})
    });
    await logActivity(req.user, 'UPDATE', 'pfsense_openvpn_server', fw.id, `OpenVPN server #${req.params.vpnid}`);
    res.json({ message: 'Đã cập nhật cấu hình OpenVPN' });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

module.exports = router;
