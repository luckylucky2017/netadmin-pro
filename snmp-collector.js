// SNMP v1/v2c monitoring for both servers and network_devices — the daemon runs on the entity's
// existing ip_address (unlike IPMI, there's no separate management IP). Started out as SNMPv3
// (USM: user + auth/priv password), but real hardware (iDRAC8 on the Dell R730 fleet) turned out
// to expose no SNMPv3 user/auth option at all — only a community string — so this now uses plain
// v2c like the rest of that fleet actually supports. Still uses the `net-snmp` package (the
// `snmp-native` dependency already in package.json only *claims* v3 support in its README — its
// code has no actual USM implementation — but v2c only needs the basic community-based session
// which either package could do; net-snmp was already in place from the v3 attempt).
const snmp = require('net-snmp');
const db = require('./database');

const SNMP_TIMEOUT_MS = 5000;
const OID_SYS_UPTIME = '1.3.6.1.2.1.1.3.0';
// session.table() takes the TABLE-level OID (one node above the "Entry" OID) — confirmed against a
// real v3 agent: passing the Entry OID (as the MIB's own naming convention would suggest) silently
// returns an empty table with no error, matching the README's own ifTable example which uses
// 1.3.6.1.2.1.2.2 (ifTable), not 1.3.6.1.2.1.2.2.1 (ifEntry).
const OID_HR_PROCESSOR_TABLE = '1.3.6.1.2.1.25.3.3'; // column 2 = hrProcessorLoad
const OID_HR_STORAGE_TABLE = '1.3.6.1.2.1.25.2.3';   // columns: 2 Type, 5 Size, 6 Used
const HR_STORAGE_RAM = '1.3.6.1.2.1.25.2.1.2';
const OID_IFX_TABLE = '1.3.6.1.2.1.31.1.1'; // column 1 = ifName, 6 = ifHCInOctets, 10 = ifHCOutOctets (Counter64)
const OID_IF_TABLE = '1.3.6.1.2.1.2.2';     // fallback for older devices: 2 = ifDescr, 10 = ifInOctets, 16 = ifOutOctets
const MAX_INTERFACES = 8;

function snmpGet(session, oids) {
  return new Promise((resolve, reject) => {
    session.get(oids, (error, varbinds) => {
      if (error) return reject(error);
      for (const vb of varbinds) {
        if (snmp.isVarbindError(vb)) return reject(new Error(snmp.varbindError(vb)));
      }
      resolve(varbinds);
    });
  });
}

function snmpTable(session, oid) {
  return new Promise((resolve, reject) => {
    session.table(oid, 20, (error, table) => {
      if (error) return reject(error);
      resolve(table || {});
    });
  });
}

// Counter64 varbind values come back as Buffer, not Number (JS numbers can't hold 64-bit ints
// losslessly) — per net-snmp's own docs, callers are responsible for converting.
function counter64ToBigInt(val) {
  if (val == null) return 0n;
  if (Buffer.isBuffer(val)) return val.length ? BigInt('0x' + val.toString('hex')) : 0n;
  return BigInt(val);
}

// OctetString varbind values (ifName, ifDescr, ...) also always come back as Buffer, confirmed
// against a real agent — net-snmp accepts JS strings as input but never returns them as output.
function octetStringToString(val) {
  return Buffer.isBuffer(val) ? val.toString() : (val == null ? '' : String(val));
}

// HOST-RESOURCES-MIB is genuinely absent on plenty of real devices (confirmed while testing this
// against a local snmpd build with no hr_* handlers compiled in, and expected on most network
// switches/routers which use vendor-specific MIBs instead) — never treat a missing table as a
// fatal error, just report no CPU/RAM data for that check.
async function readCpuPct(session) {
  try {
    const table = await snmpTable(session, OID_HR_PROCESSOR_TABLE);
    const loads = Object.values(table).map(row => Number(row[2])).filter(n => Number.isFinite(n));
    if (!loads.length) return null;
    return Math.round((loads.reduce((a, b) => a + b, 0) / loads.length) * 10) / 10;
  } catch { return null; }
}

async function readMemPct(session) {
  try {
    const table = await snmpTable(session, OID_HR_STORAGE_TABLE);
    let size = 0, used = 0;
    for (const row of Object.values(table)) {
      if (octetStringToString(row[2]) === HR_STORAGE_RAM) { size += Number(row[5]) || 0; used += Number(row[6]) || 0; }
    }
    if (!size) return null;
    return Math.round((used / size) * 1000) / 10;
  } catch { return null; }
}

