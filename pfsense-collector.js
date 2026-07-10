// Syncs status/interfaces/gateways/rules/VPN from every enabled pfSense firewall into the
// pfsense_* cache tables, so the page never has to call the real firewall API on every page load.
// Same Promise.allSettled-per-target convention as vcenter-collector.js/snmp-collector.js: one
// firewall being unreachable/misconfigured must never block the others from syncing.
const db = require('./database');
const client = require('./pfsense-client');
const { classifyIp } = require('./ssh-security-collector');

// pfSense's API only exposes cumulative in/out byte counters, not a rate — bps is derived from the
// delta against the previous poll's snapshot (stored in pfsense_firewalls.if_bandwidth_snapshot,
// internal-only, never sent to the client), same convention as snmp-collector.js's
// snmp_if_prev_snapshot. First poll after adding a firewall has no prior snapshot, so bps is null
// that one time; a counter going backwards (interface reset) is also reported as null rather than
// guessing wraparound arithmetic.
function computeBps(prevSample, currentBytes, now) {
  if (!prevSample) return null;
  const dtSec = (now - prevSample.ts) / 1000;
  if (dtSec <= 0) return null;
  const delta = currentBytes - prevSample.bytes;
  if (delta < 0) return null;
  return Math.round((delta * 8) / dtSec);
}

async function syncInterfaces(fw) {
  const [ifaceRes, gwRes] = await Promise.all([
    client.request(fw, 'GET', '/status/interfaces'),
    client.request(fw, 'GET', '/status/gateways').catch(() => ({ data: [] }))
  ]);
  // InterfaceStats.gateway holds the gateway's IP, not its config name — the only reliable join key
  // back to RoutingGatewayStatus is srcip (the gateway's monitored source IP), not name-to-name.
  const gateways = gwRes?.data || [];
  const gwStatusBySrcIp = new Map(gateways.map(g => [g.srcip, g.status]));

  let prevSnapshot = {};
  try { prevSnapshot = JSON.parse(fw.if_bandwidth_snapshot || '{}'); } catch { prevSnapshot = {}; }
  const now = Date.now();
  const nextSnapshot = {};

  const upsert = db.prepare(`
    INSERT INTO pfsense_interfaces (firewall_id, if_name, description, status, ip_address, gateway_status, in_bytes, out_bytes, in_bps, out_bps, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      description = VALUES(description), status = VALUES(status), ip_address = VALUES(ip_address),
      gateway_status = VALUES(gateway_status), in_bytes = VALUES(in_bytes), out_bytes = VALUES(out_bytes),
      in_bps = VALUES(in_bps), out_bps = VALUES(out_bps), raw_json = VALUES(raw_json), updated_at = CURRENT_TIMESTAMP
  `);
  const data = ifaceRes?.data || [];
  for (const iface of data) {
    const inBytes = Number(iface.inbytes ?? 0);
    const outBytes = Number(iface.outbytes ?? 0);
    const prev = prevSnapshot[iface.name];
    const in_bps = computeBps(prev ? { bytes: prev.in, ts: prev.ts } : null, inBytes, now);
    const out_bps = computeBps(prev ? { bytes: prev.out, ts: prev.ts } : null, outBytes, now);
    nextSnapshot[iface.name] = { in: inBytes, out: outBytes, ts: now };
    await upsert.run(
      fw.id, iface.name, iface.descr || null, iface.status || null, iface.ipaddr || null,
      gwStatusBySrcIp.get(iface.ipaddr) || null, inBytes, outBytes, in_bps, out_bps, JSON.stringify(iface)
    );
  }
  await db.prepare('UPDATE pfsense_firewalls SET if_bandwidth_snapshot = ? WHERE id = ?').run(JSON.stringify(nextSnapshot), fw.id);

  const currentNames = new Set(data.map(i => i.name));
  const known = await db.prepare('SELECT if_name FROM pfsense_interfaces WHERE firewall_id = ?').all(fw.id);
  const stale = db.prepare('DELETE FROM pfsense_interfaces WHERE firewall_id = ? AND if_name = ?');
  for (const { if_name } of known) if (!currentNames.has(if_name)) await stale.run(fw.id, if_name);
  return data.length;
}

