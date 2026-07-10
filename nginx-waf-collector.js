// Tails nginx access.log on VMs opted into WAF monitoring (vcenter_vms.waf_enabled), detects
// scanning/DoS/DDoS patterns from real request data, raises 'security' alerts, and — when a VM has
// waf_auto_block enabled — bans the offending IP via waf-manager.js's dedicated fail2ban jail.
// Modeled directly on ssh-security-collector.js (log-tailing cursor, GeoIP classification, alert
// lifecycle) — see that file for the reasoning behind the timestamp-formatting trick reused below.
//
// All detection logic lives here, in plain JS, rather than in a fail2ban filter regex — see
// waf-manager.js's header comment for why. Thresholds below are deliberately named constants near
// the top so they're easy to find and retune once real traffic data is visible on the page.
//
// A VM commonly serves several domains, each with its own access_log file (a typical nginx
// vhost-per-conf-file layout) — discoverAndSyncDomainLogs() parses /etc/nginx/**/*.conf on the VM
// for server_name+access_log pairs every poll, and each discovered (vm, log_path) gets its own
// tailing cursor/detection/alerting, tagged with its domain. VMs with no discoverable per-domain
// config fall back to the single vcenter_vms.waf_log_path.
const { NodeSSH } = require('node-ssh');
const db = require('./database');
const sshCredentials = require('./ssh-credentials');
const wafManager = require('./waf-manager');
const { classifyIp } = require('./ssh-security-collector');

const INITIAL_LOOKBACK_LINES = 1000; // access.log is far higher-volume than auth.log
const SCAN_ERROR_THRESHOLD = 20;     // >= this many 4xx/suspicious-path hits from 1 IP in a batch
const DOS_REQUEST_THRESHOLD = 50;    // >= this many requests from 1 IP within DOS_WINDOW_SEC
const DOS_WINDOW_SEC = 10;
const DDOS_MULTIPLIER = 5;           // batch total > this many times the recent baseline average
const DDOS_MIN_TOTAL = 200;          // ...and > this absolute floor, to avoid low-traffic false positives
const DDOS_BASELINE_SAMPLES = 20;
const STALE_ALERT_SEC = 900;         // auto-resolve an open waf_scan/waf_dos/waf_ddos alert after 15min quiet

// Matches nginx's `combined` format plus an optional trailing 4th quoted field — covers the very
// common `main` format some distros ship instead, which just appends "$http_x_forwarded_for" after
// user-agent (confirmed against a real log_format sample). Extra trailing fields beyond that are
// simply ignored (no `$` anchor at the end). A genuinely different field ORDER would still need a
// new regex — this only tolerates one extra trailing quoted field, not a reordering.
const NGINX_LINE_RE = /^(\S+) \S+ (\S+) \[([^\]]+)\] "([^"]*)" (\d{3}) (\S+) "([^"]*)" "([^"]*)"(?: "([^"]*)")?/;

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

// Same MySQL time_zone=SYSTEM (Asia/Ho_Chi_Minh) gotcha as ssh-security-collector.js's
// toSqlDatetime — toISOString() would silently land 7h off from every other timestamp column.
function toSqlDatetime(date) {
  return date.toLocaleString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' });
}

// nginx $time_local format: "10/Jul/2026:20:45:40 +0700"
function parseNginxTimestamp(str) {
  const m = /^(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})/.exec(str || '');
  if (!m) return new Date();
  const [, day, monStr, year, hh, mm, ss, tz] = m;
  const mon = MONTHS[monStr];
  if (mon === undefined) return new Date();
  const iso = `${year}-${String(mon + 1).padStart(2, '0')}-${day}T${hh}:${mm}:${ss}${tz.slice(0, 3)}:${tz.slice(3, 5)}`;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? new Date() : d;
}

// X-Forwarded-For can be a comma-separated chain ("client, proxy1, proxy2") when requests pass
// through multiple hops — the first entry is the original client as reported by the nearest hop.
function firstXffIp(xff) {
  if (!xff || xff === '-') return null;
  const first = xff.split(',')[0].trim();
  return first || null;
}

function parseNginxLine(line) {
  const m = NGINX_LINE_RE.exec(line);
  if (!m) return null;
  const [, remoteAddr, , timeLocal, request, statusStr, , referer, userAgent, xff] = m;
  const reqM = /^(\S+)\s+(\S+)/.exec(request);
  return {
    remoteAddr,
    xffIp: firstXffIp(xff),
    timestamp: parseNginxTimestamp(timeLocal),
    method: reqM ? reqM[1] : null,
    path: reqM ? reqM[2] : (request || null),
    status: Number(statusStr),
    referer,
    userAgent,
  };
}

