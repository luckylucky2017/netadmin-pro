// Application-level dependency vulnerability scanning via Trivy (https://trivy.dev), per VM opted in
// (vcenter_vms.trivy_scan_enabled) — complements vuln-scanner.js's OS-package scanning (dpkg/apt via
// OSV.dev) with app-level dependency manifests (package-lock.json, requirements.txt, go.sum,
// pom.xml, etc.). Unlike OS packages, there's no single "list everything installed" for app
// dependencies — the admin must say WHERE the app source/dependency files live on each VM
// (vcenter_vms.trivy_scan_path), same reasoning as nginx-waf-collector.js needing a log path.
//
// Trivy's own VulnerabilityID is already a canonical CVE directly (confirmed against a real scan —
// no OSV-style advisory-ID remapping needed the way vuln-scanner.js's extractCanonicalCveId handles
// for Ubuntu findings), so KEV/EPSS enrichment (vuln-enrichment.js, shared with vuln-scanner.js) can
// use it as-is.
const { NodeSSH } = require('node-ssh');
const db = require('./database');
const sshCredentials = require('./ssh-credentials');
const vulnEnrichment = require('./vuln-enrichment');

const SCAN_INTERVAL_HOURS = 12;
const TICK_MS = 30 * 60 * 1000;
const ALERT_SEVERITIES = new Set(['critical', 'high']);

// Official install method (trivy.dev/latest/getting-started/installation) — a single static binary,
// no package-manager repo/GPG key to add. Downloaded to a fixed temp path first (no sudo needed, just
// network) so the actual sudo'd command is an EXACT match sudoers can whitelist precisely, rather
// than a wildcard-heavy `sudo sh -c "curl ... | sh"` that's awkward to scope safely.
const INSTALL_SCRIPT = `
curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh -o /tmp/.netadmin-trivy-install.sh 2>&1
sudo -n sh /tmp/.netadmin-trivy-install.sh -b /usr/local/bin 2>&1 || sh /tmp/.netadmin-trivy-install.sh -b /usr/local/bin 2>&1
rm -f /tmp/.netadmin-trivy-install.sh
command -v trivy >/dev/null 2>&1 && echo "INSTALL_STATUS:ok" || echo "INSTALL_STATUS:failed"
`.trim();

const SUDOERS_HINT = '<ssh_user> ALL=(ALL) NOPASSWD: /usr/bin/sh /tmp/.netadmin-trivy-install.sh *';

// STATUS: line always comes first (plain echo, before any JSON) so it can be pulled out even when
// trivy's own JSON payload follows on the same stdout stream — `--quiet` suppresses trivy's own
// progress/log noise from stdout (confirmed against a real scan: with the DB already cached, stdout
// is pure "STATUS:ok\n{...trivy json...}"), but message routing between stdout/stderr across trivy
// versions isn't something to fully trust, so the JSON parser below locates the payload by its own
// first "{" rather than assuming a fixed line count after STATUS.
function buildScanScript(scanPath) {
  const quotedPath = `'${String(scanPath).replace(/'/g, "'\\''")}'`;
  return `
if ! command -v trivy >/dev/null 2>&1; then
  echo "STATUS:not_installed"
  exit 0
fi
if [ ! -d ${quotedPath} ]; then
  echo "STATUS:path_not_found"
  exit 0
fi
echo "STATUS:ok"
trivy fs --format json --scanners vuln --quiet ${quotedPath}
`.trim();
}

// Pure, testable: splits buildScanScript's stdout into { status, findings }. Real Trivy JSON
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
const setInstallStatus = db.prepare('UPDATE vcenter_vms SET trivy_scan_status = ?, trivy_scan_error = ? WHERE id = ?');

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

async function scanVm(vm) {
  const opts = await sshCredentials.buildConnectOptions(vm);
  if (!opts) { await setVmStatus.run('error', 'Chưa gán tài khoản kết nối SSH', null, vm.id); return; }
  if (!vm.trivy_scan_path) { await setVmStatus.run('error', 'Chưa cấu hình đường dẫn quét', null, vm.id); return; }
  const ssh = new NodeSSH();
  const scanStartedAt = toSqlDatetime(new Date());
  try {
    await ssh.connect(opts);
    const result = await ssh.execCommand(buildScanScript(vm.trivy_scan_path));
    const { status, findings } = parseTrivyScanOutput(result.stdout);
    if (status === 'not_installed') { await setVmStatus.run('not_installed', 'Trivy chưa được cài đặt trên VM này', null, vm.id); return; }
    if (status === 'path_not_found') { await setVmStatus.run('error', `Không tìm thấy thư mục "${vm.trivy_scan_path}"`, null, vm.id); return; }
    if (status !== 'ok') { await setVmStatus.run('error', result.stderr || 'Lỗi không xác định khi chạy trivy', null, vm.id); return; }

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
  }
}

async function installTrivy(vm) {
  const opts = await sshCredentials.buildConnectOptions(vm);
  if (!opts) throw new Error('Chưa gán tài khoản kết nối SSH');
  await setInstallStatus.run('installing', null, vm.id);
  const ssh = new NodeSSH();
  try {
    await ssh.connect(opts);
    const result = await ssh.execCommand(INSTALL_SCRIPT);
    const ok = /INSTALL_STATUS:ok/.test(result.stdout);
    if (ok) {
      await setInstallStatus.run('unknown', null, vm.id); // confirmed 'ok' only by the next real scan
      return { ok: true };
    }
    const error = result.stderr || result.stdout || 'Cài đặt Trivy thất bại';
    await setInstallStatus.run('error', error.slice(0, 2000), vm.id);
    return { ok: false, error };
  } catch (e) {
    await setInstallStatus.run('error', e.message, vm.id);
    return { ok: false, error: e.message };
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
  start, collectAll, scanVm, installTrivy,
  parseTrivyScanOutput, buildScanScript, INSTALL_SCRIPT, SUDOERS_HINT,
};
