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
//
// Cursor is tracked by BYTE OFFSET (waf_domain_logs.last_byte_offset), not line count — deliberately
// NOT reusing ssh-security-collector.js's ssh_log_cursor/wc-l/tail-n approach. `wc -l` is O(file
// size) — reading the ENTIRE access.log just to count lines on every ~30s poll caused real, reported
// CPU/disk load on busy proxy servers with large logs, and `tail -n +N` has the same scan-from-start
// cost for the "from line N" form (only "last N lines" gets GNU tail's backward-seek optimization).
// `stat -c %s` (O(1), just reads inode metadata) + `tail -c +N` (seeks directly to a byte offset,
// no scan) avoid reading any log content at all when nothing new has been written since the last
// poll, and only read the genuinely new bytes otherwise — see buildTailFromOffsetScript/
// collectLogFile below.
const { NodeSSH } = require('node-ssh');
const db = require('./database');
const sshCredentials = require('./ssh-credentials');
const wafManager = require('./waf-manager');
const { classifyIp } = require('./ssh-security-collector');
const fail2banConfig = require('./fail2ban-config');

const INITIAL_LOOKBACK_BYTES = 500000; // ~500KB bounded first-ever read — avoids scanning a huge historical log
// waf_scan_error_threshold/waf_dos_request_threshold/waf_dos_window_sec/waf_ddos_multiplier/
// waf_ddos_min_total used to be hardcoded module-level constants here — now resolved per-VM via
// fail2ban-config.js's getEffectiveConfig, editable from the "Cấu hình Fail2ban" admin page (see
// detectPerIpEvents/detectDdos/raiseWafAlert below for where they're actually used).
const DDOS_BASELINE_SAMPLES = 20;    // how many recent samples make up detectDdos' own baseline — not a threshold, not configurable
const STALE_ALERT_SEC = 900;         // auto-resolve an open waf_scan/waf_dos/waf_ddos alert after 15min quiet
const TOP_STAT_CAP = 300;            // max distinct keys tracked per (vm,domain,day,stat_type) — bounds row growth from scanner noise
const TRAFFIC_RETENTION_DAYS = 90;

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
  const [, remoteAddr, , timeLocal, request, statusStr, bytesStr, referer, userAgent, xff] = m;
  const reqM = /^(\S+)\s+(\S+)/.exec(request);
  return {
    remoteAddr,
    xffIp: firstXffIp(xff),
    timestamp: parseNginxTimestamp(timeLocal),
    // Truncated defensively — waf_events.method is VARCHAR(10) and real HTTP methods are all well
    // under that (GET/POST/DELETE/OPTIONS/...); a garbage/malformed request line (e.g. a byte-offset
    // read landing mid-line before stripPartialFirstLine existed) could otherwise produce an
    // arbitrarily long "method" token and crash the INSERT entirely instead of just one bad row.
    method: reqM ? reqM[1].slice(0, 10) : null,
    path: reqM ? reqM[2] : (request || null),
    status: Number(statusStr),
    // $body_bytes_sent is "-" when nginx has nothing to report (rare) — for the traffic report's
    // bandwidth totals a missing value should contribute 0, not NaN.
    bytesSent: bytesStr === '-' ? 0 : (Number(bytesStr) || 0),
    referer,
    userAgent,
  };
}

