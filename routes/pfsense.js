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

// Picks the OpenVPN server a user/cert/export operation targets. serverId is the server's vpnid
// (what pfSense calls it elsewhere, e.g. status/openvpn/servers) — defaults to the first configured
// server when omitted, which covers every real deployment seen so far (exactly 1 server).
async function resolveOpenvpnServer(fw, serverId) {
  const res = await client.request(fw, 'GET', '/vpn/openvpn/servers?limit=0');
  const servers = res?.data || [];
  const server = serverId ? servers.find(s => s.vpnid === Number(serverId)) : servers[0];
  if (!server) throw Object.assign(new Error('Không tìm thấy OpenVPN server nào trên firewall này'), { statusCode: 404 });
  return server;
}

async function resolveOpenvpnUser(fw, name) {
  const res = await client.request(fw, 'GET', '/users?limit=0');
  const user = (res?.data || []).find(u => u.name === name);
  if (!user) throw Object.assign(new Error('Không tìm thấy user OpenVPN này trên pfSense'), { statusCode: 404 });
  return user;
}

// CSO (Client Specific Override) has no upsert-by-common_name endpoint — callers that want
// "create or update" resolve the existing one (if any) first, same id-before-write pattern as
// resolveLiveRuleId() above.
async function resolveOpenvpnCso(fw, commonName) {
  const res = await client.request(fw, 'GET', '/vpn/openvpn/csos?limit=0');
  return (res?.data || []).find(c => c.common_name === commonName) || null;
}

// This deployment's ~90 real CSOs force a client's VPN IP via a raw `ifconfig-push <ip> <mask>`
// custom_options directive, NOT pfSense's native tunnel_network CSO field (confirmed empty on
// every single existing CSO checked) — so static-IP read/write has to go through custom_options to
// match what's actually configured, not the field that would be "correct" on a fresh install.
const IFCONFIG_PUSH_RE = /^ifconfig-push\s+(\S+)\s+(\S+)/i;
function extractStaticIp(cso) {
  const opt = (cso?.custom_options || []).find(o => IFCONFIG_PUSH_RE.test(o));
  return opt ? IFCONFIG_PUSH_RE.exec(opt)[1] : (cso?.tunnel_network || null);
}

