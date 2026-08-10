// Dashboard-facing endpoints for the CrowdSec LAPI hub configured in crowdsec_settings — separate
// from crowdsec-collector.js (which polls in the background and folds alerts into waf_events/alerts)
// so a page load can show LIVE hub state without waiting for/depending on the poll cycle. Reuses the
// collector's own token cache (getToken) rather than logging in again.
//
// /status and /alerts are LAPI-based (read-only): the configured credential is a CrowdSec MACHINE
// (watcher) token, which the hub only lets query its own submitted alerts — GET /v1/decisions (the
// hub-wide active-ban list) and bouncer/machine management both come back 403 "access forbidden"
// with this token (verified live). /decisions, /bouncers, /machines, /metrics below instead go
// through crowdsec-manager.js (`cscli` over SSH on the hub server itself, once an SSH credential is
// assigned to it) — real management, not restricted by the LAPI token's scope.
const express = require('express');
const router = express.Router();
const db = require('../database');
const { requirePermission, logActivity } = require('../auth');
const crowdsec = require('../crowdsec-collector');
const crowdsecManager = require('../crowdsec-manager');

async function lapiFetch(settings, path) {
  const token = await crowdsec.getToken(settings);
  const url = `${settings.lapi_url}${path}`;
  let res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': crowdsec.USER_AGENT } });
  if (res.status === 401) {
    // getToken's own expiry check thought the cached token was still good, but the hub disagrees
    // (revoked/restarted hub-side) — force an actual re-login rather than trusting the cache again.
    const fresh = await crowdsec.login(settings).catch(() => null);
    if (fresh) res = await fetch(url, { headers: { Authorization: `Bearer ${fresh}`, 'User-Agent': crowdsec.USER_AGENT } });
  }
  return res;
}

router.get('/status', requirePermission('waf.manage'), async (req, res) => {
  const settings = await db.prepare('SELECT lapi_url, machine_id, last_alert_id, updated_at FROM crowdsec_settings WHERE id = 1').get();
  const configured = !!(settings?.lapi_url && settings?.machine_id);
  const base = { configured, lapiUrl: settings?.lapi_url || null, machineId: settings?.machine_id || null, lastAlertId: settings?.last_alert_id ?? null };
  if (!configured) return res.json({ ...base, reachable: false, error: null });

  let reachable = false, error = null;
  try {
    const r = await lapiFetch(settings, '/v1/alerts?limit=1');
    reachable = r.ok;
    if (!r.ok) error = `Hub trả về HTTP ${r.status}`;
  } catch (e) {
    error = e.message;
  }

  const vms = await db.prepare(`
    SELECT id, name, crowdsec_machine_id, crowdsec_auto_block FROM vcenter_vms
    WHERE waf_enabled = 1 ORDER BY name ASC
  `).all();
  const mapped = vms.filter((v) => v.crowdsec_machine_id);
  const unmapped = vms.filter((v) => !v.crowdsec_machine_id);

  const managedVm = await crowdsecManager.getManagedVm();
  const sshManagement = { available: !!managedVm?.ssh_credential_id, vmName: managedVm?.name || null };

  res.json({ ...base, reachable, error, mappedVms: mapped, unmappedVms: unmapped, sshManagement });
});

// ── SSH/cscli-backed real management — see crowdsec-manager.js's header for why this can't go
// through the LAPI machine token used above. Every route here 404s cleanly (rather than a confusing
// SSH error) if the hub VM has no SSH credential assigned yet.
async function getManagedVmOr404(res) {
  const vm = await crowdsecManager.getManagedVm();
  if (!vm) { res.status(404).json({ error: 'Chưa xác định được VM máy chủ CrowdSec (kiểm tra cấu hình LAPI URL)' }); return null; }
  if (!vm.ssh_credential_id) { res.status(400).json({ error: 'Máy chủ CrowdSec chưa được gán tài khoản kết nối SSH' }); return null; }
  return vm;
}

router.get('/decisions', requirePermission('waf.manage'), async (req, res) => {
  const vm = await getManagedVmOr404(res);
  if (!vm) return;
  const result = await crowdsecManager.listDecisions(vm);
  if (!result.ok) return res.status(502).json({ error: result.error });
  res.json(result.data);
});

router.post('/decisions', requirePermission('waf.block'), async (req, res) => {
  const vm = await getManagedVmOr404(res);
  if (!vm) return;
  const { ip, duration, reason } = req.body || {};
  const result = await crowdsecManager.addDecision(vm, { ip, duration, reason });
  if (!result.ok) return res.status(400).json({ error: result.error });
  await logActivity(req.user, 'CREATE', 'crowdsec_decision', null, ip, `Thêm quyết định chặn CrowdSec: ${ip} (${duration || '4h'})${reason ? ` — ${reason}` : ''}`);
  res.json({ message: 'OK' });
});

