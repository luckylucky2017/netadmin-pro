// Monitors outbound (VM-initiated) established TCP connections on the same opted-in Linux VMs as
// ssh-security-collector.js, flagging connections to IPs outside Vietnam as anomalous. Unlike SSH
// login parsing this needs no sudo: /proc/net/tcp (what `ss` reads) is world-readable, so any user
// can see every socket's local/remote address — only per-process ownership (`-p`) needs root, which
// isn't needed here.
const { NodeSSH } = require('node-ssh');
const db = require('./database');
const { classifyIp } = require('./ssh-security-collector');
const sshCredentials = require('./ssh-credentials');

// Must match MySQL's own CURRENT_TIMESTAMP format AND timezone. This server's MySQL has
// time_zone=SYSTEM = Asia/Ho_Chi_Minh, so CURRENT_TIMESTAMP/NOW() already return GMT+7 wall-clock
// strings, not UTC (confirmed empirically). toISOString() (UTC) would silently land ~7h "in the
// past" relative to real last_seen values, so the `last_seen < scanStartedAt` prune below would
// almost never match anything — pruning would quietly stop working. The 'sv-SE' locale reliably
// gives "YYYY-MM-DD HH:MM:SS" in the target zone with no manual offset math.
function toSqlDatetime(date) {
  return date.toLocaleString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' });
}

// `state listening`/`state established` filters (rather than `-l`/plain `-t`) both drop the
// redundant State column, so LISTEN and ESTAB lines share the same 4-column layout: RecvQ SendQ
// Local Peer [process info] — one parser handles both. Only the ESTAB half needs `-p` (process
// owner) since that's the data this feature actually surfaces; LISTEN is only used to build the
// port-exclusion set. `-p` needs root to see other users' processes — try `sudo -n` first (works
// wherever the fleet's sudoers already grants it) and fall back to plain `ss` (no process names,
// same as before) so the connection data itself never breaks just because process attribution
// isn't available on a given VM yet.
//
// ===PROCS===/===CWD=== added so the report can show what a curl/wget download's actual URL and
// destination path were, not just the bare process name — `ss -p` only gives the short process
// name, never its arguments. `ps -eo pid=,args=` (full command line) covers every process in one
// call; the CWD loop is scoped to just curl/wget PIDs (matched by exact `comm`, not a substring of
// args) since that's a second `readlink` per match and every other process's cwd is irrelevant
// here. Same sudo -n-then-fallback shape as the ss call above.
const SCAN_SCRIPT = `
echo "===LISTEN==="
ss -tnH state listening 2>/dev/null
echo "===ESTAB==="
sudo -n ss -tnpH state established 2>/dev/null || ss -tnH state established 2>/dev/null
echo "===PROCS==="
sudo -n ps -eo pid=,args= 2>/dev/null || ps -eo pid=,args= 2>/dev/null
echo "===CWD==="
DL_PIDS=$( (sudo -n ps -eo pid=,comm= 2>/dev/null || ps -eo pid=,comm= 2>/dev/null) | awk '$2=="curl"||$2=="wget"{print $1}')
for pid in $DL_PIDS; do
  cwd=$(sudo -n readlink -f /proc/$pid/cwd 2>/dev/null || readlink -f /proc/$pid/cwd 2>/dev/null)
  [ -n "$cwd" ] && echo "$pid|$cwd"
done
`.trim();

// Addresses come as "1.2.3.4:80", "[::ffff:1.2.3.4]:80" (IPv4-mapped IPv6, common with dual-stack
// listeners), or "[::1]:80". Only the port matters for the listening-set; the IP matters for peers.
function splitAddrPort(addr) {
  const bracketed = /^\[(.+)\]:(\d+)$/.exec(addr);
  if (bracketed) return { ip: bracketed[1].replace(/^::ffff:/, ''), port: bracketed[2] };
  const idx = addr.lastIndexOf(':');
  if (idx === -1) return { ip: addr, port: null };
  return { ip: addr.slice(0, idx), port: addr.slice(idx + 1) };
}

