// Harbor registry image scanning via the same centrally-installed Trivy binary as trivy-scanner.js
// (see that file's header comment for why Trivy lives only on the netadmin-pro host, not per-target).
// This scan type needs neither SSH nor a Docker daemon at all — Trivy has its own registry client
// (go-containerregistry) and can pull an image's manifest/layers directly from any Docker Registry
// v2-compatible API (which Harbor is) over the network, authenticating with plain registry
// credentials. So the whole flow is just: ask Harbor's REST API what the latest tag of a tracked
// repository is, then run `trivy image <harbor-host>/<project>/<repo>:<tag>` locally.
//
// Scope is deliberately manual per repository (routes/harbor.js's POST /repos), not
// auto-discover-everything — a Harbor instance can host far more images than are worth tracking,
// same reasoning as the Docker running-containers-only scope in trivy-scanner.js, just decided by
// the admin explicitly picking repos instead of an automatic "what's currently in use" rule.
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { execFile } = require('child_process');
const fsp = require('fs').promises;
const db = require('./database');
const { getSettings } = require('./settings');
const trivyScanner = require('./trivy-scanner');

const SCAN_INTERVAL_HOURS = 12;
const TICK_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_PAGES = 50; // safety valve against a runaway pagination loop, not a real expected ceiling

function toSqlDatetime(date) {
  return date.toLocaleString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' });
}

// Raw http/https (not fetch) so `insecure` (self-signed certs) can be controlled per-request via
// rejectUnauthorized — same reasoning as uptime-collector.js's ignore_tls_errors handling, which
// Node's built-in fetch doesn't expose without wiring up an undici dispatcher.
function harborRequest(baseUrl, apiPath, { username, password, insecure } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(apiPath, baseUrl);
    } catch {
      return reject(new Error('URL Harbor không hợp lệ'));
    }
    const isHttps = target.protocol === 'https:';
    const lib = isHttps ? https : http;
    const auth = username ? 'Basic ' + Buffer.from(`${username}:${password || ''}`).toString('base64') : undefined;
    const options = {
      method: 'GET',
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: target.pathname + target.search,
      timeout: REQUEST_TIMEOUT_MS,
      headers: { Accept: 'application/json', ...(auth ? { Authorization: auth } : {}) },
    };
    if (isHttps) options.rejectUnauthorized = !insecure;
    const req = lib.request(options, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let json = null;
        try { json = body ? JSON.parse(body) : null; } catch { /* leave null — caller checks status first */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Timeout kết nối tới Harbor')));
    req.on('error', reject);
    req.end();
  });
}

async function getHarborConfig() {
  const s = await getSettings();
  if (!s.harbor_url) throw new Error('Chưa cấu hình kết nối Harbor');
  return { url: s.harbor_url.replace(/\/+$/, ''), username: s.harbor_username, password: s.harbor_password, insecure: !!s.harbor_insecure };
}

// Harbor's list endpoints page via ?page=&page_size= with no total-pages field — the conventional
// signal to stop is a batch smaller than the requested page_size.
async function harborPaginated(cfg, apiPath) {
  const results = [];
  const pageSize = 100;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const sep = apiPath.includes('?') ? '&' : '?';
    const r = await harborRequest(cfg.url, `${apiPath}${sep}page=${page}&page_size=${pageSize}`, cfg);
    if (r.status === 401) throw new Error('Sai username hoặc mật khẩu Harbor');
    if (r.status !== 200) throw new Error(`Harbor API lỗi (${apiPath}): HTTP ${r.status}`);
    const batch = Array.isArray(r.json) ? r.json : [];
    results.push(...batch);
    if (batch.length < pageSize) break;
  }
  return results;
}

// Deliberately NOT /api/v2.0/projects — confirmed against the real harbor.fds.vn that Harbor treats
// an invalid Basic Auth header as anonymous rather than rejecting it outright, so that endpoint
// returns 200 (showing only public projects) even with completely wrong credentials, making it
// useless as an auth check. /api/v2.0/users/current always requires a genuinely valid session/basic
// auth — confirmed it correctly 401s on bad creds against the real instance.
async function testConnection() {
  const cfg = await getHarborConfig();
  const r = await harborRequest(cfg.url, '/api/v2.0/users/current', cfg);
  if (r.status === 200) return { ok: true };
  if (r.status === 401) return { ok: false, error: 'Sai username hoặc mật khẩu Harbor' };
  return { ok: false, error: `Harbor trả về lỗi HTTP ${r.status}` };
}

