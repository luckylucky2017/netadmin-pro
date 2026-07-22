// On-demand fail2ban status check + auto-install, triggered by an admin clicking the "Fail2ban"
// button in "Quản lý VM giám sát" — separate from fail2ban-collector.js, which only ever reads
// ban state for VMs that already have it installed. This module answers "is it even here, and
// fully configured?" and, if not, installs/configures it.
//
// Unified with the WAF jail: this is the single canonical "make fail2ban right for this VM" entry
// point — a click here ensures BOTH the sshd jail (this module's own concern) AND, when the VM has
// WAF monitoring enabled, the netadmin-waf jail (waf-manager.js's concern) are present, in one SSH
// session. Previously these were two entirely separate install flows (Security page vs WAF page)
// that didn't know about each other, so enabling fail2ban from one page could leave the other
// page's jail silently unconfigured. waf-manager.js's own installJail/checkStatus/stopJail still
// exist for WAF-page-only actions (e.g. checking just the WAF jail without touching sshd).
const { NodeSSH } = require('node-ssh');
const fs = require('fs');
const path = require('path');
const db = require('./database');
const { logActivity } = require('./auth');
const sshCredentials = require('./ssh-credentials');
const wafManager = require('./waf-manager');
const fail2banConfig = require('./fail2ban-config');

// Real, on-disk file (fail2ban-templates/netadmin-sshd.local) is the source of truth — same reason
// as waf-manager.js's WAF templates: an admin can `sudo cp` it manually on a machine set up outside
// this app instead of only being able to get this content via the "Bật fail2ban" button. The file's
// own bantime (-1) is just its sane default for that manual-copy path — buildSshdJailTemplate below
// substitutes the VM's actual effective bantime (fail2ban-config.js, editable from the "Cấu hình
// Fail2ban" admin page) whenever this app itself pushes the file.
const SSHD_JAIL_TEMPLATE_RAW = fs.readFileSync(path.join(__dirname, 'fail2ban-templates', 'netadmin-sshd.local'), 'utf8')
  .split('\n').filter(line => !line.trim().startsWith('#')).join('\n').trim();

function buildSshdJailTemplate(bantimeSec) {
  return SSHD_JAIL_TEMPLATE_RAW.replace(/^bantime\s*=.*/m, `bantime = ${bantimeSec}`);
}

// "systemctl is-active" only proves the DAEMON is running — it says nothing about whether the sshd
// JAIL is actually enabled inside it. Confirmed on real hosts: Ubuntu 24.04's fail2ban package does
// NOT enable sshd by default (unlike some other distro/version combos where it ships pre-enabled),
// so a bare `apt-get install fail2ban && systemctl enable --now` can leave the daemon running with
// zero real protection — the UI would show "Đang chạy" while SSH brute-force is completely
// unguarded. So the check reports a distinct status when the daemon is up but the sshd jail
// specifically is missing, instead of conflating the two — same reasoning now applies to the WAF
// jail, checked and reported independently (SSHD_STATUS / WAF_STATUS on their own lines) so each
// page's own status column reflects exactly its own jail, not a merged/ambiguous value.
function buildCheckScript(includeWaf) {
  return `
if ! command -v fail2ban-client >/dev/null 2>&1 \\
   && ! (command -v dpkg >/dev/null 2>&1 && dpkg -l fail2ban 2>/dev/null | grep -q '^ii') \\
   && ! (command -v rpm >/dev/null 2>&1 && rpm -q fail2ban >/dev/null 2>&1); then
  echo "SSHD_STATUS:not_installed"
  ${includeWaf ? 'echo "WAF_STATUS:not_installed"' : ''}
  exit 0
fi
ACTIVE=$(systemctl is-active fail2ban 2>/dev/null || sudo -n systemctl is-active fail2ban 2>/dev/null)
if [ "$ACTIVE" != "active" ]; then
  echo "SSHD_STATUS:installed_not_running"
  ${includeWaf ? 'echo "WAF_STATUS:installed_not_running"' : ''}
  exit 0
fi
if sudo -n fail2ban-client status sshd 2>&1 | grep -qi "Status for the jail"; then
  echo "SSHD_STATUS:running"
else
  echo "SSHD_STATUS:sshd_jail_missing"
fi
${includeWaf ? `
if sudo -n fail2ban-client status ${wafManager.JAIL_NAME} 2>&1 | grep -qi "Status for the jail"; then
  echo "WAF_STATUS:running"
else
  echo "WAF_STATUS:not_installed"
fi` : ''}
`.trim();
}

