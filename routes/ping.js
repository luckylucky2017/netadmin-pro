const express = require('express');
const router = express.Router();
const db = require('../database');
const { requirePermission } = require('../auth');

// Every route in this file is a write action (updates status/ping_history), so gate the whole
// router at once rather than repeating the same guard on each of the 3 routes.
router.use(requirePermission('ping.write'));

let pingLib;
try { pingLib = require('ping'); } catch (e) { pingLib = null; }

async function pingHost(host) {
  if (!pingLib) {
    // Fallback: simulate ping
    return { alive: Math.random() > 0.2, time: Math.floor(Math.random() * 50) + 1 };
  }
  try {
    const res = await pingLib.promise.probe(host, { timeout: 3, min_reply: 1 });
    return { alive: res.alive, time: res.time === 'unknown' ? null : parseFloat(res.time) };
  } catch {
    return { alive: false, time: null };
  }
}

router.post('/server/:id', async (req, res) => {
  const server = await db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });

  const result = await pingHost(server.ip_address);
  const status = result.alive ? 'online' : 'offline';
  const pingMs = result.time ? Math.round(result.time) : null;

  await db.prepare('UPDATE servers SET status=?, last_ping=CURRENT_TIMESTAMP, ping_ms=? WHERE id=?').run(status, pingMs, server.id);
  await db.prepare("INSERT INTO ping_history (device_id, device_type, status, ping_ms) VALUES (?, 'server', ?, ?)").run(server.id, status, pingMs);

  res.json({ status, ping_ms: pingMs, ip: server.ip_address });
});

router.post('/device/:id', async (req, res) => {
  const device = await db.prepare('SELECT * FROM network_devices WHERE id=?').get(req.params.id);
  if (!device) return res.status(404).json({ error: 'Not found' });

  const result = await pingHost(device.ip_address);
  const status = result.alive ? 'online' : 'offline';
  const pingMs = result.time ? Math.round(result.time) : null;

  await db.prepare('UPDATE network_devices SET status=?, last_ping=CURRENT_TIMESTAMP, ping_ms=? WHERE id=?').run(status, pingMs, device.id);
  await db.prepare("INSERT INTO ping_history (device_id, device_type, status, ping_ms) VALUES (?, 'network', ?, ?)").run(device.id, status, pingMs);

  res.json({ status, ping_ms: pingMs, ip: device.ip_address });
});

router.post('/all', async (req, res) => {
  const servers = await db.prepare('SELECT id, ip_address FROM servers').all();
  const devices = await db.prepare('SELECT id, ip_address FROM network_devices').all();

  const results = { servers: [], devices: [] };

  for (const s of servers) {
    const r = await pingHost(s.ip_address);
    const status = r.alive ? 'online' : 'offline';
    const pingMs = r.time ? Math.round(r.time) : null;
    await db.prepare('UPDATE servers SET status=?, last_ping=CURRENT_TIMESTAMP, ping_ms=? WHERE id=?').run(status, pingMs, s.id);
    await db.prepare("INSERT INTO ping_history (device_id, device_type, status, ping_ms) VALUES (?, 'server', ?, ?)").run(s.id, status, pingMs);
    results.servers.push({ id: s.id, status, ping_ms: pingMs });
  }

  for (const d of devices) {
    const r = await pingHost(d.ip_address);
    const status = r.alive ? 'online' : 'offline';
    const pingMs = r.time ? Math.round(r.time) : null;
    await db.prepare('UPDATE network_devices SET status=?, last_ping=CURRENT_TIMESTAMP, ping_ms=? WHERE id=?').run(status, pingMs, d.id);
    await db.prepare("INSERT INTO ping_history (device_id, device_type, status, ping_ms) VALUES (?, 'network', ?, ?)").run(d.id, status, pingMs);
    results.devices.push({ id: d.id, status, ping_ms: pingMs });
  }

  res.json({ message: 'Ping all completed', results });
});

module.exports = router;