router.delete('/decisions/:id', requirePermission('waf.block'), async (req, res) => {
  const vm = await getManagedVmOr404(res);
  if (!vm) return;
  const result = await crowdsecManager.deleteDecisionById(vm, req.params.id);
  if (!result.ok) return res.status(400).json({ error: result.error });
  await logActivity(req.user, 'DELETE', 'crowdsec_decision', Number(req.params.id) || null, req.params.id, `Gỡ quyết định CrowdSec #${req.params.id}`);
  res.json({ message: 'OK' });
});

router.delete('/decisions', requirePermission('waf.block'), async (req, res) => {
  const vm = await getManagedVmOr404(res);
  if (!vm) return;
  const ip = String(req.query.ip || '').trim();
  if (!ip) return res.status(400).json({ error: 'Thiếu IP' });
  const result = await crowdsecManager.deleteDecisionByIp(vm, ip);
  if (!result.ok) return res.status(400).json({ error: result.error });
  await logActivity(req.user, 'DELETE', 'crowdsec_decision', null, ip, `Gỡ quyết định CrowdSec cho IP ${ip}`);
  res.json({ message: 'OK' });
});

router.get('/bouncers', requirePermission('waf.manage'), async (req, res) => {
  const vm = await getManagedVmOr404(res);
  if (!vm) return;
  const result = await crowdsecManager.listBouncers(vm);
  if (!result.ok) return res.status(502).json({ error: result.error });
  res.json(result.data);
});

router.get('/machines', requirePermission('waf.manage'), async (req, res) => {
  const vm = await getManagedVmOr404(res);
  if (!vm) return;
  const result = await crowdsecManager.listMachines(vm);
  if (!result.ok) return res.status(502).json({ error: result.error });
  res.json(result.data);
});

router.get('/metrics', requirePermission('waf.manage'), async (req, res) => {
  const vm = await getManagedVmOr404(res);
  if (!vm) return;
  const result = await crowdsecManager.getMetricsText(vm);
  if (!result.ok) return res.status(502).json({ error: result.error });
  res.json({ text: result.text });
});

// Live query proxy — NOT the local waf_events mirror (which only has what crowdsec-collector.js has
// already ingested for VMs with a resolved machine_id match); this hits the hub directly, so it shows
// everything the hub has, including alerts from a machine_id that isn't (yet) mapped to a VM here.
router.get('/alerts', requirePermission('waf.manage'), async (req, res) => {
  const settings = await db.prepare('SELECT lapi_url, machine_id, last_alert_id FROM crowdsec_settings WHERE id = 1').get();
  if (!settings?.lapi_url) return res.status(400).json({ error: 'Chưa cấu hình CrowdSec LAPI' });

  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const params = new URLSearchParams({ limit: String(limit) });
  // Both confirmed live to be real server-side LAPI filters, not client-side guesses.
  if (req.query.scenario) params.set('scenario', req.query.scenario);
  if (req.query.ip) params.set('ip', req.query.ip);

  let alerts;
  try {
    const r = await lapiFetch(settings, `/v1/alerts?${params}`);
    if (!r.ok) return res.status(502).json({ error: `Hub CrowdSec trả về HTTP ${r.status}` });
    alerts = await r.json();
  } catch (e) {
    return res.status(502).json({ error: `Không kết nối được hub CrowdSec: ${e.message}` });
  }

  const machineIds = [...new Set((alerts || []).map((a) => a.machine_id).filter(Boolean))];
  const vms = machineIds.length
    ? await db.prepare(`SELECT name, crowdsec_machine_id FROM vcenter_vms WHERE crowdsec_machine_id IN (${machineIds.map(() => '?').join(',')})`).all(...machineIds)
    : [];
  const vmByMachineId = new Map(vms.map((v) => [v.crowdsec_machine_id, v.name]));

  const rows = (alerts || []).map((a) => {
    const meta = crowdsec.firstEventMeta(a);
    return {
      id: a.id,
      createdAt: a.created_at,
      scenario: a.scenario,
      machineId: a.machine_id,
      vmName: vmByMachineId.get(a.machine_id) || null,
      ip: a.source?.ip || null,
      country: a.source?.cn || null,
      asName: a.source?.as_name || null,
      asNumber: a.source?.as_number || null,
      eventsCount: a.events_count || 0,
      httpVerb: meta.http_verb || null,
      httpPath: meta.http_path || null,
      httpStatus: meta.http_status || null,
      decisions: (a.decisions || []).map((d) => ({ type: d.type, duration: d.duration, scope: d.scope, origin: d.origin, value: d.value })),
    };
  });
  res.json(rows);
});

module.exports = router;
