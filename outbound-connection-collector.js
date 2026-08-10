// Monitors outbound (VM-initiated) established TCP connections on the same opted-in Linux VMs as
// ssh-security-collector.js, flagging connections to IPs outside Vietnam as anomalous. Unlike SSH
// login parsing this needs no sudo: /proc/net/tcp (what `ss` reads) is world-readable, so any user
// can see every socket's local/remote address — only per-process ownership (`-p`) needs root, which
// isn't needed here.
const { NodeSSH } = require('node-ssh');
const dns = require('dns');
const db = require('./database');
const { classifyIp } = require('./ssh-security-collector');
const sshCredentials = require('./ssh-credentials');

// Best-effort PTR lookup from the netadmin-pro server itself (not the monitored VM) — a domain hint
// for the "what is this IP" question that applies to every process, not just curl/wget (which
// already gets its actual URL from cmdline via parseDownloadDetail). Many IPs (internal, or public
// IPs with no PTR record configured) will legitimately resolve to nothing — that's a normal, silent
// outcome, not an error. A hard timeout guards against a slow/unresponsive resolver stalling the
// whole collection cycle; dns.reverse itself has no built-in timeout.
function reverseDnsLookup(ip, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, timeoutMs);
    dns.reverse(ip, (err, hostnames) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(!err && hostnames && hostnames.length ? hostnames[0] : null);
    });
  });
}

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
// ESTAB additionally uses `-i` (TCP_INFO): answers "is this process pulling data in or pushing it
// out" by reading the kernel's own cumulative bytes_sent/bytes_received counters for the socket —
// confirmed live to work through the same sudo -n path — rather than guessing from process name or
// packet inspection (which would mean decrypting TLS, out of scope). `-i` prints each connection as
// TWO lines: the usual summary line, then an indented continuation line (always starts with a literal
// tab — never any other line does) carrying "bytes_sent:N ... bytes_received:M ...". parseScan below
// attaches that continuation line to whichever outbound entry the summary line just before it
// produced (or discards it if that summary line itself was filtered out, e.g. an inbound/loopback
// row) — see the `pendingEstabEntry` tracking.
//
// ===PROCS===/===CWD=== added so the report can show what a curl/wget download's actual URL and
// destination path were, not just the bare process name — `ss -p` only gives the short process
// name, never its arguments. `ps -eo pid=,args=` (full command line) covers every process in one
// call; the CWD loop is scoped to just curl/wget PIDs (matched by exact `comm`, not a substring of
// args) since that's a second `readlink` per match and every other process's cwd is irrelevant
// here. Same sudo -n-then-fallback shape as the ss call above.
// UDP has no TCP-style LISTEN/ESTABLISHED state filter that reliably works the same way across
// kernels, so instead of "state established" we grab EVERY UDP socket (-a) and classify by its own
// State column ourselves in parseScan: "ESTAB" means the process called connect() and has a fixed
// peer (a real outbound target — DNS-over-UDP resolvers, NTP clients, QUIC/HTTP3, etc.); "UNCONN"
// means it's just bound to a local port with no fixed peer (the common case for e.g. a DNS
// server/client using sendto() per-packet) and is excluded, same as it would be if it showed up as
// a TCP LISTEN. Unlike the TCP branches above, this section is NOT run through a "state x" filter,
// so ss keeps its State column here — one extra leading field parseScan has to account for.
const SCAN_SCRIPT = `
echo "===LISTEN==="
ss -tnH state listening 2>/dev/null
echo "===ESTAB==="
sudo -n ss -tnpiH state established 2>/dev/null || ss -tniH state established 2>/dev/null
echo "===UDP==="
sudo -n ss -unpaH 2>/dev/null || ss -unaH 2>/dev/null
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
// Loopback check used to be an exact match on '127.0.0.1' — misses the whole 127.0.0.0/8 range
// (e.g. the '127.0.0.53'/'127.0.0.54' systemd-resolved stub addresses seen live on this fleet),
// which matters more now that UDP is scanned too (those stubs are UDP:53, the single most common
// UDP socket on any of these VMs).
function isLoopback(ip) {
  return !ip || ip.startsWith('127.') || ip === '::1';
}

function parseScan(stdout) {
  const listenPorts = new Set();
  const outbound = [];
  let section = null;
  // Tracks the outbound entry the most recent ESTAB summary line produced, so the very next line
  // (its `-i` continuation line, if any) can attach bytes_sent/bytes_received to the right entry —
  // null when that summary line was filtered out (inbound/loopback), so a continuation line for a
  // SKIPPED connection doesn't get misattributed to whatever entry came before it.
  let pendingEstabEntry = null;
  for (const raw of stdout.split('\n')) {
    // Must check BEFORE trimming: ss's `-i` continuation line is the only line that starts with a
    // literal tab, which is how it's told apart from a real summary line (which could otherwise also
    // split into >=4 whitespace-separated tokens and be misread as one).
    if (section === 'estab' && raw.startsWith('\t')) {
      if (pendingEstabEntry) {
        const sentM = /bytes_sent:(\d+)/.exec(raw);
        const recvM = /bytes_received:(\d+)/.exec(raw);
        if (sentM) pendingEstabEntry.bytesSent = Number(sentM[1]);
        if (recvM) pendingEstabEntry.bytesReceived = Number(recvM[1]);
        pendingEstabEntry = null;
      }
      continue;
    }
    const line = raw.trim();
    if (!line) continue;
    if (line === '===LISTEN===') { section = 'listen'; continue; }
    if (line === '===ESTAB===') { section = 'estab'; continue; }
    if (line === '===UDP===') { section = 'udp'; continue; }
    if (line === '===PROCS===' || line === '===CWD===') { section = 'other'; continue; }
    if (section === 'listen' || section === 'estab') {
      const cols = line.split(/\s+/);
      if (cols.length < 4) continue;
      const [, , localAddr, peerAddr, ...rest] = cols;
      if (section === 'listen') {
        const { port } = splitAddrPort(localAddr);
        if (port) listenPorts.add(port);
      } else {
        pendingEstabEntry = null; // reset per summary line; set below only if this one is kept
        const { port: localPort } = splitAddrPort(localAddr);
        if (!localPort || listenPorts.has(localPort)) continue; // inbound to a service on this VM
        const { ip: remoteIp, port: remotePort } = splitAddrPort(peerAddr);
        if (isLoopback(remoteIp)) continue;
        const { processName, pid } = parseProcessInfo(rest.join(' '));
        const entry = { remoteIp, remotePort: Number(remotePort) || null, processName, pid, protocol: 'tcp' };
        outbound.push(entry);
        pendingEstabEntry = entry;
      }
    } else if (section === 'udp') {
      // No "state x" filter here (see SCAN_SCRIPT comment), so the State column is still present:
      // State RecvQ SendQ LocalAddr PeerAddr [process] — one extra leading field vs the TCP branches.
      const cols = line.split(/\s+/);
      if (cols.length < 5 || cols[0] !== 'ESTAB') continue; // UNCONN = no fixed peer, not outbound
      const [, , , localAddr, peerAddr, ...rest] = cols;
      const { port: localPort } = splitAddrPort(localAddr);
      if (!localPort) continue;
      const { ip: remoteIp, port: remotePort } = splitAddrPort(peerAddr);
      if (isLoopback(remoteIp) || !remoteIp || remoteIp.includes('*')) continue;
      const { processName, pid } = parseProcessInfo(rest.join(' '));
      outbound.push({ remoteIp, remotePort: Number(remotePort) || null, processName, pid, protocol: 'udp' });
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

// Best-effort application-layer protocol label — answers "is this HTTP/HTTPS/DNS/SSH/etc." for
// every connection, not just curl/wget's already-known URL scheme. Two sources, most-reliable first:
// (1) the URL scheme from a curl/wget invocation (ground truth, when available); (2) a well-known
// port lookup (a convention, not a guarantee — something could run a non-HTTP protocol on 443 — but
// right in the overwhelming majority of real traffic and the only signal available for processes
// that aren't curl/wget). Returns null rather than guessing wildly when neither source has an answer.
const WELL_KNOWN_TCP_PORTS = {
  20: 'FTP-DATA', 21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP', 80: 'HTTP',
  110: 'POP3', 119: 'NNTP', 143: 'IMAP', 389: 'LDAP', 443: 'HTTPS', 445: 'SMB',
  465: 'SMTPS', 514: 'Syslog', 587: 'SMTP', 636: 'LDAPS', 990: 'FTPS', 993: 'IMAPS',
  995: 'POP3S', 1433: 'MSSQL', 1521: 'Oracle', 2049: 'NFS', 2181: 'ZooKeeper',
  3306: 'MySQL', 3389: 'RDP', 5432: 'PostgreSQL', 5671: 'AMQPS', 5672: 'AMQP',
  5984: 'CouchDB', 6379: 'Redis', 8080: 'HTTP', 8443: 'HTTPS', 8883: 'MQTTS',
  9092: 'Kafka', 9200: 'Elasticsearch', 9300: 'Elasticsearch', 27017: 'MongoDB',
};
const WELL_KNOWN_UDP_PORTS = {
  53: 'DNS', 67: 'DHCP', 68: 'DHCP', 69: 'TFTP', 123: 'NTP', 161: 'SNMP',
  443: 'QUIC/HTTP3', 500: 'IPsec/IKE', 514: 'Syslog', 1194: 'OpenVPN', 4500: 'IPsec/NAT-T',
  51820: 'WireGuard',
};
function guessAppProtocol(protocol, remotePort, downloadUrl) {
  if (downloadUrl) {
    const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(downloadUrl)?.[1]?.toLowerCase();
    if (scheme) return scheme.toUpperCase();
  }
  if (!remotePort) return null;
  const table = protocol === 'udp' ? WELL_KNOWN_UDP_PORTS : WELL_KNOWN_TCP_PORTS;
  return table[remotePort] || null;
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
    pid = COALESCE(?, pid), cmdline = COALESCE(?, cmdline), cwd = COALESCE(?, cwd),
    bytes_sent = COALESCE(?, bytes_sent), bytes_received = COALESCE(?, bytes_received) WHERE id = ?
`);
const insertNew = db.prepare(`
  INSERT INTO outbound_connections (vm_id, vm_name, remote_ip, remote_port, country, is_foreign, process_name, pid, cmdline, cwd, remote_hostname, protocol, app_protocol, bytes_sent, bytes_received)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
// Identity is still (vm, remote_ip, remote_port) only — same as the table's uq_outbound constraint,
// deliberately NOT widened to include protocol. A TCP and UDP connection sharing the exact same
// remote ip:port (e.g. QUIC/HTTP3 falling back to TCP on the same :443) is rare enough in practice
// that widening the unique key isn't worth the migration risk on a table that can grow large; in
// that rare case they collapse into one tracked row (whichever was seen first), which is an accepted
// tradeoff, not a crash — inserting a 2nd row for the same key would violate uq_outbound otherwise.
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

    // Figure out which connections are actually new BEFORE doing any PTR lookups, so an
    // already-tracked long-lived connection never pays the DNS cost again — same "resolve once"
    // philosophy as cmdline/cwd. Deduped by IP (not by connection) since several new connections can
    // share a destination (e.g. multiple ports to the same CDN edge).
    const existingByConn = new Map(await Promise.all(
      outbound.map(async (conn) => [conn, await findExisting.get(vm.id, conn.remoteIp, conn.remotePort)])
    ));
    const newIps = [...new Set(outbound.filter((c) => !existingByConn.get(c)).map((c) => c.remoteIp))];
    const hostnameByIp = new Map(await Promise.all(newIps.map(async (ip) => [ip, await reverseDnsLookup(ip)])));

    for (const conn of outbound) {
      const { country, isForeign } = classifyIp(conn.remoteIp);
      const cmdline = conn.pid ? procsByPid.get(conn.pid) || null : null;
      const cwd = conn.pid ? cwdsByPid.get(conn.pid) || null : null;
      const existing = existingByConn.get(conn);
      const bytesSent = conn.bytesSent ?? null;
      const bytesReceived = conn.bytesReceived ?? null;
      if (existing) {
        await upsertSeen.run(conn.processName, conn.pid, cmdline, cwd, bytesSent, bytesReceived, existing.id);
      } else {
        const remoteHostname = hostnameByIp.get(conn.remoteIp) || null;
        const downloadUrl = parseDownloadDetail(conn.processName, cmdline, cwd)?.url || null;
        const appProtocol = guessAppProtocol(conn.protocol, conn.remotePort, downloadUrl);
        await insertNew.run(vm.id, vm.name, conn.remoteIp, conn.remotePort, country, isForeign, conn.processName, conn.pid, cmdline, cwd, remoteHostname, conn.protocol, appProtocol, bytesSent, bytesReceived);
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

module.exports = { start, collectAll, collectVm, parseScan, splitAddrPort, parseProcessInfo, parseProcs, parseCwds, parseDownloadDetail, guessAppProtocol };
