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
    SELECT id, moref, name, power_state, ip_address, guest_family, ssh_user, ssh_port,
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

router.patch('/vms/:id/ssh-user', requirePermission('security.ssh_config'), async (req, res) => {
  const vm = await db.prepare('SELECT id, name FROM vcenter_vms WHERE id = ?').get(req.params.id);
  if (!vm) return res.status(404).json({ error: 'Không tìm thấy VM' });
  const sshUser = (req.body?.sshUser || '').trim() || null;
  const sshPortRaw = Number(req.body?.sshPort);
  const sshPort = sshPortRaw >= 1 && sshPortRaw <= 65535 ? sshPortRaw : null;
  await db.prepare('UPDATE vcenter_vms SET ssh_user = ?, ssh_port = ? WHERE id = ?').run(sshUser, sshPort, vm.id);
  await logActivity(req.user, 'UPDATE', 'vcenter_vm', vm.id, vm.name, sshUser ? `Bật giám sát SSH (user: ${sshUser}, port: ${sshPort || 22})` : 'Tắt giám sát SSH');
  res.json({ message: 'OK' });
});

async function getMonitoredVm(req, res) {
  const vm = await db.prepare('SELECT id, name, ip_address, ssh_user, ssh_port FROM vcenter_vms WHERE id = ?').get(req.params.id);
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
