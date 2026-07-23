// Polls a CrowdSec LAPI hub for new alerts and folds them into the SAME waf_events/alerts pipeline
// nginx-waf-collector.js's own JS-based scan/dos/ddos detector already writes to — so the existing
// "Sự kiện"/"IP đang bị chặn" UI, ban/unban actions, and IP exceptions all keep working unchanged.
// CrowdSec only replaces the DETECTION brain here: it runs as an agent on each monitored VM (reading
// the local nginx log with CrowdSec's own maintained scenario library — see the CrowdSec integration
// plan for why: unlike the old threshold-based detector, this can catch payload-based attacks like
// SQLi/XSS/RCE probing, not just volume/4xx-based scans), reports up to a central hub, and THIS file
// is the only thing that talks to that hub — no agent/bouncer runs on the netadmin-pro server itself.
//
// Enforcement stays 100% unchanged: if vcenter_vms.crowdsec_auto_block is on for a VM, a CrowdSec
// alert triggers the exact same wafManager.banIp() call (the netadmin-waf fail2ban jail) that the old
// detector already used — no CrowdSec bouncer, no second ban mechanism. crowdsec_auto_block defaults
// OFF on every VM; until an admin turns it on, CrowdSec alerts only get written to waf_events/alerts.
const db = require('./database');
const wafManager = require('./waf-manager');

// Same MySQL time_zone=SYSTEM=Asia/Ho_Chi_Minh gotcha as every other collector in this codebase —
// Date.prototype.toISOString() would land 7h off from every other timestamp column.
function toSqlDatetime(date) {
  return date.toLocaleString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' });
}

const insertEvent = db.prepare(`
  INSERT INTO waf_events (vm_id, vm_name, domain, event_type, src_ip, country, is_foreign, method, path, status_code, user_agent, hit_count, blocked, occurred_at, source, crowdsec_scenario)
  VALUES (?, ?, ?, 'scan', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'crowdsec', ?)
`);
const findDomainByLogPath = db.prepare('SELECT domain FROM waf_domain_logs WHERE vm_id = ? AND log_path = ?');

// alert.events[0].meta is an array of {key, value} pairs (see a real captured alert during rollout
// testing: http_path/http_verb/http_status/http_user_agent/datasource_path) — flattened once per
// alert for the waf_events row's method/path/status_code/user_agent columns, same fields the old
// detector fills.
function firstEventMeta(alert) {
  const meta = alert?.events?.[0]?.meta;
  if (!Array.isArray(meta)) return {};
  const out = {};
  for (const { key, value } of meta) out[key] = value;
  return out;
}

// CrowdSec's alert has no notion of "domain" — it only knows which log FILE the hit came from
// (meta.datasource_path, e.g. "/var/log/nginx/access_fds.vn.log"). nginx-waf-collector.js already
// maps every discovered per-domain log file to its domain in waf_domain_logs (same discovery that
// generated this VM's crowdsec acquisition config in the first place — see this file's header
// comment) — reusing that mapping here instead of leaving domain NULL, so a CrowdSec-sourced row is
// just as attributable to a specific site as a netadmin-sourced one.
async function resolveDomain(vm, datasourcePath) {
  if (!datasourcePath) return null;
  const row = await findDomainByLogPath.get(vm.id, datasourcePath);
  return row?.domain || null;
}

// A JWT machine token, cached in-memory and refreshed on expiry/401 — avoids logging in on every
// 45s poll tick. Module-level (not per-call state) since there's only ever one hub configured.
let cachedToken = null; // { token, expiresAt }

// CrowdSec's LAPI middleware rejects any request with no (or Node fetch's default) User-Agent header
// — a bare 401 "incorrect Username or Password" even when the credentials are correct, confirmed by
// diffing a working curl request against an otherwise-identical Node fetch/http request during
// rollout testing. Every request to the hub must set this explicitly.
const USER_AGENT = 'netadmin-pro-crowdsec-collector/1.0';