// Lists every project/repository pair Harbor currently has — used by the "Dò tìm" picker in the UI
// so the admin can choose from what's actually there instead of typing project/repo names by hand.
// repo.name in Harbor's API is the combined "project/repo" string; split it back apart here so the
// picker/DB deal in the same {project_name, repo_name} shape as harbor_repos.
async function discoverRepos() {
  const cfg = await getHarborConfig();
  const projects = await harborPaginated(cfg, '/api/v2.0/projects');
  const result = [];
  for (const proj of projects) {
    const repos = await harborPaginated(cfg, `/api/v2.0/projects/${encodeURIComponent(proj.name)}/repositories`);
    for (const repo of repos) {
      const shortName = repo.name && repo.name.startsWith(`${proj.name}/`) ? repo.name.slice(proj.name.length + 1) : repo.name;
      result.push({ project_name: proj.name, repo_name: shortName, artifact_count: repo.artifact_count ?? null });
    }
  }
  return result;
}

// The tag actually worth scanning — whatever was pushed most recently. Falls back to the digest
// reference (untagged artifact) if the latest push has no tag at all, since `trivy image` accepts
// either form (repo:tag or repo@sha256:...).
//
// repo_name gets DOUBLE URL-encoded here — confirmed directly against the real harbor.fds.vn: a
// repository name containing '/' (common — many repos here are nested like
// "deployment/registry/thanhtra") needs %252F, not just %2F, or Harbor's own router 404s with
// "path ... was not found" (single-encoding gets decoded back to a literal '/' before it reaches
// Harbor's route matching). This is a documented Harbor API quirk, not something specific to this
// app's HTTP client — reproduced identically with plain curl.
async function getLatestTag(cfg, projectName, repoName) {
  const encodedRepo = encodeURIComponent(encodeURIComponent(repoName));
  const r = await harborRequest(
    cfg.url,
    `/api/v2.0/projects/${encodeURIComponent(projectName)}/repositories/${encodedRepo}/artifacts?page=1&page_size=1&sort=-push_time`,
    cfg
  );
  if (r.status !== 200 || !Array.isArray(r.json) || !r.json.length) return null;
  const artifact = r.json[0];
  const tagName = Array.isArray(artifact.tags) && artifact.tags.length ? artifact.tags[0].name : null;
  return tagName ? { ref: tagName, isDigest: false } : (artifact.digest ? { ref: artifact.digest, isDigest: true } : null);
}

// TRIVY_USERNAME/TRIVY_PASSWORD via env, never a --password CLI flag — command-line arguments are
// visible to any other user on the host via `ps aux`, exactly the reasoning already applied to the
// MySQL diagnostics run earlier this session (MYSQL_PWD env var instead of `-p`).
// 10 minutes, not trivy-scanner.js's 180s (VM-local scans there pull only small manifest files or
// a Docker-daemon-cached image) — a Harbor scan pulls the full image over the network from scratch
// every time, and a real image on the user's own instance was observed taking well over 3 minutes.
// Also captures *why* a failure happened (stderr/timeout), not just a bare "error" status — found
// during real testing that a generic status alone left no way to tell a timeout apart from an auth
// failure or a genuinely malformed image reference without re-running the command by hand.
const HARBOR_SCAN_TIMEOUT_MS = 10 * 60 * 1000;

// Wrapped in trivyScanner.runExclusive — this and trivy-scanner.js's own fs/docker scans all touch
// the same --cache-dir, and each scan type runs its own independent periodic loop (server.js), so
// without serializing across modules two of them can genuinely fire around the same moment. See
// runExclusive's own comment in trivy-scanner.js for the real failure mode this avoids.
function runTrivyImageScan(imageRef, cfg) {
  return trivyScanner.runExclusive(() => new Promise((resolve) => {
    const args = ['image', imageRef, '--cache-dir', trivyScanner.LOCAL_TRIVY_CACHE_DIR, '--format', 'json', '--scanners', 'vuln', '--quiet'];
    if (cfg.insecure) args.push('--insecure');
    const env = { ...process.env };
    if (cfg.username) env.TRIVY_USERNAME = cfg.username;
    if (cfg.password) env.TRIVY_PASSWORD = cfg.password;
    execFile(trivyScanner.LOCAL_TRIVY_BIN, args, { timeout: HARBOR_SCAN_TIMEOUT_MS, maxBuffer: 20 * 1024 * 1024, env }, (err, stdout, stderr) => {
      if (err && !stdout) {
        const detail = err.killed ? `Quá thời gian chờ (${Math.round(HARBOR_SCAN_TIMEOUT_MS / 60000)} phút) — image có thể quá lớn hoặc mạng tới Harbor chậm` : (stderr || err.message || '').slice(0, 500);
        return resolve({ status: 'error', findings: [], errorDetail: detail });
      }
      resolve(trivyScanner.parseTrivyScanOutput(`STATUS:ok\n${stdout}`));
    });
  }));
}

