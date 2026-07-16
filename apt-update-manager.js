// On-demand (never auto-scheduled — see the "no auto-recheck on render" rule) apt package-update
// checking and application for VMs already opted into CVE scanning (vuln_scan_enabled). Two distinct
// actions, both explicit user clicks, never triggered by page render/refresh:
//   1. "Kiểm tra update" — checkUpdates(vm): refreshes the apt index (apt-get update) and lists what's
//      upgradable, storing a snapshot in vuln_pending_updates. Read-only on the VM's package state.
//   2. "Cập nhật đã chọn" — applyUpdates(vm, packages, user): actually installs the upgrades for the
//      specific packages the admin selected (never a blanket `apt-get upgrade`), skipping anything in
//      the global vuln_update_exceptions list, and records the outcome in vuln_update_history.
// Debian/Ubuntu (dpkg/apt) only, matching vuln-scanner.js's existing ecosystem scope — RPM-based
// distros get an honest "unsupported" rather than a silently-wrong flow.
const { NodeSSH } = require('node-ssh');
const db = require('./database');
const sshCredentials = require('./ssh-credentials');
const vulnScanner = require('./vuln-scanner');

// Debian package-name policy (lowercase letters/digits, plus + . -, must start alnum) — real dpkg
// names can never contain shell metacharacters, so this doubles as both a sanity check (rejects a
// tampered/malformed request before it ever reaches a shell command) and the only validation needed
// before interpolating a name directly into the SSH script.
const PACKAGE_NAME_RE = /^[a-z0-9][a-z0-9+.-]*$/;

const CHECK_SCRIPT = `
. /etc/os-release 2>/dev/null
if ! command -v dpkg-query >/dev/null 2>&1; then
  echo "FAMILY:unsupported"
  exit 0
fi
echo "FAMILY:debian"
echo "===APTUPDATE==="
sudo -n apt-get update 2>&1
echo "===UPGRADABLE==="
apt list --upgradable 2>/dev/null | tail -n +2
`.trim();

// Pure, testable: splits CHECK_SCRIPT's stdout into { family, aptUpdateOutput, packages }.
// `apt list --upgradable` lines look like:
//   pkgname/repo,repo2 newversion arch [upgradable from: oldversion]
function parseCheckOutput(stdout) {
  const family = /^FAMILY:(\S+)/m.exec(stdout || '')?.[1] || 'unknown';
  if (family !== 'debian') return { family, aptUpdateOutput: '', packages: [] };
  const updateIdx = stdout.indexOf('===APTUPDATE===');
  const upgradableIdx = stdout.indexOf('===UPGRADABLE===');
  const aptUpdateOutput = updateIdx !== -1 && upgradableIdx !== -1
    ? stdout.slice(updateIdx + '===APTUPDATE==='.length, upgradableIdx).trim()
    : '';
  const packages = [];
  if (upgradableIdx !== -1) {
    for (const raw of stdout.slice(upgradableIdx + '===UPGRADABLE==='.length).split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const m = /^(\S+?)\/\S+\s+(\S+)\s+\S+\s+\[upgradable from:\s*([^\]]+)\]/.exec(line);
      if (m) packages.push({ name: m[1], candidateVersion: m[2], currentVersion: m[3].trim() });
    }
  }
  return { family, aptUpdateOutput, packages };
}

function buildApplyScript(packageNames) {
  const quoted = packageNames.map((p) => `'${p}'`).join(' ');
  return `
sudo -n apt-get install --only-upgrade -y ${quoted} 2>&1
echo "===EXITCODE:$?==="
echo "===POSTVERSIONS==="
dpkg-query -W -f='\${Package}|\${Version}\\n' ${quoted} 2>/dev/null
`.trim();
}

// Pure, testable: splits buildApplyScript's stdout into { exitCode, versions (Map<pkg,version>), rawOutput }.
function parseApplyOutput(stdout) {
  const s = stdout || '';
  const exitMatch = /===EXITCODE:(\d+)===/.exec(s);
  const exitCode = exitMatch ? Number(exitMatch[1]) : null;
  const versions = new Map();
  const versionsIdx = s.indexOf('===POSTVERSIONS===');
  if (versionsIdx !== -1) {
    for (const raw of s.slice(versionsIdx + '===POSTVERSIONS==='.length).split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const sep = line.indexOf('|');
      if (sep === -1) continue;
      versions.set(line.slice(0, sep).trim(), line.slice(sep + 1).trim());
    }
  }
  const rawOutput = (exitMatch ? s.slice(0, exitMatch.index) : s).trim();
  return { exitCode, versions, rawOutput };
}

// Pure, testable: cross-references each package's ACTUAL installed version after the apply (from
// dpkg-query — ground truth) against what it was immediately before (fromVersion, the check-time
// current_version) — more reliable than parsing apt's free-text install log, which varies across
// apt versions/locales/translations. 'updated' whenever the installed version genuinely changed
// (even if it lands on something other than the originally-offered candidate — a repo update between
// check and apply can offer a newer version, which is still a real success); 'failed' when the
// version is unchanged (apt silently refused: held package, dependency conflict, disk full, etc.) or
// the package is no longer installed at all (shouldn't normally happen for --only-upgrade, handled
// rather than left to crash on an undefined lookup).
function evaluateApplyResult(fromVersion, installedVersion) {
  if (installedVersion === undefined) {
    return { status: 'failed', toVersion: null, error: 'Gói không còn được cài đặt trên VM sau khi chạy lệnh cập nhật' };
  }
  if (installedVersion === fromVersion) {
    return { status: 'failed', toVersion: installedVersion, error: 'Phiên bản không đổi — cập nhật có thể đã bị chặn (gói bị giữ/hold, xung đột phụ thuộc, hoặc apt từ chối)' };
  }
  return { status: 'updated', toVersion: installedVersion, error: null };
}

