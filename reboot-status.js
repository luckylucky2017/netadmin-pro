// Shared by vuln-scanner.js (checked piggybacked on its existing periodic SSH session, every ~12h
// per VM — this is what makes the reboot-required state a proactive standing alert rather than
// something only discovered when an admin happens to click "Kiểm tra update") and
// apt-update-manager.js (the explicit "Kiểm tra update" click, for an immediate fresh read). A
// separate module — not living in either — avoids a circular require, since apt-update-manager.js
// already requires vuln-scanner.js for its post-apply rescan.
//
// A newly-installed kernel (or libc, etc.) is fully "up to date" from apt's perspective the moment
// dpkg installs it — it just isn't the RUNNING kernel/library yet. Debian/Ubuntu track that gap
// separately via /var/run/reboot-required(.pkgs), completely outside the package-upgrade mechanism —
// confirmed against a real VM whose newest kernel package was already installed with zero
// "upgradable" entries for it, purely awaiting a reboot.
const db = require('./database');

const REBOOT_CHECK_CMD = `
if [ -f /var/run/reboot-required ]; then
  echo "YES"
  cat /var/run/reboot-required.pkgs 2>/dev/null | sort -u
fi
`.trim();

// Pure, testable.
function parseRebootCheckOutput(stdout) {
  const lines = (stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const rebootRequired = lines[0] === 'YES';
  return { rebootRequired, rebootPackages: rebootRequired ? lines.slice(1) : [] };
}

const setRebootStatus = db.prepare('UPDATE vcenter_vms SET reboot_required = ?, reboot_required_packages = ? WHERE id = ?');

async function raiseRebootAlert(vm, rebootPackages) {
  const already = await db.prepare(`
    SELECT id FROM alerts WHERE metric = 'reboot_required' AND source_type = 'vcenter_vm' AND source_id = ? AND status = 'open'
  `).get(vm.id);
  if (already) return;
  await db.prepare(`
    INSERT INTO alerts (category, severity, title, message, source_type, source_id, source_name, metric, metric_value, status)
    VALUES ('security', 'medium', ?, ?, 'vcenter_vm', ?, ?, 'reboot_required', ?, 'open')
  `).run(
    'VM cần khởi động lại để áp dụng cập nhật',
    `VM "${vm.name}" đã cài bản cập nhật (thường là kernel) nhưng chưa khởi động lại để áp dụng — trong lúc chờ, VM vẫn chạy kernel/thư viện cũ có thể còn lỗ hổng đã được vá: ${rebootPackages.slice(0, 10).join(', ')}${rebootPackages.length > 10 ? ', ...' : ''}`,
    vm.id, vm.name, String(rebootPackages.length)
  );
}

// Resolved automatically once a later check finds reboot_required=false (the VM was rebooted) —
// same "still open until proven otherwise" lifecycle as every other alert this app raises.
async function resolveRebootAlert(vm) {
  const open = await db.prepare(`
    SELECT id FROM alerts WHERE metric = 'reboot_required' AND source_type = 'vcenter_vm' AND source_id = ? AND status = 'open'
  `).get(vm.id);
  if (open) await db.prepare("UPDATE alerts SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP WHERE id = ?").run(open.id);
}

// Persists the state and raises/resolves the standing alert to match — call after running
// REBOOT_CHECK_CMD over an already-open SSH session.
async function recordRebootStatus(vm, rebootRequired, rebootPackages) {
  await setRebootStatus.run(rebootRequired ? 1 : 0, rebootPackages.join(', ') || null, vm.id);
  if (rebootRequired) await raiseRebootAlert(vm, rebootPackages);
  else await resolveRebootAlert(vm);
}

module.exports = { REBOOT_CHECK_CMD, parseRebootCheckOutput, recordRebootStatus };
