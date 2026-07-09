const express = require('express');
const router = express.Router();
const db = require('../database');
const { requirePermission, logActivity } = require('../auth');
const snmpCollector = require('../snmp-collector');

// snmp_if_prev_snapshot is internal bookkeeping (raw octet counters for the bps calc), not useful
// to the client — snmp_community isn't a real secret so it isn't filtered out.
function sanitizeDevice(d) {
  if (!d) return d;
  const { snmp_if_prev_snapshot, ...rest } = d;
  return rest;
}

router.get('/', async (req, res) => {
  const { search, status, type } = req.query;
  let query = 'SELECT * FROM network_devices WHERE 1=1';
  const params = [];
  if (search) { query += ' AND (name LIKE ? OR ip_address LIKE ? OR brand LIKE ? OR model LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`); }
  if (status) { query += ' AND status = ?'; params.push(status); }
  if (type) { query += ' AND type = ?'; params.push(type); }
  query += ' ORDER BY name ASC';
  const devices = await db.prepare(query).all(...params);
  devices.forEach(d => { try { d.tags = JSON.parse(d.tags || '[]'); } catch { d.tags = []; } });
  res.json(devices.map(sanitizeDevice));
});

router.get('/stats', async (req, res) => {
  const total = (await db.prepare('SELECT COUNT(*) as cnt FROM network_devices').get()).cnt;
  const online = (await db.prepare("SELECT COUNT(*) as cnt FROM network_devices WHERE status='online'").get()).cnt;
  const offline = (await db.prepare("SELECT COUNT(*) as cnt FROM network_devices WHERE status='offline'").get()).cnt;
  const byType = await db.prepare("SELECT type, COUNT(*) as cnt FROM network_devices GROUP BY type").all();
  res.json({ total, online, offline, unknown: total - online - offline, byType });
});

router.get('/:id', async (req, res) => {
  const device = await db.prepare('SELECT * FROM network_devices WHERE id = ?').get(req.params.id);
  if (!device) return res.status(404).json({ error: 'Not found' });
  try { device.tags = JSON.parse(device.tags || '[]'); } catch { device.tags = []; }
  const history = await db.prepare("SELECT * FROM ping_history WHERE device_id=? AND device_type='network' ORDER BY checked_at DESC LIMIT 50").all(req.params.id);
  device.ping_history = history;
  res.json(sanitizeDevice(device));
});

router.post('/', requirePermission('devices.write'), async (req, res) => {
  const { name, hostname, ip_address, mac_address, type, brand, model, firmware, location, vlan, ports, tags, notes } = req.body;
  if (!name || !ip_address || !type) return res.status(400).json({ error: 'Name, IP, and type are required' });
  const tagsJson = JSON.stringify(Array.isArray(tags) ? tags : (tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : []));
  // SNMP config is gated the same way as servers.js — silently dropped, not 403'd, if the
  // requester lacks devices.snmp_config.
  const canConfigSnmp = req.user.permissions.includes('devices.snmp_config');
  const snmp_enabled = canConfigSnmp && req.body.snmp_enabled ? 1 : 0;
  const snmp_port = canConfigSnmp ? (req.body.snmp_port || 161) : 161;
  const snmp_community = canConfigSnmp ? (req.body.snmp_community || 'public') : 'public';
  const result = await db.prepare(`
    INSERT INTO network_devices (name, hostname, ip_address, mac_address, type, brand, model, firmware, location, vlan, ports, tags, notes, snmp_enabled, snmp_port, snmp_community)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, hostname, ip_address, mac_address, type, brand, model, firmware, location, vlan, ports || 0, tagsJson, notes, snmp_enabled, snmp_port, snmp_community);
  await logActivity(req.user, 'CREATE', 'device', result.lastInsertRowid, name);
  res.status(201).json({ id: result.lastInsertRowid, message: 'Device created' });
});

router.put('/:id', requirePermission('devices.write'), async (req, res) => {
  const { name, hostname, ip_address, mac_address, type, brand, model, firmware, location, vlan, ports, tags, notes } = req.body;
  const tagsJson = JSON.stringify(Array.isArray(tags) ? tags : (tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : []));

  const canConfigSnmp = req.user.permissions.includes('devices.snmp_config');
  let snmpSet = '';
  const snmpParams = [];
  if (canConfigSnmp) {
    snmpSet = ', snmp_enabled=?, snmp_port=?, snmp_community=?';
    snmpParams.push(req.body.snmp_enabled ? 1 : 0, req.body.snmp_port || 161, req.body.snmp_community || 'public');
  }

  await db.prepare(`
    UPDATE network_devices SET name=?, hostname=?, ip_address=?, mac_address=?, type=?, brand=?, model=?, firmware=?, location=?, vlan=?, ports=?, tags=?, notes=?, updated_at=CURRENT_TIMESTAMP${snmpSet} WHERE id=?
  `).run(name, hostname, ip_address, mac_address, type, brand, model, firmware, location, vlan, ports, tagsJson, notes, ...snmpParams, req.params.id);
  await logActivity(req.user, 'UPDATE', 'device', req.params.id, name);
  res.json({ message: 'Updated' });
});

router.delete('/:id', requirePermission('devices.delete'), async (req, res) => {
  const device = await db.prepare('SELECT name FROM network_devices WHERE id=?').get(req.params.id);
  if (!device) return res.status(404).json({ error: 'Not found' });
  await db.prepare('DELETE FROM network_devices WHERE id=?').run(req.params.id);
  await logActivity(req.user, 'DELETE', 'device', req.params.id, device.name);
  res.json({ message: 'Deleted' });
});

// On-demand SNMP status refresh — same permission tier as manual Ping.
router.post('/:id/snmp/check', requirePermission('ping.write'), async (req, res) => {
  const device = await db.prepare('SELECT id, ip_address, snmp_port, snmp_community, snmp_enabled, snmp_if_prev_snapshot FROM network_devices WHERE id = ?').get(req.params.id);
  if (!device) return res.status(404).json({ error: 'Not found' });
  if (!device.snmp_enabled) return res.status(400).json({ error: 'Thiết bị này chưa bật giám sát SNMP' });
  const result = await snmpCollector.checkDevice(device);
  res.json(result);
});

module.exports = router;