async function syncRules(fw) {
  const res = await client.request(fw, 'GET', '/firewall/rules?limit=0');
  const data = res?.data || [];
  const upsert = db.prepare(`
    INSERT INTO pfsense_firewall_rules (firewall_id, rule_tracker, interface, action, protocol, source, destination, description, enabled, sort_order, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      interface = VALUES(interface), action = VALUES(action), protocol = VALUES(protocol),
      source = VALUES(source), destination = VALUES(destination), description = VALUES(description),
      enabled = VALUES(enabled), sort_order = VALUES(sort_order), raw_json = VALUES(raw_json),
      updated_at = CURRENT_TIMESTAMP
  `);
  for (const rule of data) {
    const tracker = String(rule.tracker);
    await upsert.run(
      fw.id, tracker, Array.isArray(rule.interface) ? rule.interface.join(',') : rule.interface,
      rule.type || null, rule.protocol || null, rule.source || null, rule.destination || null,
      rule.descr || null, rule.disabled ? 0 : 1, rule.id, JSON.stringify(rule)
    );
  }
  const currentTrackers = new Set(data.map(r => String(r.tracker)));
  const known = await db.prepare('SELECT rule_tracker FROM pfsense_firewall_rules WHERE firewall_id = ?').all(fw.id);
  const stale = db.prepare('DELETE FROM pfsense_firewall_rules WHERE firewall_id = ? AND rule_tracker = ?');
  for (const { rule_tracker } of known) if (!currentTrackers.has(rule_tracker)) await stale.run(fw.id, rule_tracker);
  return data.length;
}

// client_id turned out NOT to be stable across polls in live testing (confirmed: the same physical
// connection got a different client_id on the very next sync, producing duplicate rows instead of
// clean upserts) — common_name + remote_host (source IP:port, fixed for the life of one TCP/UDP
// session) is used as the stable key instead. If a client somehow reconnects with a new source port
// mid-poll, worst case is one cycle showing no rate for that slot, never a wrong one (computeBps()
// already discards a mismatched delta as null).
// remote_host from pfSense is "IP:port" (IPv4) or "[IP]:port" (IPv6) — strip the port before
// handing off to classifyIp(), which expects a bare address.
function extractIp(remoteHost) {
  if (!remoteHost) return null;
  const bracketed = /^\[([^\]]+)\]:\d+$/.exec(remoteHost);
  if (bracketed) return bracketed[1];
  const idx = remoteHost.lastIndexOf(':');
  return idx > 0 ? remoteHost.slice(0, idx) : remoteHost;
}

