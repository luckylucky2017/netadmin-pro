// Package-level vulnerability scanning, per VM opted in (vcenter_vms.vuln_scan_enabled) — pulls the
// installed package list via SSH (dpkg for Debian/Ubuntu; RPM-based distros aren't supported yet,
// see buildEcosystem below for why) and matches it against OSV.dev (https://osv.dev), a free, public,
// no-API-key vulnerability database aggregating CVEs plus distro-specific advisories (Ubuntu Security
// Notices, Debian Security Advisories, etc.). Modeled on the same SSH-collector shape as
// ssh-security-collector.js/nginx-waf-collector.js, but runs far less often — package versions change
// on the order of days/weeks, not seconds, so this uses its own "due" polling pattern (like
// uptime-collector.js's check_interval_sec) rather than the ~30-60s cadence of the security collectors.
const { NodeSSH } = require('node-ssh');
const db = require('./database');
const sshCredentials = require('./ssh-credentials');

const OSV_API = 'https://api.osv.dev/v1';
const OSV_BATCH_CHUNK = 500; // OSV's documented batch limit is 1000 queries/request — chunk well under that
const SCAN_INTERVAL_HOURS = 12; // how often each VM is actually rescanned
const TICK_MS = 30 * 60 * 1000; // how often collectAll checks "who's due" — cheap DB query, not a full scan
const ALERT_SEVERITIES = new Set(['critical', 'high']); // only these raise a standing alert — most real CVEs on any system are low/medium noise

// Detects the package manager, captures /etc/os-release's ID/VERSION_ID, and dumps every installed
// package as "name|version" — no sudo needed for either dpkg-query or rpm (both read local package
// DBs any user can access). \${Package}/\${Version} are dpkg-query's OWN format placeholders, not JS
// template interpolation — the backslash is required here or Node would try to evaluate them as JS
// variables before the string ever reaches the remote shell.
const SCAN_SCRIPT = `
. /etc/os-release 2>/dev/null
echo "OSID:$ID"
echo "OSVER:$VERSION_ID"
if command -v dpkg-query >/dev/null 2>&1; then
  echo "FAMILY:debian"
  echo "===PACKAGES==="
  dpkg-query -W -f='\${Package}|\${Version}\\n' 2>/dev/null
elif command -v rpm >/dev/null 2>&1; then
  echo "FAMILY:rpm"
  echo "===PACKAGES==="
  rpm -qa --queryformat '%{NAME}|%{VERSION}-%{RELEASE}\\n' 2>/dev/null
else
  echo "FAMILY:unknown"
fi
`.trim();

// Pure, testable: splits SCAN_SCRIPT's stdout into { family, osId, osVersion, packages }.
function parseScanOutput(stdout) {
  const family = /^FAMILY:(\S+)/m.exec(stdout)?.[1] || 'unknown';
  const osId = /^OSID:(\S+)/m.exec(stdout)?.[1] || null;
  const osVersion = /^OSVER:"?([^"\n]+)"?/m.exec(stdout)?.[1] || null;
  const packages = [];
  const idx = stdout.indexOf('===PACKAGES===');
  if (idx !== -1) {
    for (const raw of stdout.slice(idx + '===PACKAGES==='.length).split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const sep = line.indexOf('|');
      if (sep === -1) continue;
      const name = line.slice(0, sep).trim();
      const version = line.slice(sep + 1).trim();
      if (name && version) packages.push({ name, version });
    }
  }
  return { family, osId, osVersion, packages };
}

// Pure, testable: OSV.dev's ecosystem strings are version-suffixed ("Ubuntu:24.04", "Debian:12") —
// only Debian/Ubuntu are mapped here. RPM-based distros (RHEL/CentOS/Rocky/Alma/Fedora) have
// meaningfully weaker/inconsistent OSV.dev ecosystem coverage; returning null here (rather than
// guessing an ecosystem string that would silently return zero/wrong results) makes scanVm report an
// honest "not supported yet" instead of a scan that always comes back clean for the wrong reason.
function buildEcosystem(osId, osVersion) {
  if (!osId || !osVersion) return null;
  const map = { ubuntu: 'Ubuntu', debian: 'Debian' };
  const name = map[osId.toLowerCase()];
  return name ? `${name}:${osVersion}` : null;
}

