// Manages the CrowdSec server itself over SSH via `cscli`, run with sudo -n on whichever
// vcenter_vms row is the hub (resolved by matching crowdsec_settings.lapi_url's hostname against
// vcenter_vms.ip_address — the LAPI URL is already the single source of truth for where the hub
// lives, no separate "which VM is the hub" setting needed).
//
// This exists because the LAPI credential routes/crowdsec.js already uses (a CrowdSec MACHINE/
// watcher JWT) is deliberately restricted by the hub itself: GET /v1/decisions (the hub-wide active
// ban list) and bouncer/machine management both come back 403 "access forbidden" with that token
// type (confirmed live). `cscli` run locally as root on the hub has no such restriction — it IS the
// hub's own admin tool — so this is the only way to actually list/add/delete decisions or inspect
// bouncers/machines short of provisioning a separate bouncer API key.
//
// Every cscli flag used below (decisions add/delete's --ip/--duration/--reason/--id, -o json) was
// confirmed live against the real hub (v1.7.8) during rollout, including that `add`/`delete` print
// nothing on success (exit code 0, empty stdout) — only `list` actually returns JSON.
const { NodeSSH } = require('node-ssh');
const db = require('./database');
const sshCredentials = require('./ssh-credentials');

const IP_OR_CIDR_RE = /^[\da-fA-F:.]+(\/\d{1,3})?$/;
const DURATION_RE = /^\d+[smh]$/;

async function getManagedVm() {
  const settings = await db.prepare('SELECT lapi_url FROM crowdsec_settings WHERE id = 1').get();
  if (!settings?.lapi_url) return null;
  let host;
  try { host = new URL(settings.lapi_url).hostname; } catch { return null; }
  return db.prepare('SELECT * FROM vcenter_vms WHERE ip_address = ?').get(host);
}

async function connect(vm) {
  const opts = await sshCredentials.buildConnectOptions(vm);
  if (!opts) throw new Error('Chưa gán tài khoản kết nối SSH cho máy chủ CrowdSec');
  const ssh = new NodeSSH();
  await ssh.connect(opts);
  return ssh;
}

// listMachines/listBouncers/listDecisions all go through here — cscli -o json.
async function runCscliJson(vm, args) {
  let ssh;
  try {
    ssh = await connect(vm);
    const result = await ssh.execCommand(`sudo -n cscli ${args} -o json 2>&1`);
    const out = (result.stdout || '').trim();
    if (result.code !== 0) return { ok: false, error: (out || result.stderr || 'Lệnh cscli thất bại').slice(0, 500) };
    if (!out) return { ok: true, data: [] }; // e.g. "decisions list" with nothing currently banned
    try {
      return { ok: true, data: JSON.parse(out) };
    } catch {
      return { ok: false, error: `Không phân tích được kết quả JSON: ${out.slice(0, 300)}` };
    }
  } catch (e) {
    return { ok: false, error: `Không kết nối được SSH: ${e.message}` };
  } finally {
    if (ssh) ssh.dispose();
  }
}