const setRepoStatus = db.prepare(`
  UPDATE harbor_repos SET scan_status=?, scan_error=?, last_tag=COALESCE(?, last_tag), package_count=?, last_scanned_at=CURRENT_TIMESTAMP WHERE id=?
`);

async function scanRepo(repo) {
  const fullName = `${repo.project_name}/${repo.repo_name}`;
  if (!(await trivyScanner.isLocalTrivyInstalled())) {
    await setRepoStatus.run('error', 'Trivy chưa được cài trên máy chủ netadmin-pro — vào đầu trang "Quét mã nguồn (Trivy)" để cài đặt', null, null, repo.id);
    return;
  }
  const scanStartedAt = toSqlDatetime(new Date());
  try {
    const cfg = await getHarborConfig();
    const latest = await getLatestTag(cfg, repo.project_name, repo.repo_name);
    if (!latest) {
      await setRepoStatus.run('error', 'Không tìm thấy artifact/tag nào trong repository này trên Harbor', null, null, repo.id);
      return;
    }
    const registryHost = new URL(cfg.url).host; // trivy wants host[:port]/project/repo:tag, no scheme
    const imageRef = latest.isDigest ? `${registryHost}/${fullName}@${latest.ref}` : `${registryHost}/${fullName}:${latest.ref}`;

    await fsp.mkdir(trivyScanner.LOCAL_TRIVY_CACHE_DIR, { recursive: true });
    const { status, findings, errorDetail } = await runTrivyImageScan(imageRef, cfg);
    if (status !== 'ok') {
      const message = errorDetail ? `Lỗi khi Trivy quét image trên Harbor: ${errorDetail}` : `Lỗi khi Trivy quét image trên Harbor (trạng thái: ${status})`;
      await setRepoStatus.run('error', message, latest.isDigest ? null : latest.ref, null, repo.id);
      return;
    }
    for (const f of findings) f.targetFile = f.targetFile ? `${imageRef} :: ${f.targetFile}` : imageRef;

    // scan_type='harbor', source_type='harbor_repo' — vm_id/source_id here is really harbor_repos.id,
    // not a VM; see trivy-scanner.js's enrichAndStoreFindings/raiseTrivyAlert comments on why passing
    // a {id, name} shaped like this works even though the column names still say "vm"/"vcenter_vm".
    await trivyScanner.enrichAndStoreFindings({ id: repo.id, name: fullName }, 'harbor', findings, 'harbor_repo');
    await trivyScanner.resolveStaleFindings.run(repo.id, 'harbor', scanStartedAt);
    await setRepoStatus.run('ok', null, latest.isDigest ? null : latest.ref, findings.length, repo.id);
  } catch (e) {
    await setRepoStatus.run('error', e.message, null, null, repo.id);
    console.error(`[harbor-scanner] ${fullName}: ${e.message}`);
  }
}

async function collectAll() {
  const due = await db.prepare(`
    SELECT * FROM harbor_repos WHERE scan_mode = 'auto'
      AND (last_scanned_at IS NULL OR last_scanned_at <= DATE_SUB(NOW(), INTERVAL ${SCAN_INTERVAL_HOURS} HOUR))
  `).all();
  for (const repo of due) await scanRepo(repo); // sequential — same reasoning as trivy-scanner.js's collectAll
}

function start(intervalMs = TICK_MS) {
  const tick = () => collectAll().catch((e) => console.error('[harbor-scanner] Lỗi:', e.message));
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = {
  start, collectAll, scanRepo, testConnection, discoverRepos, getLatestTag,
  harborRequest, harborPaginated, getHarborConfig,
};
