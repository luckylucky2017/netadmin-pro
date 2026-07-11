// Mirrors fail2ban's *current* ban state into the alerts table, so a real fail2ban block shows up
// in Trung tâm cảnh báo with IP, jail, VM, and timestamp — separate from ssh-security-collector.js's
// own brute-force heuristic (that one infers an attack from raw auth.log; this one reports what
// fail2ban itself actually decided to block).
//
// Deliberately reconciles against `fail2ban-client status` (ground truth: "what's banned right now")
// rather than tailing /var/log/fail2ban.log for Ban/Unban lines. A busy jail's log is dominated by
// "Found"/"already banned" noise — a bounded tail lookback can miss real Ban events entirely on a
// high-volume attack, and log rotation/restarts add more edge cases. Asking fail2ban directly avoids
// all of that, at the cost of the alert's created_at being "first time we polled and saw it banned"
// rather than the exact ban instant — acceptable given the ~45s poll interval.
const { NodeSSH } = require('node-ssh');
const db = require('./database');
const sshCredentials = require('./ssh-credentials');
const fail2banManager = require('./fail2ban-manager');

const STATUS_SCRIPT = `
which fail2ban-client >/dev/null 2>&1 || { echo "FAIL2BAN:none"; exit 0; }
echo "FAIL2BAN:present"
jails=$(sudo -n fail2ban-client status 2>/dev/null | grep "Jail list:" | sed 's/.*Jail list:\\s*//')
if [ -z "$jails" ]; then echo "JAILS:none"; exit 0; fi
echo "JAILS:$jails"
IFS=',' read -ra JAIL_ARR <<< "$jails"
for j in "\${JAIL_ARR[@]}"; do
  j=$(echo "$j" | xargs)
  echo "===JAIL:$j==="
  sudo -n fail2ban-client status "$j" 2>/dev/null | grep "Banned IP list:" | sed 's/.*Banned IP list:\\s*//'
done
`.trim();

function parseStatus(stdout) {
  if (/^FAIL2BAN:none/m.test(stdout)) return null; // not installed on this VM
  const banned = {}; // jail -> [ip, ...]
  let currentJail = null;
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    const jailHeader = /^===JAIL:(.+)===$/.exec(line);
    if (jailHeader) { currentJail = jailHeader[1]; banned[currentJail] = []; continue; }
    if (currentJail && line && !line.startsWith('FAIL2BAN:') && !line.startsWith('JAILS:')) {
      banned[currentJail] = line.split(/\s+/).filter(Boolean);
    }
  }
  return banned;
}

async function raiseBanAlert(vm, jail, ip) {
  const already = await db.prepare(`
    SELECT id FROM alerts WHERE metric = 'fail2ban_ban' AND source_type = 'vcenter_vm' AND source_id = ? AND metric_value = ? AND status = 'open'
  `).get(vm.id, ip);
  if (already) return; // still banned from an earlier detection — don't duplicate
  await db.prepare(`
    INSERT INTO alerts (category, severity, title, message, source_type, source_id, source_name, metric, metric_value, status)
    VALUES ('security', 'critical', ?, ?, 'vcenter_vm', ?, ?, 'fail2ban_ban', ?, 'open')
  `).run(
    'fail2ban đã chặn IP',
    `fail2ban chặn IP ${ip} tại jail "${jail}" trên VM "${vm.name}"`,
    vm.id, vm.name, ip
  );
}

async function resolveStaleUnbans(vm, stillBannedIps) {
  const openAlerts = await db.prepare(`
    SELECT id, metric_value FROM alerts WHERE metric = 'fail2ban_ban' AND source_type = 'vcenter_vm' AND source_id = ? AND status = 'open'
  `).all(vm.id);
  const resolve = db.prepare("UPDATE alerts SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP WHERE id = ?");
  for (const a of openAlerts) {
    if (!stillBannedIps.has(a.metric_value)) await resolve.run(a.id);
  }
}

