const express = require('express');
const router = express.Router();
const db = require('../database');
const { requirePermission, logActivity } = require('../auth');
const ipmiCollector = require('../ipmi-collector');
const snmpCollector = require('../snmp-collector');

// ipmi_password is a credential — never returned to the client, same treatment as
// users.password_hash. snmp_community is not a real secret (same treatment network_devices'
// original snmp_community field always had), just excluded here is snmp_if_prev_snapshot —
// internal bookkeeping (raw octet counters for the bps calc), not useful to the client.
function sanitizeServer(s) {
  if (!s) return s;
  const { ipmi_password, snmp_if_prev_snapshot, ...rest } = s;
  return rest;
}

// ssh_user is now a denormalized display cache derived from the chosen credential — the client
// sends credentialId (from the "Tài khoản kết nối" vault), not a free-text username. Resolving it
// here (rather than trusting a client-supplied ssh_user) keeps the cache always in sync with the
// credential's real username, and existing read sites (routes/security.js checks, chatbot-tools.js,
// table displays) keep working unchanged since ssh_user still holds the right string.
async function resolveSshCredential(credentialId) {
  if (!credentialId) return { ssh_credential_id: null, ssh_user: null };
  const cred = await db.prepare('SELECT id, username FROM ssh_credentials WHERE id = ?').get(credentialId);
  if (!cred) throw new Error('Không tìm thấy tài khoản kết nối SSH');
  return { ssh_credential_id: cred.id, ssh_user: cred.username };
}