// Interface traffic: ifHCInOctets/ifHCOutOctets are cumulative counters, not a rate — bps is
// derived from the delta against the previous poll's snapshot (stored in snmp_if_prev_snapshot,
// never sent to the client). First poll after adding SNMP to an entity has no prior snapshot, so
// bps is null that one time; a counter going backwards (wrap/device reset) is also reported as
// null for that interface rather than guessing wraparound arithmetic.
async function readInterfaces(session, prevSnapshotJson) {
  let table, useHC = true;
  try {
    table = await snmpTable(session, OID_IFX_TABLE);
    if (!Object.keys(table).length) throw new Error('empty ifXTable');
  } catch {
    useHC = false;
    try { table = await snmpTable(session, OID_IF_TABLE); } catch { table = {}; }
  }

  let prev = {};
  try { prev = JSON.parse(prevSnapshotJson || '{}'); } catch { prev = {}; }
  const now = Date.now();
  const nextSnapshot = {};
  const rows = [];
  const indexes = Object.keys(table).map(Number).sort((a, b) => a - b).slice(0, MAX_INTERFACES);

  for (const idx of indexes) {
    const row = table[idx];
    const name = octetStringToString(useHC ? row[1] : row[2]) || `if${idx}`;
    const inOctets = useHC ? counter64ToBigInt(row[6]) : BigInt(row[10] || 0);
    const outOctets = useHC ? counter64ToBigInt(row[10]) : BigInt(row[16] || 0);
    nextSnapshot[idx] = { in: inOctets.toString(), out: outOctets.toString(), ts: now };

    let in_bps = null, out_bps = null;
    const prevRow = prev[idx];
    if (prevRow) {
      const dtSec = (now - prevRow.ts) / 1000;
      if (dtSec > 0) {
        const dIn = inOctets - BigInt(prevRow.in);
        const dOut = outOctets - BigInt(prevRow.out);
        if (dIn >= 0n) in_bps = Math.round(Number(dIn * 8n) / dtSec);
        if (dOut >= 0n) out_bps = Math.round(Number(dOut * 8n) / dtSec);
      }
    }
    rows.push({ name, in_bps, out_bps });
  }
  return { interfaces: rows, snapshot: JSON.stringify(nextSnapshot) };
}

// Never throws — network/auth failures resolve as status 'down' with an error string, same
// contract as ipmi-collector.js's checkServer()/uptime-collector.js's performCheck().
async function checkEntity(row) {
  if (!row.snmp_enabled) {
    return { status: 'unknown', error: 'Chưa bật giám sát SNMP', uptime_sec: null, cpu_pct: null, mem_used_pct: null, interfaces_json: null, snapshot_json: row.snmp_if_prev_snapshot || null };
  }
  const session = snmp.createSession(row.ip_address, row.snmp_community || 'public', {
    port: row.snmp_port || 161,
    version: snmp.Version2c,
    timeout: SNMP_TIMEOUT_MS,
    retries: 1,
  });
  try {
    const [uptimeVb] = await snmpGet(session, [OID_SYS_UPTIME]);
    const uptime_sec = Math.round(Number(uptimeVb.value) / 100); // TimeTicks are hundredths of a second
    // Sequential, not Promise.all: firing 3 concurrent table-walk (GetBulk) requests on the same
    // session confused a real test agent's continuation sequencing — the first poll silently came
    // back with an empty interface list, and on a second run the agent crashed outright. One session
    // = one in-flight request at a time.
    const cpu_pct = await readCpuPct(session);
    const mem_used_pct = await readMemPct(session);
    const ifResult = await readInterfaces(session, row.snmp_if_prev_snapshot);
    return { status: 'up', error: null, uptime_sec, cpu_pct, mem_used_pct, interfaces_json: JSON.stringify(ifResult.interfaces), snapshot_json: ifResult.snapshot };
  } catch (e) {
    return { status: 'down', error: e.message, uptime_sec: null, cpu_pct: null, mem_used_pct: null, interfaces_json: null, snapshot_json: row.snmp_if_prev_snapshot || null };
  } finally {
    session.close();
  }
}

const SNMP_SELECT_COLS = 'id, ip_address, snmp_port, snmp_community, snmp_enabled, snmp_if_prev_snapshot';
const updateServerSnmp = db.prepare(`UPDATE servers SET snmp_status=?, snmp_uptime_sec=?, snmp_cpu_pct=?, snmp_mem_used_pct=?, snmp_interfaces=?, snmp_if_prev_snapshot=?, snmp_checked_at=CURRENT_TIMESTAMP, snmp_error=? WHERE id=?`);
const updateDeviceSnmp = db.prepare(`UPDATE network_devices SET snmp_status=?, snmp_uptime_sec=?, snmp_cpu_pct=?, snmp_mem_used_pct=?, snmp_interfaces=?, snmp_if_prev_snapshot=?, snmp_checked_at=CURRENT_TIMESTAMP, snmp_error=? WHERE id=?`);

async function checkAndSave(row, updateStmt) {
  const r = await checkEntity(row);
  await updateStmt.run(r.status, r.uptime_sec, r.cpu_pct, r.mem_used_pct, r.interfaces_json, r.snapshot_json, r.error, row.id);
  return r;
}

async function collectAll() {
  const servers = await db.prepare(`SELECT ${SNMP_SELECT_COLS} FROM servers WHERE snmp_enabled = 1`).all();
  const devices = await db.prepare(`SELECT ${SNMP_SELECT_COLS} FROM network_devices WHERE snmp_enabled = 1`).all();
  await Promise.allSettled([
    ...servers.map(s => checkAndSave(s, updateServerSnmp)),
    ...devices.map(d => checkAndSave(d, updateDeviceSnmp)),
  ]);
}

function start(intervalMs = 60000) {
  const tick = () => collectAll().catch(e => console.error('[snmp] Lỗi:', e.message));
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = {
  start,
  collectAll,
  checkServer: (row) => checkAndSave(row, updateServerSnmp),
  checkDevice: (row) => checkAndSave(row, updateDeviceSnmp),
};
