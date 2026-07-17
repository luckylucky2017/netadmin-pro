// Application-level dependency vulnerability scanning via Trivy (https://trivy.dev), per VM opted in
// (vcenter_vms.trivy_scan_enabled) — complements vuln-scanner.js's OS-package scanning (dpkg/apt via
// OSV.dev) with app-level dependency manifests (package-lock.json, requirements.txt, go.sum,
// pom.xml, etc.).
//
// Architecture: Trivy itself is installed ONCE, locally on the netadmin-pro host (into
// LOCAL_TRIVY_DIR below — no sudo, since the app already owns that directory) — NOT on every target
// VM. Trivy's `fs` scan needs local filesystem access, so for each VM this module: (1) SSHes in with
// the credential already configured for that VM (the same one used for every other collector) and
// `find`s just the dependency manifest files under vcenter_vms.trivy_scan_path, (2) pulls those files
// (only the manifests — not node_modules/vendor/the whole tree) via SFTP into a local temp dir that
// mirrors the remote relative structure, (3) runs the single centrally-installed trivy binary against
// that temp dir, (4) deletes the temp dir. Net effect: target VMs need zero installation and zero
// sudo for this feature — only ordinary read access to their own source tree, which the SSH
// credential already has.
const { NodeSSH } = require('node-ssh');
const { execFile } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const db = require('./database');
const sshCredentials = require('./ssh-credentials');
const vulnEnrichment = require('./vuln-enrichment');

const SCAN_INTERVAL_HOURS = 12;
const TICK_MS = 30 * 60 * 1000;
const ALERT_SEVERITIES = new Set(['critical', 'high']);

// Both live inside the app's own directory (gitignored — see .gitignore) rather than a system path,
// so install needs no sudo and the binary/DB survive a `git pull` without being tracked by git.
// TRIVY_CACHE_DIR is set explicitly rather than left to trivy's own $HOME-based default because this
// process may run as a system service account whose $HOME isn't guaranteed to be writable/set.
const LOCAL_TRIVY_DIR = path.join(__dirname, '.trivy-bin');
const LOCAL_TRIVY_BIN = path.join(LOCAL_TRIVY_DIR, 'trivy');
const LOCAL_TRIVY_CACHE_DIR = path.join(__dirname, '.trivy-cache');

async function isLocalTrivyInstalled() {
  try {
    await fsp.access(LOCAL_TRIVY_BIN, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Same official install method as before (trivy.dev/latest/getting-started/installation), just run
// LOCALLY instead of over SSH — -b points at our own directory (fixed, never user input), so this
// needs no sudo at all, unlike the old per-VM remote install.
function installLocalTrivy() {
  return new Promise((resolve) => {
    const script = `mkdir -p '${LOCAL_TRIVY_DIR}' && curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh -s -- -b '${LOCAL_TRIVY_DIR}'`;
    execFile('sh', ['-c', script], { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: (stderr || err.message || 'Cài đặt Trivy thất bại').slice(0, 2000) });
      resolve({ ok: true });
    });
  });
}

// Known dependency-manifest filenames across the ecosystems Trivy's fs scanner supports — only these
// (never the full source tree/node_modules/vendor) get pulled from the VM, since Trivy parses lock
// files directly and doesn't need installed packages present to determine versions.
const MANIFEST_FILENAMES = [
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  'requirements.txt', 'Pipfile.lock', 'poetry.lock',
  'go.mod', 'go.sum',
  'pom.xml', 'build.gradle', 'build.gradle.kts',
  'Gemfile.lock', 'composer.lock',
];
const PRUNE_DIR_NAMES = ['node_modules', '.git', 'vendor', '.venv', 'venv', 'dist', 'build', '__pycache__', '.tox'];

function shellQuoteSingle(str) {
  return `'${String(str).replace(/'/g, "'\\''")}'`;
}

function buildFindManifestsScript(scanPath) {
  const quotedPath = shellQuoteSingle(scanPath);
  const pruneExpr = PRUNE_DIR_NAMES.map((d) => `-name ${shellQuoteSingle(d)}`).join(' -o ');
  const nameExpr = MANIFEST_FILENAMES.map((n) => `-name ${shellQuoteSingle(n)}`).join(' -o ');
  return `
if [ ! -d ${quotedPath} ]; then
  echo "STATUS:path_not_found"
  exit 0
fi
echo "STATUS:ok"
find ${quotedPath} \\( -type d \\( ${pruneExpr} \\) -prune \\) -o -type f \\( ${nameExpr} \\) -print
`.trim();
}

function parseFindManifestsOutput(stdout) {
  const lines = String(stdout || '').split('\n');
  const status = /^STATUS:(\S+)/.exec(lines[0] || '')?.[1] || 'error';
  if (status !== 'ok') return { status, files: [] };
  return { status: 'ok', files: lines.slice(1).map((l) => l.trim()).filter(Boolean) };
}

function runLocalTrivyScan(dir) {
  return new Promise((resolve) => {
    execFile(
      LOCAL_TRIVY_BIN,
      ['fs', '--cache-dir', LOCAL_TRIVY_CACHE_DIR, '--format', 'json', '--scanners', 'vuln', '--quiet', dir],
      { timeout: 120000, maxBuffer: 20 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) return resolve({ status: 'error', findings: [] });
        resolve(parseTrivyScanOutput(`STATUS:ok\n${stdout}`));
      }
    );
  });
}