// sshdIgnoreIpLine: current ssh_ip_exceptions baked into the sshd jail's own `ignoreip` (see
// ip-exceptions.js's buildIgnoreIpLine) — same reasoning as waf-manager.js's equivalent: fail2ban
// itself refuses to ban an excepted IP, not just this app's own isExceptedIp() check in banIp()
// below. wafIgnoreIpLine is only used when includeWaf (waf-manager.js's own waf_ip_exceptions,
// a SEPARATE list — see database.js).
//
// Explicitly enables the sshd jail via jail.d (never rely on distro defaults — see buildCheckScript's
// comment above) and, when includeWaf, splices in waf-manager.js's own jail-config-writing step so
// both jails get configured in one combined install + single reload, rather than two separate SSH
// round-trips that could disagree if one half fails.
function buildInstallScript(includeWaf, sshdIgnoreIpLine, wafIgnoreIpLine, sshBantimeSec, wafBantimeSec) {
  return `
set -e
if command -v apt-get >/dev/null 2>&1; then PKG_MGR=apt
elif command -v dnf >/dev/null 2>&1; then PKG_MGR=dnf
elif command -v yum >/dev/null 2>&1; then PKG_MGR=yum
else echo "INSTALL:unsupported_os"; exit 1
fi
case "$PKG_MGR" in
  apt)
    sudo -n apt-get update -y >/dev/null 2>&1
    sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y fail2ban
    ;;
  dnf)
    sudo -n dnf install -y epel-release >/dev/null 2>&1 || true
    sudo -n dnf install -y fail2ban
    ;;
  yum)
    sudo -n yum install -y epel-release >/dev/null 2>&1 || true
    sudo -n yum install -y fail2ban
    ;;
esac
sudo -n mkdir -p /etc/fail2ban/jail.d
sudo -n tee /etc/fail2ban/jail.d/netadmin-sshd.local >/dev/null <<'SSHD_EOF'
${buildSshdJailTemplate(sshBantimeSec)}
${sshdIgnoreIpLine}
SSHD_EOF
${includeWaf ? wafManager.buildWafJailFilesScript(wafIgnoreIpLine, wafBantimeSec) : ''}
sudo -n systemctl enable --now fail2ban
sleep 2
sudo -n fail2ban-client reload --restart 2>/dev/null || true
sleep 1
ACTIVE=$(systemctl is-active fail2ban 2>/dev/null || sudo -n systemctl is-active fail2ban 2>/dev/null)
if [ "$ACTIVE" != "active" ]; then
  echo "SSHD_STATUS:$ACTIVE"
  ${includeWaf ? 'echo "WAF_STATUS:$ACTIVE"' : ''}
  exit 0
fi
if sudo -n fail2ban-client status sshd 2>&1 | grep -qi "Status for the jail"; then
  echo "SSHD_STATUS:running"
else
  echo "SSHD_STATUS:sshd_jail_missing"
fi
${includeWaf ? `
if sudo -n fail2ban-client status ${wafManager.JAIL_NAME} 2>&1 | grep -qi "Status for the jail"; then
  echo "WAF_STATUS:running"
else
  echo "WAF_STATUS:not_installed"
fi` : ''}
`.trim();
}

// Stop (not uninstall) — flipping the toggle off should be cheap to reverse, so this just stops the
// service rather than removing the package; turning back on skips straight to systemctl start since
// installFail2ban's apt/dnf/yum install step is a no-op when the package is already present.
// Stopping the DAEMON necessarily takes every jail down with it, sshd and WAF alike (they're one
// process) — the WAF page's own waf_jail_status is updated too so it doesn't keep showing a stale
// "running" for a jail that's actually down because this page's toggle turned the whole thing off.
const STOP_SCRIPT = `
sudo -n systemctl stop fail2ban 2>/dev/null
ACTIVE=$(systemctl is-active fail2ban 2>/dev/null || sudo -n systemctl is-active fail2ban 2>/dev/null)
echo "STOP_STATUS:$ACTIVE"
`.trim();

