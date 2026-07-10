// On-demand WAF jail install/check/stop + manual ban/unban, triggered from "Giám sát WAF" →
// "Quản lý giám sát" — mirrors fail2ban-manager.js exactly, but for a dedicated jail (JAIL_NAME)
// instead of the stock sshd one.
//
// Deliberate design: this jail's own fail2ban filter NEVER matches anything (see FILTER_CONTENT) —
// all detection (dò quét/DoS/DDoS) happens in nginx-waf-collector.js's own log parsing, not in
// fail2ban's regex engine. The jail exists purely as a ban/unban target (`fail2ban-client set
// netadmin-waf banip <ip>`), the same mechanism ssh-security-collector.js's tryImmediateBan already
// uses against the pre-existing sshd jail. Keeping 100% of detection logic in one place (the
// collector) avoids two independent, driftable definitions of "what counts as an attack."
const { NodeSSH } = require('node-ssh');
const db = require('./database');
const { logActivity } = require('./auth');
const sshCredentials = require('./ssh-credentials');

const JAIL_NAME = 'netadmin-waf';

// Absolute path, safe charset only (letters/digits/_-./) — this value comes from an admin-editable
// text field (routes/waf.js's PATCH /waf/vms/:id) and gets interpolated into a remote shell command
// below, so it's validated again here as defense-in-depth even though the route already rejects
// anything outside this charset before it's ever stored.
const SAFE_LOG_PATH_RE = /^\/[A-Za-z0-9_\-./]+$/;

const CHECK_SCRIPT = `
if ! command -v fail2ban-client >/dev/null 2>&1; then
  echo "STATUS:not_installed"
  exit 0
fi
OUT=$(sudo -n fail2ban-client status ${JAIL_NAME} 2>&1)
if echo "$OUT" | grep -q "Sorry but the jail"; then
  echo "STATUS:not_installed"
elif echo "$OUT" | grep -qi "Status for the jail"; then
  echo "STATUS:running"
else
  echo "STATUS:error"
  echo "$OUT"
fi
`.trim();

// Ensures the fail2ban package itself is present (same apt/dnf/yum detection as
// fail2ban-manager.js's INSTALL_SCRIPT), then writes a filter that can never match anything real and
// a jail pointed at the VM's configured nginx log path, and reloads.
function buildInstallScript(logPath) {
  return `
set -e
if ! command -v fail2ban-client >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then PKG_MGR=apt
  elif command -v dnf >/dev/null 2>&1; then PKG_MGR=dnf
  elif command -v yum >/dev/null 2>&1; then PKG_MGR=yum
  else echo "INSTALL:unsupported_os"; exit 1
  fi
  case "$PKG_MGR" in
    apt) sudo -n apt-get update -y >/dev/null 2>&1; sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y fail2ban ;;
    dnf) sudo -n dnf install -y epel-release >/dev/null 2>&1 || true; sudo -n dnf install -y fail2ban ;;
    yum) sudo -n yum install -y epel-release >/dev/null 2>&1 || true; sudo -n yum install -y fail2ban ;;
  esac
  sudo -n systemctl enable --now fail2ban
fi
sudo -n mkdir -p /etc/fail2ban/filter.d /etc/fail2ban/jail.d
sudo -n tee /etc/fail2ban/filter.d/${JAIL_NAME}.local >/dev/null <<'FILTER_EOF'
[Definition]
failregex = ^NEVER_MATCH_NETADMIN_WAF_PLACEHOLDER$
ignoreregex =
FILTER_EOF
sudo -n tee /etc/fail2ban/jail.d/${JAIL_NAME}.local >/dev/null <<JAIL_EOF
[${JAIL_NAME}]
enabled = true
filter = ${JAIL_NAME}
logpath = ${logPath}
maxretry = 100000
findtime = 1
bantime = 3600
action = %(action_)s
JAIL_EOF
sudo -n fail2ban-client reload
sleep 1
OUT=$(sudo -n fail2ban-client status ${JAIL_NAME} 2>&1)
if echo "$OUT" | grep -qi "Status for the jail"; then echo "FINAL_STATUS:running"; else echo "FINAL_STATUS:error"; echo "$OUT"; fi
`.trim();
}

// Disables just this jail (enabled=false + reload) rather than stopping the whole fail2ban daemon —
// the sshd jail (and any other jail already on this VM) must keep running.
const STOP_SCRIPT = `
if [ -f /etc/fail2ban/jail.d/${JAIL_NAME}.local ]; then
  sudo -n sed -i 's/^enabled = true/enabled = false/' /etc/fail2ban/jail.d/${JAIL_NAME}.local
  sudo -n fail2ban-client reload
fi
sleep 1
OUT=$(sudo -n fail2ban-client status ${JAIL_NAME} 2>&1)
if echo "$OUT" | grep -q "Sorry but the jail"; then echo "STOP_STATUS:stopped"; else echo "STOP_STATUS:still_running"; fi
`.trim();

const SUDOERS_HINT = '<ssh_user> ALL=(ALL) NOPASSWD: /usr/bin/apt-get, /usr/bin/dnf, /usr/bin/yum, /usr/bin/systemctl, /usr/bin/fail2ban-client, /usr/bin/tee, /usr/bin/mkdir, /usr/bin/sed';

async function connect(vm) {
  const opts = await sshCredentials.buildConnectOptions(vm);
  if (!opts) throw new Error('Chưa gán tài khoản kết nối SSH cho VM này');
  const ssh = new NodeSSH();
  await ssh.connect(opts);
  return ssh;
}