// A connection is "outbound" (this VM initiated it) when its local port is NOT one of this VM's
// own listening ports — i.e. it's an ephemeral client-side port, not a service accepting inbound
// traffic. This is robust to VMs that happen to listen on high ports (seen in practice: 8000-9100
// range on some app servers) where a naive "local port > 1024" heuristic would misclassify inbound
// connections to those services as outbound.
// With `-p` (root only), ss appends "users:((\"name\",pid=123,fd=4)[,(\"name2\",pid=456,fd=7)])" —
// a socket can be shared by more than one process (e.g. forked sshd); just the first is shown here.
function parseProcessInfo(tail) {
  const m = /\(\("([^"]+)",pid=(\d+)/.exec(tail);
  return m ? { processName: m[1], pid: Number(m[2]) } : { processName: null, pid: null };
}

// "===PROCS==="/"===CWD===" sections are recognized as explicit section transitions too (set
// section to something other than 'listen'/'estab' so their lines are safely skipped by the
// ss-column parsing below) — without this, a `ps`/readlink output line that happens to split into
// >=4 whitespace-separated columns could get misread as an ESTAB socket line.
function parseScan(stdout) {
  const listenPorts = new Set();
  const outbound = [];
  let section = null;
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line === '===LISTEN===') { section = 'listen'; continue; }
    if (line === '===ESTAB===') { section = 'estab'; continue; }
    if (line === '===PROCS===' || line === '===CWD===') { section = 'other'; continue; }
    if (section !== 'listen' && section !== 'estab') continue;
    const cols = line.split(/\s+/);
    if (cols.length < 4) continue;
    const [, , localAddr, peerAddr, ...rest] = cols;
    if (section === 'listen') {
      const { port } = splitAddrPort(localAddr);
      if (port) listenPorts.add(port);
    } else if (section === 'estab') {
      const { port: localPort } = splitAddrPort(localAddr);
      if (!localPort || listenPorts.has(localPort)) continue; // inbound to a service on this VM
      const { ip: remoteIp, port: remotePort } = splitAddrPort(peerAddr);
      if (!remoteIp || remoteIp === '127.0.0.1' || remoteIp === '::1') continue;
      const { processName, pid } = parseProcessInfo(rest.join(' '));
      outbound.push({ remoteIp, remotePort: Number(remotePort) || null, processName, pid });
    }
  }
  return outbound;
}

// "===PROCS===" section: `ps -eo pid=,args=` — one process per line, e.g.
// "1234 curl -o /tmp/file.zip http://example.com/file.zip". Returns Map<pid, cmdline>.
//
// Section boundaries are found by EXACT equality on a trimmed line (mirroring parseScan's
// "===LISTEN==="/"===ESTAB===" handling above) rather than a substring/regex search across the
// whole stdout blob. This matters here specifically: `ps -eo args=` legitimately includes the
// shell process currently running this very script, whose own `args` IS the entire script text —
// "===CWD===" marker and all — with any newlines inside that single ps row collapsed to spaces
// (confirmed empirically against a real VM). A substring search for "\n===CWD===" would find that
// embedded, mid-line occurrence and truncate the section early, losing every real process line
// after it. Matching only a line that IS "===CWD===" and nothing else doesn't have that failure
// mode, since `ps` always renders exactly one process per stdout line — the self-referential entry
// still lands in the map (under its own real PID, with garbage-looking cmdline text), which is
// harmless: it's never looked up, since it doesn't match any actual connection's PID.
function parseProcs(stdout) {
  const map = new Map();
  let inSection = false;
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (line === '===PROCS===') { inSection = true; continue; }
    if (line === '===CWD===') break;
    if (!inSection || !line) continue;
    const m = /^(\d+)\s+(.*)$/.exec(line);
    if (m) map.set(Number(m[1]), m[2]);
  }
  return map;
}