router.get('/', async (req, res) => {
  const { search, status, type, tag } = req.query;
  let query = 'SELECT * FROM servers WHERE 1=1';
  const params = [];

  if (search) { query += ' AND (name LIKE ? OR ip_address LIKE ? OR hostname LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  if (status) { query += ' AND status = ?'; params.push(status); }
  if (type) { query += ' AND type = ?'; params.push(type); }
  if (tag) { query += ' AND tags LIKE ?'; params.push(`%${tag}%`); }

  query += ' ORDER BY name ASC';
  const servers = await db.prepare(query).all(...params);
  servers.forEach(s => { try { s.tags = JSON.parse(s.tags || '[]'); } catch { s.tags = []; } });
  res.json(servers.map(sanitizeServer));
});

router.get('/stats', async (req, res) => {
  const total = (await db.prepare('SELECT COUNT(*) as cnt FROM servers').get()).cnt;
  const online = (await db.prepare("SELECT COUNT(*) as cnt FROM servers WHERE status='online'").get()).cnt;
  const offline = (await db.prepare("SELECT COUNT(*) as cnt FROM servers WHERE status='offline'").get()).cnt;
  const unknown = total - online - offline;
  res.json({ total, online, offline, unknown });
});

router.get('/:id', async (req, res) => {
  const server = await db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  try { server.tags = JSON.parse(server.tags || '[]'); } catch { server.tags = []; }
  const history = await db.prepare("SELECT * FROM ping_history WHERE device_id=? AND device_type='server' ORDER BY checked_at DESC LIMIT 50").all(req.params.id);
  server.ping_history = history;
  // Short-window trend for the detail view's sparklines — metrics_history only retains ~2h
  // (purged periodically by metrics-simulator.js/ssh-collector.js), recorded every 5s (simulated)
  // or 30s (real SSH), so 200 rows comfortably covers that whole retention window.
  const metrics = await db.prepare('SELECT cpu_pct, ram_pct, disk_pct, recorded_at FROM metrics_history WHERE server_id=? ORDER BY recorded_at ASC LIMIT 200').all(req.params.id);
  server.metrics_history = metrics;
  res.json(sanitizeServer(server));
});

router.post('/', requirePermission('servers.write'), async (req, res) => {
  const { name, hostname, ip_address, type, os, cpu, ram, storage, location, rack, ssh_port, credentialId, tags, notes } = req.body;
  if (!name || !ip_address) return res.status(400).json({ error: 'Name and IP address are required' });
  const tagsJson = JSON.stringify(Array.isArray(tags) ? tags : (tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : []));
  let sshCred;
  try { sshCred = await resolveSshCredential(credentialId); } catch (e) { return res.status(400).json({ error: e.message }); }
  // IPMI credentials are gated by a separate permission from general servers.write — a request
  // without servers.ipmi_config just silently gets no IPMI fields set, rather than a 403 that would
  // block the rest of a normal server-create action.
  const canConfigIpmi = req.user.permissions.includes('servers.ipmi_config');
  const ipmi_host = canConfigIpmi ? (req.body.ipmi_host || null) : null;
  const ipmi_username = canConfigIpmi ? (req.body.ipmi_username || null) : null;
  const ipmi_password = canConfigIpmi ? (req.body.ipmi_password || null) : null;
  // SNMP config is gated the same way as IPMI's — silently dropped, not 403'd, if the requester
  // lacks servers.snmp_config, so a normal server-create action isn't blocked by it.
  const canConfigSnmp = req.user.permissions.includes('servers.snmp_config');
  const snmp_enabled = canConfigSnmp && req.body.snmp_enabled ? 1 : 0;
  const snmp_port = canConfigSnmp ? (req.body.snmp_port || 161) : 161;
  const snmp_community = canConfigSnmp ? (req.body.snmp_community || 'public') : 'public';
  const result = await db.prepare(`
    INSERT INTO servers (name, hostname, ip_address, type, os, cpu, ram, storage, location, rack, ssh_port, ssh_user, ssh_credential_id, tags, notes, ipmi_host, ipmi_username, ipmi_password, snmp_enabled, snmp_port, snmp_community)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, hostname, ip_address, type || 'server', os, cpu, ram, storage, location, rack, ssh_port || 22, sshCred.ssh_user, sshCred.ssh_credential_id, tagsJson, notes, ipmi_host, ipmi_username, ipmi_password, snmp_enabled, snmp_port, snmp_community);
  await logActivity(req.user, 'CREATE', 'server', result.lastInsertRowid, name);
  res.status(201).json({ id: result.lastInsertRowid, message: 'Server created' });
});

router.put('/:id', requirePermission('servers.write'), async (req, res) => {
  const { name, hostname, ip_address, type, os, cpu, ram, storage, location, rack, ssh_port, credentialId, tags, notes } = req.body;
  const tagsJson = JSON.stringify(Array.isArray(tags) ? tags : (tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : []));
  let sshCred;
  try { sshCred = await resolveSshCredential(credentialId); } catch (e) { return res.status(400).json({ error: e.message }); }

  const canConfigIpmi = req.user.permissions.includes('servers.ipmi_config');
  let ipmiSet = '';
  const ipmiParams = [];
  if (canConfigIpmi) {
    // Blank password in the form means "keep the existing one" — NULLIF/COALESCE does that in one
    // query rather than a separate read-then-conditionally-write round trip.
    ipmiSet = ', ipmi_host=?, ipmi_username=?, ipmi_password=COALESCE(NULLIF(?, \'\'), ipmi_password)';
    ipmiParams.push(req.body.ipmi_host || null, req.body.ipmi_username || null, req.body.ipmi_password || '');
  }

  const canConfigSnmp = req.user.permissions.includes('servers.snmp_config');
  let snmpSet = '';
  const snmpParams = [];
  if (canConfigSnmp) {
    snmpSet = ', snmp_enabled=?, snmp_port=?, snmp_community=?';
    snmpParams.push(req.body.snmp_enabled ? 1 : 0, req.body.snmp_port || 161, req.body.snmp_community || 'public');
  }

  await db.prepare(`
    UPDATE servers SET name=?, hostname=?, ip_address=?, type=?, os=?, cpu=?, ram=?, storage=?, location=?, rack=?, ssh_port=?, ssh_user=?, ssh_credential_id=?, tags=?, notes=?, updated_at=CURRENT_TIMESTAMP${ipmiSet}${snmpSet} WHERE id=?
  `).run(name, hostname, ip_address, type, os, cpu, ram, storage, location, rack, ssh_port, sshCred.ssh_user, sshCred.ssh_credential_id, tagsJson, notes, ...ipmiParams, ...snmpParams, req.params.id);
  await logActivity(req.user, 'UPDATE', 'server', req.params.id, name);
  res.json({ message: 'Updated' });
});

router.delete('/:id', requirePermission('servers.delete'), async (req, res) => {
  const server = await db.prepare('SELECT name FROM servers WHERE id=?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  await db.prepare('DELETE FROM servers WHERE id=?').run(req.params.id);
  await logActivity(req.user, 'DELETE', 'server', req.params.id, server.name);
  res.json({ message: 'Deleted' });
});

// On-demand IPMI status refresh — same permission tier as manual Ping (read-only network check
// against a device the app is already trusted to reach).
router.post('/:id/ipmi/check', requirePermission('ping.write'), async (req, res) => {
  const server = await db.prepare('SELECT id, ipmi_host, ipmi_username, ipmi_password FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!server.ipmi_host) return res.status(400).json({ error: 'Máy chủ này chưa cấu hình IPMI' });
  const result = await ipmiCollector.checkServer(server);
  res.json(result);
});

// On-demand SNMP status refresh — same permission tier as manual Ping/IPMI check-now.
router.post('/:id/snmp/check', requirePermission('ping.write'), async (req, res) => {
  const server = await db.prepare('SELECT id, ip_address, snmp_port, snmp_community, snmp_enabled, snmp_if_prev_snapshot FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (!server.snmp_enabled) return res.status(400).json({ error: 'Máy chủ này chưa bật giám sát SNMP' });
  const result = await snmpCollector.checkServer(server);
  res.json(result);
});

module.exports = router;