// Named attack-signature patterns checked against the request path (which already includes the
// query string — nginx's $request has no space-separated query field, so parseNginxLine's `path`
// captures "/foo?bar=baz" as one token). Checked in this order; the FIRST match wins as the
// "dominant category" for a request that happens to match more than one (e.g. a payload containing
// both a script tag and a SQL keyword) — ordered roughly by how actionable/dangerous a confirmed
// hit is, not by likelihood. Deliberately avoids overly broad patterns (bare `select`, bare `../`,
// `.php$`) that would false-positive on ordinary traffic; every pattern here requires a fairly
// specific, rarely-legitimate token combination. Not exhaustive — tunable once real traffic is
// visible on the page; this is a curated subset of what's realistically detectable from a single
// access-log line (no request body, no response content), not a full WAF ruleset like ModSecurity
// CRS.
const ATTACK_SIGNATURES = [
  { category: 'sqli', re: /\bunion\b(\s|%20|\+)+(\bselect\b|%73%65%6c%65%63%74)|\bselect\b.{1,60}\bfrom\b|\'\s*or\s*\'?1\'?\s*=\s*\'?1|\bor\b\s+\d+\s*=\s*\d+\s*(--|#|$)|\bsleep\(\s*\d|\bbenchmark\(|\bwaitfor\s+delay\b|\bpg_sleep\(|information_schema|\bxp_cmdshell\b|\bunion\b.{1,10}\bselect\b/i },
  { category: 'xss', re: /<script[\s>]|%3cscript|javascript:|on(error|load|click|mouseover|focus)\s*=|<img[^>]+onerror|<svg[^>]+onload|document\.(cookie|location)/i },
  { category: 'rce', re: /;\s*(cat|ls|whoami|id|uname|wget|curl)\b|\$\([^)]*\)|`[^`]*`|\|\s*(nc|netcat|bash|sh)\b|\bexec\s*\(|\bsystem\s*\(|\bpassthru\s*\(|\bshell_exec\s*\(/i },
  { category: 'lfi', re: /\.\.\/|\.\.%2f|%2e%2e%2f|\/etc\/passwd|\/etc\/shadow|php:\/\/(filter|input)|\bwin\.ini\b|\bboot\.ini\b/i },
  { category: 'sensitive_file', re: /\.env(\.|$)|\.git\/|\.aws\/credentials|\.ssh\/|id_rsa|wp-config\.php|\.htpasswd|\.htaccess$/i },
  { category: 'cms_scan', re: /wp-login\.php|wp-admin|xmlrpc\.php|phpmyadmin|adminer\.php|\/actuator|\/manager\/html|\/console\// },
];

// Vietnamese labels for alert titles/messages — the frontend has its own copy for the events/banned
// tables (public/js/app.js's ATTACK_CATEGORY_LABEL), kept in sync manually since one lives server-
// side (Node) and the other client-side (browser globals), same split as WAF_EVENT_LABEL already.
const ATTACK_CATEGORY_LABEL = {
  sqli: 'SQL Injection', xss: 'XSS', rce: 'RCE/Command Injection', lfi: 'LFI/Path Traversal',
  sensitive_file: 'lộ file nhạy cảm', cms_scan: 'dò quét CMS/Admin',
};

// Pure, testable: which named signature (if any) matches this request path — null if none.
function classifyAttackPattern(path) {
  if (!path) return null;
  for (const sig of ATTACK_SIGNATURES) if (sig.re.test(path)) return sig.category;
  return null;
}

// Payload-based categories (a real SQLi/XSS/RCE/LFI string is a strong signal even from just a
// handful of requests) use a much lower threshold than generic scanning noise (a single stray 404
// or a sensitive-file/CMS probe is common background bot traffic and needs volume to mean anything).
const HIGH_SEVERITY_CATEGORIES = new Set(['sqli', 'xss', 'rce', 'lfi']);
const HIGH_SEVERITY_THRESHOLD = 3;

// Pure, testable: groups a batch of parsed hits by IP (h.ip — set by the caller to remoteAddr or
// xffIp depending on the VM's waf_trust_xff setting) and flags scan/DoS per IP. No DB/SSH access.
// config.waf_scan_error_threshold/waf_dos_request_threshold/waf_dos_window_sec used to be hardcoded
// module-level constants (SCAN_ERROR_THRESHOLD/DOS_REQUEST_THRESHOLD/DOS_WINDOW_SEC) — now resolved
// per-VM via fail2ban-config.js, editable from the "Cấu hình Fail2ban" admin page; defaults to
// fail2banConfig.DEFAULTS so existing callers/tests that don't pass a config keep working unchanged.
// HIGH_SEVERITY_THRESHOLD is deliberately NOT configurable — a much lower, fixed bar specifically for
// confirmed attack-payload categories (sqli/xss/rce/lfi), not a general scanning-noise threshold.
function detectPerIpEvents(hits, config = fail2banConfig.DEFAULTS) {
  const byIp = new Map();
  for (const h of hits) {
    if (!h.ip) continue;
    if (!byIp.has(h.ip)) byIp.set(h.ip, []);
    byIp.get(h.ip).push(h);
  }
  const events = [];
  for (const [ip, ipHits] of byIp) {
    const flagged = ipHits
      .map(h => ({ ...h, attackCategory: classifyAttackPattern(h.path) }))
      .filter(h => h.status >= 400 || h.attackCategory);
    const highSevHits = flagged.filter(h => HIGH_SEVERITY_CATEGORIES.has(h.attackCategory));
    if (flagged.length >= config.waf_scan_error_threshold || highSevHits.length >= HIGH_SEVERITY_THRESHOLD) {
      const categoryCounts = {};
      for (const h of flagged) if (h.attackCategory) categoryCounts[h.attackCategory] = (categoryCounts[h.attackCategory] || 0) + 1;
      const dominantCategory = Object.keys(categoryCounts).sort((a, b) => categoryCounts[b] - categoryCounts[a])[0] || null;
      // Prefer showing a real attack-payload hit as the sample (not just whichever came last),
      // so the event's displayed path/status is the actual malicious request, not a generic 404.
      const sample = highSevHits[highSevHits.length - 1] || flagged[flagged.length - 1];
      events.push({ type: 'scan', ip, hitCount: flagged.length, attackCategory: dominantCategory, sample });
    }

    const sorted = [...ipHits].sort((a, b) => a.timestamp - b.timestamp);
    let maxInWindow = 0, windowStart = 0;
    for (let i = 0; i < sorted.length; i++) {
      while (sorted[i].timestamp - sorted[windowStart].timestamp > config.waf_dos_window_sec * 1000) windowStart++;
      maxInWindow = Math.max(maxInWindow, i - windowStart + 1);
    }
    if (maxInWindow >= config.waf_dos_request_threshold) {
      events.push({ type: 'dos', ip, hitCount: maxInWindow, attackCategory: null, sample: sorted[sorted.length - 1] });
    }
  }
  return events;
}

// Pure, testable: compares this batch's total request count against a rolling baseline.
// config.waf_ddos_multiplier/waf_ddos_min_total — same per-VM-configurable pattern as
// detectPerIpEvents above; DDOS_BASELINE_SAMPLES (how many recent samples make up the baseline
// itself, not a detection threshold) stays a fixed internal constant, not exposed on the admin page.
function detectDdos(totalCount, recentSampleCounts, config = fail2banConfig.DEFAULTS) {
  if (!recentSampleCounts.length) return false;
  const avg = recentSampleCounts.reduce((s, n) => s + n, 0) / recentSampleCounts.length;
  return totalCount > config.waf_ddos_min_total && totalCount > avg * config.waf_ddos_multiplier;
}

// ── Traffic report aggregation ─────────────────────────────────────────────────────────────────
// Grouped (not per-version) browser/OS classification for the traffic report's summary breakdown —
// deliberately coarse (no UA-parsing dependency) since the report shows "Chrome" / "Windows" style
// buckets, not exact version numbers. Order matters: Edge and Opera both include "Chrome" in their
// UA string (Chromium-based), so they're checked before the bare Chrome pattern.
function classifyBrowser(ua) {
  if (!ua) return 'Không xác định';
  if (/bot|spider|crawl|curl\/|wget\/|python-requests|go-http-client|facebookexternalhit/i.test(ua)) return 'Bot/Script';
  if (/edg\//i.test(ua)) return 'Edge';
  if (/opr\/|opera/i.test(ua)) return 'Opera';
  if (/chrome\//i.test(ua)) return 'Chrome';
  if (/firefox\//i.test(ua)) return 'Firefox';
  if (/version\/.*safari/i.test(ua)) return 'Safari';
  if (/msie|trident/i.test(ua)) return 'Internet Explorer';
  return 'Khác';
}

function classifyOs(ua) {
  if (!ua) return 'Không xác định';
  // iOS/Android checked before Windows/macOS/Linux: a real iPhone/iPad UA always embeds the literal
  // substring "like Mac OS X" (e.g. "iPhone; CPU iPhone OS 17_0 like Mac OS X"), and an Android UA's
  // WebView component can embed "Linux" — checking the desktop OSes first would misclassify both.
  if (/android/i.test(ua)) return 'Android';
  if (/iphone|ipad|ipod/i.test(ua)) return 'iOS';
  if (/windows/i.test(ua)) return 'Windows';
  if (/mac os x|macintosh/i.test(ua)) return 'macOS';
  if (/linux/i.test(ua)) return 'Linux';
  return 'Khác';
}

// Pure, testable: which status-class bucket (waf_traffic_daily's 4 columns) a status code falls
// into — null for anything outside 2xx-5xx (malformed/unparseable status).
function statusClass(status) {
  if (status >= 200 && status < 300) return '2xx';
  if (status >= 300 && status < 400) return '3xx';
  if (status >= 400 && status < 500) return '4xx';
  if (status >= 500 && status < 600) return '5xx';
  return null;
}

// Pure, testable: reduces one poll's parsed hits (already carrying .ip, see processLogFileResult)
// down to what recordTrafficAggregates needs to persist — the daily totals plus 5 dimensions' worth
// of per-key {hits, bytes} counts for that single batch. Takes a countryFn injection (rather than
// calling classifyIp directly) so this stays testable without geoip-lite/DB access.
function aggregateHitsForTraffic(hits, countryFn) {
  const daily = { requestCount: hits.length, bytesSum: 0, s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0 };
  const dims = { path: new Map(), ip: new Map(), country: new Map(), browser: new Map(), os: new Map() };
  const bump = (map, key, bytes) => {
    if (!key) return;
    const cur = map.get(key) || { hits: 0, bytes: 0 };
    cur.hits += 1; cur.bytes += bytes;
    map.set(key, cur);
  };
  const countryCache = new Map();
  for (const h of hits) {
    daily.bytesSum += h.bytesSent || 0;
    const cls = statusClass(h.status);
    if (cls === '2xx') daily.s2xx++;
    else if (cls === '3xx') daily.s3xx++;
    else if (cls === '4xx') daily.s4xx++;
    else if (cls === '5xx') daily.s5xx++;

    const pathKey = ((h.path || '').split('?')[0] || '/').slice(0, 255);
    bump(dims.path, pathKey, h.bytesSent || 0);
    bump(dims.ip, h.ip, h.bytesSent || 0);

    let country = countryCache.get(h.ip);
    if (country === undefined) { country = countryFn(h.ip) || 'XX'; countryCache.set(h.ip, country); }
    bump(dims.country, country, h.bytesSent || 0);
    bump(dims.browser, classifyBrowser(h.userAgent), h.bytesSent || 0);
    bump(dims.os, classifyOs(h.userAgent), h.bytesSent || 0);
  }
  return { daily, dims };
}

// Pure, testable: which IPs actually made up a batch of hits, most active first — used specifically
// to attach "who was part of this" to a DDoS event, since detectDdos itself only ever looks at the
// batch's TOTAL count (no single IP crossing a per-IP threshold is what makes it a DDoS rather than
// a DoS in the first place). Capped at `limit` — this is context for a human investigating an
// alert, not a full breakdown (the "Lưu lượng" traffic report already covers that).
function computeTopIps(hits, countryFn, limit = 10) {
  const byIp = new Map();
  for (const h of hits) {
    if (!h.ip) continue;
    byIp.set(h.ip, (byIp.get(h.ip) || 0) + 1);
  }
  return [...byIp.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([ip, hits]) => ({ ip, hits, country: countryFn(ip) || null }));
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

// Batches stat+conditional-tail for MULTIPLE domain logs into ONE SSH round-trip, not one per
// domain — critical at real scale: some real VMs here serve 100-300+ domains, so N separate round
// trips per poll was itself a major contributor to server load, independent of the O(file size)
// wc-l/tail-n issue.
//
// A first version of this ran one `sudo -n stat`/`tail` PER domain inside the batch — still just 1
// SSH round trip, but measured at ~14s per 100 domains on a real host: sudo itself has real
// per-invocation overhead (policy lookup, PAM, logging), and spawning it 100+ times in one script
// dominates the runtime even though each individual stat is O(1). Fixed by collapsing the size-check
// into ONE `stat` call covering every path in the batch at once (GNU stat accepts multiple file
// operands, one output line each) — tail is then only spawned per-domain for files that actually
// grew, which in practice is a small fraction of the batch on any given poll.
//
// Each domain's output is wrapped in a "===LOG:<id>===" marker (same delimiting idiom as
// DISCOVER_SCRIPT/discoverDomainLogs above) so parseBatchTailOutput can match results back to the
// right waf_domain_logs row. offset===null means "never polled before": read a bounded recent chunk
// (tail -c N, seeks from the end, still O(1)) instead of the whole file; otherwise reads only the
// genuinely new bytes via tail -c +N (seeks directly to that byte position).
const MAX_DOMAINS_PER_BATCH = 100; // keep each single SSH command comfortably sized even at 300+ domains

function buildBatchTailScript(domainLogs) {
  const quotedPaths = domainLogs.map(row => `"${row.logPath}"`).join(' ');
  // Falls back to a non-sudo stat only if sudo produced literally no output (sudo unavailable/not
  // configured at all) — NOT per-file, since GNU stat exits non-zero if even one of many operands
  // fails (e.g. a config-referenced log that was never created), which would otherwise wrongly
  // discard every already-successful line and retry the entire batch without sudo.
  const statScript = `
STAT_OUT=$(sudo -n stat -c '%n|%s' ${quotedPaths} 2>/dev/null)
if [ -z "$STAT_OUT" ]; then STAT_OUT=$(stat -c '%n|%s' ${quotedPaths} 2>/dev/null); fi
`.trim();

  const blocks = domainLogs.map(row => {
    const offset = row.lastByteOffset;
    const isInitial = offset === null;
    const tailCmd = isInitial ? `tail -c ${INITIAL_LOOKBACK_BYTES} "${row.logPath}"` : `tail -c +$((${offset} + 1)) "${row.logPath}"`;
    const minSize = isInitial ? 0 : offset;
    return `
echo "===LOG:${row.id}==="
SIZE=$(printf '%s\\n' "$STAT_OUT" | grep -F "${row.logPath}|" | tail -1 | cut -d'|' -f2)
if [ -z "$SIZE" ]; then
  echo "SIZE:none"
elif [ "$SIZE" -gt ${minSize} ]; then
  echo "SIZE:$SIZE"
  sudo -n ${tailCmd} 2>/dev/null || ${tailCmd} 2>/dev/null
else
  echo "SIZE:$SIZE"
fi`.trim();
  });
  return statScript + '\n' + blocks.join('\n');
}

// Pure, testable: splits buildBatchTailScript's combined stdout back into per-domain
// { sizeToken, chunk } results, keyed by waf_domain_logs id.
function parseBatchTailOutput(stdout) {
  const results = new Map();
  const parts = (stdout || '').split(/^===LOG:(\d+)===$/m);
  for (let i = 1; i < parts.length; i += 2) {
    const id = Number(parts[i]);
    const lines = (parts[i + 1] || '').split('\n');
    const sizeLineIdx = lines.findIndex(l => l.startsWith('SIZE:'));
    if (sizeLineIdx === -1) { results.set(id, { sizeToken: null, chunk: '' }); continue; }
    results.set(id, { sizeToken: lines[sizeLineIdx].slice(5).trim(), chunk: lines.slice(sizeLineIdx + 1).join('\n') });
  }
  return results;
}

const insertEvent = db.prepare(`
  INSERT INTO waf_events (vm_id, vm_name, domain, event_type, src_ip, country, is_foreign, method, path, status_code, user_agent, hit_count, blocked, occurred_at, attack_category, top_ips)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const setByteOffset = db.prepare('UPDATE waf_domain_logs SET last_byte_offset = ? WHERE id = ?');
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

const upsertTrafficDaily = db.prepare(`
  INSERT INTO waf_traffic_daily (vm_id, domain, day, request_count, bytes_sum, status_2xx, status_3xx, status_4xx, status_5xx)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON DUPLICATE KEY UPDATE request_count = request_count + VALUES(request_count), bytes_sum = bytes_sum + VALUES(bytes_sum),
    status_2xx = status_2xx + VALUES(status_2xx), status_3xx = status_3xx + VALUES(status_3xx),
    status_4xx = status_4xx + VALUES(status_4xx), status_5xx = status_5xx + VALUES(status_5xx)
`);
const selectExistingTopKeys = db.prepare('SELECT stat_key FROM waf_traffic_top WHERE vm_id = ? AND domain = ? AND day = ? AND stat_type = ?');
const upsertTrafficTop = db.prepare(`
  INSERT INTO waf_traffic_top (vm_id, domain, day, stat_type, stat_key, hit_count, bytes_sum)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON DUPLICATE KEY UPDATE hit_count = hit_count + VALUES(hit_count), bytes_sum = bytes_sum + VALUES(bytes_sum)
`);
const pruneTrafficDaily = db.prepare(`DELETE FROM waf_traffic_daily WHERE day < DATE_SUB(CURDATE(), INTERVAL ${TRAFFIC_RETENTION_DAYS} DAY)`);
const pruneTrafficTop = db.prepare(`DELETE FROM waf_traffic_top WHERE day < DATE_SUB(CURDATE(), INTERVAL ${TRAFFIC_RETENTION_DAYS} DAY)`);

// Persists one poll batch's traffic aggregates (see aggregateHitsForTraffic above) into the daily
// rollup + per-dimension top-N tables backing the "Báo cáo lưu lượng" tab. day is derived from the
// batch's own last timestamp rather than "now" so a poll processing an old/backlogged chunk of log
// still lands on the correct calendar day.
async function recordTrafficAggregates(vm, domain, hits) {
  const day = toSqlDatetime(hits[hits.length - 1].timestamp).slice(0, 10);
  const domainKey = domain || '';
  const { daily, dims } = aggregateHitsForTraffic(hits, (ip) => classifyIp(ip).country);
  await upsertTrafficDaily.run(vm.id, domainKey, day, daily.requestCount, daily.bytesSum, daily.s2xx, daily.s3xx, daily.s4xx, daily.s5xx);
  for (const [statType, counts] of Object.entries(dims)) {
    if (!counts.size) continue;
    const existing = new Set((await selectExistingTopKeys.all(vm.id, domainKey, day, statType)).map(r => r.stat_key));
    for (const [key, v] of counts) {
      if (!existing.has(key) && existing.size >= TOP_STAT_CAP) continue;
      await upsertTrafficTop.run(vm.id, domainKey, day, statType, key, v.hits, v.bytes);
      existing.add(key);
    }
  }
}

async function raiseWafAlert(vm, domain, ev, country, blockResult, config) {
  const metric = ev.type === 'scan' ? 'waf_scan' : 'waf_dos';
  const already = await db.prepare(`
    SELECT id FROM alerts WHERE metric = ? AND source_type = 'vcenter_vm' AND source_id = ? AND metric_value = ? AND status = 'open'
  `).get(metric, vm.id, ev.ip);
  if (already) return; // still active — waf_events row above already recorded this occurrence
  const categoryLabel = ev.attackCategory ? ATTACK_CATEGORY_LABEL[ev.attackCategory] || ev.attackCategory : null;
  const title = ev.type === 'scan'
    ? (categoryLabel ? `WAF phát hiện ${categoryLabel}` : 'WAF phát hiện dò quét')
    : 'WAF phát hiện tấn công DoS';
  const action = vm.waf_auto_block
    ? (blockResult?.ok ? ' — ĐÃ CHẶN IP qua fail2ban'
      : blockResult?.excepted ? ' — bỏ qua, không chặn (IP nằm trong danh sách ngoại lệ)'
      : ` — CHƯA chặn được (${blockResult?.error || 'lỗi không rõ'})`)
    : ' — chỉ cảnh báo (tự động chặn đang tắt cho VM này)';
  const site = domainLabel(domain, vm.name);
  const message = ev.type === 'scan'
    ? `IP ${ev.ip}${country ? ` (${country})` : ''} gửi ${ev.hitCount} request${categoryLabel ? ` nghi ${categoryLabel}` : ' lỗi/đường dẫn khả nghi'} tới "${site}" trên VM "${vm.name}"${action}`
    : `IP ${ev.ip}${country ? ` (${country})` : ''} gửi ${ev.hitCount} request trong ${config.waf_dos_window_sec}s tới "${site}" trên VM "${vm.name}"${action}`;
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
  const config = await fail2banConfig.getEffectiveConfig(vm.id);
  const perIpEvents = detectPerIpEvents(hits, config);
  for (const ev of perIpEvents) {
    const { country, isForeign } = classifyIp(ev.ip);
    let blockResult = null;
    if (vm.waf_auto_block) blockResult = await wafManager.banIp(vm, ev.ip);
    await insertEvent.run(
      vm.id, vm.name, domain, ev.type, ev.ip, country, isForeign,
      ev.sample.method, ev.sample.path, ev.sample.status, ev.sample.userAgent,
      ev.hitCount, blockResult?.ok ? 1 : 0, toSqlDatetime(ev.sample.timestamp), ev.attackCategory || null, null
    );
    await raiseWafAlert(vm, domain, ev, country, blockResult, config);
  }

  const lastTs = hits[hits.length - 1].timestamp;
  const totalCount = hits.length;
  const recentSamples = await getRecentTraffic.all(domainLogId, DDOS_BASELINE_SAMPLES);
  if (detectDdos(totalCount, recentSamples.map(r => r.request_count), config)) {
    const topIps = computeTopIps(hits, (ip) => classifyIp(ip).country);
    await insertEvent.run(vm.id, vm.name, domain, 'ddos', null, null, 0, null, null, null, null, totalCount, 0, toSqlDatetime(lastTs), null, JSON.stringify(topIps));
    await raiseDdosAlert(vm, domain, totalCount);
  }
  await recordTraffic.run(domainLogId, toSqlDatetime(lastTs), totalCount);
  await pruneTraffic.run(domainLogId, domainLogId, DDOS_BASELINE_SAMPLES);
  await recordTrafficAggregates(vm, domain, hits);
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
    // upsertDomainLog only touches domain/conf_file (ON DUPLICATE KEY UPDATE doesn't mention
    // last_byte_offset), so a domain rediscovered on every poll keeps its existing cursor — this
    // fetch just reads back whatever that current value is (NULL the first time this row is ever
    // created, a real byte offset afterward).
    const existing = await db.prepare('SELECT last_byte_offset FROM waf_domain_logs WHERE id = ?').get(lastInsertRowid);
    rows.push({ id: lastInsertRowid, domain: d.domain, logPath: d.logPath, lastByteOffset: existing?.last_byte_offset ?? null });
  }
  const currentIds = new Set(rows.map(r => r.id));
  const known = await db.prepare('SELECT id FROM waf_domain_logs WHERE vm_id = ?').all(vm.id);
  for (const { id } of known) {
    if (!currentIds.has(id)) await db.prepare('DELETE FROM waf_domain_logs WHERE id = ?').run(id);
  }
  return rows;
}

