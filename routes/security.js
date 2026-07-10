const express = require('express');
const router = express.Router();
const db = require('../database');
const { requirePermission, logActivity } = require('../auth');
const fail2banManager = require('../fail2ban-manager');

router.get('/events', async (req, res) => {
  const { vmId, eventType, foreignOnly, search, limit } = req.query;
  let query = "SELECT * FROM ssh_login_events WHERE source_type = 'vm'";
  const params = [];
  if (vmId) { query += ' AND source_id = ?'; params.push(vmId); }
  if (eventType) { query += ' AND event_type = ?'; params.push(eventType); }
  if (foreignOnly === 'true') query += ' AND is_foreign = 1';
  if (search) { query += ' AND (source_name LIKE ? OR src_ip LIKE ? OR username LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  // A successful login from outside VN is the one truly actionable warning here (failed foreign
  // attempts are mostly bot noise) — surface it above the rest instead of letting it sit wherever
  // it falls chronologically.
  query += `
    ORDER BY CASE WHEN event_type = 'accepted' AND is_foreign = 1 THEN 0 ELSE 1 END, occurred_at DESC
    LIMIT ?
  `;
  params.push(Math.min(Number(limit) || 200, 1000));
  res.json(await db.prepare(query).all(...params));
});

router.get('/stats', async (req, res) => {
  const since = 'DATE_SUB(NOW(), INTERVAL 24 HOUR)';
  const total = (await db.prepare(`SELECT COUNT(*) as cnt FROM ssh_login_events WHERE occurred_at >= ${since}`).get()).cnt;
  const accepted = (await db.prepare(`SELECT COUNT(*) as cnt FROM ssh_login_events WHERE event_type='accepted' AND occurred_at >= ${since}`).get()).cnt;
  const failed = (await db.prepare(`SELECT COUNT(*) as cnt FROM ssh_login_events WHERE event_type='failed' AND occurred_at >= ${since}`).get()).cnt;
  // "foreign" = successful logins from outside VN specifically — the actionable signal (matches
  // raiseForeignLoginAlert). Failed attempts from abroad are mostly background bot scanning noise
  // and are still visible per-row in /events, just not surfaced as a headline warning.
  const foreign = (await db.prepare(`SELECT COUNT(*) as cnt FROM ssh_login_events WHERE is_foreign=1 AND event_type='accepted' AND occurred_at >= ${since}`).get()).cnt;
  const monitored = (await db.prepare("SELECT COUNT(*) as cnt FROM vcenter_vms WHERE ssh_user IS NOT NULL AND ssh_user != ''").get()).cnt;
  res.json({ total, accepted, failed, foreign, monitored });
});

// VMs list for the monitoring-management panel: which ones are eligible (Linux + have an IP from
// VMware Tools) and which are currently opted in (ssh_user set).
router.get('/vms', async (req, res) => {
  const vms = await db.prepare(`
    SELECT id, moref, name, power_state, ip_address, guest_family, ssh_user, ssh_port, ssh_credential_id,
           fail2ban_status, fail2ban_checked_at, fail2ban_error
    FROM vcenter_vms ORDER BY name ASC
  `).all();
  res.json(vms);
});

router.get('/outbound', async (req, res) => {
  const { vmId, foreignOnly, search } = req.query;
  let query = 'SELECT * FROM outbound_connections WHERE 1=1';
  const params = [];
  if (vmId) { query += ' AND vm_id = ?'; params.push(vmId); }
  if (foreignOnly === 'true') query += ' AND is_foreign = 1';
  if (search) { query += ' AND (vm_name LIKE ? OR remote_ip LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
  query += ' ORDER BY is_foreign DESC, last_seen DESC LIMIT 500';
  res.json(await db.prepare(query).all(...params));
});

router.get('/outbound/stats', async (req, res) => {
  const total = (await db.prepare('SELECT COUNT(*) as cnt FROM outbound_connections').get()).cnt;
  // Foreign rows are never pruned just for being closed (kept as history — see collector), so
  // "foreign" here is the all-time count; "foreignActive" is the still-open subset, which is the
  // more urgent headline number (recent enough to have been refreshed by the last ~2 poll cycles).
  const foreign = (await db.prepare('SELECT COUNT(*) as cnt FROM outbound_connections WHERE is_foreign = 1').get()).cnt;
  const foreignActive = (await db.prepare("SELECT COUNT(*) as cnt FROM outbound_connections WHERE is_foreign = 1 AND last_seen >= DATE_SUB(NOW(), INTERVAL 150 SECOND)").get()).cnt;
  const foreignVms = (await db.prepare('SELECT COUNT(DISTINCT vm_id) as cnt FROM outbound_connections WHERE is_foreign = 1').get()).cnt;
  res.json({ total, foreign, foreignActive, foreignVms });
});

// credentialId (not a free-text username) selects which saved account — from "Tài khoản kết nối" —
// to connect with; ssh_user is kept as a denormalized display cache of the credential's username
// (see routes/servers.js's resolveSshCredential for the same pattern). Shared by the single-VM
// PATCH below and the bulk-save route, so both apply identical validation/logging.
async function updateVmSshUser(vm, credentialId, sshPortRaw, user, bulkSuffix = '') {
  let sshUser = null;
  if (credentialId) {
    const cred = await db.prepare('SELECT username FROM ssh_credentials WHERE id = ?').get(credentialId);
    if (!cred) throw new Error('Không tìm thấy tài khoản kết nối SSH');
    sshUser = cred.username;
  }
  const sshPort = sshPortRaw >= 1 && sshPortRaw <= 65535 ? sshPortRaw : null;
  await db.prepare('UPDATE vcenter_vms SET ssh_user = ?, ssh_credential_id = ?, ssh_port = ? WHERE id = ?').run(sshUser, credentialId, sshPort, vm.id);
  await logActivity(user, 'UPDATE', 'vcenter_vm', vm.id, vm.name,
    (sshUser ? `Bật giám sát SSH (user: ${sshUser}, port: ${sshPort || 22})` : 'Tắt giám sát SSH') + bulkSuffix);
}

router.patch('/vms/:id/ssh-user', requirePermission('security.ssh_config'), async (req, res) => {
  const vm = await db.prepare('SELECT id, name FROM vcenter_vms WHERE id = ?').get(req.params.id);
  if (!vm) return res.status(404).json({ error: 'Không tìm thấy VM' });
  try {
    await updateVmSshUser(vm, req.body?.credentialId || null, Number(req.body?.sshPort), req.user);
    res.json({ message: 'OK' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Bulk equivalent of the route above — each item can carry its own credentialId/sshPort (VMs in
// the same selection commonly need different accounts/ports), driven by the "Lưu đã chọn" bulk
// toolbar on the "Quản lý VM giám sát" tab. One bad item (VM deleted mid-edit, bad credential id)
// doesn't block the rest — same partial-success shape as /alerts/bulk-ack's count, plus a per-item
// error list so the UI can say exactly which VMs failed and why.
router.patch('/vms/bulk-ssh-user', requirePermission('security.ssh_config'), async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: 'Chưa chọn VM nào' });
  let count = 0;
  const errors = [];
  for (const item of items) {
    const id = Number(item?.id);
    if (!Number.isInteger(id) || id <= 0) continue;
    const vm = await db.prepare('SELECT id, name FROM vcenter_vms WHERE id = ?').get(id);
    if (!vm) { errors.push(`VM #${id}: không tìm thấy`); continue; }
    try {
      await updateVmSshUser(vm, item.credentialId || null, Number(item.sshPort), req.user, ' (hàng loạt)');
      count++;
    } catch (e) {
      errors.push(`${vm.name}: ${e.message}`);
    }
  }
  res.json({ message: 'OK', count, errors });
});

async function getMonitoredVm(req, res) {
  // ssh_credential_id must be selected here — fail2banManager.checkStatus/installFail2ban/
  // stopFail2ban all resolve their SSH connection from vm.ssh_credential_id via
  // sshCredentials.buildConnectOptions(vm). Omitting it silently makes every VM look
  // credential-less (buildConnectOptions returns null on a missing field) even when a real
  // credential is assigned, regardless of what the DB row actually holds.
  const vm = await db.prepare('SELECT id, name, ip_address, ssh_user, ssh_port, ssh_credential_id FROM vcenter_vms WHERE id = ?').get(req.params.id);
  if (!vm) { res.status(404).json({ error: 'Không tìm thấy VM' }); return null; }
  if (!vm.ssh_user || !vm.ip_address) { res.status(400).json({ error: 'VM này chưa bật giám sát SSH (cần cấu hình SSH User trước)' }); return null; }
  return vm;
}

// On-demand read-only check ("is fail2ban here and running?") — safe for Operator too, it never
// modifies the VM.
router.post('/vms/:id/fail2ban/check', requirePermission('security.fail2ban.check'), async (req, res) => {
  const vm = await getMonitoredVm(req, res);
  if (!vm) return;
  const result = await fail2banManager.checkStatus(vm);
  res.json(result);
});

// Installs fail2ban via sudo package-manager commands on the real VM — a genuine system mutation,
// so Admin-only (same reasoning as PATCH /vms/:id/ssh-user above).
router.post('/vms/:id/fail2ban/install', requirePermission('security.fail2ban.manage'), async (req, res) => {
  const vm = await getMonitoredVm(req, res);
  if (!vm) return;
  const result = await fail2banManager.installFail2ban(vm, req.user);
  res.json(result);
});

// Stops the service (leaves it installed) — the "off" side of the toggle. Admin-only, same
// reasoning as install: this disables real brute-force protection on a production server.
router.post('/vms/:id/fail2ban/stop', requirePermission('security.fail2ban.manage'), async (req, res) => {
  const vm = await getMonitoredVm(req, res);
  if (!vm) return;
  const result = await fail2banManager.stopFail2ban(vm, req.user);
  res.json(result);
});

module.exports = router;
