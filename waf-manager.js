// On-demand WAF jail install/check/stop + manual ban/unban, triggered from "Giám sát WAF" →
// "Quản lý giám sát" — mirrors fail2ban-manager.js exactly, but for a dedicated jail (JAIL_NAME)
// instead of the stock sshd one.
//
// Deliberate design: this jail's own fail2ban filter NEVER matches anything (see
// buildWafJailFilesScript below) —
// all detection (dò quét/DoS/DDoS) happens in nginx-waf-collector.js's own log parsing, not in
// fail2ban's regex engine. The jail exists purely as a ban/unban target (`fail2ban-client set
// netadmin-waf banip <ip>`), the same mechanism ssh-security-collector.js's tryImmediateBan already
// uses against the pre-existing sshd jail. Keeping 100% of detection logic in one place (the
// collector) avoids two independent, driftable definitions of "what counts as an attack."
const { NodeSSH } = require('node-ssh');
const fs = require('fs');
const path = require('path');
const db = require('./database');
const { logActivity } = require('./auth');
const sshCredentials = require('./ssh-credentials');

const JAIL_NAME = 'netadmin-waf';

// Real, on-disk config files (fail2ban-templates/) are the single source of truth for what gets
// deployed — not just JS string literals — so an admin can also apply them manually on a machine
// set up outside this app (`sudo cp ... && fail2ban-client reload --restart`, see the comment header
// in each template file for the exact commands). Loaded once at require-time; stripped of their `#`
// comment header before being written to the remote host, so production /etc/fail2ban/* files stay
// minimal instead of carrying this repo's internal dev commentary.
function loadTemplate(filename) {
  const raw = fs.readFileSync(path.join(__dirname, 'fail2ban-templates', filename), 'utf8');
  return raw.split('\n').filter(line => !line.trim().startsWith('#')).join('\n').trim();
}
const WAF_FILTER_TEMPLATE = loadTemplate('netadmin-waf-filter.local');
const WAF_JAIL_TEMPLATE = loadTemplate('netadmin-waf-jail.local');

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

// Just the "write the WAF jail's config files" step (no package install, no reload) — factored out
// so fail2ban-manager.js's unified installFail2ban() can splice this into its own combined script
// (package install + sshd jail + WAF jail, one single reload) instead of duplicating this content or
// running a second separate SSH round-trip. buildInstallScript() below still uses it standalone for
// the WAF page's own "Cài đặt jail" button, which only needs the WAF side.
//
// failregex MUST include a <HOST> group — confirmed on a real host (fail2ban 1.0.2): a filter with
// zero capture groups fails validation at `fail2ban-client reload` time ("No failure-id group in
// '...'"), which aborts the WHOLE reload transaction and was observed tearing down this jail even
// though it had been running fine before (a later reload — e.g. triggered by the sshd-jail install
// below — re-validates every already-loaded filter, not just the one that changed). The placeholder
// text before <HOST> still makes this practically unmatchable against any real log line.
//
// Also confirmed on the same real host: plain `fail2ban-client reload` does NOT pick up a brand-new
// jail that wasn't already running — it only reloads config for jails already active. `reload
// --restart` is required to make it actually scan jail.d and start newly-added jails; every reload
// call in this file/fail2ban-manager.js uses that flag for exactly this reason.
//
// No longer takes a logPath argument — the jail's own logpath is a fixed /dev/null (see
// fail2ban-templates/netadmin-waf-jail.local's header comment for why: this jail's filter never
// matches anything, and a VM commonly has several per-domain access logs that no single jail
// logpath could cover anyway). vcenter_vms.waf_log_path is a completely separate concern — it's
// nginx-waf-collector.js's own fallback path for actual log TAILING when no domain could be
// auto-discovered from /etc/nginx config, unrelated to this jail's config.
function buildWafJailFilesScript() {
  return `
sudo -n mkdir -p /etc/fail2ban/filter.d /etc/fail2ban/jail.d
sudo -n tee /etc/fail2ban/filter.d/${JAIL_NAME}.local >/dev/null <<'FILTER_EOF'
${WAF_FILTER_TEMPLATE}
FILTER_EOF
sudo -n tee /etc/fail2ban/jail.d/${JAIL_NAME}.local >/dev/null <<'JAIL_EOF'
${WAF_JAIL_TEMPLATE}
JAIL_EOF
`.trim();
}