// add/delete print nothing on success — success is just "exit code 0", not JSON to parse.
async function runCscliAction(vm, args) {
  let ssh;
  try {
    ssh = await connect(vm);
    const result = await ssh.execCommand(`sudo -n cscli ${args} 2>&1`);
    if (result.code !== 0) return { ok: false, error: (result.stdout || result.stderr || 'Lệnh cscli thất bại').slice(0, 500) };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Không kết nối được SSH: ${e.message}` };
  } finally {
    if (ssh) ssh.dispose();
  }
}

function listDecisions(vm) {
  return runCscliJson(vm, 'decisions list');
}

function addDecision(vm, { ip, duration, reason }) {
  if (!IP_OR_CIDR_RE.test(ip || '')) return Promise.resolve({ ok: false, error: 'IP/CIDR không hợp lệ' });
  const dur = DURATION_RE.test(duration || '') ? duration : '4h';
  const reasonArg = reason ? ` --reason "${String(reason).replace(/["`$\\]/g, '').slice(0, 200)}"` : '';
  return runCscliAction(vm, `decisions add --ip ${ip} --duration ${dur} --type ban${reasonArg}`);
}

// cscli's own delete is idempotent — deleting an ip/id that doesn't currently have an active
// decision still exits 0 with no output, so "ok: true" here means "the command ran", not
// necessarily "something was actually removed".
function deleteDecisionById(vm, decisionId) {
  if (!/^\d+$/.test(String(decisionId))) return Promise.resolve({ ok: false, error: 'ID quyết định không hợp lệ' });
  return runCscliAction(vm, `decisions delete --id ${decisionId}`);
}

function deleteDecisionByIp(vm, ip) {
  if (!IP_OR_CIDR_RE.test(ip || '')) return Promise.resolve({ ok: false, error: 'IP/CIDR không hợp lệ' });
  return runCscliAction(vm, `decisions delete --ip ${ip}`);
}

function listBouncers(vm) {
  return runCscliJson(vm, 'bouncers list');
}

function listMachines(vm) {
  return runCscliJson(vm, 'machines list');
}

// Metrics is a multi-table text report, not meant to be parsed structurally — rendered as
// preformatted text on the frontend, same as `cscli metrics` looks in a real terminal.
async function getMetricsText(vm) {
  let ssh;
  try {
    ssh = await connect(vm);
    const result = await ssh.execCommand('sudo -n cscli metrics 2>&1');
    if (result.code !== 0) return { ok: false, error: (result.stdout || result.stderr || 'Lệnh cscli thất bại').slice(0, 500) };
    return { ok: true, text: result.stdout };
  } catch (e) {
    return { ok: false, error: `Không kết nối được SSH: ${e.message}` };
  } finally {
    if (ssh) ssh.dispose();
  }
}

// "list" with no -a flag shows only what's actually INSTALLED on this hub (matches "danh sách các
// Attack Scenarios đã cài đặt" — installed, not the full hub catalog of everything available).
function listScenarios(vm) {
  return runCscliJson(vm, 'scenarios list');
}

// Runs an arbitrary shell snippet and captures combined stdout+stderr as text — for hub
// update/upgrade, whose useful output is human-readable progress/plan text, not structured JSON
// (confirmed live: `hub upgrade --dry-run -o json` still prints the same human text, -o json isn't
// honored for the dry-run plan).
async function runRaw(vm, shellCmd) {
  let ssh;
  try {
    ssh = await connect(vm);
    const result = await ssh.execCommand(shellCmd);
    return { ok: result.code === 0, text: (result.stdout || '') + (result.stderr ? `\n${result.stderr}` : ''), code: result.code };
  } catch (e) {
    return { ok: false, text: `Không kết nối được SSH: ${e.message}`, code: null };
  } finally {
    if (ssh) ssh.dispose();
  }
}

// Refreshes the catalog index from hub.crowdsec.net, then prints the upgrade plan WITHOUT applying
// it (--dry-run) — "Nothing to do, the hub index is up to date." when nothing needs upgrading,
// confirmed live. Safe to call as often as wanted, purely informational.
function checkHubUpdates(vm) {
  return runRaw(vm, 'sudo -n cscli hub update 2>&1; echo "---PLAN---"; sudo -n cscli hub upgrade --dry-run 2>&1');
}

// Actually applies pending scenario/collection/parser upgrades, then reloads (not restarts) the
// crowdsec service — `systemctl reload` maps to `crowdsec -t && kill -HUP $MAINPID` (confirmed from
// the real unit file), which re-validates config and picks up newly-upgraded scenarios/parsers
// without dropping the running process or its in-memory alert/decision state.
async function upgradeHub(vm) {
  const result = await runRaw(vm, 'sudo -n cscli hub update 2>&1; echo "---UPGRADE---"; sudo -n cscli hub upgrade 2>&1');
  if (result.ok) await runRaw(vm, 'sudo -n systemctl reload crowdsec 2>&1');
  return result;
}

module.exports = {
  getManagedVm, listDecisions, addDecision, deleteDecisionById, deleteDecisionByIp,
  listScenarios, checkHubUpdates, upgradeHub,
  listBouncers, listMachines, getMetricsText,
};
