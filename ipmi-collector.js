// Read-only IPMI v2.0 status monitoring for physical servers (Dell iDRAC / HPE iLO / generic BMC) —
// power state + hardware sensor health (temp/fan/PSU). No power control, no configuration changes.
// No mature native Node.js IPMI client exists, so this shells out to the `ipmitool` CLI, same
// pattern the app already uses for SSH via node-ssh.
const { execFile } = require('child_process');
const db = require('./database');

const IPMI_TIMEOUT_MS = 15000;

// execFile (not exec) passes args as an array — never shell-interpreted, so a password/host
// containing shell-special characters can't break out into command injection. Password goes via
// the IPMI_PASSWORD env var + -E flag rather than -P on the command line, so it never appears in
// `ps aux` output for other local users to see.
function runIpmitool(server, args) {
  return new Promise((resolve, reject) => {
    execFile(
      'ipmitool',
      ['-I', 'lanplus', '-H', server.ipmi_host, '-U', server.ipmi_username, '-E', ...args],
      { env: { ...process.env, IPMI_PASSWORD: server.ipmi_password }, timeout: IPMI_TIMEOUT_MS },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr?.trim() || err.message));
        resolve(stdout);
      }
    );
  });
}

function parsePowerState(stdout) {
  if (/Chassis Power is on/i.test(stdout)) return 'on';
  if (/Chassis Power is off/i.test(stdout)) return 'off';
  return 'unknown';
}

// `sdr elist` output, one sensor per line, pipe-delimited — confirmed against ipmitool's own man
// page (`Name | SensorID(hex) | Status | Entity | Reading`), e.g.:
//   Processor1 Temp  | 98h | ok  |  3.1 | 57 degrees C
//   PS2 Status       | 25h | cr  | 10.2 | Power Supply AC lost
// The health code is the 3rd field (index 2), NOT the last field — the last field is the free-text
// reading ("57 degrees C", "Power Supply AC lost"), which never equals a health code, so reading
// parts[parts.length-1] here silently never detected a warning/critical sensor. Codes: ok | nc
// (non-critical) | cr (critical) | nr (non-recoverable) | ns (no sensor/not present, e.g. an empty
// PSU bay — not itself a fault).
function parseHealth(stdout) {
  let worst = 'ok';
  for (const line of stdout.split('\n')) {
    const parts = line.split('|').map(p => p.trim());
    if (parts.length < 3) continue;
    const code = parts[2]?.toLowerCase();
    if (!code) continue;
    if (code === 'cr' || code === 'nr') return 'critical'; // worst possible — short-circuit
    if (code === 'nc') worst = 'warning';
  }
  return worst;
}

// Categorizes each `sdr elist` line by sensor name prefix — the naming scheme below matches Dell
// iDRAC's own sensor names (confirmed against ipmitool/Dell documentation; not yet verified
// against this fleet's real hardware output, still pending real IPMI credentials). Falls back to
// 'other' for anything unrecognized rather than dropping it, so a naming variant on a different
// vendor's BMC still shows up somewhere instead of silently disappearing.
const SENSOR_CATEGORY_PATTERNS = [
  [/^CPU/i, 'cpu'],
  [/^(DIMM|Memory)/i, 'memory'],
  [/^(Drive|HDD|Disk)/i, 'storage'],
  [/^(PS|Power)/i, 'power'],
  [/^Fan/i, 'fan'],
  [/^(Temp|Ambient|Inlet|Exhaust)/i, 'temperature'],
];
function sensorCategory(name) {
  for (const [re, cat] of SENSOR_CATEGORY_PATTERNS) if (re.test(name)) return cat;
  return 'other';
}
// ok | nc (non-critical) | cr/nr (critical/non-recoverable) | ns (no sensor/not present — an
// empty bay, not itself a fault) — same codes parseHealth() already reads, just kept per-sensor
// here instead of collapsed to one worst-case value.
function sensorStatus(code) {
  if (code === 'ok') return 'ok';
  if (code === 'nc') return 'warning';
  if (code === 'cr' || code === 'nr') return 'critical';
  if (code === 'ns') return 'unknown';
  return 'unknown';
}
function parseSensorsByCategory(sdrOut) {
  const categories = {};
  for (const line of sdrOut.split('\n')) {
    const parts = line.split('|').map(p => p.trim());
    if (parts.length < 3 || !parts[0]) continue;
    const name = parts[0];
    // Status is field index 2 (`Name | SensorID | Status | Entity | Reading`), not the last field —
    // see parseHealth()'s comment above for how that mixup was confirmed against ipmitool's man page.
    const code = parts[2]?.toLowerCase();
    if (!code) continue;
    const cat = sensorCategory(name);
    (categories[cat] = categories[cat] || []).push({ name, status: sensorStatus(code) });
  }
  return categories;
}

