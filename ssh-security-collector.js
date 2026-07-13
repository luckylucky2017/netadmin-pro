// Monitors SSH login activity on Linux VMs the user has opted into (vcenter_vms.ssh_credential_id
// set), flags logins from outside Vietnam via an offline GeoIP lookup, and raises 'security' alerts
// for foreign successful logins or brute-force bursts of failed attempts. Only ever reads log
// files — never touches guest state.
const { NodeSSH } = require('node-ssh');
const geoip = require('geoip-lite');
const db = require('./database');
const sshCredentials = require('./ssh-credentials');
const fail2banManager = require('./fail2ban-manager');

// Ubuntu/Debian log to auth.log, RHEL/CentOS to secure — try both, first one that exists wins.
// Both are root-only (0600), so every read goes through `sudo -n` — the target VM needs a scoped
// NOPASSWD sudoers rule for exactly these tail/wc invocations (see routes/security.js docs / the
// "Quản lý VM giám sát" panel for the exact line to add). `-n` means a VM without that rule just
// silently produces no output here rather than hanging on a password prompt.
const DETECT_SCRIPT = `
for f in /var/log/auth.log /var/log/secure; do
  if [ -f "$f" ]; then echo "LOGFILE:$f"; sudo -n wc -l "$f" 2>/dev/null | awk '{print $1}'; exit 0; fi
done
echo "LOGFILE:none"
`.trim();

const RE_ACCEPTED = /Accepted (?:password|publickey|keyboard-interactive\/pam) for (\S+) from ([0-9a-fA-F.:]+) port (\d+)/;
// Some PAM/2FA setups fail via the keyboard-interactive prompt rather than plain password auth —
// matched symmetrically with RE_ACCEPTED above so those failures aren't silently dropped.
const RE_FAILED = /Failed (?:password|keyboard-interactive\/pam) for (?:invalid user )?(\S+) from ([0-9a-fA-F.:]+) port (\d+)/;
const RE_INVALID = /Invalid user (\S+) from ([0-9a-fA-F.:]+) port (\d+)/;

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

// MySQL's time_zone=SYSTEM on this server = Asia/Ho_Chi_Minh, so CURRENT_TIMESTAMP/NOW() already
// store GMT+7 wall-clock strings, not UTC (confirmed empirically: a fresh row's recorded_at
// matched the OS clock at write time to the second). A hand-built Date must be formatted the same
// way before storage, or it silently lands 7h off from every other timestamp in the same column —
// toISOString() would give UTC. The 'sv-SE' locale is a reliable trick for "YYYY-MM-DD HH:MM:SS"
// with no manual offset math.
function toSqlDatetime(date) {
  return date.toLocaleString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' });
}

// Two syslog timestamp formats seen in the wild: classic BSD ("Jul  6 12:34:56", no year — rsyslog
// RSYSLOG_TraditionalFileFormat) and ISO 8601 with an explicit offset ("2026-07-06T21:54:41.278444+07:00"
// — rsyslog's newer RSYSLOG_FileFormat, the actual default on these VMs). Try ISO first since that's
// what this fleet uses; fall back to BSD, then to "now" if the line has neither.
function parseSyslogTimestamp(line) {
  const iso = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))/.exec(line);
  if (iso) {
    const d = new Date(iso[1]);
    if (!isNaN(d.getTime())) return d;
  }
  const bsd = /^(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})/.exec(line);
  if (bsd && bsd[1] in MONTHS) {
    const now = new Date();
    const d = new Date(now.getFullYear(), MONTHS[bsd[1]], Number(bsd[2]), Number(bsd[3]), Number(bsd[4]), Number(bsd[5]));
    if (d.getTime() - now.getTime() > 86400000) d.setFullYear(d.getFullYear() - 1);
    return d;
  }
  return new Date();
}

function isPrivateIp(ip) {
  return /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fe80:|fc00:|fd00:)/.test(ip);
}

// geoip-lite ships MaxMind GeoLite2 data locally — no external calls, no rate limit, no leaking
// real (possibly attacker) IPs to a third party.
function classifyIp(ip) {
  if (!ip || isPrivateIp(ip)) return { country: null, isForeign: 0 };
  const country = geoip.lookup(ip)?.country || null;
  return { country, isForeign: country && country !== 'VN' ? 1 : 0 };
}

function parseLine(line) {
  let m = RE_ACCEPTED.exec(line);
  if (m) return { eventType: 'accepted', username: m[1], ip: m[2] };
  m = RE_FAILED.exec(line) || RE_INVALID.exec(line);
  if (m) return { eventType: 'failed', username: m[1], ip: m[2] };
  return null;
}

const insertEvent = db.prepare(`
  INSERT INTO ssh_login_events (source_type, source_id, source_name, event_type, username, src_ip, country, is_foreign, occurred_at)
  VALUES ('vm', ?, ?, ?, ?, ?, ?, ?, ?)
`);
const getCursor = db.prepare('SELECT last_line_count FROM ssh_log_cursor WHERE source_type = ? AND source_id = ?');
const upsertCursor = db.prepare(`
  INSERT INTO ssh_log_cursor (source_type, source_id, last_line_count, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
  ON DUPLICATE KEY UPDATE last_line_count = VALUES(last_line_count), updated_at = CURRENT_TIMESTAMP
`);