// Common vulnerability-scan targets — not exhaustive, tunable. Deliberately avoids broad patterns
// like `\.php$` that would false-positive on any real PHP app.
const SUSPICIOUS_PATH_RE = /\.env(\.|$)|\.git\/|\.aws\/credentials|wp-login\.php|wp-admin|xmlrpc\.php|phpmyadmin|\/actuator|\.\.\//i;

// Pure, testable: groups a batch of parsed hits by IP (h.ip — set by the caller to remoteAddr or
// xffIp depending on the VM's waf_trust_xff setting) and flags scan/DoS per IP. No DB/SSH access.
function detectPerIpEvents(hits) {
  const byIp = new Map();
  for (const h of hits) {
    if (!h.ip) continue;
    if (!byIp.has(h.ip)) byIp.set(h.ip, []);
    byIp.get(h.ip).push(h);
  }
  const events = [];
  for (const [ip, ipHits] of byIp) {
    const errorHits = ipHits.filter(h => h.status >= 400 || SUSPICIOUS_PATH_RE.test(h.path || ''));
    if (errorHits.length >= SCAN_ERROR_THRESHOLD) {
      events.push({ type: 'scan', ip, hitCount: errorHits.length, sample: errorHits[errorHits.length - 1] });
    }

    const sorted = [...ipHits].sort((a, b) => a.timestamp - b.timestamp);
    let maxInWindow = 0, windowStart = 0;
    for (let i = 0; i < sorted.length; i++) {
      while (sorted[i].timestamp - sorted[windowStart].timestamp > DOS_WINDOW_SEC * 1000) windowStart++;
      maxInWindow = Math.max(maxInWindow, i - windowStart + 1);
    }
    if (maxInWindow >= DOS_REQUEST_THRESHOLD) {
      events.push({ type: 'dos', ip, hitCount: maxInWindow, sample: sorted[sorted.length - 1] });
    }
  }
  return events;
}

// Pure, testable: compares this batch's total request count against a rolling baseline.
function detectDdos(totalCount, recentSampleCounts) {
  if (!recentSampleCounts.length) return false;
  const avg = recentSampleCounts.reduce((s, n) => s + n, 0) / recentSampleCounts.length;
  return totalCount > DDOS_MIN_TOTAL && totalCount > avg * DDOS_MULTIPLIER;
}

// ── nginx config parsing: discover per-domain access_log files ────────────────────────────────
// Finds every /etc/nginx/**/*.conf-ish file and cats its content back, one file at a time, each
// prefixed with a marker line so discoverDomainLogs() can attribute results to their source file.
const DISCOVER_SCRIPT = `
FILES=$(sudo -n find /etc/nginx -type f \\( -name "*.conf" -o -path "*/sites-enabled/*" \\) 2>/dev/null)
if [ -z "$FILES" ]; then FILES=$(find /etc/nginx -type f \\( -name "*.conf" -o -path "*/sites-enabled/*" \\) 2>/dev/null); fi
for f in $FILES; do
  echo "===FILE:$f==="
  sudo -n cat "$f" 2>/dev/null || cat "$f" 2>/dev/null
done
`.trim();

// Finds every top-level `server { ... }` block by brace-depth matching (works regardless of
// nesting level inside http{}/other wrapping blocks) — a plain-regex approach can't reliably
// handle nested braces (e.g. location{} blocks inside server{}), so this walks character by
// character instead.
function extractServerBlocks(text) {
  const blocks = [];
  const serverKeywordRe = /\bserver\s*\{/g;
  let m;
  while ((m = serverKeywordRe.exec(text))) {
    const openBraceIdx = m.index + m[0].length - 1;
    let depth = 1, i = openBraceIdx + 1;
    while (i < text.length && depth > 0) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') depth--;
      i++;
    }
    if (depth === 0) {
      blocks.push(text.slice(openBraceIdx + 1, i - 1));
      serverKeywordRe.lastIndex = i;
    }
  }
  return blocks;
}

function extractDirectiveValues(blockText, name) {
  const re = new RegExp(`\\b${name}\\s+([^;]+);`, 'g');
  const results = [];
  let m;
  while ((m = re.exec(blockText))) results.push(m[1].trim());
  return results;
}