// Reconciles the sshd jail's live banned list against ssh_ip_exceptions (a list separate from the
// WAF one — see database.js) BEFORE the caller raises any ban alerts, unbanning any match via the
// already-open SSH session and mutating `banned.sshd` in place so an excepted IP is never alerted
// on or synced into ssh_banned_ips below. Same self-heal shape as nginx-waf-collector.js's
// syncBannedIps: catches the case an exception (esp. a CIDR range) was added AFTER that exact IP
// was already banned, which only proactively unbans at exception-creation time, not existing bans
// that merely fall within a newly added range.
async function reconcileSshExceptions(vm, ssh, banned) {
  const sshdIps = banned.sshd;
  if (!sshdIps || !sshdIps.length) return;
  const exceptions = await fail2banManager.getExceptions();
  const kept = [];
  for (const ip of sshdIps) {
    if (fail2banManager.isExceptedIp(ip, exceptions)) {
      const result = await fail2banManager.unbanIpViaSsh(ssh, ip).catch(e => ({ ok: false, error: e.message }));
      if (result.ok) {
        console.warn(`[fail2ban] ${vm.name}: đã tự động gỡ chặn IP ${ip} khỏi jail sshd vì nằm trong danh sách ngoại lệ`);
        continue;
      }
      console.error(`[fail2ban] ${vm.name}: IP ${ip} nằm trong ngoại lệ SSH nhưng gỡ chặn thất bại — ${result.error}`);
    }
    kept.push(ip);
  }
  banned.sshd = kept;
}

const upsertSshBannedIp = db.prepare(`
  INSERT INTO ssh_banned_ips (vm_id, ip, first_seen, last_seen) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  ON DUPLICATE KEY UPDATE last_seen = CURRENT_TIMESTAMP
`);
const deleteSshBannedIp = db.prepare('DELETE FROM ssh_banned_ips WHERE vm_id = ? AND ip = ?');

// Mirrors just the sshd jail's currently-banned list into ssh_banned_ips (ignores other jails on the
// same VM, e.g. netadmin-waf — that one is nginx-waf-collector.js's own concern) — same
// staleness-pruning shape as waf_banned_ips: a row disappears the moment it's no longer in the live
// list (bantime expired, manually unbanned, or fail2ban itself not installed/reachable this poll).
async function syncSshBannedIps(vm, sshdIps) {
  const currentSet = new Set(sshdIps);
  for (const ip of sshdIps) await upsertSshBannedIp.run(vm.id, ip);
  const known = await db.prepare('SELECT ip FROM ssh_banned_ips WHERE vm_id = ?').all(vm.id);
  for (const { ip } of known) if (!currentSet.has(ip)) await deleteSshBannedIp.run(vm.id, ip);
}

async function collectVm(vm) {
  const opts = await sshCredentials.buildConnectOptions(vm);
  if (!opts) return;
  const ssh = new NodeSSH();
  try {
    await ssh.connect(opts);

    const result = await ssh.execCommand(STATUS_SCRIPT);
    const banned = parseStatus(result.stdout);
    if (!banned) { await syncSshBannedIps(vm, []); return; } // fail2ban not installed/reachable — clear any stale rows

    await reconcileSshExceptions(vm, ssh, banned);
    const stillBannedIps = new Set();
    for (const [jail, ips] of Object.entries(banned)) {
      for (const ip of ips) {
        stillBannedIps.add(ip);
        await raiseBanAlert(vm, jail, ip);
      }
    }
    await resolveStaleUnbans(vm, stillBannedIps);
    await syncSshBannedIps(vm, banned.sshd || []);
  } catch (e) {
    console.error(`[fail2ban] ${vm.name} (${vm.ip_address}): ${e.message}`);
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
  // A VM that fell out of the query above (powered off, credential removed, etc.) isn't polled, so
  // any ssh_banned_ips rows left over from before would show stale/unverifiable "still banned"
  // state — clear them, same reasoning as nginx-waf-collector.js's equivalent cleanup.
  const monitoredIds = vms.map(v => v.id);
  await db.prepare(`
    DELETE FROM ssh_banned_ips WHERE vm_id NOT IN (${monitoredIds.map(() => '?').join(',') || 'NULL'})
  `).run(...monitoredIds);
}

function start(intervalMs = 45000) {
  // Wrapped in .catch — see alert-engine.js's start() for why (async setInterval + network DB).
  const tick = () => collectAll().catch(e => console.error('[fail2ban] Lỗi:', e.message));
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = { start, collectAll, collectVm, parseStatus };