// Pure, testable: splits a "STATUS:ok\n{...trivy json...}" string into { status, findings }. Real Trivy JSON
// confirmed (live scan against a real npm project): top-level `Results` is entirely ABSENT (not an
// empty array) when nothing scannable is found — every access below defaults defensively rather than
// assuming the key exists.
function parseTrivyScanOutput(stdout) {
  const status = /^STATUS:(\S+)/m.exec(stdout || '')?.[1] || 'error';
  if (status !== 'ok') return { status, findings: [] };
  const jsonStart = (stdout || '').indexOf('{');
  if (jsonStart === -1) return { status: 'ok', findings: [] }; // no dependency manifests found at this path — not an error
  let data;
  try {
    data = JSON.parse(stdout.slice(jsonStart));
  } catch {
    return { status: 'parse_error', findings: [] };
  }
  const findings = [];
  for (const result of data.Results || []) {
    for (const v of result.Vulnerabilities || []) {
      findings.push({
        targetFile: result.Target || null,
        ecosystem: result.Type || null,
        packageName: v.PkgName,
        packageVersion: v.InstalledVersion,
        vulnId: v.VulnerabilityID,
        summary: v.Title || null,
        details: v.Description ? String(v.Description).slice(0, 4000) : null,
        severity: String(v.Severity || 'unknown').toLowerCase(),
        referenceUrl: v.PrimaryURL || (Array.isArray(v.References) ? v.References[0] : null) || null,
        fixedVersion: v.FixedVersion || null,
      });
    }
  }
  return { status: 'ok', findings };
}

function toSqlDatetime(date) {
  return date.toLocaleString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' });
}

const upsertFinding = db.prepare(`
  INSERT INTO trivy_findings (vm_id, vm_name, target_file, ecosystem, package_name, package_version, vuln_id, summary, details, severity, reference_url, fixed_version, in_kev, epss_score, epss_percentile, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  ON DUPLICATE KEY UPDATE package_version = VALUES(package_version), summary = VALUES(summary),
    details = VALUES(details), severity = VALUES(severity), reference_url = VALUES(reference_url),
    fixed_version = VALUES(fixed_version), in_kev = VALUES(in_kev), epss_score = VALUES(epss_score),
    epss_percentile = VALUES(epss_percentile), last_seen = CURRENT_TIMESTAMP, resolved_at = NULL
`);
const resolveStaleFindings = db.prepare(`
  UPDATE trivy_findings SET resolved_at = CURRENT_TIMESTAMP WHERE vm_id = ? AND resolved_at IS NULL AND last_seen < ?
`);
const setVmStatus = db.prepare(`
  UPDATE vcenter_vms SET trivy_scan_status = ?, trivy_scan_error = ?, trivy_last_scanned_at = CURRENT_TIMESTAMP, trivy_package_count = ?
  WHERE id = ?
`);
async function raiseTrivyAlert(vm, finding) {
  const already = await db.prepare(`
    SELECT id FROM alerts WHERE metric = 'trivy_finding' AND source_type = 'vcenter_vm' AND source_id = ? AND metric_value = ? AND status = 'open'
  `).get(vm.id, `${finding.package_name}:${finding.vuln_id}`);
  if (already) return;
  // Same reasoning as vuln-scanner.js's raiseVulnAlert: a CISA KEV listing forces 'critical'
  // regardless of Trivy's own severity, since active exploitation trumps any static rating.
  const alertSeverity = finding.inKev ? 'critical' : finding.severity;
  const kevPrefix = finding.inKev ? '[CISA KEV — đang bị khai thác thực tế] ' : '';
  await db.prepare(`
    INSERT INTO alerts (category, severity, title, message, source_type, source_id, source_name, metric, metric_value, status)
    VALUES ('security', ?, ?, ?, 'vcenter_vm', ?, ?, 'trivy_finding', ?, 'open')
  `).run(
    alertSeverity,
    `${kevPrefix}Phát hiện lỗ hổng trong mã nguồn ứng dụng (${finding.severity})`,
    `Package "${finding.package_name}" (${finding.package_version}, ${finding.ecosystem || '?'} — ${finding.target_file || '?'}) trên VM "${vm.name}" dính lỗ hổng ${finding.vuln_id}${finding.summary ? `: ${finding.summary.slice(0, 200)}` : ''}${finding.fixed_version ? ` — nâng cấp lên phiên bản ${finding.fixed_version}` : ''}`,
    vm.id, vm.name, `${finding.package_name}:${finding.vuln_id}`
  );
}

