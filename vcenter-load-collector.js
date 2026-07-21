// Reads guest OS load average (1/5/15 min) via SSH for vCenter VMs that already have an SSH
// credential configured for other features (fail2ban/Trivy/WAF) — vCenter's own performance
// counters have no equivalent (cpu.usage.average is % of allocated CPU consumed, not "processes
// waiting to run"), so this is the only way to get it. Opportunistic: no separate enable toggle,
// just piggybacks on whatever SSH access is already set up. /proc/loadavg is world-readable, so
// no sudo/NOPASSWD provisioning is needed (unlike ssh-security-collector.js's auth.log reads).
const { NodeSSH } = require('node-ssh');
const db = require('./database');
const sshCredentials = require('./ssh-credentials');

const LOADAVG_RE = /^([\d.]+)\s+([\d.]+)\s+([\d.]+)/;

function parseLoadavg(stdout) {
  const m = LOADAVG_RE.exec((stdout || '').trim());
  if (!m) return null;
  return { load1: parseFloat(m[1]), load5: parseFloat(m[2]), load15: parseFloat(m[3]) };
}

const updateOk = db.prepare(`
  UPDATE vcenter_vms SET load_avg_1=?, load_avg_5=?, load_avg_15=?,
    load_avg_checked_at=CURRENT_TIMESTAMP, load_avg_error=NULL WHERE id=?
`);
// Errors leave the last-known values in place (same convention as trivy_scan_error etc.) — a
// transient SSH hiccup shouldn't blank out a number that was correct a minute ago.
const updateError = db.prepare(`
  UPDATE vcenter_vms SET load_avg_checked_at=CURRENT_TIMESTAMP, load_avg_error=? WHERE id=?
`);

async function collectVm(vm) {
  const opts = await sshCredentials.buildConnectOptions(vm);
  if (!opts) return;
  const ssh = new NodeSSH();
  try {
    await ssh.connect(opts);
    const result = await ssh.execCommand('cat /proc/loadavg');
    const parsed = parseLoadavg(result.stdout);
    if (!parsed) {
      await updateError.run((result.stderr || 'Không đọc được /proc/loadavg').slice(0, 500), vm.id);
      return;
    }
    await updateOk.run(parsed.load1, parsed.load5, parsed.load15, vm.id);
  } catch (e) {
    await updateError.run(e.message.slice(0, 500), vm.id);
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
}

function start(intervalMs = 45000) {
  const tick = () => collectAll().catch(e => console.error('[vcenter-load] Lỗi:', e.message));
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = { start, collectAll, collectVm, parseLoadavg };
