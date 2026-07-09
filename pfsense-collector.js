// Syncs status/interfaces/gateways/rules/VPN from every enabled pfSense firewall into the
// pfsense_* cache tables, so the page never has to call the real firewall API on every page load.
// Same Promise.allSettled-per-target convention as vcenter-collector.js/snmp-collector.js: one
// firewall being unreachable/misconfigured must never block the others from syncing.
const db = require('./database');
const client = require('./pfsense-client');

async function syncInterfaces(fw) {
  const [ifaceRes, gwRes] = await Promise.all([
    client.request(fw, 'GET', '/status/interfaces'),
    client.request(fw, 'GET', '/status/gateways').catch(() => ({ data: [] }))
  ]);
  // InterfaceStats.gateway holds the gateway's IP, not its config name — the only reliable join key
  // back to RoutingGatewayStatus is srcip (the gateway's monitored source IP), not name-to-name.
  const gateways = gwRes?.data || [];
  const gwStatusBySrcIp = new Map(gateways.map(g => [g.srcip, g.status]));
  const upsert = db.prepare(`
    INSERT INTO pfsense_interfaces (firewall_id, if_name, description, status, ip_address, gateway_status, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      description = VALUES(description), status = VALUES(status), ip_address = VALUES(ip_address),
      gateway_status = VALUES(gateway_status), raw_json = VALUES(raw_json), updated_at = CURRENT_TIMESTAMP
  `);
  const data = ifaceRes?.data || [];
  for (const iface of data) {
    await upsert.run(
      fw.id, iface.name, iface.descr || null, iface.status || null, iface.ipaddr || null,
      gwStatusBySrcIp.get(iface.ipaddr) || null, JSON.stringify(iface)
    );
  }
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

async function syncVpn(fw) {
  const [ovpnRes, ipsecRes] = await Promise.all([
    client.request(fw, 'GET', '/status/openvpn/servers').catch(() => ({ data: [] })),
    client.request(fw, 'GET', '/status/ipsec/sas').catch(() => ({ data: [] }))
  ]);
  await db.prepare('DELETE FROM pfsense_vpn_status WHERE firewall_id = ?').run(fw.id);
  const insert = db.prepare(`
    INSERT INTO pfsense_vpn_status (firewall_id, vpn_type, tunnel_name, status, remote_info, connected_since, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const servers = ovpnRes?.data || [];
  let count = 0;
  for (const srv of servers) {
    const conns = srv.conns || [];
    if (!conns.length) {
      await insert.run(fw.id, 'openvpn', srv.name, 'idle', null, null, JSON.stringify(srv));
      count++;
      continue;
    }
    for (const c of conns) {
      await insert.run(
        fw.id, 'openvpn', `${srv.name} · ${c.common_name}`, 'connected', c.remote_host,
        c.connect_time ? new Date(c.connect_time).toISOString().slice(0, 19).replace('T', ' ') : null,
        JSON.stringify(c)
      );
      count++;
    }
  }
  const sas = ipsecRes?.data || [];
  for (const sa of sas) {
    await insert.run(fw.id, 'ipsec', sa.name || sa['con-name'] || 'ipsec', sa.state || 'unknown', sa['remote-host'] || null, null, JSON.stringify(sa));
    count++;
  }
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
