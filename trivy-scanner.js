// Application-level vulnerability scanning via Trivy (https://trivy.dev), per VM opted in — two
// independent scan types, both reusing the same central install (vcenter_vms.trivy_scan_enabled for
// filesystem dependency manifests like package-lock.json/requirements.txt/go.sum, and
// trivy_docker_enabled for Docker images) — complements vuln-scanner.js's OS-package scanning
// (dpkg/apt via OSV.dev).
//
// Architecture: Trivy itself is installed ONCE, locally on the netadmin-pro host (into
// LOCAL_TRIVY_DIR below — no sudo, since the app already owns that directory) — NOT on every target
// VM. Both `trivy fs` and `trivy image` need local filesystem access to what they scan, so for each
// VM this module SSHes in with the credential already configured for that VM (the same one used for
// every other collector) and PULLS just what's needed rather than running trivy remotely:
//   - Filesystem scan: `find`s just the dependency manifest files under trivy_scan_path (never the
//     whole tree/node_modules/vendor), pulls them via SFTP into a local temp dir mirroring the
//     remote relative structure, scans that dir locally.
//   - Docker scan: lists the images backing currently RUNNING containers only (not every image on
//     the host — running images are what's actually exposed; scanning every unused/stale image would
//     be slow and bandwidth-heavy for comparatively little value), `docker save`s each one to a
//     remote tarball, pulls it via SFTP, scans it locally, deletes both the remote and local tarball.
// Net effect either way: target VMs need zero Trivy installation. The filesystem scan needs zero sudo
// too; the Docker scan needs the SSH user to have Docker access (docker group membership, or
// passwordless sudo for the docker command — same NOPASSWD sudoers convention used elsewhere in this
// app), since only root/the docker group can talk to the Docker socket.
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

// A process-wide mutex serializing every `trivy` invocation — fs scans, docker scans here, AND
// harbor-scanner.js's registry scans all share the same --cache-dir, and this app runs each scan
// type's collectAll() as its OWN independent setInterval loop (see server.js), so two of them can
// genuinely fire around the same moment with no coordination between them. Found via real testing:
// two trivy processes touching that cache directory concurrently don't just contend/slow down, one
// fails outright ("cache may be in use by another process: timeout"). Every caller funnels through
// runExclusive so only one `trivy` process ever runs at a time, regardless of which scanner
// triggered it — a queue, not a "reject if busy", so a scan-now click during an automatic sweep
// still eventually runs rather than erroring.
let trivyLockChain = Promise.resolve();
function runExclusive(fn) {
  const run = trivyLockChain.then(fn, fn);
  trivyLockChain = run.then(() => {}, () => {});
  return run;
}

// Shared by both `trivy fs <dir>` and `trivy image --input <tar>` — caller supplies the full argv
// (subcommand onward) since the two scan types differ beyond just the target argument.
function runLocalTrivyScan(args) {
  return runExclusive(() => new Promise((resolve) => {
    execFile(
      LOCAL_TRIVY_BIN, args,
      { timeout: 180000, maxBuffer: 20 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) return resolve({ status: 'error', findings: [] });
        resolve(parseTrivyScanOutput(`STATUS:ok\n${stdout}`));
      }
    );
  }));
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