// Merges a plain `staticIp` field (from our own form) into the custom_options array pfSense
// actually stores it in — replacing any existing ifconfig-push line, preserving every other
// custom option untouched. `existingOptions` should be the CSO's current custom_options if editing
// one, or [] when creating fresh. Netmask is always 255.255.255.0 in every real example seen.
function applyStaticIpToCsoPayload(payload, existingOptions = []) {
  const { staticIp, ...rest } = payload;
  if (staticIp === undefined) return rest;
  const otherOptions = (existingOptions || []).filter(o => !IFCONFIG_PUSH_RE.test(o));
  rest.custom_options = staticIp ? [`ifconfig-push ${staticIp} 255.255.255.0`, ...otherOptions] : otherOptions;
  return rest;
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
  const rows = await db.prepare('SELECT vpn_type, tunnel_name, status, remote_info, connected_since, bytes_recv, bytes_sent, rate_recv_bps, rate_sent_bps, country, is_foreign, tunnel_ip, updated_at FROM pfsense_vpn_status WHERE firewall_id = ? ORDER BY is_foreign DESC, vpn_type ASC, tunnel_name ASC').all(fw.id);
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

// ── OpenVPN — xem/sửa cấu hình server đã tồn tại + quản lý user (chứng chỉ, CSO, xuất file) ──

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

// ── User OpenVPN — chứng chỉ + tài khoản cục bộ pfSense + CSO (cài đặt nâng cao) + xuất file ──
// Không cache gì ở đây (không bảng DB nào) — luôn đọc/ghi thẳng qua API pfSense, vì đây là dữ liệu
// nhạy cảm (username, chứng chỉ) không cần đồng bộ định kỳ như interface/rule/trạng thái VPN.

router.get('/firewalls/:id/openvpn/users', requirePermission('pfsense.vpn.manage'), async (req, res) => {
  const fw = await requireFirewall(req, res); if (!fw) return;
  try {
    const [usersRes, csosRes, serversRes] = await Promise.all([
      client.request(fw, 'GET', '/users?limit=0'),
      client.request(fw, 'GET', '/vpn/openvpn/csos?limit=0').catch(() => ({ data: [] })),
      client.request(fw, 'GET', '/status/openvpn/servers').catch(() => ({ data: [] }))
    ]);
    const csoByName = new Map((csosRes?.data || []).map(c => [c.common_name, c]));
    // Trạng thái kết nối thật lấy trực tiếp từ /status/openvpn/servers (không qua bảng cache
    // pfsense_vpn_status) — trang này đã theo nguyên tắc "không cache" cho toàn bộ dữ liệu user,
    // và conns[].common_name khớp đúng username (đã xác nhận: CN chứng chỉ = username).
    const connByName = new Map();
    for (const srv of serversRes?.data || []) {
      for (const c of srv.conns || []) connByName.set(c.common_name, { remoteHost: c.remote_host, connectedSince: c.connect_time });
    }
    // "Lần cuối kết nối" cho user hiện KHÔNG kết nối phải lấy từ bảng riêng
    // (pfsense_ovpn_user_last_conn) — pfsense_vpn_status chỉ giữ kết nối đang hoạt động, dữ liệu bị
    // xóa ngay khi user ngắt kết nối nên không thể trả lời "lần cuối là khi nào" cho user offline.
    const lastConnRows = await db.prepare(
      'SELECT username, last_connected_at FROM pfsense_ovpn_user_last_conn WHERE firewall_id = ?'
    ).all(fw.id);
    const lastConnByName = new Map(lastConnRows.map(r => [r.username, r.last_connected_at]));
    // Chỉ những user có gắn chứng chỉ mới là user OpenVPN thật — phân biệt với tài khoản hệ thống
    // (admin, backup...) cũng nằm trong cùng danh sách /users.
    const users = (usersRes?.data || [])
      .filter(u => Array.isArray(u.cert) && u.cert.length > 0)
      .map(u => {
        const cso = csoByName.get(u.name);
        const conn = connByName.get(u.name);
        return {
          name: u.name,
          descr: u.descr || null,
          disabled: !!u.disabled,
          expires: u.expires || null,
          hasCso: !!cso,
          csoBlocked: !!cso?.block,
          staticIp: extractStaticIp(cso),
          connected: !!conn,
          connectedSince: conn?.connectedSince || null,
          remoteHost: conn?.remoteHost || null,
          lastConnectedAt: conn?.connectedSince || lastConnByName.get(u.name) || null
        };
      });
    res.json(users);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.patch('/firewalls/:id/openvpn/users/:name', requirePermission('pfsense.vpn.manage'), async (req, res) => {
  const fw = await requireFirewall(req, res); if (!fw) return;
  const name = req.params.name;
  try {
    const user = await resolveOpenvpnUser(fw, name);
    const { disabled, expires, descr } = req.body;
    await client.request(fw, 'PATCH', '/user', {
      id: user.id,
      ...(disabled !== undefined ? { disabled: !!disabled } : {}),
      ...(expires !== undefined ? { expires: expires || '' } : {}),
      ...(descr !== undefined ? { descr } : {})
    });
    await logActivity(req.user, 'UPDATE', 'pfsense_openvpn_user', fw.id, name);
    res.json({ message: 'Đã cập nhật user' });
  } catch (e) {
    res.status(e.statusCode === 404 ? 404 : 502).json({ error: e.message });
  }
});

router.post('/firewalls/:id/openvpn/users', requirePermission('pfsense.vpn.manage'), async (req, res) => {
  const fw = await requireFirewall(req, res); if (!fw) return;
  const { name, password, descr, serverId, expires, cso } = req.body;
  if (!name || !password) return res.status(400).json({ error: 'Thiếu name/password' });

  let certRefid;
  try {
    const server = await resolveOpenvpnServer(fw, serverId);
    const certRes = await client.request(fw, 'POST', '/system/certificate/generate', {
      descr: name, caref: server.caref, keytype: 'RSA', keylen: 2048, digest_alg: 'sha256',
      lifetime: 3650, dn_commonname: name, type: 'user'
    });
    certRefid = certRes?.data?.refid;
    if (!certRefid) throw new Error('pfSense không trả về refid chứng chỉ vừa tạo');
  } catch (e) {
    return res.status(502).json({ error: `Tạo chứng chỉ thất bại: ${e.message}` });
  }

  try {
    await client.request(fw, 'POST', '/user', { name, password, descr: descr || '', cert: [certRefid], expires: expires || '' });
  } catch (e) {
    return res.status(502).json({
      error: `Đã tạo chứng chỉ (refid ${certRefid}) nhưng tạo user thất bại: ${e.message} — vào pfSense (System > Cert Manager) xóa chứng chỉ mồ côi này nếu cần.`
    });
  }

  let warning = null;
  if (cso && typeof cso === 'object' && Object.keys(cso).length) {
    try {
      await client.request(fw, 'POST', '/vpn/openvpn/cso', { common_name: name, ...applyStaticIpToCsoPayload(cso, []) });
    } catch (e) {
      warning = `Đã tạo user "${name}" nhưng lưu cài đặt nâng cao thất bại: ${e.message} — có thể sửa lại sau ở nút "Cài đặt nâng cao".`;
    }
  }

  await logActivity(req.user, 'CREATE', 'pfsense_openvpn_user', fw.id, name);
  res.status(201).json({ message: warning || `Đã tạo user OpenVPN "${name}"`, warning: !!warning });
});

router.get('/firewalls/:id/openvpn/users/:name/cso', requirePermission('pfsense.vpn.manage'), async (req, res) => {
  const fw = await requireFirewall(req, res); if (!fw) return;
  try {
    const cso = await resolveOpenvpnCso(fw, req.params.name);
    res.json(cso ? { ...cso, staticIp: extractStaticIp(cso) } : null);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.put('/firewalls/:id/openvpn/users/:name/cso', requirePermission('pfsense.vpn.manage'), async (req, res) => {
  const fw = await requireFirewall(req, res); if (!fw) return;
  const name = req.params.name;
  try {
    const existing = await resolveOpenvpnCso(fw, name);
    const payload = applyStaticIpToCsoPayload(req.body, existing?.custom_options || []);
    if (existing) {
      await client.request(fw, 'PATCH', '/vpn/openvpn/cso', { id: existing.id, ...payload });
    } else {
      await client.request(fw, 'POST', '/vpn/openvpn/cso', { common_name: name, ...payload });
    }
    await logActivity(req.user, 'UPDATE', 'pfsense_openvpn_cso', fw.id, name);
    res.json({ message: 'Đã lưu cài đặt nâng cao' });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.delete('/firewalls/:id/openvpn/users/:name', requirePermission('pfsense.vpn.manage'), async (req, res) => {
  const fw = await requireFirewall(req, res); if (!fw) return;
  const name = req.params.name;
  try {
    const user = await resolveOpenvpnUser(fw, name);
    const cso = await resolveOpenvpnCso(fw, name);
    if (cso) await client.request(fw, 'DELETE', `/vpn/openvpn/cso?id=${cso.id}`, { id: cso.id });
    await client.request(fw, 'DELETE', `/user?id=${user.id}`, { id: user.id });

    if (req.query.deleteCert === 'true' && Array.isArray(user.cert) && user.cert.length) {
      const certsRes = await client.request(fw, 'GET', '/system/certificates?limit=0');
      const certs = certsRes?.data || [];
      for (const certref of user.cert) {
        const cert = certs.find(c => c.refid === certref);
        if (cert) await client.request(fw, 'DELETE', `/system/certificate?id=${cert.id}`, { id: cert.id });
      }
    }

    await logActivity(req.user, 'DELETE', 'pfsense_openvpn_user', fw.id, name);
    res.json({ message: `Đã xóa user "${name}"` });
  } catch (e) {
    res.status(e.statusCode === 404 ? 404 : 502).json({ error: e.message });
  }
});

router.get('/firewalls/:id/openvpn/users/:name/config', requirePermission('pfsense.vpn.manage'), async (req, res) => {
  const fw = await requireFirewall(req, res); if (!fw) return;
  const name = req.params.name;
  try {
    const user = await resolveOpenvpnUser(fw, name);
    const certref = Array.isArray(user.cert) ? user.cert[0] : null;
    if (!certref) return res.status(400).json({ error: 'User chưa có chứng chỉ' });

    const server = await resolveOpenvpnServer(fw, req.query.serverId);
    const configsRes = await client.request(fw, 'GET', '/vpn/openvpn/client_export/configs?limit=0');
    const exportConfig = (configsRes?.data || []).find(c => c.server === server.vpnid);
    if (!exportConfig) {
      return res.status(400).json({ error: 'Chưa cấu hình OpenVPN Client Export cho server này trên pfSense — vào System > Pkg Manager cấu hình trước' });
    }

    const exportRes = await client.request(fw, 'POST', '/vpn/openvpn/client_export', {
      id: exportConfig.id, type: 'confinline', certref, username: name
    });
    const data = exportRes?.data;
    if (!data?.binary_data) return res.status(502).json({ error: 'pfSense không trả về nội dung file cấu hình' });

    // binary_data is plain-text .ovpn content for type=confinline (confirmed against a real export
    // in live testing) despite the field name — pfSense's other export types (confzip, inst-*) are
    // genuinely binary, but this app only ever requests confinline, so no base64 decode is needed.
    const filename = data.filename || `${name}.ovpn`;
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(data.binary_data);
  } catch (e) {
    res.status(e.statusCode === 404 ? 404 : 502).json({ error: e.message });
  }
});

module.exports = router;