// Sudoers hint surfaced to the admin when a check/install fails on "sudo: a password is required" —
// the VM's ssh_user needs a broader NOPASSWD rule than the one already documented for fail2ban-client
// itself (see ssh-security-collector.js) to allow the package-manager + systemctl commands above.
const SUDOERS_HINT = '<ssh_user> ALL=(ALL) NOPASSWD: /usr/bin/apt-get, /usr/bin/dnf, /usr/bin/yum, /usr/bin/systemctl, /usr/bin/fail2ban-client, /usr/bin/tee, /usr/bin/mkdir, /usr/bin/sed';

const STATUS_MESSAGE = {
  sshd_jail_missing: 'fail2ban đang chạy nhưng jail sshd chưa được bật',
};

async function connect(vm) {
  const opts = await sshCredentials.buildConnectOptions(vm);
  if (!opts) throw new Error('Chưa gán tài khoản kết nối SSH cho VM này');
  const ssh = new NodeSSH();
  await ssh.connect(opts);
  return ssh;
}

const setStatus = db.prepare(`
  UPDATE vcenter_vms SET fail2ban_status = ?, fail2ban_checked_at = CURRENT_TIMESTAMP, fail2ban_error = ? WHERE id = ?
`);
const setWafJailStatus = db.prepare(`
  UPDATE vcenter_vms SET waf_jail_status = ?, waf_jail_checked_at = CURRENT_TIMESTAMP, waf_jail_error = ? WHERE id = ?
`);

// Applies the WAF_STATUS: line from either script's output to vcenter_vms.waf_jail_status, so the
// WAF page's own status column reflects whatever this combined action just found/did — no-op if the
// VM doesn't have WAF monitoring enabled (includeWaf was false, so the script never emitted a line).
async function applyWafStatusFromOutput(stdout, vm) {
  const wafStatus = /^WAF_STATUS:(\S+)/m.exec(stdout)?.[1];
  if (!wafStatus) return;
  const error = wafStatus === 'not_installed' ? 'Jail WAF chưa được cấu hình (kiểm tra từ trang Giám sát bất thường)' : null;
  await setWafJailStatus.run(wafStatus, error, vm.id);
}

async function checkStatus(vm) {
  let ssh;
  try {
    ssh = await connect(vm);
    const includeWaf = !!vm.waf_enabled;
    const result = await ssh.execCommand(buildCheckScript(includeWaf));
    const sshdStatus = /^SSHD_STATUS:(\S+)/m.exec(result.stdout)?.[1] || 'error';
    const error = STATUS_MESSAGE[sshdStatus] || (sshdStatus === 'error' ? (result.stderr || 'Không xác định được trạng thái fail2ban') : null);
    await setStatus.run(sshdStatus, error, vm.id);
    if (includeWaf) await applyWafStatusFromOutput(result.stdout, vm);
    return { status: sshdStatus, error };
  } catch (e) {
    const error = `Không kết nối được SSH: ${e.message}`;
    await setStatus.run('error', error, vm.id);
    return { status: 'error', error };
  } finally {
    if (ssh) ssh.dispose();
  }
}

