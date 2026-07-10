// On-demand fail2ban status check + auto-install, triggered by an admin clicking the "Fail2ban"
// button in "Quản lý VM giám sát" — separate from fail2ban-collector.js, which only ever reads
// ban state for VMs that already have it installed. This module answers "is it even here?" and,
// if not, installs it.
const { NodeSSH } = require('node-ssh');
const db = require('./database');
const { logActivity } = require('./auth');
const sshCredentials = require('./ssh-credentials');

// "systemctl is-active" only proves the DAEMON is running — it says nothing about whether the sshd
// JAIL is actually enabled inside it. Confirmed on real hosts: Ubuntu 24.04's fail2ban package does
// NOT enable sshd by default (unlike some other distro/version combos where it ships pre-enabled),
// so a bare `apt-get install fail2ban && systemctl enable --now` can leave the daemon running with
// zero real protection — the UI would show "Đang chạy" while SSH brute-force is completely
// unguarded. So CHECK_SCRIPT reports a distinct status when the daemon is up but the sshd jail
// specifically is missing, instead of conflating the two.
const CHECK_SCRIPT = `
if ! command -v fail2ban-client >/dev/null 2>&1 \\
   && ! (command -v dpkg >/dev/null 2>&1 && dpkg -l fail2ban 2>/dev/null | grep -q '^ii') \\
   && ! (command -v rpm >/dev/null 2>&1 && rpm -q fail2ban >/dev/null 2>&1); then
  echo "STATUS:not_installed"
  exit 0
fi
ACTIVE=$(systemctl is-active fail2ban 2>/dev/null || sudo -n systemctl is-active fail2ban 2>/dev/null)
if [ "$ACTIVE" != "active" ]; then echo "STATUS:installed_not_running"; exit 0; fi
if sudo -n fail2ban-client status sshd 2>&1 | grep -qi "Status for the jail"; then
  echo "STATUS:running"
else
  echo "STATUS:sshd_jail_missing"
fi
`.trim();

// Explicitly enables the sshd jail via jail.d (same approach as waf-manager.js's dedicated jail —
// never rely on distro defaults) rather than just installing the package and hoping jail.conf's
// shipped default has it on.
const INSTALL_SCRIPT = `
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
[sshd]
enabled = true
SSHD_EOF
sudo -n systemctl enable --now fail2ban
sleep 2
sudo -n fail2ban-client reload 2>/dev/null || true
sleep 1
ACTIVE=$(systemctl is-active fail2ban 2>/dev/null || sudo -n systemctl is-active fail2ban 2>/dev/null)
if [ "$ACTIVE" != "active" ]; then
  echo "FINAL_STATUS:$ACTIVE"
elif sudo -n fail2ban-client status sshd 2>&1 | grep -qi "Status for the jail"; then
  echo "FINAL_STATUS:active"
else
  echo "FINAL_STATUS:daemon_active_no_sshd_jail"
fi
`.trim();

// Stop (not uninstall) — flipping the toggle off should be cheap to reverse, so this just stops the
// service rather than removing the package; turning back on skips straight to systemctl start since
// installFail2ban's apt/dnf/yum install step is a no-op when the package is already present.
const STOP_SCRIPT = `
sudo -n systemctl stop fail2ban 2>/dev/null
ACTIVE=$(systemctl is-active fail2ban 2>/dev/null || sudo -n systemctl is-active fail2ban 2>/dev/null)
echo "STOP_STATUS:$ACTIVE"
`.trim();

// Sudoers hint surfaced to the admin when a check/install fails on "sudo: a password is required" —
// the VM's ssh_user needs a broader NOPASSWD rule than the one already documented for fail2ban-client
// itself (see ssh-security-collector.js) to allow the package-manager + systemctl commands above.
const SUDOERS_HINT = '<ssh_user> ALL=(ALL) NOPASSWD: /usr/bin/apt-get, /usr/bin/dnf, /usr/bin/yum, /usr/bin/systemctl, /usr/bin/fail2ban-client';

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

async function checkStatus(vm) {
  let ssh;
  try {
    ssh = await connect(vm);
    const result = await ssh.execCommand(CHECK_SCRIPT);
    const m = /^STATUS:(\S+)/m.exec(result.stdout);
    const status = m ? m[1] : 'error';
    const error = status === 'error' ? (result.stderr || 'Không xác định được trạng thái fail2ban') : null;
    await setStatus.run(status, error, vm.id);
    return { status, error };
  } catch (e) {
    await setStatus.run('error', `Không kết nối được SSH: ${e.message}`, vm.id);
    return { status: 'error', error: `Không kết nối được SSH: ${e.message}` };
  } finally {
    if (ssh) ssh.dispose();
  }
}

async function installFail2ban(vm, user = null) {
  await setStatus.run('installing', null, vm.id);
  let ssh;
  try {
    ssh = await connect(vm);
    const result = await ssh.execCommand(INSTALL_SCRIPT);
    const finalStatus = /^FINAL_STATUS:(\S+)/m.exec(result.stdout)?.[1];
    if (finalStatus === 'active') {
      await setStatus.run('running', null, vm.id);
      await logActivity(user, 'UPDATE', 'vcenter_vm', vm.id, vm.name, 'Cài đặt fail2ban thành công (đã bật jail sshd)');
      return { status: 'running', error: null };
    }
    if (finalStatus === 'daemon_active_no_sshd_jail') {
      const error = 'fail2ban đang chạy nhưng không bật được jail sshd (kiểm tra /etc/fail2ban/jail.d/netadmin-sshd.local trên VM)';
      await setStatus.run('sshd_jail_missing', error, vm.id);
      return { status: 'sshd_jail_missing', error };
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
      await logActivity(user, 'UPDATE', 'vcenter_vm', vm.id, vm.name, 'Đã tắt fail2ban');
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

module.exports = { checkStatus, installFail2ban, stopFail2ban, SUDOERS_HINT };