const INITIAL_LOOKBACK_LINES = 200;
// ssh_brute_force_window_sec/ssh_brute_force_threshold/ssh_block_foreign_immediately used to be
// hardcoded here (60s/5/always-on) — now resolved per-VM via fail2ban-config.js's
// getEffectiveConfig, editable from the "Cấu hình Fail2ban" admin page. Retuned once already against
// real attack data: the original 10-in-300s default missed a real distributed slow brute-force (11
// different IPs from the same /24, each pacing ~1 attempt/7-15min — always well under any per-IP
// volume threshold, domestic or not); 5-in-60s catches a genuinely fast domestic burst, and the
// foreign-IP rule is what actually neutralizes the slow/distributed case.
const fail2banConfig = require('./fail2ban-config');

async function raiseForeignLoginAlert(vm, parsed, country) {
  await db.prepare(`
    INSERT INTO alerts (category, severity, title, message, source_type, source_id, source_name, metric, metric_value, status)
    VALUES ('security', 'critical', ?, ?, 'vcenter_vm', ?, ?, 'ssh_foreign_login', ?, 'open')
  `).run(
    'Đăng nhập SSH thành công từ nước ngoài',
    `User "${parsed.username}" đăng nhập SSH thành công vào VM "${vm.name}" từ ${parsed.ip} (${country})`,
    vm.id, vm.name, `${parsed.ip} (${country})`
  );
}

// Best-effort immediate ban via fail2ban's own sshd jail — reuses the same enforcement mechanism
// fail2ban-collector.js already mirrors into alerts, rather than inventing a second blocking path
// (e.g. raw iptables) that could conflict with or outlive fail2ban's own bookkeeping. No-ops
// cleanly (returns false) if fail2ban isn't installed, the sshd jail doesn't exist, or sudo isn't
// permitted for fail2ban-client on this particular VM — the alert is still raised either way.
async function tryImmediateBan(ssh, ip) {
  try {
    const status = await ssh.execCommand('sudo -n fail2ban-client status sshd 2>/dev/null');
    if (!/Banned IP list/.test(status.stdout)) return false; // fail2ban/jail not available here
    if (status.stdout.includes(ip)) return true; // fail2ban itself already got there first
    const ban = await ssh.execCommand(`sudo -n fail2ban-client set sshd banip ${ip} 2>/dev/null`);
    return ban.stdout.trim() === '1';
  } catch {
    return false;
  }
}

// Two independent triggers, unioned in one query: (a) the usual volume threshold — cnt >=
// config.ssh_brute_force_threshold within config.ssh_brute_force_window_sec, catches a fast domestic
// burst; (b) when config.ssh_block_foreign_immediately is on, ANY failed attempt at all from a
// foreign (non-VN) IP — zero tolerance, no threshold, since a legitimate failed login (a typo) is
// overwhelmingly domestic, and this is what actually catches a slow/distributed attacker that paces
// each IP under the volume threshold. MAX(is_foreign)/MAX(country) is safe per-src_ip: is_foreign is
// a deterministic function of the IP (classifyIp), never mixed within one GROUP BY src_ip bucket.
async function checkBruteForce(vm, ssh, config) {
  const suspects = await db.prepare(`
    SELECT src_ip, COUNT(*) as cnt, MAX(is_foreign) as is_foreign, MAX(country) as country
    FROM ssh_login_events
    WHERE source_type = 'vm' AND source_id = ? AND event_type = 'failed'
      AND occurred_at >= DATE_SUB(NOW(), INTERVAL ? SECOND)
    GROUP BY src_ip
    HAVING cnt >= ? ${config.ssh_block_foreign_immediately ? 'OR MAX(is_foreign) = 1' : ''}
  `).all(vm.id, config.ssh_brute_force_window_sec, config.ssh_brute_force_threshold);
  if (!suspects.length) return;

  const exceptions = await fail2banManager.getExceptions();

  for (const b of suspects) {
    // Excepted (ssh_ip_exceptions — separate from the WAF one, see database.js) — treat as fully
    // trusted, not just "not blocked": no ban attempt, and no standing alert either, since repeated
    // failed logins from a known-good source (e.g. a misconfigured internal service retrying) isn't
    // a real brute-force signal worth surfacing.
    if (fail2banManager.isExceptedIp(b.src_ip, exceptions)) continue;

    // Only genuinely triggered by the zero-tolerance foreign rule (not incidentally also over the
    // volume threshold) gets the "blocked immediately, no threshold" message below — otherwise the
    // volume-based wording applies even for a foreign IP that happened to also cross the count.
    const triggeredByForeignRule = !!b.is_foreign && config.ssh_block_foreign_immediately && b.cnt < config.ssh_brute_force_threshold;
    const blocked = await tryImmediateBan(ssh, b.src_ip);

    // Successfully blocked: don't raise a separate ssh_bruteforce alert — fail2ban-collector.js's
    // own reconciliation already raises (and correctly opens/resolves) a "fail2ban đã chặn IP"
    // alert for this exact IP, which is the more accurate signal ("blocked", with a real lifecycle)
    // than re-announcing the same detection on a timer. This is also what stops the flood: without
    // it, a multi-hour attack re-alerted every check, burying the block alerts under hundreds of
    // duplicates.
    if (blocked) continue;

    // Not blocked (fail2ban absent/not permitted here) — this is the one case that still needs a
    // standing alert, since nothing else will surface it. Kept open indefinitely instead of
    // re-alerting every check; a human acknowledging/resolving it lets it re-fire if attacks resume.
    const already = await db.prepare(`
      SELECT id FROM alerts
      WHERE category = 'security' AND metric = 'ssh_bruteforce' AND source_type = 'vcenter_vm' AND source_id = ?
        AND metric_value = ? AND status = 'open'
    `).get(vm.id, b.src_ip);
    if (already) continue;
    const reason = triggeredByForeignRule
      ? `Đăng nhập SSH thất bại từ IP nước ngoài${b.country ? ` (${b.country})` : ''} — chặn ngay không cần chờ đủ ngưỡng`
      : `${b.cnt} lần đăng nhập thất bại trong ${Math.round(config.ssh_brute_force_window_sec / 60)} phút qua`;
    await db.prepare(`
      INSERT INTO alerts (category, severity, title, message, source_type, source_id, source_name, metric, metric_value, status)
      VALUES ('security', 'critical', ?, ?, 'vcenter_vm', ?, ?, 'ssh_bruteforce', ?, 'open')
    `).run(
      'Nghi ngờ tấn công brute-force SSH',
      `${reason} từ ${b.src_ip} vào VM "${vm.name}" — CHƯA chặn được (fail2ban không sẵn có hoặc chưa cấp quyền sudo trên VM này)`,
      vm.id, vm.name, b.src_ip
    );
  }
}