// vm must include waf_enabled (routes/security.js's getMonitoredVm selects it) so this can decide
// whether to also provision the WAF jail — see module header comment. waf_log_path is NOT needed
// here — the WAF jail's own logpath is a fixed /dev/null, unrelated to that field (see
// waf-manager.js's buildWafJailFilesScript).
async function installFail2ban(vm, user = null) {
  await setStatus.run('installing', null, vm.id);
  let ssh;
  try {
    ssh = await connect(vm);
    const includeWaf = !!vm.waf_enabled;
    const sshdIgnoreIpLine = buildIgnoreIpLine(await getExceptions());
    const wafIgnoreIpLine = includeWaf ? buildIgnoreIpLine(await wafManager.getExceptions()) : '';
    const config = await fail2banConfig.getEffectiveConfig(vm.id);
    const result = await ssh.execCommand(buildInstallScript(includeWaf, sshdIgnoreIpLine, wafIgnoreIpLine, config.ssh_bantime_sec, config.waf_bantime_sec));
    const sshdStatus = /^SSHD_STATUS:(\S+)/m.exec(result.stdout)?.[1];
    if (sshdStatus === 'running') {
      await setStatus.run('running', null, vm.id);
      if (includeWaf) await applyWafStatusFromOutput(result.stdout, vm);
      const jailsNote = includeWaf ? ' (đã bật jail sshd + jail WAF)' : ' (đã bật jail sshd)';
      await logActivity(user, 'UPDATE', 'vcenter_vm', vm.id, vm.name, `Cài đặt fail2ban thành công${jailsNote}`);
      return { status: 'running', error: null };
    }
    if (sshdStatus === 'sshd_jail_missing') {
      const error = STATUS_MESSAGE.sshd_jail_missing;
      await setStatus.run(sshdStatus, error, vm.id);
      if (includeWaf) await applyWafStatusFromOutput(result.stdout, vm);
      return { status: sshdStatus, error };
    }
    const passwordRequired = /a password is required|sudo:.*password/i.test(result.stderr || '');
    const error = passwordRequired
      ? `Thiếu quyền sudo NOPASSWD trên VM này. Cần thêm dòng sau vào /etc/sudoers.d/ trên VM: "${SUDOERS_HINT}"`
      : (result.stderr || result.stdout || 'Cài đặt thất bại không rõ nguyên nhân').slice(0, 500);
    await setStatus.run('error', error, vm.id);
    return { status: 'error', error };
  } catch (e) {
    const error = `Không kết nối được SSH: ${e.message}`;
    await setStatus.run('error', error, vm.id);
    return { status: 'error', error };
  } finally {
    if (ssh) ssh.dispose();
  }
}

async function stopFail2ban(vm, user = null) {
  let ssh;
  try {
    ssh = await connect(vm);
    const result = await ssh.execCommand(STOP_SCRIPT);
    const active = /^STOP_STATUS:(\S+)/m.exec(result.stdout)?.[1];
    if (active !== 'active') {
      await setStatus.run('installed_not_running', null, vm.id);
      if (vm.waf_enabled) await setWafJailStatus.run('installed_not_running', 'fail2ban daemon đã bị tắt (từ trang Giám sát bất thường)', vm.id);
      await logActivity(user, 'UPDATE', 'vcenter_vm', vm.id, vm.name, 'Đã tắt fail2ban (bao gồm cả jail WAF nếu có)');
      return { status: 'installed_not_running', error: null };
    }
    const error = 'Không tắt được fail2ban (có thể thiếu quyền sudo NOPASSWD cho systemctl)';
    await setStatus.run('error', error, vm.id);
    return { status: 'error', error };
  } catch (e) {
    const error = `Không kết nối được SSH: ${e.message}`;
    await setStatus.run('error', error, vm.id);
    return { status: 'error', error };
  } finally {
    if (ssh) ssh.dispose();
  }
}

// ── Manual ban/unban + exceptions for the sshd jail — mirrors waf-manager.js's equivalents exactly,
// but against the stock 'sshd' jail instead of a dedicated one, and against ssh_ip_exceptions (a
// deliberately separate list from waf_ip_exceptions — see database.js's comment on that table).
const SSHD_JAIL_NAME = 'sshd';
const { SAFE_IP_RE, matchesException, isExceptedIp, buildIgnoreIpLine } = require('./ip-exceptions');

async function getExceptions() {
  return db.prepare('SELECT id, ip, note FROM ssh_ip_exceptions').all();
}

// Re-writes the sshd jail's config with the CURRENT ssh_ip_exceptions baked into `ignoreip` AND the
// VM's current effective bantime (fail2ban-config.js) and reloads just this jail — mirrors
// waf-manager.js's pushIgnoreIp exactly, see its comment for why `reload --restart <jail>` is the
// right/proven tool here and why it doesn't drop real active bans. Re-applying bantime here too
// (not just ignoreip) means every existing caller of this function (routes/security.js, whenever
// exceptions change) also keeps the jail's bantime in sync for free — the "Cấu hình Fail2ban" admin
// page reuses this exact same function after saving, rather than needing a second push path.
async function pushIgnoreIp(vm) {
  let ssh;
  try {
    ssh = await connect(vm);
    const ignoreIpLine = buildIgnoreIpLine(await getExceptions());
    const config = await fail2banConfig.getEffectiveConfig(vm.id);
    const script = `
sudo -n mkdir -p /etc/fail2ban/jail.d
sudo -n tee /etc/fail2ban/jail.d/netadmin-sshd.local >/dev/null <<'SSHD_EOF'
${buildSshdJailTemplate(config.ssh_bantime_sec)}
${ignoreIpLine}
SSHD_EOF
sudo -n fail2ban-client reload --restart ${SSHD_JAIL_NAME} 2>&1
sleep 1
sudo -n fail2ban-client get ${SSHD_JAIL_NAME} ignoreip 2>&1
`.trim();
    const result = await ssh.execCommand(script);
    return { ok: !result.stderr, output: result.stdout };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    if (ssh) ssh.dispose();
  }
}