const replacePendingForVm = db.prepare('DELETE FROM vuln_pending_updates WHERE vm_id = ?');
const insertPending = db.prepare(`
  INSERT INTO vuln_pending_updates (vm_id, vm_name, package_name, current_version, candidate_version)
  VALUES (?, ?, ?, ?, ?)
`);
const deletePending = db.prepare('DELETE FROM vuln_pending_updates WHERE vm_id = ? AND package_name = ?');
const insertHistory = db.prepare(`
  INSERT INTO vuln_update_history (vm_id, vm_name, package_name, from_version, to_version, status, error, applied_by)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const setUpdateCheckedAt = db.prepare('UPDATE vcenter_vms SET update_checked_at = CURRENT_TIMESTAMP WHERE id = ?');

async function getExceptionSet() {
  const rows = await db.prepare('SELECT package_name FROM vuln_update_exceptions').all();
  return new Set(rows.map((r) => r.package_name));
}

// Refreshes the apt index and records what's currently upgradable — read-only on the VM itself
// (apt-get update only refreshes the local package index cache, installs nothing).
async function checkUpdates(vm) {
  const opts = await sshCredentials.buildConnectOptions(vm);
  if (!opts) throw new Error('Chưa gán tài khoản kết nối SSH');
  const ssh = new NodeSSH();
  try {
    await ssh.connect(opts);
    const result = await ssh.execCommand(CHECK_SCRIPT);
    const { family, aptUpdateOutput, packages } = parseCheckOutput(result.stdout);
    if (family !== 'debian') {
      throw new Error('Chưa hỗ trợ kiểm tra update cho hệ điều hành này (hiện chỉ hỗ trợ Ubuntu/Debian)');
    }
    // "E:" lines are apt's own error prefix (network failure, repo unreachable, GPG issues, etc.) —
    // surfaced as a warning rather than failing the whole check, since apt list --upgradable still
    // returns a (possibly stale) result from the last-known-good cache even when the refresh failed.
    const updateError = /^E:/m.test(aptUpdateOutput) ? aptUpdateOutput.split('\n').filter((l) => l.startsWith('E:')).join('; ') : null;

    const exceptions = await getExceptionSet();
    await replacePendingForVm.run(vm.id);
    for (const pkg of packages) {
      await insertPending.run(vm.id, vm.name, pkg.name, pkg.currentVersion, pkg.candidateVersion);
    }
    await setUpdateCheckedAt.run(vm.id);
    return {
      packages: packages.map((p) => ({ ...p, excepted: exceptions.has(p.name) })),
      updateError,
    };
  } finally {
    ssh.dispose();
  }
}

// Installs upgrades for exactly the requested packages (never a blanket `apt-get upgrade`) — filters
// out anything in the global exceptions list server-side even if the caller already filtered
// client-side, verifies each outcome against real post-install dpkg state, records history, clears
// successfully-updated packages out of vuln_pending_updates, and kicks off a fresh CVE scan for this
// VM so vuln_findings reflects the new package versions immediately rather than showing stale
// findings tied to versions that no longer exist.
async function applyUpdates(vm, requestedNames, user) {
  const validNames = requestedNames.filter((n) => PACKAGE_NAME_RE.test(n));
  const exceptions = await getExceptionSet();
  const packageNames = validNames.filter((n) => !exceptions.has(n));
  if (!packageNames.length) return { results: [], skipped: requestedNames.length };

  const pendingRows = await db.prepare('SELECT package_name, current_version FROM vuln_pending_updates WHERE vm_id = ?').all(vm.id);
  const fromVersions = new Map(pendingRows.map((r) => [r.package_name, r.current_version]));

  const opts = await sshCredentials.buildConnectOptions(vm);
  if (!opts) throw new Error('Chưa gán tài khoản kết nối SSH');
  const ssh = new NodeSSH();
  const results = [];
  try {
    await ssh.connect(opts);
    // apt-get install for several packages (esp. anything pulling a kernel/large runtime) can
    // legitimately take minutes — node-ssh/ssh2 impose no artificial per-command timeout by default,
    // so this simply waits for the channel to close naturally.
    const result = await ssh.execCommand(buildApplyScript(packageNames));
    const { versions, rawOutput } = parseApplyOutput(result.stdout);
    for (const name of packageNames) {
      const fromVersion = fromVersions.get(name) || null;
      const evalResult = evaluateApplyResult(fromVersion, versions.get(name));
      const error = evalResult.error || (evalResult.status === 'failed' ? rawOutput.slice(0, 500) : null);
      await insertHistory.run(vm.id, vm.name, name, fromVersion, evalResult.toVersion, evalResult.status, error, user?.name || user?.email || null);
      if (evalResult.status === 'updated') await deletePending.run(vm.id, name);
      results.push({ package: name, status: evalResult.status, fromVersion, toVersion: evalResult.toVersion, error });
    }
  } finally {
    ssh.dispose();
  }

  // Best-effort — a scan failure here shouldn't hide the (already-recorded) update results from the caller.
  try { await vulnScanner.scanVm(vm, new Map()); } catch (e) { console.error(`[apt-update] rescan sau update thất bại cho ${vm.name}: ${e.message}`); }

  return { results, skipped: requestedNames.length - packageNames.length };
}

module.exports = {
  checkUpdates, applyUpdates, getExceptionSet,
  parseCheckOutput, buildApplyScript, parseApplyOutput, evaluateApplyResult,
  PACKAGE_NAME_RE,
};
