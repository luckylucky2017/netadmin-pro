// "Outside-in" uptime + SSL certificate expiry monitoring — UptimeRobot/Kuma-style, separate from
// the internal SSH/vCenter monitoring elsewhere in the app. 3 check types (monitors.type):
//   - 'http' (default): full HTTP(S) request, status code + optional keyword matching + TLS cert
//     read straight off the same socket used for the check (see performHttpCheck).
//   - 'tcp': raw TCP connect to host:port, no protocol awareness — for anything a browser can't
//     directly hit (databases, message queues, SSH, a custom service on a bare port).
//   - 'ping': ICMP echo via the `ping` npm package (host reachability only, no port/protocol at
//     all) — the actual escape hatch for "URL-only isn't accurate enough", since a host can be
//     network-reachable while its web server is down, or vice versa; these 3 types answer 3
//     genuinely different questions about the same target.
// Uses Node's built-in http/https modules for the 'http' type (no extra dependency) so the SSL
// certificate can be read straight off the same TLS socket used for the uptime check itself,
// rather than opening a second connection.
const https = require('https');
const http = require('http');
const net = require('net');
const { URL } = require('url');
const db = require('./database');

// Already a real dependency (routes/ping.js/chatbot-tools.js use it the same way) — internally
// spawns the system `ping` binary with an argument array (not a shell string), so a malicious host
// value can't inject shell metacharacters; routes/monitors.js still validates host against a strict
// charset as defense-in-depth before it ever reaches here.
let pingLib;
try { pingLib = require('ping'); } catch { pingLib = null; }

const MAX_BODY_BYTES = 1_000_000; // cap keyword-matching reads so a huge page can't blow up memory

// This server's MySQL has time_zone=SYSTEM = Asia/Ho_Chi_Minh, so CURRENT_TIMESTAMP/NOW() already
// return GMT+7 wall-clock strings, not UTC (confirmed empirically) — cert_expires_at must match or
// the frontend (which assumes every stored timestamp is GMT+7) would display it 7h earlier than
// the certificate's real expiry. toISOString() gives UTC; 'sv-SE' locale reliably gives
// "YYYY-MM-DD HH:MM:SS" in the target zone instead.
function toSqlDatetime(date) {
  return date.toLocaleString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' });
}

// Single HTTP(S) request: measures response time, reads the peer TLS certificate (https only), and
// applies keyword matching if configured. Never throws — network/timeout failures resolve as 'down'
// with an error string, same contract as fail2ban-manager.js/ipmi-collector.js's check functions.
// Fields every performXCheck resolves with, beyond the base {status, status_code, response_ms,
// error} — kept as one constant so every early-return/error path (tcp, ping, malformed URL,
// connection error) fills them in as null instead of silently omitting keys, which would leave
// stale values in updateMonitorCache's positional bind on a check that used to succeed and now fails.
const EMPTY_CERT_FIELDS = {
  cert_expires_at: null, cert_issuer: null, cert_valid_from: null, cert_subject: null,
  cert_serial: null, cert_fingerprint: null, cert_san: null, tls_protocol: null, tls_cipher: null,
};