// `ipmitool sel elist` output, one event per line, pipe-delimited:
//   1 | 04/12/2026 | 10:15:32 | Power Supply #0x72 | Power Supply AC lost | Asserted
//   2 | 04/13/2026 | 08:00:00 | Memory #0x1c | Correctable ECC | Asserted
// Oldest-first — reversed here so callers get newest-first, then capped, so "most recent N events"
// is actually the most recent N (not the oldest N from a long-lived log).
function parseSelLog(selOut, maxEntries = 30) {
  const entries = [];
  for (const line of selOut.split('\n')) {
    const parts = line.split('|').map(p => p.trim());
    if (parts.length < 6) continue;
    const [id, date, time, sensor, description, direction] = parts;
    if (!id) continue;
    entries.push({ id, occurred_at: `${date} ${time}`, sensor, description, direction });
  }
  return entries.reverse().slice(0, maxEntries);
}

const setStatus = db.prepare(`
  UPDATE servers SET ipmi_power_state = ?, ipmi_health = ?, ipmi_sensors = ?, ipmi_sel_log = ?, ipmi_checked_at = CURRENT_TIMESTAMP, ipmi_error = ? WHERE id = ?
`);

// Single-server on-demand check — used both by the periodic collector below and the "Kiểm tra IPMI"
// button (routes/servers.js POST /:id/ipmi/check).
async function checkServer(server) {
  if (!server.ipmi_host || !server.ipmi_username) {
    return { power_state: 'unknown', health: 'unknown', sensors: null, sel_log: null, error: 'Chưa cấu hình IPMI host/username' };
  }
  try {
    // Three separate ipmitool processes, not three requests sharing one session/socket (unlike the
    // net-snmp session-concurrency bug fixed earlier) — running them in parallel is safe here.
    const [powerOut, sdrOut, selOut] = await Promise.all([
      runIpmitool(server, ['power', 'status']),
      runIpmitool(server, ['sdr', 'elist']),
      runIpmitool(server, ['sel', 'elist']),
    ]);
    const power_state = parsePowerState(powerOut);
    const health = parseHealth(sdrOut);
    const sensors = parseSensorsByCategory(sdrOut);
    const sel_log = parseSelLog(selOut);
    await setStatus.run(power_state, health, JSON.stringify(sensors), JSON.stringify(sel_log), null, server.id);
    return { power_state, health, sensors, sel_log, error: null };
  } catch (e) {
    await setStatus.run('unknown', 'unknown', null, null, e.message, server.id);
    return { power_state: 'unknown', health: 'unknown', sensors: null, sel_log: null, error: e.message };
  }
}

async function collectAll() {
  const servers = await db.prepare("SELECT id, ipmi_host, ipmi_username, ipmi_password FROM servers WHERE ipmi_host IS NOT NULL AND ipmi_host != ''").all();
  if (!servers.length) return;
  await Promise.allSettled(servers.map(checkServer));
}

function start(intervalMs = 60000) {
  // Wrapped in .catch — same reasoning as the other collectors (async setInterval + external process).
  const tick = () => collectAll().catch(e => console.error('[ipmi] Lỗi:', e.message));
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = { start, collectAll, checkServer, parsePowerState, parseHealth, parseSensorsByCategory, parseSelLog };