async function collectVm(vm) {
  const opts = await sshCredentials.buildConnectOptions(vm);
  if (!opts) return;
  const ssh = new NodeSSH();
  try {
    await ssh.connect(opts);

    const detect = await ssh.execCommand(DETECT_SCRIPT);
    const logfile = /^LOGFILE:(\S+)/m.exec(detect.stdout)?.[1];
    if (!logfile || logfile === 'none') return;
    const lineCountRaw = detect.stdout.trim().split('\n')[1];
    if (!/^\d+$/.test(lineCountRaw || '')) {
      // sudo -n failed silently (no NOPASSWD rule on this VM yet) — nothing to parse until it's
      // provisioned; log once so it's visible instead of quietly producing zero events forever.
      console.warn(`[ssh-security] ${vm.name}: không đọc được ${logfile} — cần cấu hình sudoers NOPASSWD cho user "${vm.ssh_user}" (xem trang Giám sát bất thường)`);
      return;
    }
    const totalLines = Number(lineCountRaw);

    const cursor = await getCursor.get('vm', vm.id);
    let startLine;
    if (!cursor) {
      // First-ever collection for this VM: seed with a bounded recent lookback instead of the
      // whole history, then only new lines are read from here on.
      startLine = Math.max(0, totalLines - INITIAL_LOOKBACK_LINES);
    } else if (totalLines < cursor.last_line_count) {
      // Log rotated (logrotate truncates/renames auth.log) — current file is shorter than what
      // we'd already read. Read the new file from the start rather than skipping the gap.
      startLine = 0;
    } else {
      startLine = cursor.last_line_count;
    }

    if (totalLines > startLine) {
      const tail = await ssh.execCommand(`sudo -n tail -n +$((${startLine} + 1)) "${logfile}"`);
      for (const line of tail.stdout.split('\n').filter(Boolean)) {
        const parsed = parseLine(line);
        if (!parsed) continue;
        const { country, isForeign } = classifyIp(parsed.ip);
        await insertEvent.run(vm.id, vm.name, parsed.eventType, parsed.username, parsed.ip, country, isForeign, toSqlDatetime(parseSyslogTimestamp(line)));
        if (parsed.eventType === 'accepted' && isForeign) await raiseForeignLoginAlert(vm, parsed, country);
      }
      await checkBruteForce(vm, ssh, await fail2banConfig.getEffectiveConfig(vm.id));
    }
    await upsertCursor.run('vm', vm.id, totalLines);
  } catch (e) {
    console.error(`[ssh-security] ${vm.name} (${vm.ip_address}): ${e.message}`);
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
  await db.prepare("DELETE FROM ssh_login_events WHERE occurred_at < DATE_SUB(NOW(), INTERVAL 30 DAY)").run();
}

function start(intervalMs = 45000) {
  // Wrapped in .catch — see alert-engine.js's start() for why (async setInterval + network DB).
  const tick = () => collectAll().catch(e => console.error('[ssh-security] Lỗi:', e.message));
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = { start, collectAll, collectVm, parseLine, classifyIp, checkBruteForce };