async function login(settings) {
  const res = await fetch(`${settings.lapi_url}/v1/watchers/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({ machine_id: settings.machine_id, password: settings.machine_password }),
  });
  if (!res.ok) throw new Error(`Đăng nhập CrowdSec LAPI thất bại (HTTP ${res.status})`);
  const data = await res.json();
  cachedToken = { token: data.token, expiresAt: Date.parse(data.expire) };
  return cachedToken.token;
}

async function getToken(settings) {
  if (cachedToken && cachedToken.expiresAt - Date.now() > 60000) return cachedToken.token;
  return login(settings);
}

// Fetches recent alerts and returns only the ones newer than the stored cursor, oldest-first so
// ingestAlert()/the caller processes them in the order they actually happened. /v1/alerts has no
// "since this ID" server-side filter, so a bounded recent window (limit=200) is fetched and filtered
// client-side — plenty of headroom for 3 monitored VMs' worth of traffic between 45s poll ticks.
async function fetchNewAlerts(settings) {
  const token = await getToken(settings);
  const url = `${settings.lapi_url}/v1/alerts?limit=200`;
  let res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': USER_AGENT } });
  if (res.status === 401) {
    const fresh = await login(settings);
    res = await fetch(url, { headers: { Authorization: `Bearer ${fresh}`, 'User-Agent': USER_AGENT } });
  }
  if (!res.ok) throw new Error(`Poll CrowdSec alerts thất bại (HTTP ${res.status})`);
  const alerts = await res.json();
  return (alerts || [])
    .filter((a) => !a.simulated && a.id > settings.last_alert_id)
    .sort((a, b) => a.id - b.id);
}

async function raiseCrowdsecAlert(vm, ip, country, scenario, domain, blockResult, autoBlockOn) {
  const already = await db.prepare(`
    SELECT id FROM alerts WHERE metric = 'waf_crowdsec' AND source_type = 'vcenter_vm' AND source_id = ? AND metric_value = ? AND status = 'open'
  `).get(vm.id, ip);
  if (already) return; // still active — the waf_events row above already recorded this occurrence
  const action = autoBlockOn
    ? (blockResult?.ok ? ' — ĐÃ CHẶN IP qua fail2ban'
      : blockResult?.excepted ? ' — bỏ qua, không chặn (IP nằm trong danh sách ngoại lệ)'
      : ` — CHƯA chặn được (${blockResult?.error || 'lỗi không rõ'})`)
    : ' — chỉ cảnh báo (tự động chặn CrowdSec đang tắt cho VM này)';
  const scenarioLabel = scenario ? scenario.replace(/^crowdsecurity\//, '') : 'hành vi bất thường';
  const site = domain ? `"${domain}" trên VM "${vm.name}"` : `VM "${vm.name}"`;
  await db.prepare(`
    INSERT INTO alerts (category, severity, title, message, source_type, source_id, source_name, metric, metric_value, status)
    VALUES ('security', 'critical', ?, ?, 'vcenter_vm', ?, ?, 'waf_crowdsec', ?, 'open')
  `).run(
    'CrowdSec phát hiện tấn công',
    `IP ${ip}${country ? ` (${country})` : ''} bị CrowdSec gắn cờ "${scenarioLabel}" tới ${site}${action}`,
    vm.id, vm.name, ip,
  );
}

async function ingestAlert(vm, alert) {
  const ip = alert.source?.ip;
  if (!ip) return; // Range-scoped or non-IP alerts — nothing to log/ban per-IP for
  const country = alert.source?.cn || null;
  const isForeign = country && country !== 'VN' ? 1 : 0;
  const scenario = alert.scenario || null;
  const meta = firstEventMeta(alert);
  const statusCode = meta.http_status ? Number(meta.http_status) : null;
  const occurredAt = toSqlDatetime(new Date(alert.created_at));
  const domain = await resolveDomain(vm, meta.datasource_path);

  let blockResult = null;
  if (vm.crowdsec_auto_block) {
    blockResult = await wafManager.banIp(vm, ip).catch((e) => ({ ok: false, error: e.message }));
  }
  const blocked = blockResult?.ok ? 1 : 0;

  await insertEvent.run(
    vm.id, vm.name, domain, ip, country, isForeign,
    meta.http_verb || null, meta.http_path || null, statusCode, meta.http_user_agent || null,
    alert.events_count || 1, blocked, occurredAt, scenario,
  );
  await raiseCrowdsecAlert(vm, ip, country, scenario, domain, blockResult, !!vm.crowdsec_auto_block);
}

async function pollAlerts() {
  const settings = await db.prepare('SELECT * FROM crowdsec_settings WHERE id = 1').get();
  if (!settings?.lapi_url || !settings?.machine_id || !settings?.machine_password) return; // not configured yet

  const vms = await db.prepare(`
    SELECT id, name, ip_address, ssh_port, ssh_credential_id, crowdsec_machine_id, crowdsec_auto_block
    FROM vcenter_vms WHERE waf_enabled = 1 AND crowdsec_machine_id IS NOT NULL AND crowdsec_machine_id != ''
  `).all();
  if (!vms.length) return; // no VM has a crowdsec_machine_id assigned yet
  const vmByMachineId = new Map(vms.map((v) => [v.crowdsec_machine_id, v]));

  let alerts;
  try {
    alerts = await fetchNewAlerts(settings);
  } catch (e) {
    console.error(`[crowdsec] Không lấy được alert từ hub (${settings.lapi_url}): ${e.message}`);
    return;
  }
  if (!alerts.length) return;

  let maxId = settings.last_alert_id;
  for (const alert of alerts) {
    const vm = vmByMachineId.get(alert.machine_id);
    if (vm) {
      try {
        await ingestAlert(vm, alert);
      } catch (e) {
        console.error(`[crowdsec] Lỗi xử lý alert #${alert.id} (VM ${vm.name}): ${e.message}`);
      }
    }
    if (alert.id > maxId) maxId = alert.id;
  }
  if (maxId !== settings.last_alert_id) {
    await db.prepare('UPDATE crowdsec_settings SET last_alert_id = ? WHERE id = 1').run(maxId);
  }
}

function start(intervalMs = 45000) {
  const tick = () => pollAlerts().catch((e) => console.error(`[crowdsec] poll lỗi: ${e.message}`));
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = { start, pollAlerts, fetchNewAlerts, ingestAlert };