function performHttpCheck(monitor) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let target;
    try {
      target = new URL(monitor.url);
    } catch {
      return resolve({ status: 'down', status_code: null, response_ms: null, error: 'URL không hợp lệ', ...EMPTY_CERT_FIELDS });
    }
    const isHttps = target.protocol === 'https:';
    const lib = isHttps ? https : http;
    const options = {
      method: 'GET',
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: target.pathname + target.search,
      timeout: (monitor.timeout_sec || 10) * 1000,
      headers: { 'User-Agent': 'NetAdminPro-UptimeMonitor/1.0', Connection: 'close' },
      // Force a brand-new TCP+TLS handshake every check — never reuse the global agent's keep-alive
      // pool. Confirmed via real testing: on a reused/session-resumed connection,
      // res.socket.getPeerCertificate() unreliably comes back empty (no valid_to), silently losing
      // cert-expiry monitoring on repeat checks. A fresh handshake also means response_ms reflects a
      // genuine cold connection, which is what an uptime monitor should actually be measuring.
      agent: false,
    };
    if (isHttps) options.rejectUnauthorized = !monitor.ignore_tls_errors;

    const req = lib.request(options, (res) => {
      // Read the peer certificate as soon as headers arrive, NOT in the 'end' handler — by the time
      // the body finishes streaming, res.socket can already be null (Node may detach/recycle it,
      // especially on short responses or keep-alive), which threw here during real-domain testing.
      const certFields = { ...EMPTY_CERT_FIELDS };
      if (isHttps && res.socket) {
        // getProtocol/getCipher describe the negotiated TLS session itself — available whenever the
        // handshake completed, independent of whether the peer certificate below parses cleanly.
        if (typeof res.socket.getProtocol === 'function') certFields.tls_protocol = res.socket.getProtocol() || null;
        if (typeof res.socket.getCipher === 'function') certFields.tls_cipher = res.socket.getCipher()?.standardName || res.socket.getCipher()?.name || null;
        if (typeof res.socket.getPeerCertificate === 'function') {
          // detailed=true unlocks subjectaltname and the full issuer/subject objects — without it,
          // Node's default only returns C/O/CN, dropping most of what an admin actually wants here.
          const cert = res.socket.getPeerCertificate(true);
          if (cert && cert.valid_to) {
            certFields.cert_expires_at = toSqlDatetime(new Date(cert.valid_to));
            certFields.cert_issuer = cert.issuer?.O || cert.issuer?.CN || null;
            certFields.cert_valid_from = toSqlDatetime(new Date(cert.valid_from));
            certFields.cert_subject = cert.subject?.CN || cert.subject?.O || null;
            certFields.cert_serial = cert.serialNumber || null;
            certFields.cert_fingerprint = cert.fingerprint256 || cert.fingerprint || null;
            // subjectaltname comes back as "DNS:a.com, DNS:b.com, IP Address:1.2.3.4" — strip the
            // "DNS:"/"IP Address:" prefixes for a cleaner comma-separated display list.
            certFields.cert_san = cert.subjectaltname
              ? cert.subjectaltname.split(',').map((s) => s.trim().replace(/^(DNS|IP Address):/, '')).join(', ')
              : null;
          }
        }
      }

      let body = '';
      res.on('data', (chunk) => { if (body.length < MAX_BODY_BYTES) body += chunk; });
      res.on('end', () => {
        const response_ms = Date.now() - startedAt;
        // expected_status_code (nullable) requires an EXACT match when set — e.g. a monitor behind
        // a redirect-happy load balancer or one that deliberately wants to alert on a 3xx it used to
        // silently accept. Falls back to the original "any 2xx/3xx counts as up" range when unset,
        // so every pre-existing monitor keeps behaving exactly as before.
        let status = monitor.expected_status_code != null
          ? (res.statusCode === monitor.expected_status_code ? 'up' : 'down')
          : (res.statusCode >= 200 && res.statusCode < 400) ? 'up' : 'down';
        let error = status === 'down'
          ? (monitor.expected_status_code != null ? `HTTP ${res.statusCode} (mong đợi ${monitor.expected_status_code})` : `HTTP ${res.statusCode}`)
          : null;
        if (status === 'up' && monitor.keyword) {
          const found = body.includes(monitor.keyword);
          const shouldBePresent = monitor.keyword_type !== 'not_contains';
          if (found !== shouldBePresent) {
            status = 'down';
            error = shouldBePresent
              ? `Không tìm thấy từ khóa "${monitor.keyword}"`
              : `Vẫn thấy từ khóa "${monitor.keyword}" (đáng lẽ không được có)`;
          }
        }
        resolve({ status, status_code: res.statusCode, response_ms, error, ...certFields });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Timeout')));
    req.on('error', (e) => {
      resolve({ status: 'down', status_code: null, response_ms: Date.now() - startedAt, error: e.message, ...EMPTY_CERT_FIELDS });
    });
    req.end();
  });
}

// Raw TCP connect — 'up' the instant the handshake completes, no data exchanged. This is
// deliberately protocol-blind: it answers "is something listening and accepting connections on
// this port" (a database, SSH, a message broker, a bare custom service), not "is the application
// behind it healthy" — that distinction is exactly what makes it a meaningfully different check
// from an HTTP monitor, not a strictly weaker one.
function performTcpCheck(monitor) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const timeoutMs = (monitor.timeout_sec || 10) * 1000;
    const finish = (status, error) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({ status, status_code: null, response_ms: Date.now() - startedAt, error, ...EMPTY_CERT_FIELDS });
    };
    const socket = net.createConnection({ host: monitor.host, port: monitor.port, timeout: timeoutMs });
    socket.on('connect', () => finish('up', null));
    socket.on('timeout', () => finish('down', `Timeout kết nối TCP tới ${monitor.host}:${monitor.port}`));
    socket.on('error', (e) => finish('down', e.message));
  });
}

