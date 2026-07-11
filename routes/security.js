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
           fail2ban_status, fail2ban_checked_at, fail2ban_error, waf_enabled
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
  // waf_enabled/waf_log_path are also required here — fail2banManager's checkStatus/installFail2ban
  // use them to decide whether to also check/configure the netadmin-waf jail alongside sshd (see
  // fail2ban-manager.js's module header comment on the unified check/install flow).
  const vm = await db.prepare('SELECT id, name, ip_address, ssh_user, ssh_port, ssh_credential_id, waf_enabled, waf_log_path FROM vcenter_vms WHERE id = ?').get(req.params.id);
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

// ── "IP đang bị chặn" (sshd jail) — mirrors routes/waf.js's GET /banned-ips: pure DB read (no live
// SSH), so ungated beyond requireAuth like every other GET in this file — see database.js's comment
// on why Viewer gets zero permission rows and relies on GETs staying open.
// "why blocked" context (event_count, usernames) is aggregated across every ssh_login_events row
// ever recorded for that (vm, ip) with event_type='failed' — not just the burst that triggered the
// ban — so the full pattern is visible, not just the latest attempt.
router.get('/banned-ips', async (req, res) => {
  const rows = await db.prepare(`
    SELECT b.vm_id, v.name AS vm_name, b.ip, b.first_seen, b.last_seen,
           agg.country, agg.event_count, agg.usernames
    FROM ssh_banned_ips b
    JOIN vcenter_vms v ON v.id = b.vm_id
    LEFT JOIN (
      SELECT source_id AS vm_id, src_ip,
        SUBSTRING_INDEX(GROUP_CONCAT(country ORDER BY occurred_at DESC SEPARATOR ','), ',', 1) AS country,
        COUNT(*) AS event_count,
        SUBSTRING_INDEX(GROUP_CONCAT(DISTINCT username ORDER BY occurred_at DESC SEPARATOR '|||'), '|||', 8) AS usernames
      FROM ssh_login_events
      WHERE source_type = 'vm' AND event_type = 'failed'
      GROUP BY source_id, src_ip
    ) agg ON agg.vm_id = b.vm_id AND agg.src_ip = b.ip
    ORDER BY b.last_seen DESC
  `).all();
  res.json(rows);
});

router.post('/vms/:id/block-ip', requirePermission('security.block'), async (req, res) => {
  const vm = await getMonitoredVm(req, res);
  if (!vm) return;
  const ip = String(req.body?.ip || '').trim();
  if (!ip) return res.status(400).json({ error: 'Thiếu địa chỉ IP' });
  const result = await fail2banManager.banIp(vm, ip);
  if (result.ok) await logActivity(req.user, 'UPDATE', 'vcenter_vm', vm.id, vm.name, `Chặn thủ công IP ${ip} qua jail sshd`);
  res.json(result);
});

router.post('/vms/:id/unblock-ip', requirePermission('security.block'), async (req, res) => {
  const vm = await getMonitoredVm(req, res);
  if (!vm) return;
  const ip = String(req.body?.ip || '').trim();
  if (!ip) return res.status(400).json({ error: 'Thiếu địa chỉ IP' });
  const result = await fail2banManager.unbanIp(vm, ip);
  if (result.ok) await logActivity(req.user, 'UPDATE', 'vcenter_vm', vm.id, vm.name, `Gỡ chặn IP ${ip} khỏi jail sshd`);
  res.json(result);
});

// ── SSH IP exceptions — a list SEPARATE from waf_ip_exceptions (see database.js's comment on that
// table for why), checked by fail2ban-manager.js's banIp() before every sshd-jail ban attempt.
function isValidExceptionIp(value) {
  const cidrM = /^(.+)\/(\d{1,3})$/.exec(value);
  const base = cidrM ? cidrM[1] : value;
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(base)) {
    if (!base.split('.').every(o => Number(o) <= 255)) return false;
    if (cidrM && (Number(cidrM[2]) < 0 || Number(cidrM[2]) > 32)) return false;
    return true;
  }
  // Bare IPv6 only — no CIDR support for v6 (matchesException treats it as exact-match anyway).
  if (!cidrM && /^[0-9a-fA-F:]+$/.test(value) && value.includes(':')) return true;
  return false;
}

router.get('/exceptions', async (req, res) => {
  res.json(await db.prepare('SELECT * FROM ssh_ip_exceptions ORDER BY created_at DESC').all());
});

router.post('/exceptions', requirePermission('security.block'), async (req, res) => {
  const ip = String(req.body?.ip || '').trim();
  const note = String(req.body?.note || '').trim().slice(0, 255) || null;
  if (!isValidExceptionIp(ip)) {
    return res.status(400).json({ error: 'IP/CIDR không hợp lệ — dùng dạng "203.0.113.5" hoặc "203.0.113.0/24" (IPv4) hoặc địa chỉ IPv6 đầy đủ' });
  }
  try {
    await db.prepare('INSERT INTO ssh_ip_exceptions (ip, note, created_by) VALUES (?, ?, ?)').run(ip, note, req.user.name || req.user.email);
  } catch (e) {
    if (e.errno === 1062) return res.status(400).json({ error: 'IP/CIDR này đã có trong danh sách ngoại lệ' });
    throw e;
  }
  await logActivity(req.user, 'CREATE', 'ssh_ip_exception', null, ip, `Thêm ngoại lệ IP SSH: ${ip}${note ? ' — ' + note : ''}`);
  // Best-effort immediate unban on every VM whose fail2ban is currently running, mirroring
  // routes/waf.js's POST /exceptions — the periodic reconcileSshExceptions in fail2ban-collector.js
  // is the real safety net (catches CIDR ranges added after a specific IP was already banned), this
  // is just so an already-banned false positive doesn't wait up to ~45s for the next poll. Also
  // pushes the updated exceptions list into fail2ban's own `ignoreip` on the sshd jail (see
  // fail2ban-manager.js's pushIgnoreIp) — unlike the WAF jail, this has real additional value here:
  // it stops fail2ban's OWN native auth.log filter from auto-banning an excepted IP on a real failed
  // SSH login, a path this app's own tryImmediateBan/isExceptedIp check never sees.
  const vms = await db.prepare(`
    SELECT id, name, ip_address, ssh_credential_id, ssh_port FROM vcenter_vms
    WHERE fail2ban_status = 'running' AND ssh_credential_id IS NOT NULL
  `).all();
  await Promise.allSettled(vms.map(vm => fail2banManager.unbanIp(vm, ip)));
  await Promise.allSettled(vms.map(vm => fail2banManager.pushIgnoreIp(vm)));
  res.json({ message: 'OK' });
});

router.delete('/exceptions/:id', requirePermission('security.block'), async (req, res) => {
  const row = await db.prepare('SELECT * FROM ssh_ip_exceptions WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Không tìm thấy' });
  await db.prepare('DELETE FROM ssh_ip_exceptions WHERE id = ?').run(row.id);
  await logActivity(req.user, 'DELETE', 'ssh_ip_exception', row.id, row.ip, `Xóa ngoại lệ IP SSH: ${row.ip}`);
  // Push the updated (now-shorter) exceptions list to every running sshd jail so the removed IP
  // stops being ignored — see the POST handler's comment above.
  const vms = await db.prepare(`
    SELECT id, name, ip_address, ssh_credential_id, ssh_port FROM vcenter_vms
    WHERE fail2ban_status = 'running' AND ssh_credential_id IS NOT NULL
  `).all();
  await Promise.allSettled(vms.map(vm => fail2banManager.pushIgnoreIp(vm)));
  res.json({ message: 'OK' });
});

module.exports = router;