// Ensures the fail2ban package itself is present (same apt/dnf/yum detection as
// fail2ban-manager.js's INSTALL_SCRIPT), then writes the WAF jail's config and reloads.
function buildInstallScript() {
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
${buildWafJailFilesScript()}
sudo -n fail2ban-client reload --restart
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
  sudo -n fail2ban-client reload --restart
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
  await setStatus.run('installing', null, vm.id);
  let ssh;
  try {
    ssh = await connect(vm);
    const result = await ssh.execCommand(buildInstallScript());
    const finalStatus = /^FINAL_STATUS:(\S+)/m.exec(result.stdout)?.[1];
    if (finalStatus === 'running') {
      await setStatus.run('running', null, vm.id);
      await logActivity(user, 'UPDATE', 'vcenter_vm', vm.id, vm.name, 'Cài đặt jail WAF thành công');
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

function isIpv4(ip) { return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip || ''); }

function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => Number.isNaN(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

// Pure, testable: does `ip` fall under exception entry `entryIp`? entryIp may be a bare IPv4/IPv6
// address (exact match) or an IPv4 CIDR range like "203.0.113.0/24" — CIDR ranges are IPv4-only,
// IPv6 exceptions are always exact-match to keep this simple.
function matchesException(ip, entryIp) {
  if (!ip || !entryIp) return false;
  const cidrM = /^(.+)\/(\d{1,2})$/.exec(entryIp);
  if (cidrM && isIpv4(cidrM[1]) && isIpv4(ip)) {
    const prefixLen = Number(cidrM[2]);
    if (prefixLen < 0 || prefixLen > 32) return false;
    const mask = prefixLen === 0 ? 0 : (0xFFFFFFFF << (32 - prefixLen)) >>> 0;
    const a = ipv4ToInt(ip), b = ipv4ToInt(cidrM[1]);
    if (a === null || b === null) return false;
    return (a & mask) === (b & mask);
  }
  return ip === entryIp;
}

function isExceptedIp(ip, exceptions) {
  return exceptions.some(e => matchesException(ip, e.ip));
}

async function getExceptions() {
  return db.prepare('SELECT id, ip, note FROM waf_ip_exceptions').all();
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

// Reuses an already-open SSH session — mirrors listBannedIpsViaSsh below, used by
// nginx-waf-collector.js's per-poll exception reconciliation so it doesn't open a 2nd connection
// per stale IP found.
async function unbanIpViaSsh(ssh, ip) {
  if (!SAFE_IP_RE.test(ip || '')) return { ok: false, error: `Địa chỉ IP không hợp lệ: "${ip}"` };
  const result = await ssh.execCommand(`sudo -n fail2ban-client set ${JAIL_NAME} unbanip ${ip} 2>&1`);
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

// Pure, testable: parses `fail2ban-client status <jail>` stdout into { ips, error }.
function parseBannedIpsOutput(stdout) {
  if (!/Status for the jail/i.test(stdout || '')) return { ips: [], error: 'Jail WAF chưa được cài đặt trên VM này' };
  const m = /Banned IP list:\s*(.*)/.exec(stdout);
  const ips = m ? m[1].split(/\s+/).filter(Boolean) : [];
  return { ips, error: null };
}

// Reuses an already-open SSH session — used by nginx-waf-collector.js's per-poll sync, which
// already has a connection open for log tailing, so this avoids a second SSH round-trip per VM.
async function listBannedIpsViaSsh(ssh) {
  const result = await ssh.execCommand(`sudo -n fail2ban-client status ${JAIL_NAME} 2>&1`);
  return parseBannedIpsOutput(result.stdout);
}

async function listBannedIps(vm) {
  let ssh;
  try {
    ssh = await connect(vm);
    return await listBannedIpsViaSsh(ssh);
  } catch (e) {
    return { ips: [], error: `Không kết nối được SSH: ${e.message}` };
  } finally {
    if (ssh) ssh.dispose();
  }
}

module.exports = {
  JAIL_NAME, SAFE_LOG_PATH_RE, checkStatus, installJail, stopJail, banIp, unbanIp, listBannedIps, SUDOERS_HINT,
  matchesException, isExceptedIp, getExceptions,
  parseBannedIpsOutput, listBannedIpsViaSsh, unbanIpViaSsh, buildWafJailFilesScript,
};