// Downloads each found manifest file into tempDir, mirroring its path relative to scanPath (so
// Trivy's own `Target` field in the JSON output, relative to the dir we hand it, lines up with the
// real path on the VM once prefixed back in scanVm below). Skips anything find could report outside
// scanPath (shouldn't happen — find is scoped under it — but defensive against writing outside tempDir).
async function pullManifestFiles(ssh, scanPath, files, tempDir) {
  const base = scanPath.replace(/\/+$/, '');
  let pulled = 0;
  for (const remoteFile of files) {
    const rel = path.posix.relative(base, remoteFile);
    if (rel.startsWith('..')) continue;
    const localFile = path.join(tempDir, rel);
    await fsp.mkdir(path.dirname(localFile), { recursive: true });
    await ssh.getFile(localFile, remoteFile);
    pulled++;
  }
  return pulled;
}

async function scanVm(vm) {
  const opts = await sshCredentials.buildConnectOptions(vm);
  if (!opts) { await setVmStatus.run('error', 'Chưa gán tài khoản kết nối SSH', null, vm.id); return; }
  if (!vm.trivy_scan_path) { await setVmStatus.run('error', 'Chưa cấu hình đường dẫn quét', null, vm.id); return; }
  if (!(await isLocalTrivyInstalled())) {
    await setVmStatus.run('error', 'Trivy chưa được cài trên máy chủ netadmin-pro — vào đầu trang "Quét mã nguồn (Trivy)" để cài đặt', null, vm.id);
    return;
  }
  const scanPath = vm.trivy_scan_path.replace(/\/+$/, '') || vm.trivy_scan_path;
  const ssh = new NodeSSH();
  const scanStartedAt = toSqlDatetime(new Date());
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'netadmin-trivy-'));
  try {
    await ssh.connect(opts);
    const findResult = await ssh.execCommand(buildFindManifestsScript(scanPath));
    const { status: findStatus, files } = parseFindManifestsOutput(findResult.stdout);
    if (findStatus === 'path_not_found') { await setVmStatus.run('error', `Không tìm thấy thư mục "${vm.trivy_scan_path}" trên VM`, null, vm.id); return; }
    if (!files.length) {
      // No dependency manifest anywhere under scanPath — not an error, just nothing to report.
      await resolveStaleFindings.run(vm.id, scanStartedAt);
      await setVmStatus.run('ok', null, 0, vm.id);
      return;
    }

    await pullManifestFiles(ssh, scanPath, files, tempDir);
    await fsp.mkdir(LOCAL_TRIVY_CACHE_DIR, { recursive: true });
    const { status, findings } = await runLocalTrivyScan(tempDir);
    if (status !== 'ok') { await setVmStatus.run('error', `Lỗi khi Trivy quét cục bộ trên máy chủ (trạng thái: ${status})`, null, vm.id); return; }
    for (const f of findings) f.targetFile = f.targetFile ? path.posix.join(scanPath, f.targetFile) : scanPath;

    const cveIdsThisScan = findings.map((f) => f.vulnId).filter((id) => /^CVE-\d{4}-\d+/.test(id));
    const [kevSet, epssScores] = await Promise.all([
      vulnEnrichment.getKevSet(),
      vulnEnrichment.queryEpssBatch(cveIdsThisScan),
    ]);

    for (const f of findings) {
      const inKev = kevSet.has(f.vulnId);
      const epss = epssScores.get(f.vulnId);
      await upsertFinding.run(
        vm.id, vm.name, f.targetFile, f.ecosystem, f.packageName, f.packageVersion, f.vulnId,
        f.summary, f.details, f.severity, f.referenceUrl, f.fixedVersion,
        inKev ? 1 : 0, epss?.score ?? null, epss?.percentile ?? null
      );
      if (ALERT_SEVERITIES.has(f.severity) || inKev) {
        await raiseTrivyAlert(vm, {
          package_name: f.packageName, package_version: f.packageVersion, vuln_id: f.vulnId,
          summary: f.summary, severity: f.severity, ecosystem: f.ecosystem, target_file: f.targetFile,
          fixed_version: f.fixedVersion, inKev,
        });
      }
    }
    await resolveStaleFindings.run(vm.id, scanStartedAt);
    await setVmStatus.run('ok', null, findings.length, vm.id);
  } catch (e) {
    await setVmStatus.run('error', e.message, null, vm.id);
    console.error(`[trivy-scanner] ${vm.name} (${vm.ip_address}): ${e.message}`);
  } finally {
    ssh.dispose();
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Read-only reconnaissance for the "chọn đường dẫn" dropdown in the UI — most apps this admin runs
// live directly under /opt or /data (confirmed by the user), so rather than making them type a path
// from memory, list what's actually there and let them pick. No user input reaches this command (the
// two base dirs are hardcoded), so no shell-escaping is needed the way buildFindManifestsScript needs it.
const DISCOVER_PATHS_SCRIPT = `
for base in /opt /data; do
  if [ -d "$base" ]; then
    find "$base" -mindepth 1 -maxdepth 1 -type d 2>/dev/null
  fi
done
`.trim();

function parseDiscoverPathsOutput(stdout) {
  const lines = String(stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
  return [...new Set(lines)].sort();
}

async function discoverPaths(vm) {
  const opts = await sshCredentials.buildConnectOptions(vm);
  if (!opts) throw new Error('Chưa gán tài khoản kết nối SSH');
  const ssh = new NodeSSH();
  try {
    await ssh.connect(opts);
    const result = await ssh.execCommand(DISCOVER_PATHS_SCRIPT);
    return { paths: parseDiscoverPathsOutput(result.stdout) };
  } finally {
    ssh.dispose();
  }
}

async function collectAll() {
  // trivy_scan_mode = 'manual' VMs excluded here, same reasoning as vuln-scanner.js's collectAll —
  // only ever scanned via the explicit "Quét ngay" route.
  const due = await db.prepare(`
    SELECT id, name, ip_address, ssh_credential_id, ssh_port, trivy_scan_path FROM vcenter_vms
    WHERE trivy_scan_enabled = 1 AND trivy_scan_mode = 'auto' AND ssh_credential_id IS NOT NULL
      AND ip_address IS NOT NULL AND ip_address != '' AND trivy_scan_path IS NOT NULL AND trivy_scan_path != ''
      AND power_state = 'POWERED_ON' AND (guest_family IS NULL OR guest_family = 'LINUX')
      AND (trivy_last_scanned_at IS NULL OR trivy_last_scanned_at <= DATE_SUB(NOW(), INTERVAL ${SCAN_INTERVAL_HOURS} HOUR))
  `).all();
  if (!due.length) return;
  for (const vm of due) await scanVm(vm); // sequential — same reasoning as vuln-scanner.js's collectAll
}

function start(intervalMs = TICK_MS) {
  const tick = () => collectAll().catch((e) => console.error('[trivy-scanner] Lỗi:', e.message));
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = {
  start, collectAll, scanVm, discoverPaths,
  isLocalTrivyInstalled, installLocalTrivy,
  parseTrivyScanOutput, buildFindManifestsScript, parseFindManifestsOutput,
  parseDiscoverPathsOutput, DISCOVER_PATHS_SCRIPT,
  LOCAL_TRIVY_DIR, LOCAL_TRIVY_BIN, LOCAL_TRIVY_CACHE_DIR,
};
