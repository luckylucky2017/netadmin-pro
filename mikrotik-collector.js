// Syncs identity/resource info, interfaces (+ traffic bps), and firewall filter rules from every
// enabled MikroTik firewall into the mikrotik_* cache tables, so the page never has to open a live
// RouterOS API connection on every page load. Same Promise.allSettled-per-target convention as
// pfsense-collector.js/vcenter-collector.js: one firewall being unreachable must never block the
// others from syncing.
const db = require('./database');
const client = require('./mikrotik-client');

// RouterOS's /interface/print only exposes cumulative rx-byte/tx-byte counters, not a rate — same
// situation as pfSense's interface stats, so bps is derived from the delta against the previous
// poll's snapshot (mikrotik_firewalls.if_bandwidth_snapshot, internal-only). First poll after
// adding a firewall has no prior snapshot (bps null that once); a counter going backwards
// (interface reset/counter wraparound) is also reported null rather than guessing at wraparound math.
function computeBps(prevSample, currentBytes, now) {
  if (!prevSample) return null;
  const dtSec = (now - prevSample.ts) / 1000;
  if (dtSec <= 0) return null;
  const delta = currentBytes - prevSample.bytes;
  if (delta < 0) return null;
  return Math.round((delta * 8) / dtSec);
}

// RouterOS API returns boolean-ish fields as the strings "true"/"false" (running) or "yes"/"no"
// (disabled) depending on the command — normalize both to a plain JS boolean here once, rather
// than repeating the two different truthy-string checks at every call site.
function asBool(v) {
  return v === 'true' || v === 'yes';
}

async function syncInterfaces(fw, conn) {
  const data = await conn.write('/interface/print');
  let prevSnapshot = {};
  try { prevSnapshot = JSON.parse(fw.if_bandwidth_snapshot || '{}'); } catch { prevSnapshot = {}; }
  const now = Date.now();
  const nextSnapshot = {};

  const upsert = db.prepare(`
    INSERT INTO mikrotik_interfaces (firewall_id, ros_id, name, type, running, disabled, in_bps, out_bps, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON DUPLICATE KEY UPDATE
      name = VALUES(name), type = VALUES(type), running = VALUES(running), disabled = VALUES(disabled),
      in_bps = VALUES(in_bps), out_bps = VALUES(out_bps), updated_at = CURRENT_TIMESTAMP
  `);
  for (const iface of data) {
    const rosId = iface['.id'];
    const inBytes = Number(iface['rx-byte'] ?? 0);
    const outBytes = Number(iface['tx-byte'] ?? 0);
    const prev = prevSnapshot[rosId];
    const in_bps = computeBps(prev ? { bytes: prev.in, ts: prev.ts } : null, inBytes, now);
    const out_bps = computeBps(prev ? { bytes: prev.out, ts: prev.ts } : null, outBytes, now);
    nextSnapshot[rosId] = { in: inBytes, out: outBytes, ts: now };
    await upsert.run(fw.id, rosId, iface.name, iface.type || null, asBool(iface.running) ? 1 : 0, asBool(iface.disabled) ? 1 : 0, in_bps, out_bps);
  }
  await db.prepare('UPDATE mikrotik_firewalls SET if_bandwidth_snapshot = ? WHERE id = ?').run(JSON.stringify(nextSnapshot), fw.id);

  const currentIds = new Set(data.map(i => i['.id']));
  const known = await db.prepare('SELECT ros_id FROM mikrotik_interfaces WHERE firewall_id = ?').all(fw.id);
  const stale = db.prepare('DELETE FROM mikrotik_interfaces WHERE firewall_id = ? AND ros_id = ?');
  for (const { ros_id } of known) if (!currentIds.has(ros_id)) await stale.run(fw.id, ros_id);
  return data.length;
}

async function syncRules(fw, conn) {
  const data = await conn.write('/ip/firewall/filter/print');
  const upsert = db.prepare(`
    INSERT INTO mikrotik_firewall_rules (firewall_id, ros_id, chain, action, protocol, src_address, dst_address, dst_port, comment, disabled, sort_order, raw_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON DUPLICATE KEY UPDATE
      chain = VALUES(chain), action = VALUES(action), protocol = VALUES(protocol),
      src_address = VALUES(src_address), dst_address = VALUES(dst_address), dst_port = VALUES(dst_port),
      comment = VALUES(comment), disabled = VALUES(disabled), sort_order = VALUES(sort_order),
      raw_json = VALUES(raw_json), updated_at = CURRENT_TIMESTAMP
  `);
  let order = 0;
  for (const rule of data) {
    const rosId = rule['.id'];
    await upsert.run(
      fw.id, rosId, rule.chain || null, rule.action || null, rule.protocol || null,
      rule['src-address'] || null, rule['dst-address'] || null, rule['dst-port'] || null,
      rule.comment || null, asBool(rule.disabled) ? 1 : 0, order++, JSON.stringify(rule)
    );
  }
  const currentIds = new Set(data.map(r => r['.id']));
  const known = await db.prepare('SELECT ros_id FROM mikrotik_firewall_rules WHERE firewall_id = ?').all(fw.id);
  const stale = db.prepare('DELETE FROM mikrotik_firewall_rules WHERE firewall_id = ? AND ros_id = ?');
  for (const { ros_id } of known) if (!currentIds.has(ros_id)) await stale.run(fw.id, ros_id);
  return data.length;
}

async function syncOneFirewall(fw) {
  try {
    await client.withConnection(fw, async (conn) => {
      const [identity, resource] = await Promise.all([
        conn.write('/system/identity/print'),
        conn.write('/system/resource/print'),
      ]);
      await syncInterfaces(fw, conn);
      await syncRules(fw, conn);
      await db.prepare(`
        UPDATE mikrotik_firewalls SET status='ok', last_error=NULL, last_synced_at=CURRENT_TIMESTAMP,
          identity=?, routeros_version=?, uptime=? WHERE id=?
      `).run(identity[0]?.name || null, resource[0]?.version || null, resource[0]?.uptime || null, fw.id);
    });
    return { firewallId: fw.id, ok: true };
  } catch (e) {
    await db.prepare("UPDATE mikrotik_firewalls SET status='error', last_error=?, last_synced_at=CURRENT_TIMESTAMP WHERE id=?").run(e.message, fw.id);
    return { firewallId: fw.id, ok: false, error: e.message };
  }
}

async function syncAll() {
  const firewalls = await db.prepare('SELECT * FROM mikrotik_firewalls WHERE enabled = 1').all();
  if (!firewalls.length) return { skipped: true };
  const results = await Promise.allSettled(firewalls.map(syncOneFirewall));
  return { count: firewalls.length, results };
}

function start(intervalMs = 60000) {
  const tick = () => syncAll().catch(e => console.error('[mikrotik] Lỗi đồng bộ:', e.message));
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = { start, syncAll, syncOneFirewall, computeBps, asBool };