// "===CWD===" section: "pid|cwd" lines, curl/wget PIDs only (see SCAN_SCRIPT). Returns Map<pid, cwd>.
// Same exact-line-match section detection as parseProcs, for the same reason.
function parseCwds(stdout) {
  const map = new Map();
  let inSection = false;
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (line === '===CWD===') { inSection = true; continue; }
    if (!inSection || !line) continue;
    const idx = line.indexOf('|');
    if (idx === -1) continue;
    const pid = Number(line.slice(0, idx));
    const cwd = line.slice(idx + 1);
    if (pid && cwd) map.set(pid, cwd);
  }
  return map;
}

// Pure, testable: given a curl/wget command line (+ its process cwd, for resolving a relative
// destination path), extracts { url, destination } — the actual download target and where it
// landed. Deliberately not exhaustive of every curl/wget flag, just the common explicit-destination
// forms; returns destination: null (url may still be set) when only the implicit "same name as the
// URL, in cwd" default applies, since we don't re-derive the exact filename curl/wget would choose
// (e.g. Content-Disposition can override it) — the UI falls back to showing "cwd (tên file gốc)".
function parseDownloadDetail(processName, cmdline, cwd) {
  if (!cmdline) return null;
  const proc = (processName || '').toLowerCase();
  if (proc !== 'curl' && proc !== 'wget') return null;

  // Tokenize respecting simple '...'/"..." quoting (a real cmdline from /proc rarely has nested
  // quotes) — good enough for the common invocations this is meant to surface, not a full shell
  // parser.
  const tokens = cmdline.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  const strip = (t) => t.replace(/^["']|["']$/g, '');

  const url = tokens.map(strip).find((t) => /^[a-z][a-z0-9+.-]*:\/\//i.test(t));
  if (!url) return null;

  let destination = null;
  for (let i = 0; i < tokens.length; i++) {
    const t = strip(tokens[i]);
    if ((proc === 'curl' && (t === '-o' || t === '--output')) || (proc === 'wget' && (t === '-O' || t === '--output-document'))) {
      destination = strip(tokens[i + 1] || '');
    } else if (proc === 'curl' && /^--output=/.test(t)) {
      destination = strip(t.slice('--output='.length));
    } else if (proc === 'wget' && /^--output-document=/.test(t)) {
      destination = strip(t.slice('--output-document='.length));
    } else if (proc === 'wget' && (t === '-P' || t === '--directory-prefix')) {
      const dir = strip(tokens[i + 1] || '');
      const filename = url.split('/').filter(Boolean).pop() || 'index.html';
      destination = dir ? `${dir.replace(/\/$/, '')}/${filename}` : null;
    } else if (proc === 'wget' && /^--directory-prefix=/.test(t)) {
      const dir = strip(t.slice('--directory-prefix='.length));
      const filename = url.split('/').filter(Boolean).pop() || 'index.html';
      destination = `${dir.replace(/\/$/, '')}/${filename}`;
    }
  }
  // Resolve a relative -o/-O path against the process's actual cwd so the report shows a full,
  // unambiguous path instead of a fragment that only makes sense if you already know where the
  // process was running from.
  if (destination && cwd && !destination.startsWith('/')) {
    destination = `${cwd.replace(/\/$/, '')}/${destination}`;
  }
  return { url, destination };
}

async function raiseOutboundForeignAlert(vm, remoteIp, remotePort, country, processName, pid) {
  const procText = processName ? ` bởi tiến trình "${processName}"${pid ? ` (PID ${pid})` : ''}` : '';
  await db.prepare(`
    INSERT INTO alerts (category, severity, title, message, source_type, source_id, source_name, metric, metric_value, status)
    VALUES ('security', 'critical', ?, ?, 'vcenter_vm', ?, ?, 'outbound_foreign', ?, 'open')
  `).run(
    'Kết nối ra ngoài bất thường tới IP nước ngoài',
    `VM "${vm.name}" mở kết nối ra ${remoteIp}:${remotePort} (${country})${procText} — không phải Việt Nam`,
    vm.id, vm.name, `${remoteIp} (${country})`
  );
}

// COALESCE keeps the last known process name/pid/cmdline/cwd if this cycle's scan didn't resolve
// one (e.g. a transient sudo hiccup, or — very commonly for a short-lived curl/wget — the process
// already exited by the time this poll ran) rather than blanking out previously-known attribution.
const upsertSeen = db.prepare(`
  UPDATE outbound_connections SET last_seen = CURRENT_TIMESTAMP, process_name = COALESCE(?, process_name),
    pid = COALESCE(?, pid), cmdline = COALESCE(?, cmdline), cwd = COALESCE(?, cwd) WHERE id = ?
`);
const insertNew = db.prepare(`
  INSERT INTO outbound_connections (vm_id, vm_name, remote_ip, remote_port, country, is_foreign, process_name, pid, cmdline, cwd)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const findExisting = db.prepare(`
  SELECT id FROM outbound_connections WHERE vm_id = ? AND remote_ip = ? AND remote_port = ?
`);

async function collectVm(vm) {
  const opts = await sshCredentials.buildConnectOptions(vm);
  if (!opts) return;
  const ssh = new NodeSSH();
  try {
    await ssh.connect(opts);

    const scanStartedAt = toSqlDatetime(new Date());
    const result = await ssh.execCommand(SCAN_SCRIPT);
    const outbound = parseScan(result.stdout);
    const procsByPid = parseProcs(result.stdout);
    const cwdsByPid = parseCwds(result.stdout);

    for (const conn of outbound) {
      const { country, isForeign } = classifyIp(conn.remoteIp);
      const cmdline = conn.pid ? procsByPid.get(conn.pid) || null : null;
      const cwd = conn.pid ? cwdsByPid.get(conn.pid) || null : null;
      const existing = await findExisting.get(vm.id, conn.remoteIp, conn.remotePort);
      if (existing) {
        await upsertSeen.run(conn.processName, conn.pid, cmdline, cwd, existing.id);
      } else {
        await insertNew.run(vm.id, vm.name, conn.remoteIp, conn.remotePort, country, isForeign, conn.processName, conn.pid, cmdline, cwd);
        if (isForeign) await raiseOutboundForeignAlert(vm, conn.remoteIp, conn.remotePort, country, conn.processName, conn.pid);
      }
    }
    // Anything not refreshed this cycle is no longer established. Benign (non-foreign) rows are
    // pruned immediately — they're just current-state noise. Foreign rows are kept as a permanent
    // history even after the connection closes (last_seen simply stops advancing), since a past
    // connection to a foreign IP is itself the security-relevant fact, not just its live status.
    await db.prepare('DELETE FROM outbound_connections WHERE vm_id = ? AND is_foreign = 0 AND last_seen < ?').run(vm.id, scanStartedAt);
  } catch (e) {
    console.error(`[outbound-conn] ${vm.name} (${vm.ip_address}): ${e.message}`);
  } finally {
    ssh.dispose();
  }
}

async function collectAll() {
  const vms = await db.prepare(`
    SELECT id, name, ip_address, ssh_user, ssh_port, ssh_credential_id FROM vcenter_vms
    WHERE power_state = 'POWERED_ON' AND ssh_credential_id IS NOT NULL
      AND ip_address IS NOT NULL AND ip_address != ''
      AND (guest_family IS NULL OR guest_family = 'LINUX')
  `).all();
  if (!vms.length) return;
  await Promise.allSettled(vms.map(collectVm));
  // Foreign history is kept much longer than routine data (180 days) since it's a security record,
  // not live status — this just bounds it so the table doesn't grow forever.
  await db.prepare("DELETE FROM outbound_connections WHERE is_foreign = 1 AND last_seen < DATE_SUB(NOW(), INTERVAL 180 DAY)").run();
}

function start(intervalMs = 60000) {
  // Wrapped in .catch — see alert-engine.js's start() for why (async setInterval + network DB).
  const tick = () => collectAll().catch(e => console.error('[outbound-conn] Lỗi:', e.message));
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = { start, collectAll, collectVm, parseScan, splitAddrPort, parseProcessInfo, parseProcs, parseCwds, parseDownloadDetail };