// ICMP echo via the `ping` package — pure host reachability, no port/protocol involved at all.
// response_ms falls back to our own wall-clock measurement when the underlying `ping` binary's
// reported time is 'unknown' (observed on some minimal/musl-based ping implementations that don't
// print a time on a fast local reply) rather than storing a misleading null on an otherwise-alive host.
async function performPingCheck(monitor) {
  const startedAt = Date.now();
  if (!pingLib) {
    return { status: 'down', status_code: null, response_ms: null, error: 'Thư viện ping (ICMP) không khả dụng trên server này', ...EMPTY_CERT_FIELDS };
  }
  try {
    const res = await pingLib.promise.probe(monitor.host, { timeout: monitor.timeout_sec || 10 });
    if (!res.alive) return { status: 'down', status_code: null, response_ms: null, error: 'Không phản hồi ping (ICMP)', ...EMPTY_CERT_FIELDS };
    const response_ms = (res.time == null || res.time === 'unknown') ? (Date.now() - startedAt) : Math.round(parseFloat(res.time));
    return { status: 'up', status_code: null, response_ms, error: null, ...EMPTY_CERT_FIELDS };
  } catch (e) {
    return { status: 'down', status_code: null, response_ms: Date.now() - startedAt, error: e.message, ...EMPTY_CERT_FIELDS };
  }
}

// Dispatches to the right check by monitors.type — the single entry point every caller
// (checkMonitor below, routes/monitors.js's POST /:id/check) actually calls; individual
// performXCheck functions above are exported mainly for direct unit testing.
function performCheck(monitor) {
  if (monitor.type === 'tcp') return performTcpCheck(monitor);
  if (monitor.type === 'ping') return performPingCheck(monitor);
  return performHttpCheck(monitor);
}

const insertCheck = db.prepare('INSERT INTO monitor_checks (monitor_id, status, status_code, response_ms, error) VALUES (?, ?, ?, ?, ?)');
// SSL/TLS detail fields live only on monitors (a latest-value cache), not per-row in monitor_checks —
// same treatment cert_expires_at/cert_issuer already had, since a cert doesn't meaningfully change
// between consecutive checks and storing it on every row would just bloat the 30-day check history.
const updateMonitorCache = db.prepare(`
  UPDATE monitors SET current_status=?, last_checked_at=CURRENT_TIMESTAMP, last_response_ms=?, last_status_code=?, last_error=?,
    cert_expires_at=?, cert_issuer=?, cert_valid_from=?, cert_subject=?, cert_serial=?, cert_fingerprint=?, cert_san=?, tls_protocol=?, tls_cipher=?,
    updated_at=CURRENT_TIMESTAMP
  WHERE id=?
`);

async function checkMonitor(monitor) {
  const r = await performCheck(monitor);
  await insertCheck.run(monitor.id, r.status, r.status_code, r.response_ms, r.error);
  await updateMonitorCache.run(
    r.status, r.response_ms, r.status_code, r.error,
    r.cert_expires_at, r.cert_issuer, r.cert_valid_from, r.cert_subject, r.cert_serial, r.cert_fingerprint, r.cert_san, r.tls_protocol, r.tls_cipher,
    monitor.id
  );
  return r;
}

async function collectAll() {
  // Each monitor has its own check_interval_sec — one shared tick loop filters for "due" monitors
  // rather than running N separate setInterval timers.
  const due = await db.prepare(`
    SELECT * FROM monitors WHERE enabled = 1
      AND (last_checked_at IS NULL OR last_checked_at <= DATE_SUB(NOW(), INTERVAL check_interval_sec SECOND))
  `).all();
  if (due.length) await Promise.allSettled(due.map(checkMonitor));
  await db.prepare("DELETE FROM monitor_checks WHERE checked_at < DATE_SUB(NOW(), INTERVAL 30 DAY)").run();
}

function start(intervalMs = 30000) {
  // Wrapped in .catch — same reasoning as the other collectors (async setInterval + network I/O).
  const tick = () => collectAll().catch(e => console.error('[uptime] Lỗi:', e.message));
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = { start, collectAll, checkMonitor, performCheck, performHttpCheck, performTcpCheck, performPingCheck };