async function banIp(vm, ip) {
  if (!SAFE_IP_RE.test(ip || '')) return { ok: false, error: `Địa chỉ IP không hợp lệ: "${ip}"` };
  const exceptions = await getExceptions();
  if (isExceptedIp(ip, exceptions)) {
    return { ok: false, excepted: true, error: 'IP nằm trong danh sách ngoại lệ — không bị chặn' };
  }
  let ssh;
  try {
    ssh = await connect(vm);
    const status = await ssh.execCommand(`sudo -n fail2ban-client status ${SSHD_JAIL_NAME} 2>&1`);
    if (!/Status for the jail/i.test(status.stdout)) return { ok: false, error: 'Jail sshd chưa được cài đặt trên VM này' };
    if (status.stdout.includes(ip)) return { ok: true, error: null }; // already banned
    const result = await ssh.execCommand(`sudo -n fail2ban-client set ${SSHD_JAIL_NAME} banip ${ip} 2>&1`);
    // `banip`'s own return value isn't a reliable success signal on every fail2ban version/action
    // config — confirmed live against a real jail that returns "0" even when the ban was genuinely
    // applied (the IP really was in the jail's banned list right after). Always verify against the
    // actual live list instead of trusting the command's exit text.
    const after = await ssh.execCommand(`sudo -n fail2ban-client status ${SSHD_JAIL_NAME} 2>&1`);
    const ok = after.stdout.includes(ip);
    return ok ? { ok: true, error: null } : { ok: false, error: (result.stdout || result.stderr || 'Không chặn được IP').slice(0, 300) };
  } catch (e) {
    return { ok: false, error: `Không kết nối được SSH: ${e.message}` };
  } finally {
    if (ssh) ssh.dispose();
  }
}

// Reuses an already-open SSH session — mirrors waf-manager.js's unbanIpViaSsh, used by
// fail2ban-collector.js's per-poll exception reconciliation.
async function unbanIpViaSsh(ssh, ip) {
  if (!SAFE_IP_RE.test(ip || '')) return { ok: false, error: `Địa chỉ IP không hợp lệ: "${ip}"` };
  const result = await ssh.execCommand(`sudo -n fail2ban-client set ${SSHD_JAIL_NAME} unbanip ${ip} 2>&1`);
  const ok = result.stdout.trim() === '1';
  return ok ? { ok: true, error: null } : { ok: false, error: (result.stdout || result.stderr || 'Không gỡ chặn được IP').slice(0, 300) };
}

async function unbanIp(vm, ip) {
  let ssh;
  try {
    ssh = await connect(vm);
    return await unbanIpViaSsh(ssh, ip);
  } catch (e) {
    return { ok: false, error: `Không kết nối được SSH: ${e.message}` };
  } finally {
    if (ssh) ssh.dispose();
  }
}

async function listBannedIps(vm) {
  let ssh;
  try {
    ssh = await connect(vm);
    const result = await ssh.execCommand(`sudo -n fail2ban-client status ${SSHD_JAIL_NAME} 2>&1`);
    return wafManager.parseBannedIpsOutput(result.stdout);
  } catch (e) {
    return { ips: [], error: `Không kết nối được SSH: ${e.message}` };
  } finally {
    if (ssh) ssh.dispose();
  }
}

module.exports = {
  checkStatus, installFail2ban, stopFail2ban, SUDOERS_HINT,
  SSHD_JAIL_NAME, banIp, unbanIp, unbanIpViaSsh, listBannedIps,
  matchesException, isExceptedIp, getExceptions, pushIgnoreIp,
};