function parseServerBlockForLogs(blockText) {
  const serverNames = extractDirectiveValues(blockText, 'server_name');
  const domain = serverNames.length
    ? (serverNames[0].split(/\s+/).find(tok => tok !== '_' && tok !== 'default_server') || null)
    : null;
  const logPaths = [];
  for (const directive of extractDirectiveValues(blockText, 'access_log')) {
    const firstToken = directive.split(/\s+/)[0];
    if (firstToken === 'off' || firstToken.startsWith('syslog:')) continue;
    logPaths.push(firstToken);
  }
  return { domain, logPaths };
}

// Pure, testable: parses the DISCOVER_SCRIPT's raw stdout (multiple files, each preceded by a
// "===FILE:<path>===" marker) into a flat list of {domain, logPath, confFile}. Comments (# to
// end of line) are stripped before block extraction.
function discoverDomainLogs(rawOutput) {
  const results = [];
  const parts = (rawOutput || '').split(/^===FILE:(.+)===$/m);
  for (let i = 1; i < parts.length; i += 2) {
    const confFile = parts[i].trim();
    const content = parts[i + 1] || '';
    const cleaned = content.split('\n').map(l => l.replace(/#.*$/, '')).join('\n');
    for (const block of extractServerBlocks(cleaned)) {
      const { domain, logPaths } = parseServerBlockForLogs(block);
      for (const logPath of logPaths) results.push({ domain, logPath, confFile });
    }
  }
  return results;
}

function buildDetectScript(path) {
  return `
if sudo -n test -f "${path}" 2>/dev/null || test -f "${path}" 2>/dev/null; then
  echo "LOGFILE:${path}"
  N=$(sudo -n wc -l "${path}" 2>/dev/null | awk '{print $1}')
  if [ -z "$N" ]; then N=$(wc -l "${path}" 2>/dev/null | awk '{print $1}'); fi
  echo "$N"
else
  echo "LOGFILE:none"
fi
`.trim();
}

function buildTailScript(path, startLine) {
  return `sudo -n tail -n +$((${startLine} + 1)) "${path}" 2>/dev/null || tail -n +$((${startLine} + 1)) "${path}" 2>/dev/null`;
}

const insertEvent = db.prepare(`
  INSERT INTO waf_events (vm_id, vm_name, domain, event_type, src_ip, country, is_foreign, method, path, status_code, user_agent, hit_count, blocked, occurred_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const getCursor = db.prepare('SELECT last_line_count FROM ssh_log_cursor WHERE source_type = ? AND source_id = ?');
const upsertCursor = db.prepare(`
  INSERT INTO ssh_log_cursor (source_type, source_id, last_line_count, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
  ON DUPLICATE KEY UPDATE last_line_count = VALUES(last_line_count), updated_at = CURRENT_TIMESTAMP
`);
const recordTraffic = db.prepare(`
  INSERT INTO waf_traffic_stats (domain_log_id, sample_ts, request_count) VALUES (?, ?, ?)
  ON DUPLICATE KEY UPDATE request_count = VALUES(request_count)
`);
const getRecentTraffic = db.prepare('SELECT request_count FROM waf_traffic_stats WHERE domain_log_id = ? ORDER BY sample_ts DESC LIMIT ?');
const pruneTraffic = db.prepare(`
  DELETE FROM waf_traffic_stats WHERE domain_log_id = ? AND sample_ts NOT IN (
    SELECT sample_ts FROM (SELECT sample_ts FROM waf_traffic_stats WHERE domain_log_id = ? ORDER BY sample_ts DESC LIMIT ?) t
  )
`);
const upsertDomainLog = db.prepare(`
  INSERT INTO waf_domain_logs (vm_id, domain, log_path, conf_file) VALUES (?, ?, ?, ?)
  ON DUPLICATE KEY UPDATE domain = VALUES(domain), conf_file = VALUES(conf_file), id = LAST_INSERT_ID(id)
`);

function domainLabel(domain, vmName) {
  return domain || vmName;
}

async function raiseWafAlert(vm, domain, ev, country, blockResult) {
  const metric = ev.type === 'scan' ? 'waf_scan' : 'waf_dos';
  const already = await db.prepare(`
    SELECT id FROM alerts WHERE metric = ? AND source_type = 'vcenter_vm' AND source_id = ? AND metric_value = ? AND status = 'open'
  `).get(metric, vm.id, ev.ip);
  if (already) return; // still active — waf_events row above already recorded this occurrence
  const title = ev.type === 'scan' ? 'WAF phát hiện dò quét' : 'WAF phát hiện tấn công DoS';
  const action = vm.waf_auto_block
    ? (blockResult?.ok ? ' — ĐÃ CHẶN IP qua fail2ban'
      : blockResult?.excepted ? ' — bỏ qua, không chặn (IP nằm trong danh sách ngoại lệ)'
      : ` — CHƯA chặn được (${blockResult?.error || 'lỗi không rõ'})`)
    : ' — chỉ cảnh báo (tự động chặn đang tắt cho VM này)';
  const site = domainLabel(domain, vm.name);
  const message = ev.type === 'scan'
    ? `IP ${ev.ip}${country ? ` (${country})` : ''} gửi ${ev.hitCount} request lỗi/đường dẫn khả nghi tới "${site}" trên VM "${vm.name}"${action}`
    : `IP ${ev.ip}${country ? ` (${country})` : ''} gửi ${ev.hitCount} request trong ${DOS_WINDOW_SEC}s tới "${site}" trên VM "${vm.name}"${action}`;
  await db.prepare(`
    INSERT INTO alerts (category, severity, title, message, source_type, source_id, source_name, metric, metric_value, status)
    VALUES ('security', 'critical', ?, ?, 'vcenter_vm', ?, ?, ?, ?, 'open')
  `).run(title, message, vm.id, vm.name, metric, ev.ip);
}

async function raiseDdosAlert(vm, domain, totalCount) {
  const site = domainLabel(domain, vm.name);
  const already = await db.prepare(`
    SELECT id FROM alerts WHERE metric = 'waf_ddos' AND source_type = 'vcenter_vm' AND source_id = ? AND metric_value = ? AND status = 'open'
  `).get(vm.id, site);
  if (already) return;
  await db.prepare(`
    INSERT INTO alerts (category, severity, title, message, source_type, source_id, source_name, metric, metric_value, status)
    VALUES ('security', 'critical', ?, ?, 'vcenter_vm', ?, ?, 'waf_ddos', ?, 'open')
  `).run(
    'WAF phát hiện nghi ngờ DDoS',
    `Tổng lưu lượng request tới "${site}" trên VM "${vm.name}" tăng đột biến (${totalCount} request/đợt quét, gấp nhiều lần mức bình thường gần đây) — traffic đến từ nhiều IP phân tán, không thể tự động chặn 1 địa chỉ cụ thể`,
    vm.id, vm.name, site
  );
}

// Ground-truth reconciliation against waf_events (which keeps getting fresh rows every poll an
// attack is still ongoing) rather than comparing against the alert's own created_at — mirrors
// fail2ban-collector.js's resolveStaleUnbans reasoning: an alert should stay open for as long as the
// underlying condition keeps recurring, not just for a fixed window from first detection.
async function resolveStaleWafAlerts(vm) {
  const staleIpAlerts = await db.prepare(`
    SELECT a.id FROM alerts a
    WHERE a.source_type = 'vcenter_vm' AND a.source_id = ? AND a.status = 'open' AND a.metric IN ('waf_scan', 'waf_dos')
      AND NOT EXISTS (
        SELECT 1 FROM waf_events e
        WHERE e.vm_id = a.source_id AND e.src_ip = a.metric_value
          AND e.event_type = (CASE a.metric WHEN 'waf_scan' THEN 'scan' ELSE 'dos' END)
          AND e.occurred_at >= DATE_SUB(NOW(), INTERVAL ${STALE_ALERT_SEC} SECOND)
      )
  `).all(vm.id);
  const staleDdosAlerts = await db.prepare(`
    SELECT a.id FROM alerts a
    WHERE a.source_type = 'vcenter_vm' AND a.source_id = ? AND a.status = 'open' AND a.metric = 'waf_ddos'
      AND NOT EXISTS (
        SELECT 1 FROM waf_events e
        WHERE e.vm_id = a.source_id AND e.event_type = 'ddos' AND (e.domain <=> a.metric_value OR (e.domain IS NULL AND a.metric_value = e.vm_name))
          AND e.occurred_at >= DATE_SUB(NOW(), INTERVAL ${STALE_ALERT_SEC} SECOND)
      )
  `).all(vm.id);
  const resolve = db.prepare("UPDATE alerts SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP WHERE id = ?");
  for (const a of [...staleIpAlerts, ...staleDdosAlerts]) await resolve.run(a.id);
}

async function processHits(vm, domain, domainLogId, hits) {
  const perIpEvents = detectPerIpEvents(hits);
  for (const ev of perIpEvents) {
    const { country, isForeign } = classifyIp(ev.ip);
    let blockResult = null;
    if (vm.waf_auto_block) blockResult = await wafManager.banIp(vm, ev.ip);
    await insertEvent.run(
      vm.id, vm.name, domain, ev.type, ev.ip, country, isForeign,
      ev.sample.method, ev.sample.path, ev.sample.status, ev.sample.userAgent,
      ev.hitCount, blockResult?.ok ? 1 : 0, toSqlDatetime(ev.sample.timestamp)
    );
    await raiseWafAlert(vm, domain, ev, country, blockResult);
  }

  const lastTs = hits[hits.length - 1].timestamp;
  const totalCount = hits.length;
  const recentSamples = await getRecentTraffic.all(domainLogId, DDOS_BASELINE_SAMPLES);
  if (detectDdos(totalCount, recentSamples.map(r => r.request_count))) {
    await insertEvent.run(vm.id, vm.name, domain, 'ddos', null, null, 0, null, null, null, null, totalCount, 0, toSqlDatetime(lastTs));
    await raiseDdosAlert(vm, domain, totalCount);
  }
  await recordTraffic.run(domainLogId, toSqlDatetime(lastTs), totalCount);
  await pruneTraffic.run(domainLogId, domainLogId, DDOS_BASELINE_SAMPLES);
}

// Re-parses /etc/nginx config on every poll (cheap: a handful of small text files) and upserts
// waf_domain_logs to match — rows for logs no longer present get deleted along with their cursor,
// so a domain removed from config (or renamed log file) doesn't linger forever. Falls back to the
// single vcenter_vms.waf_log_path (domain=NULL) when nothing could be discovered at all.
async function discoverAndSyncDomainLogs(vm, ssh) {
  let discovered = [];
  try {
    const result = await ssh.execCommand(DISCOVER_SCRIPT);
    discovered = discoverDomainLogs(result.stdout);
  } catch { /* fall through to the fallback below */ }

  discovered = discovered.filter(d => wafManager.SAFE_LOG_PATH_RE.test(d.logPath));
  if (!discovered.length && wafManager.SAFE_LOG_PATH_RE.test(vm.waf_log_path || '')) {
    discovered = [{ domain: null, logPath: vm.waf_log_path, confFile: null }];
  }

  const rows = [];
  for (const d of discovered) {
    const { lastInsertRowid } = await upsertDomainLog.run(vm.id, d.domain, d.logPath, d.confFile);
    rows.push({ id: lastInsertRowid, domain: d.domain, logPath: d.logPath });
  }
  const currentIds = new Set(rows.map(r => r.id));
  const known = await db.prepare('SELECT id FROM waf_domain_logs WHERE vm_id = ?').all(vm.id);
  for (const { id } of known) {
    if (!currentIds.has(id)) {
      await db.prepare('DELETE FROM waf_domain_logs WHERE id = ?').run(id);
      await db.prepare("DELETE FROM ssh_log_cursor WHERE source_type = 'nginx_domain' AND source_id = ?").run(id);
    }
  }
  return rows;
}

async function collectLogFile(vm, ssh, domainLogRow) {
  const { id: domainLogId, domain, logPath } = domainLogRow;
  const detect = await ssh.execCommand(buildDetectScript(logPath));
  const logfile = /^LOGFILE:(\S+)/m.exec(detect.stdout)?.[1];
  if (!logfile || logfile === 'none') {
    console.warn(`[nginx-waf] ${vm.name}: không tìm thấy log tại ${logPath}`);
    return;
  }
  const lineCountRaw = detect.stdout.trim().split('\n')[1];
  if (!/^\d+$/.test(lineCountRaw || '')) {
    console.warn(`[nginx-waf] ${vm.name}: không đọc được ${logfile} — cần cấu hình sudoers NOPASSWD (xem trang Giám sát WAF)`);
    return;
  }
  const totalLines = Number(lineCountRaw);

  const cursor = await getCursor.get('nginx_domain', domainLogId);
  let startLine;
  if (!cursor) startLine = Math.max(0, totalLines - INITIAL_LOOKBACK_LINES);
  else if (totalLines < cursor.last_line_count) startLine = 0; // log rotated
  else startLine = cursor.last_line_count;

  if (totalLines > startLine) {
    const tail = await ssh.execCommand(buildTailScript(logfile, startLine));
    const hits = [];
    for (const line of tail.stdout.split('\n').filter(Boolean)) {
      const parsed = parseNginxLine(line);
      if (!parsed) continue;
      // waf_trust_xff opt-in (see routes/waf.js) — default is remote_addr, the real TCP peer.
      // Only trust X-Forwarded-For when the admin has confirmed this VM sits behind a reverse
      // proxy/load balancer that sets it; otherwise every request would appear to come from the
      // same proxy IP, breaking both detection (all traffic bucketed under 1 "attacker") and
      // auto-block (would ban the proxy itself, taking down all real traffic).
      parsed.ip = vm.waf_trust_xff ? (parsed.xffIp || parsed.remoteAddr) : parsed.remoteAddr;
      hits.push(parsed);
    }
    if (hits.length) await processHits(vm, domain, domainLogId, hits);
  }
  await upsertCursor.run('nginx_domain', domainLogId, totalLines);
}

const upsertBannedIp = db.prepare(`
  INSERT INTO waf_banned_ips (vm_id, ip, first_seen, last_seen) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  ON DUPLICATE KEY UPDATE last_seen = CURRENT_TIMESTAMP
`);

// Mirrors the jail's live "Banned IP list:" into waf_banned_ips every poll — reuses the SSH session
// already open for log tailing (see waf-manager.js's listBannedIpsViaSsh). A row disappears the
// moment it's no longer in the live list (bantime expired, manually unbanned, or the jail itself
// isn't installed) — same staleness-pruning shape as discoverAndSyncDomainLogs above.
async function syncBannedIps(vm, ssh) {
  const { ips } = await wafManager.listBannedIpsViaSsh(ssh).catch(() => ({ ips: [] }));
  for (const ip of ips) await upsertBannedIp.run(vm.id, ip);
  const currentSet = new Set(ips);
  const known = await db.prepare('SELECT ip FROM waf_banned_ips WHERE vm_id = ?').all(vm.id);
  const stale = db.prepare('DELETE FROM waf_banned_ips WHERE vm_id = ? AND ip = ?');
  for (const { ip } of known) if (!currentSet.has(ip)) await stale.run(vm.id, ip);
}

async function collectVm(vm) {
  const opts = await sshCredentials.buildConnectOptions(vm);
  if (!opts) return;
  const ssh = new NodeSSH();
  try {
    await ssh.connect(opts);
    await syncBannedIps(vm, ssh);
    const domainLogs = await discoverAndSyncDomainLogs(vm, ssh);
    if (!domainLogs.length) {
      console.warn(`[nginx-waf] ${vm.name}: không phát hiện được domain/log nginx nào (kiểm tra quyền đọc /etc/nginx hoặc đường dẫn log dự phòng)`);
    }
    for (const row of domainLogs) {
      try { await collectLogFile(vm, ssh, row); }
      catch (e) { console.error(`[nginx-waf] ${vm.name} — ${row.domain || row.logPath}: ${e.message}`); }
    }
    await resolveStaleWafAlerts(vm);
  } catch (e) {
    console.error(`[nginx-waf] ${vm.name} (${vm.ip_address}): ${e.message}`);
  } finally {
    ssh.dispose();
  }
}

async function collectAll() {
  const vms = await db.prepare(`
    SELECT id, name, ip_address, ssh_port, ssh_credential_id, waf_log_path, waf_auto_block, waf_trust_xff
    FROM vcenter_vms
    WHERE waf_enabled = 1 AND ssh_credential_id IS NOT NULL
      AND ip_address IS NOT NULL AND ip_address != '' AND power_state = 'POWERED_ON'
  `).all();
  if (!vms.length) return;
  await Promise.allSettled(vms.map(collectVm));
  await db.prepare("DELETE FROM waf_events WHERE occurred_at < DATE_SUB(NOW(), INTERVAL 30 DAY)").run();
  // A VM that's no longer monitored (waf_enabled=0) isn't polled above, so any waf_banned_ips rows
  // left over from before it was turned off would show stale/unverifiable "still banned" state —
  // clear them rather than let the page imply live info we no longer actually have.
  const monitoredIds = vms.map(v => v.id);
  await db.prepare(`
    DELETE FROM waf_banned_ips WHERE vm_id NOT IN (${monitoredIds.map(() => '?').join(',') || 'NULL'})
  `).run(...monitoredIds);
}

function start(intervalMs = 30000) {
  const tick = () => collectAll().catch(e => console.error('[nginx-waf] Lỗi:', e.message));
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = {
  start, collectAll, collectVm,
  parseNginxLine, parseNginxTimestamp, detectPerIpEvents, detectDdos,
  discoverDomainLogs, extractServerBlocks, parseServerBlockForLogs,
};