// scan_type ('fs'|'docker') is part of the unique key (see database.js migration) so a filesystem
// finding and a docker-image finding can't collide even if they happen to share vm_id/target_file/
// package_name/vuln_id (e.g. an image containing a file at the same relative path already found via
// the fs scan) — and so resolveStaleFindings below can resolve one scan type without touching the
// other's findings when a VM has only one of the two enabled.
const upsertFinding = db.prepare(`
  INSERT INTO trivy_findings (vm_id, vm_name, scan_type, target_file, ecosystem, package_name, package_version, vuln_id, summary, details, severity, reference_url, fixed_version, in_kev, epss_score, epss_percentile, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  ON DUPLICATE KEY UPDATE package_version = VALUES(package_version), summary = VALUES(summary),
    details = VALUES(details), severity = VALUES(severity), reference_url = VALUES(reference_url),
    fixed_version = VALUES(fixed_version), in_kev = VALUES(in_kev), epss_score = VALUES(epss_score),
    epss_percentile = VALUES(epss_percentile), last_seen = CURRENT_TIMESTAMP, resolved_at = NULL
`);
const resolveStaleFindings = db.prepare(`
  UPDATE trivy_findings SET resolved_at = CURRENT_TIMESTAMP WHERE vm_id = ? AND scan_type = ? AND resolved_at IS NULL AND last_seen < ?
`);
const setVmStatus = db.prepare(`
  UPDATE vcenter_vms SET trivy_scan_status = ?, trivy_scan_error = ?, trivy_last_scanned_at = CURRENT_TIMESTAMP, trivy_package_count = ?
  WHERE id = ?
`);
const setDockerVmStatus = db.prepare(`
  UPDATE vcenter_vms SET trivy_docker_scan_status = ?, trivy_docker_scan_error = ?, trivy_docker_last_scanned_at = CURRENT_TIMESTAMP, trivy_docker_image_count = ?
  WHERE id = ?
`);
// sourceType defaults to 'vcenter_vm' for this module's own fs/docker scans; harbor-scanner.js
// passes 'harbor_repo' explicitly and a {id, name} shaped like a harbor_repos row instead of a real
// VM — this function only ever reads .id/.name off `source`, so it works unmodified either way.
async function raiseTrivyAlert(source, finding, sourceType = 'vcenter_vm') {
  const already = await db.prepare(`
    SELECT id FROM alerts WHERE metric = 'trivy_finding' AND source_type = ? AND source_id = ? AND metric_value = ? AND status = 'open'
  `).get(sourceType, source.id, `${finding.package_name}:${finding.vuln_id}`);
  if (already) return;
  // Same reasoning as vuln-scanner.js's raiseVulnAlert: a CISA KEV listing forces 'critical'
  // regardless of Trivy's own severity, since active exploitation trumps any static rating.
  const alertSeverity = finding.inKev ? 'critical' : finding.severity;
  const kevPrefix = finding.inKev ? '[CISA KEV — đang bị khai thác thực tế] ' : '';
  await db.prepare(`
    INSERT INTO alerts (category, severity, title, message, source_type, source_id, source_name, metric, metric_value, status)
    VALUES ('security', ?, ?, ?, ?, ?, ?, 'trivy_finding', ?, 'open')
  `).run(
    alertSeverity,
    `${kevPrefix}Phát hiện lỗ hổng trong mã nguồn ứng dụng (${finding.severity})`,
    `Package "${finding.package_name}" (${finding.package_version}, ${finding.ecosystem || '?'} — ${finding.target_file || '?'}) trên "${source.name}" dính lỗ hổng ${finding.vuln_id}${finding.summary ? `: ${finding.summary.slice(0, 200)}` : ''}${finding.fixed_version ? ` — nâng cấp lên phiên bản ${finding.fixed_version}` : ''}`,
    sourceType, source.id, source.name, `${finding.package_name}:${finding.vuln_id}`
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

// Shared by all scan types (fs/docker here, harbor-scanner.js's registry scan too): enrich with
// KEV/EPSS, upsert, alert on critical/high/KEV findings. `source` just needs {id, name} — see
// raiseTrivyAlert's comment on why a harbor_repos row works here unmodified.
async function enrichAndStoreFindings(source, scanType, findings, sourceType = 'vcenter_vm') {
  const cveIdsThisScan = findings.map((f) => f.vulnId).filter((id) => /^CVE-\d{4}-\d+/.test(id));
  const [kevSet, epssScores] = await Promise.all([
    vulnEnrichment.getKevSet(),
    vulnEnrichment.queryEpssBatch(cveIdsThisScan),
  ]);
  for (const f of findings) {
    const inKev = kevSet.has(f.vulnId);
    const epss = epssScores.get(f.vulnId);
    await upsertFinding.run(
      source.id, source.name, scanType, f.targetFile, f.ecosystem, f.packageName, f.packageVersion, f.vulnId,
      f.summary, f.details, f.severity, f.referenceUrl, f.fixedVersion,
      inKev ? 1 : 0, epss?.score ?? null, epss?.percentile ?? null
    );
    if (ALERT_SEVERITIES.has(f.severity) || inKev) {
      await raiseTrivyAlert(source, {
        package_name: f.packageName, package_version: f.packageVersion, vuln_id: f.vulnId,
        summary: f.summary, severity: f.severity, ecosystem: f.ecosystem, target_file: f.targetFile,
        fixed_version: f.fixedVersion, inKev,
      }, sourceType);
    }
  }
}

async function scanFilesystem(vm) {
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
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'netadmin-trivy-fs-'));
  try {
    await ssh.connect(opts);
    const findResult = await ssh.execCommand(buildFindManifestsScript(scanPath));
    const { status: findStatus, files } = parseFindManifestsOutput(findResult.stdout);
    if (findStatus === 'path_not_found') { await setVmStatus.run('error', `Không tìm thấy thư mục "${vm.trivy_scan_path}" trên VM`, null, vm.id); return; }
    if (!files.length) {
      // No dependency manifest anywhere under scanPath — not an error, just nothing to report.
      await resolveStaleFindings.run(vm.id, 'fs', scanStartedAt);
      await setVmStatus.run('ok', null, 0, vm.id);
      return;
    }

    await pullManifestFiles(ssh, scanPath, files, tempDir);
    await fsp.mkdir(LOCAL_TRIVY_CACHE_DIR, { recursive: true });
    const { status, findings } = await runLocalTrivyScan(['fs', '--cache-dir', LOCAL_TRIVY_CACHE_DIR, '--format', 'json', '--scanners', 'vuln', '--quiet', tempDir]);
    if (status !== 'ok') { await setVmStatus.run('error', `Lỗi khi Trivy quét cục bộ trên máy chủ (trạng thái: ${status})`, null, vm.id); return; }
    for (const f of findings) f.targetFile = f.targetFile ? path.posix.join(scanPath, f.targetFile) : scanPath;

    await enrichAndStoreFindings(vm, 'fs', findings);
    await resolveStaleFindings.run(vm.id, 'fs', scanStartedAt);
    await setVmStatus.run('ok', null, findings.length, vm.id);
  } catch (e) {
    await setVmStatus.run('error', e.message, null, vm.id);
    console.error(`[trivy-scanner] ${vm.name} (${vm.ip_address}): ${e.message}`);
  } finally {
    ssh.dispose();
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Docker image scanning ───────────────────────────────────────────────────────────────────────
// Scope is deliberately fixed to images backing currently RUNNING containers — not every image on
// the host (`docker images`) — per the admin's own call: unused/stale images cost real scan
// time/bandwidth (image tarballs are MBs–GBs, not the KB-sized lockfiles the fs scan pulls) for
// comparatively little security value versus what's actually exposed right now.
const MAX_DOCKER_IMAGES_PER_SCAN = 30; // safety valve against a host with an unusually large fleet of distinct running images

// Tries a plain `docker` command first, falls back to `sudo -n docker` (NOPASSWD) if the SSH user
// isn't in the docker group — mirrors the try-then-sudo-fallback pattern used for reading logs
// elsewhere in this app. Deliberately does NOT pipe through `sort`/other commands before checking the
// exit code — piping would report the pipeline's LAST command's exit status, silently masking a
// `docker` permission failure as success. Dedup happens in parseDockerListOutput instead.
const DOCKER_LIST_SCRIPT = `
if ! command -v docker >/dev/null 2>&1; then
  echo "STATUS:not_installed"
  exit 0
fi
OUT=$(docker ps --format '{{.Image}}' 2>&1)
if [ $? -eq 0 ]; then
  echo "STATUS:ok"
  echo "$OUT"
  exit 0
fi
OUT=$(sudo -n docker ps --format '{{.Image}}' 2>&1)
if [ $? -eq 0 ]; then
  echo "STATUS:ok"
  echo "$OUT"
  exit 0
fi
echo "STATUS:no_access"
`.trim();

function parseDockerListOutput(stdout) {
  const lines = String(stdout || '').split('\n');
  const status = /^STATUS:(\S+)/.exec(lines[0] || '')?.[1] || 'error';
  if (status !== 'ok') return { status, images: [] };
  const images = [...new Set(lines.slice(1).map((l) => l.trim()).filter(Boolean))];
  return { status: 'ok', images };
}

// Permissive enough for repo/namespace/tag/digest characters (registry.example.com/team/app:1.2.3,
// app@sha256:...) while rejecting shell metacharacters — image names come from our own `docker ps`
// output (semi-trusted) but this still gets shell-interpolated into a remote command, so validate
// defensively rather than assume.
const DOCKER_IMAGE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.\-/:@]*$/;

const REMOTE_DOCKER_TAR_PATH = '/tmp/.netadmin-trivy-docker-save.tar';

function buildDockerSaveScript(imageName) {
  const quotedImage = shellQuoteSingle(imageName);
  const quotedTar = shellQuoteSingle(REMOTE_DOCKER_TAR_PATH);
  return `
docker save ${quotedImage} -o ${quotedTar} 2>&1 && echo "STATUS:ok" && exit 0
sudo -n docker save ${quotedImage} -o ${quotedTar} 2>&1 && echo "STATUS:ok" && exit 0
echo "STATUS:error"
`.trim();
}

function parseDockerSaveOutput(stdout) {
  return /STATUS:ok\s*$/.test(String(stdout || '').trim()) ? 'ok' : 'error';
}

const REMOTE_DOCKER_CLEANUP_SCRIPT = `rm -f ${shellQuoteSingle(REMOTE_DOCKER_TAR_PATH)}`;

// Pulls one image's tarball, scans it locally, cleans up both the local and remote copy. Returns
// { findings } on success or throws (caller decides how to record the per-image failure).
async function pullAndScanDockerImage(ssh, imageName, tempDir) {
  const saveResult = await ssh.execCommand(buildDockerSaveScript(imageName));
  if (parseDockerSaveOutput(saveResult.stdout) !== 'ok') {
    throw new Error(`Không thể xuất image "${imageName}" trên VM (cần quyền docker hoặc sudo -n docker) — ${(saveResult.stderr || saveResult.stdout || '').slice(0, 300)}`);
  }
  const localTar = path.join(tempDir, 'image.tar');
  try {
    await ssh.getFile(localTar, REMOTE_DOCKER_TAR_PATH);
    const { status, findings } = await runLocalTrivyScan([
      'image', '--input', localTar, '--cache-dir', LOCAL_TRIVY_CACHE_DIR,
      '--format', 'json', '--scanners', 'vuln', '--quiet',
    ]);
    if (status !== 'ok') throw new Error(`Lỗi khi Trivy quét image cục bộ (trạng thái: ${status})`);
    for (const f of findings) f.targetFile = f.targetFile ? `${imageName} :: ${f.targetFile}` : imageName;
    return { findings };
  } finally {
    await ssh.execCommand(REMOTE_DOCKER_CLEANUP_SCRIPT).catch(() => {});
    await fsp.rm(localTar, { force: true }).catch(() => {});
  }
}

async function scanDocker(vm) {
  const opts = await sshCredentials.buildConnectOptions(vm);
  if (!opts) { await setDockerVmStatus.run('error', 'Chưa gán tài khoản kết nối SSH', null, vm.id); return; }
  if (!(await isLocalTrivyInstalled())) {
    await setDockerVmStatus.run('error', 'Trivy chưa được cài trên máy chủ netadmin-pro — vào đầu trang "Quét mã nguồn (Trivy)" để cài đặt', null, vm.id);
    return;
  }
  const ssh = new NodeSSH();
  const scanStartedAt = toSqlDatetime(new Date());
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'netadmin-trivy-docker-'));
  try {
    await ssh.connect(opts);
    const listResult = await ssh.execCommand(DOCKER_LIST_SCRIPT);
    const { status: listStatus, images } = parseDockerListOutput(listResult.stdout);
    if (listStatus === 'not_installed') { await setDockerVmStatus.run('error', 'Docker chưa được cài đặt trên VM này', null, vm.id); return; }
    if (listStatus === 'no_access') { await setDockerVmStatus.run('error', 'Tài khoản SSH không có quyền chạy docker (cần vào nhóm docker hoặc cấu hình sudo -n docker)', null, vm.id); return; }
    if (listStatus !== 'ok') { await setDockerVmStatus.run('error', `Lỗi khi liệt kê container đang chạy (trạng thái: ${listStatus})`, null, vm.id); return; }
    if (!images.length) {
      // No running containers — not an error, just nothing to report.
      await resolveStaleFindings.run(vm.id, 'docker', scanStartedAt);
      await setDockerVmStatus.run('ok', null, 0, vm.id);
      return;
    }

    const truncated = images.length > MAX_DOCKER_IMAGES_PER_SCAN;
    const toScan = images.slice(0, MAX_DOCKER_IMAGES_PER_SCAN);
    await fsp.mkdir(LOCAL_TRIVY_CACHE_DIR, { recursive: true });

    const allFindings = [];
    const errors = [];
    for (const imageName of toScan) {
      if (!DOCKER_IMAGE_NAME_RE.test(imageName)) { errors.push(`bỏ qua tên image không hợp lệ: ${imageName}`); continue; }
      try {
        const { findings } = await pullAndScanDockerImage(ssh, imageName, tempDir);
        allFindings.push(...findings);
      } catch (e) {
        errors.push(e.message);
        console.error(`[trivy-scanner] Docker image "${imageName}" trên ${vm.name}: ${e.message}`);
      }
    }

    await enrichAndStoreFindings(vm, 'docker', allFindings);
    await resolveStaleFindings.run(vm.id, 'docker', scanStartedAt);
    const statusNote = [
      truncated ? `Đã quét ${toScan.length}/${images.length} image đang chạy (giới hạn ${MAX_DOCKER_IMAGES_PER_SCAN} mỗi lần quét)` : null,
      errors.length ? `${errors.length} image lỗi: ${errors.slice(0, 3).join('; ')}` : null,
    ].filter(Boolean).join(' — ') || null;
    const allImagesFailed = toScan.length > 0 && errors.length === toScan.length;
    await setDockerVmStatus.run(allImagesFailed ? 'error' : 'ok', statusNote, allFindings.length, vm.id);
  } catch (e) {
    await setDockerVmStatus.run('error', e.message, null, vm.id);
    console.error(`[trivy-scanner] Docker scan ${vm.name} (${vm.ip_address}): ${e.message}`);
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

async function collectAllFilesystem() {
  // trivy_scan_mode = 'manual' VMs excluded here, same reasoning as vuln-scanner.js's collectAll —
  // only ever scanned via the explicit "Quét ngay" route.
  const due = await db.prepare(`
    SELECT id, name, ip_address, ssh_credential_id, ssh_port, trivy_scan_path FROM vcenter_vms
    WHERE trivy_scan_enabled = 1 AND trivy_scan_mode = 'auto' AND ssh_credential_id IS NOT NULL
      AND ip_address IS NOT NULL AND ip_address != '' AND trivy_scan_path IS NOT NULL AND trivy_scan_path != ''
      AND power_state = 'POWERED_ON' AND (guest_family IS NULL OR guest_family = 'LINUX')
      AND (trivy_last_scanned_at IS NULL OR trivy_last_scanned_at <= DATE_SUB(NOW(), INTERVAL ${SCAN_INTERVAL_HOURS} HOUR))
  `).all();
  for (const vm of due) await scanFilesystem(vm); // sequential — same reasoning as vuln-scanner.js's collectAll
}

async function collectAllDocker() {
  const due = await db.prepare(`
    SELECT id, name, ip_address, ssh_credential_id, ssh_port FROM vcenter_vms
    WHERE trivy_docker_enabled = 1 AND trivy_docker_mode = 'auto' AND ssh_credential_id IS NOT NULL
      AND ip_address IS NOT NULL AND ip_address != ''
      AND power_state = 'POWERED_ON' AND (guest_family IS NULL OR guest_family = 'LINUX')
      AND (trivy_docker_last_scanned_at IS NULL OR trivy_docker_last_scanned_at <= DATE_SUB(NOW(), INTERVAL ${SCAN_INTERVAL_HOURS} HOUR))
  `).all();
  for (const vm of due) await scanDocker(vm); // sequential — same reasoning as vuln-scanner.js's collectAll
}

async function collectAll() {
  await collectAllFilesystem();
  await collectAllDocker();
}

function start(intervalMs = TICK_MS) {
  const tick = () => collectAll().catch((e) => console.error('[trivy-scanner] Lỗi:', e.message));
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = {
  start, collectAll, collectAllFilesystem, collectAllDocker,
  scanFilesystem, scanDocker, discoverPaths,
  isLocalTrivyInstalled, installLocalTrivy,
  parseTrivyScanOutput, buildFindManifestsScript, parseFindManifestsOutput,
  parseDiscoverPathsOutput, DISCOVER_PATHS_SCRIPT,
  parseDockerListOutput, buildDockerSaveScript, parseDockerSaveOutput, DOCKER_LIST_SCRIPT, DOCKER_IMAGE_NAME_RE,
  LOCAL_TRIVY_DIR, LOCAL_TRIVY_BIN, LOCAL_TRIVY_CACHE_DIR,
  // Shared with harbor-scanner.js — see enrichAndStoreFindings/raiseTrivyAlert's own comments on why
  // a harbor_repos row works here unmodified (both only ever need {id, name} off the "source"), and
  // runExclusive's own comment on why every trivy invocation across both modules must serialize.
  runLocalTrivyScan, enrichAndStoreFindings, resolveStaleFindings, runExclusive,
};