async function syncVpn(fw) {
  const [ovpnRes, ipsecRes] = await Promise.all([
    client.request(fw, 'GET', '/status/openvpn/servers').catch(() => ({ data: [] })),
    client.request(fw, 'GET', '/status/ipsec/sas').catch(() => ({ data: [] }))
  ]);

  let prevSnapshot = {};
  try { prevSnapshot = JSON.parse(fw.vpn_bandwidth_snapshot || '{}'); } catch { prevSnapshot = {}; }
  const now = Date.now();
  const nextSnapshot = {};

  const upsert = db.prepare(`
    INSERT INTO pfsense_vpn_status (firewall_id, vpn_type, tunnel_name, status, remote_info, connected_since, client_key, bytes_recv, bytes_sent, rate_recv_bps, rate_sent_bps, country, is_foreign, tunnel_ip, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      tunnel_name = VALUES(tunnel_name), status = VALUES(status), remote_info = VALUES(remote_info),
      connected_since = VALUES(connected_since), bytes_recv = VALUES(bytes_recv), bytes_sent = VALUES(bytes_sent),
      rate_recv_bps = VALUES(rate_recv_bps), rate_sent_bps = VALUES(rate_sent_bps),
      country = VALUES(country), is_foreign = VALUES(is_foreign), tunnel_ip = VALUES(tunnel_ip),
      raw_json = VALUES(raw_json), updated_at = CURRENT_TIMESTAMP
  `);
  const lastConnUpsert = db.prepare(`
    INSERT INTO pfsense_ovpn_user_last_conn (firewall_id, username, last_connected_at, last_remote_host)
    VALUES (?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE last_connected_at = VALUES(last_connected_at), last_remote_host = VALUES(last_remote_host), updated_at = CURRENT_TIMESTAMP
  `);
  const servers = ovpnRes?.data || [];
  const currentKeys = [];
  let count = 0;
  for (const srv of servers) {
    for (const c of srv.conns || []) {
      const clientKey = `ovpn-${srv.vpnid}-${c.common_name}-${c.remote_host}`;
      currentKeys.push(clientKey);
      const bytesRecv = Number(c.bytes_recv ?? 0);
      const bytesSent = Number(c.bytes_sent ?? 0);
      const prev = prevSnapshot[clientKey];
      const rate_recv_bps = computeBps(prev ? { bytes: prev.recv, ts: prev.ts } : null, bytesRecv, now);
      const rate_sent_bps = computeBps(prev ? { bytes: prev.sent, ts: prev.ts } : null, bytesSent, now);
      nextSnapshot[clientKey] = { recv: bytesRecv, sent: bytesSent, ts: now };
      const { country, isForeign } = classifyIp(extractIp(c.remote_host));
      const connectedSinceSql = c.connect_time ? new Date(c.connect_time).toISOString().slice(0, 19).replace('T', ' ') : null;
      await upsert.run(
        fw.id, 'openvpn', `${srv.name} · ${c.common_name}`, 'connected', c.remote_host,
        connectedSinceSql,
        clientKey, bytesRecv, bytesSent, rate_recv_bps, rate_sent_bps, country, isForeign, c.virtual_addr || null, JSON.stringify(c)
      );
      if (c.common_name) await lastConnUpsert.run(fw.id, c.common_name, connectedSinceSql, c.remote_host || null);
      count++;
    }
  }
  const sas = ipsecRes?.data || [];
  for (const sa of sas) {
    const clientKey = `ipsec-${sa.uniqueid ?? sa.con_id ?? sa.name}`;
    currentKeys.push(clientKey);
    const { country, isForeign } = classifyIp(extractIp(sa.remote_host));
    await upsert.run(
      fw.id, 'ipsec', sa.name || sa['con-name'] || 'ipsec', sa.state || 'unknown', sa.remote_host || null,
      null, clientKey, null, null, null, null, country, isForeign, null, JSON.stringify(sa)
    );
    count++;
  }
  await db.prepare('UPDATE pfsense_firewalls SET vpn_bandwidth_snapshot = ? WHERE id = ?').run(JSON.stringify(nextSnapshot), fw.id);

  const currentKeySet = new Set(currentKeys);
  const known = await db.prepare('SELECT client_key FROM pfsense_vpn_status WHERE firewall_id = ?').all(fw.id);
  const stale = db.prepare('DELETE FROM pfsense_vpn_status WHERE firewall_id = ? AND client_key = ?');
  for (const { client_key } of known) if (!currentKeySet.has(client_key)) await stale.run(fw.id, client_key);
  return count;
}

async function syncOneFirewall(fw) {
  try {
    await client.testConnection(fw);
    const [ifaceCount, ruleCount, vpnCount] = await Promise.all([
      syncInterfaces(fw), syncRules(fw), syncVpn(fw)
    ]);
    await db.prepare("UPDATE pfsense_firewalls SET status='ok', last_synced_at=CURRENT_TIMESTAMP, last_error=NULL WHERE id=?").run(fw.id);
    return { firewallId: fw.id, interfaces: ifaceCount, rules: ruleCount, vpn: vpnCount };
  } catch (e) {
    await db.prepare("UPDATE pfsense_firewalls SET status='error', last_error=? WHERE id=?").run(e.message, fw.id);
    return { firewallId: fw.id, error: e.message };
  }
}

async function syncAll() {
  const firewalls = await db.prepare('SELECT * FROM pfsense_firewalls WHERE enabled = 1').all();
  if (!firewalls.length) return { skipped: true };
  const results = await Promise.allSettled(firewalls.map(syncOneFirewall));
  return { firewalls: results.map(r => r.status === 'fulfilled' ? r.value : { error: r.reason?.message }) };
}

// Self-rescheduling (not setInterval) so a slow cycle never overlaps the next one.
function start(intervalMs = 60000) {
  let stopped = false;
  async function tick() {
    try { await syncAll(); } catch (e) { console.error('[pfsense] Lỗi đồng bộ:', e.message); }
    if (!stopped) setTimeout(tick, intervalMs);
  }
  tick();
  return { stop: () => { stopped = true; } };
}

module.exports = { start, syncAll, syncOneFirewall };