// tail -c N (the bounded first-ever-poll read) cuts at an arbitrary BYTE position, not a line
// boundary — its first "line" is very likely a partial fragment missing its own beginning. Strips
// that fragment so it's never mis-parsed as a real (truncated) request; the caller must advance its
// offset bookkeeping by skippedBytes to stay accurate. Incremental reads (tail -c +N) never need this
// — their offset is always exactly at a newline boundary carried over from the previous poll.
function stripPartialFirstLine(chunk) {
  const firstNewlineIdx = chunk.indexOf('\n');
  if (firstNewlineIdx === -1) return { skippedBytes: Buffer.byteLength(chunk, 'utf8'), cleanedChunk: '' };
  const skipped = chunk.slice(0, firstNewlineIdx + 1);
  return { skippedBytes: Buffer.byteLength(skipped, 'utf8'), cleanedChunk: chunk.slice(firstNewlineIdx + 1) };
}

// Pure post-processing of one domain's already-fetched batch result (no SSH access) — the SSH round
// trip itself happens once, in bulk, in collectVm via buildBatchTailScript.
async function processLogFileResult(vm, domainLogRow, sizeToken, chunk) {
  const { id: domainLogId, domain, logPath, lastByteOffset } = domainLogRow;
  const isInitial = lastByteOffset == null;
  if (!sizeToken || sizeToken === 'none') {
    console.warn(`[nginx-waf] ${vm.name}: không tìm thấy log tại ${logPath}`);
    return;
  }
  if (sizeToken === 'error' || !/^\d+$/.test(sizeToken)) {
    console.warn(`[nginx-waf] ${vm.name}: không đọc được ${logPath} — cần cấu hình sudoers NOPASSWD (xem trang Giám sát WAF)`);
    return;
  }
  const newSize = Number(sizeToken);
  const rotated = !isInitial && newSize < lastByteOffset; // file truncated/rotated since last poll
  let nextOffset = (isInitial || rotated) ? Math.max(0, newSize - INITIAL_LOOKBACK_BYTES) : lastByteOffset;

  if (!rotated) {
    let effectiveChunk = chunk;
    if (isInitial && chunk) {
      const { skippedBytes, cleanedChunk } = stripPartialFirstLine(chunk);
      nextOffset += skippedBytes;
      effectiveChunk = cleanedChunk;
    }
    const lastNewlineIdx = effectiveChunk.lastIndexOf('\n');
    if (lastNewlineIdx !== -1) {
      // Only advance the cursor past COMPLETE lines — a trailing fragment with no newline yet is
      // either the log mid-write or an unusually long single line; leave it for the next poll
      // rather than risk splitting a line across two batches.
      const consumedText = effectiveChunk.slice(0, lastNewlineIdx + 1);
      nextOffset += Buffer.byteLength(consumedText, 'utf8');
      const hits = [];
      for (const line of consumedText.split('\n').filter(Boolean)) {
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
  }
  await setByteOffset.run(nextOffset, domainLogId);
}

const upsertBannedIp = db.prepare(`
  INSERT INTO waf_banned_ips (vm_id, ip, first_seen, last_seen) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  ON DUPLICATE KEY UPDATE last_seen = CURRENT_TIMESTAMP
`);

const deleteBannedIp = db.prepare('DELETE FROM waf_banned_ips WHERE vm_id = ? AND ip = ?');

// Mirrors the jail's live "Banned IP list:" into waf_banned_ips every poll — reuses the SSH session
// already open for log tailing (see waf-manager.js's listBannedIpsViaSsh). A row disappears the
// moment it's no longer in the live list (bantime expired, manually unbanned, or the jail itself
// isn't installed) — same staleness-pruning shape as discoverAndSyncDomainLogs above.
//
// Also reconciles against waf_ip_exceptions every poll: an IP can end up banned-but-excepted if the
// exception (esp. a CIDR range) was added AFTER that specific address was already banned — POST
// /exceptions only proactively unbans the literal string just inserted, not existing bans that
// merely fall within a newly added range. Catching it here (not just at exception-creation time)
// self-heals that gap on the very next poll instead of leaving it stuck — matching the requirement
// that an excepted IP must not stay blocked, with the unban logged as a warning, not silently.
async function syncBannedIps(vm, ssh) {
  const { ips } = await wafManager.listBannedIpsViaSsh(ssh).catch(() => ({ ips: [] }));
  const exceptions = await wafManager.getExceptions();
  const currentSet = new Set();
  for (const ip of ips) {
    if (wafManager.isExceptedIp(ip, exceptions)) {
      const result = await wafManager.unbanIpViaSsh(ssh, ip).catch(e => ({ ok: false, error: e.message }));
      if (result.ok) {
        console.warn(`[nginx-waf] ${vm.name}: đã tự động gỡ chặn IP ${ip} vì nằm trong danh sách ngoại lệ`);
        await deleteBannedIp.run(vm.id, ip);
        continue; // excepted + successfully unbanned — not "currently banned" anymore, skip re-adding
      }
      console.error(`[nginx-waf] ${vm.name}: IP ${ip} nằm trong ngoại lệ nhưng gỡ chặn thất bại — ${result.error}`);
    }
    currentSet.add(ip);
    await upsertBannedIp.run(vm.id, ip);
  }
  const known = await db.prepare('SELECT ip FROM waf_banned_ips WHERE vm_id = ?').all(vm.id);
  for (const { ip } of known) if (!currentSet.has(ip)) await deleteBannedIp.run(vm.id, ip);
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
    // Batched into groups of MAX_DOMAINS_PER_BATCH SSH round trips total, not one round trip per
    // domain — some real VMs here serve 100-300+ domains, so this is the difference between ~3
    // SSH exec calls per poll and hundreds.
    for (let i = 0; i < domainLogs.length; i += MAX_DOMAINS_PER_BATCH) {
      const batch = domainLogs.slice(i, i + MAX_DOMAINS_PER_BATCH);
      const result = await ssh.execCommand(buildBatchTailScript(batch));
      const parsed = parseBatchTailOutput(result.stdout);
      for (const row of batch) {
        const r = parsed.get(row.id);
        try { await processLogFileResult(vm, row, r?.sizeToken, r?.chunk || ''); }
        catch (e) { console.error(`[nginx-waf] ${vm.name} — ${row.domain || row.logPath}: ${e.message}`); }
      }
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
  await pruneTrafficDaily.run();
  await pruneTrafficTop.run();
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
  classifyAttackPattern, ATTACK_SIGNATURES, ATTACK_CATEGORY_LABEL,
  buildBatchTailScript, parseBatchTailOutput, stripPartialFirstLine,
  classifyBrowser, classifyOs, statusClass, aggregateHitsForTraffic, computeTopIps,
};