// Batch-queries OSV.dev for every package at once (chunked), returning only the packages that had at
// least one hit — { name, version, vulnIds }. The batch endpoint deliberately returns minimal data
// (id + modified date only, see OSV's own docs) to keep it cheap for large package lists; full
// details are fetched separately, only for the (much smaller) set of distinct IDs actually found.
async function queryOsvBatch(packages, ecosystem) {
  const hits = [];
  for (let i = 0; i < packages.length; i += OSV_BATCH_CHUNK) {
    const chunk = packages.slice(i, i + OSV_BATCH_CHUNK);
    const body = { queries: chunk.map((p) => ({ package: { name: p.name, ecosystem }, version: p.version })) };
    const res = await fetch(`${OSV_API}/querybatch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`OSV querybatch HTTP ${res.status}`);
    const data = await res.json();
    for (let j = 0; j < chunk.length; j++) {
      const vulnIds = (data.results?.[j]?.vulns || []).map((v) => v.id);
      if (vulnIds.length) hits.push({ ...chunk[j], vulnIds });
    }
  }
  return hits;
}

async function fetchVulnDetail(id) {
  const res = await fetch(`${OSV_API}/vulns/${encodeURIComponent(id)}`);
  if (!res.ok) return null;
  return res.json();
}

// Pure, testable: prefers a distro-provided categorical rating (Ubuntu Security Notices/Debian
// Security Tracker entries carry one, e.g. {type:"Ubuntu", score:"low"}) over parsing a raw CVSS
// vector string ourselves ({type:"CVSS_V3", score:"CVSS:3.1/AV:N/..."}) — full CVSS-to-severity-
// bucket math is a well-defined but nontrivial formula, and the distro's own human-assigned rating is
// both simpler and, for exactly the distro this package belongs to, arguably more relevant than a
// generic upstream CVSS score anyway. Falls back to 'unknown' rather than guessing when neither is present.
function extractSeverity(detail) {
  const entries = detail?.severity || [];
  // Match any CVSS_* type generically (V2/V3/V4 confirmed to exist in real OSV.dev data, and OSV may
  // add further versions later) rather than enumerating specific version strings — an exact-version
  // exclusion list is exactly the kind of check that silently breaks the next time a new CVSS
  // version shows up (confirmed against a real UBUNTU-CVE-2023-20585 entry during testing: a
  // CVSS_V4 vector slipped through an earlier V2/V3-only exclusion list and got stored as the
  // "severity", overflowing the VARCHAR(20) column since a raw vector string is much longer than a
  // one-word rating like "low"/"high").
  const distro = entries.find((s) => !String(s.type || '').startsWith('CVSS_'));
  if (distro?.score) return String(distro.score).toLowerCase().slice(0, 20);
  return 'unknown';
}

function toSqlDatetime(date) {
  return date.toLocaleString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' });
}

const upsertFinding = db.prepare(`
  INSERT INTO vuln_findings (vm_id, vm_name, package_name, package_version, vuln_id, summary, severity, reference_url, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  ON DUPLICATE KEY UPDATE package_version = VALUES(package_version), summary = VALUES(summary),
    severity = VALUES(severity), reference_url = VALUES(reference_url), last_seen = CURRENT_TIMESTAMP,
    resolved_at = NULL
`);
const resolveStaleFindings = db.prepare(`
  UPDATE vuln_findings SET resolved_at = CURRENT_TIMESTAMP
  WHERE vm_id = ? AND resolved_at IS NULL AND last_seen < ?
`);
const setVmStatus = db.prepare(`
  UPDATE vcenter_vms SET vuln_scan_status = ?, vuln_scan_error = ?, vuln_last_scanned_at = CURRENT_TIMESTAMP, vuln_package_count = ?
  WHERE id = ?
`);

async function raiseVulnAlert(vm, finding) {
  const already = await db.prepare(`
    SELECT id FROM alerts WHERE metric = 'vuln_finding' AND source_type = 'vcenter_vm' AND source_id = ? AND metric_value = ? AND status = 'open'
  `).get(vm.id, `${finding.package_name}:${finding.vuln_id}`);
  if (already) return;
  await db.prepare(`
    INSERT INTO alerts (category, severity, title, message, source_type, source_id, source_name, metric, metric_value, status)
    VALUES ('security', 'critical', ?, ?, 'vcenter_vm', ?, ?, 'vuln_finding', ?, 'open')
  `).run(
    `Phát hiện lỗ hổng bảo mật (${finding.severity})`,
    `Package "${finding.package_name}" (${finding.package_version}) trên VM "${vm.name}" dính lỗ hổng ${finding.vuln_id}${finding.summary ? `: ${finding.summary.slice(0, 200)}` : ''}`,
    vm.id, vm.name, `${finding.package_name}:${finding.vuln_id}`
  );
}

async function scanVm(vm, detailCache) {
  const opts = await sshCredentials.buildConnectOptions(vm);
  if (!opts) { await setVmStatus.run('error', 'Chưa gán tài khoản kết nối SSH', null, vm.id); return; }
  const ssh = new NodeSSH();
  const scanStartedAt = toSqlDatetime(new Date());
  try {
    await ssh.connect(opts);
    const result = await ssh.execCommand(SCAN_SCRIPT);
    const { family, osId, osVersion, packages } = parseScanOutput(result.stdout);
    if (family === 'unknown' || !packages.length) {
      await setVmStatus.run('error', 'Không xác định được trình quản lý gói (dpkg/rpm) trên VM này', 0, vm.id);
      return;
    }
    const ecosystem = buildEcosystem(osId, osVersion);
    if (!ecosystem) {
      await setVmStatus.run('unsupported_os', `Chưa hỗ trợ quét lỗ hổng cho hệ điều hành "${osId || '?'} ${osVersion || ''}" (hiện chỉ hỗ trợ Ubuntu/Debian)`, packages.length, vm.id);
      return;
    }

    const hits = await queryOsvBatch(packages, ecosystem);
    for (const hit of hits) {
      for (const vulnId of hit.vulnIds) {
        let detail = detailCache.get(vulnId);
        if (detail === undefined) {
          detail = await fetchVulnDetail(vulnId);
          detailCache.set(vulnId, detail);
        }
        const summary = detail?.summary || detail?.details?.slice(0, 500) || null;
        const severity = extractSeverity(detail);
        const referenceUrl = detail?.references?.[0]?.url || null;
        await upsertFinding.run(vm.id, vm.name, hit.name, hit.version, vulnId, summary, severity, referenceUrl);
        if (ALERT_SEVERITIES.has(severity)) await raiseVulnAlert(vm, { package_name: hit.name, package_version: hit.version, vuln_id: vulnId, summary, severity });
      }
    }
    await resolveStaleFindings.run(vm.id, scanStartedAt);
    await setVmStatus.run('ok', null, packages.length, vm.id);
  } catch (e) {
    await setVmStatus.run('error', e.message, null, vm.id);
    console.error(`[vuln-scanner] ${vm.name} (${vm.ip_address}): ${e.message}`);
  } finally {
    ssh.dispose();
  }
}

async function collectAll() {
  // vuln_scan_mode = 'manual' VMs are deliberately excluded here — they're only ever scanned via the
  // explicit "Quét ngay" route handler (routes/vuln.js), never on this automatic due-check schedule.
  const due = await db.prepare(`
    SELECT id, name, ip_address, ssh_credential_id, ssh_port FROM vcenter_vms
    WHERE vuln_scan_enabled = 1 AND vuln_scan_mode = 'auto' AND ssh_credential_id IS NOT NULL AND ip_address IS NOT NULL AND ip_address != ''
      AND power_state = 'POWERED_ON' AND (guest_family IS NULL OR guest_family = 'LINUX')
      AND (vuln_last_scanned_at IS NULL OR vuln_last_scanned_at <= DATE_SUB(NOW(), INTERVAL ${SCAN_INTERVAL_HOURS} HOUR))
  `).all();
  if (!due.length) return;
  // Shared across all due VMs in this tick — many VMs likely share the same OS version and a lot of
  // overlapping packages, so this avoids redundant /vulns/{id} detail fetches for the same finding.
  const detailCache = new Map();
  for (const vm of due) await scanVm(vm, detailCache); // sequential, not allSettled — OSV.dev is a shared external API, no need to hammer it with concurrent VMs
}

function start(intervalMs = TICK_MS) {
  const tick = () => collectAll().catch((e) => console.error('[vuln-scanner] Lỗi:', e.message));
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = {
  start, collectAll, scanVm,
  parseScanOutput, buildEcosystem, queryOsvBatch, fetchVulnDetail, extractSeverity,
};