const setStatus = db.prepare(`
  UPDATE vcenter_vms SET waf_jail_status = ?, waf_jail_checked_at = CURRENT_TIMESTAMP, waf_jail_error = ? WHERE id = ?
`);

async function checkStatus(vm) {
  let ssh;
  try {
    ssh = await connect(vm);
    const result = await ssh.execCommand(CHECK_SCRIPT);
    const m = /^STATUS:(\S+)/m.exec(result.stdout);
    const status = m ? m[1] : 'error';
    const error = status === 'error' ? (result.stdout.split('\n').slice(1).join('\n') || result.stderr || 'Không xác định được trạng thái jail WAF') : null;
    await setStatus.run(status, error, vm.id);
    return { status, error };
  } catch (e) {
    await setStatus.run('error', `Không kết nối được SSH: ${e.message}`, vm.id);
    return { status: 'error', error: `Không kết nối được SSH: ${e.message}` };
  } finally {
    if (ssh) ssh.dispose();
  }
}

async function installJail(vm, user = null) {
  if (!SAFE_LOG_PATH_RE.test(vm.waf_log_path || '')) {
    const error = `Đường dẫn log không hợp lệ: "${vm.waf_log_path}"`;
    await setStatus.run('error', error, vm.id);
    return { status: 'error', error };
  }
  await setStatus.run('installing', null, vm.id);
  let ssh;
  try {
    ssh = await connect(vm);
    const result = await ssh.execCommand(buildInstallScript(vm.waf_log_path));
    const finalStatus = /^FINAL_STATUS:(\S+)/m.exec(result.stdout)?.[1];
    if (finalStatus === 'running') {
      await setStatus.run('running', null, vm.id);
      await logActivity(user, 'UPDATE', 'vcenter_vm', vm.id, vm.name, `Cài đặt jail WAF thành công (log: ${vm.waf_log_path})`);
      return { status: 'running', error: null };
    }
    const passwordRequired = /a password is required|sudo:.*password/i.test(result.stderr || result.stdout || '');
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

async function stopJail(vm, user = null) {
  let ssh;
  try {
    ssh = await connect(vm);
    const result = await ssh.execCommand(STOP_SCRIPT);
    const status = /^STOP_STATUS:(\S+)/m.exec(result.stdout)?.[1];
    if (status === 'stopped') {
      await setStatus.run('installed_not_running', null, vm.id);
      await logActivity(user, 'UPDATE', 'vcenter_vm', vm.id, vm.name, 'Đã dừng jail WAF');
      return { status: 'installed_not_running', error: null };
    }
    const error = 'Không dừng được jail WAF (có thể thiếu quyền sudo NOPASSWD)';
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

// Best-effort — used both by the collector's auto-block path and the manual "Chặn ngay" button.
// Returns { ok, error } rather than throwing, so a failed ban (jail not installed, sudo not
// permitted) never crashes the caller — it's surfaced as a message on the alert/event instead.
// IPv4/IPv6 charset only — ip normally comes from nginx's own $remote_addr (the real TCP peer
// address, not attacker-controlled request content), but it's validated here anyway as
// defense-in-depth since it gets interpolated straight into a remote shell command below.
const SAFE_IP_RE = /^[0-9a-fA-F:.]+$/;

async function banIp(vm, ip) {
  if (!SAFE_IP_RE.test(ip || '')) return { ok: false, error: `Địa chỉ IP không hợp lệ: "${ip}"` };
  let ssh;
  try {
    ssh = await connect(vm);
    const status = await ssh.execCommand(`sudo -n fail2ban-client status ${JAIL_NAME} 2>&1`);
    if (!/Status for the jail/i.test(status.stdout)) return { ok: false, error: 'Jail WAF chưa được cài đặt trên VM này' };
    const result = await ssh.execCommand(`sudo -n fail2ban-client set ${JAIL_NAME} banip ${ip} 2>&1`);
    const ok = result.stdout.trim() === '1' || /already banned/i.test(result.stdout);
    return ok ? { ok: true, error: null } : { ok: false, error: (result.stdout || result.stderr || 'Không chặn được IP').slice(0, 300) };
  } catch (e) {
    return { ok: false, error: `Không kết nối được SSH: ${e.message}` };
  } finally {
    if (ssh) ssh.dispose();
  }
}

async function unbanIp(vm, ip) {
  if (!SAFE_IP_RE.test(ip || '')) return { ok: false, error: `Địa chỉ IP không hợp lệ: "${ip}"` };
  let ssh;
  try {
    ssh = await connect(vm);
    const result = await ssh.execCommand(`sudo -n fail2ban-client set ${JAIL_NAME} unbanip ${ip} 2>&1`);
    const ok = result.stdout.trim() === '1';
    return ok ? { ok: true, error: null } : { ok: false, error: (result.stdout || result.stderr || 'Không gỡ chặn được IP').slice(0, 300) };
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
    const result = await ssh.execCommand(`sudo -n fail2ban-client status ${JAIL_NAME} 2>&1`);
    if (!/Status for the jail/i.test(result.stdout)) return { ips: [], error: 'Jail WAF chưa được cài đặt trên VM này' };
    const m = /Banned IP list:\s*(.*)/.exec(result.stdout);
    const ips = m ? m[1].split(/\s+/).filter(Boolean) : [];
    return { ips, error: null };
  } catch (e) {
    return { ips: [], error: `Không kết nối được SSH: ${e.message}` };
  } finally {
    if (ssh) ssh.dispose();
  }
}

module.exports = { JAIL_NAME, SAFE_LOG_PATH_RE, checkStatus, installJail, stopJail, banIp, unbanIp, listBannedIps, SUDOERS_HINT };
