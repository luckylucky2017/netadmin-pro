const express = require('express');
const router = express.Router();
const db = require('../database');
const { requirePermission, logActivity } = require('../auth');
const wafManager = require('../waf-manager');

router.get('/events', async (req, res) => {
  const { vmId, eventType, search, limit } = req.query;
  let query = 'SELECT * FROM waf_events WHERE 1=1';
  const params = [];
  if (vmId) { query += ' AND vm_id = ?'; params.push(vmId); }
  if (eventType) { query += ' AND event_type = ?'; params.push(eventType); }
  if (search) { query += ' AND (vm_name LIKE ? OR src_ip LIKE ? OR path LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  query += ' ORDER BY occurred_at DESC LIMIT ?';
  params.push(Math.min(Number(limit) || 200, 1000));
  res.json(await db.prepare(query).all(...params));
});

router.get('/stats', async (req, res) => {
  const since = 'DATE_SUB(NOW(), INTERVAL 24 HOUR)';
  const scan = (await db.prepare(`SELECT COUNT(*) as cnt FROM waf_events WHERE event_type='scan' AND occurred_at >= ${since}`).get()).cnt;
  const dos = (await db.prepare(`SELECT COUNT(*) as cnt FROM waf_events WHERE event_type='dos' AND occurred_at >= ${since}`).get()).cnt;
  const ddos = (await db.prepare(`SELECT COUNT(*) as cnt FROM waf_events WHERE event_type='ddos' AND occurred_at >= ${since}`).get()).cnt;
  const blocked = (await db.prepare(`SELECT COUNT(*) as cnt FROM waf_events WHERE blocked=1 AND occurred_at >= ${since}`).get()).cnt;
  const monitored = (await db.prepare('SELECT COUNT(*) as cnt FROM vcenter_vms WHERE waf_enabled = 1').get()).cnt;
  res.json({ scan, dos, ddos, blocked, monitored });
});

// VMs list for "Quản lý giám sát": which are eligible (have an SSH credential + IP — assigned on
// the "Giám sát bất thường" → "Quản lý VM giám sát" tab, reused as-is here, no separate credential
// picker on this page) and which are currently opted into WAF.
router.get('/vms', async (req, res) => {
  const vms = await db.prepare(`
    SELECT id, moref, name, power_state, ip_address, guest_family, ssh_credential_id, ssh_user, ssh_port,
           waf_enabled, waf_log_path, waf_auto_block, waf_trust_xff, waf_jail_status, waf_jail_checked_at, waf_jail_error
    FROM vcenter_vms ORDER BY name ASC
  `).all();
  res.json(vms);
});

// Domains/log files discovered from this VM's /etc/nginx config by the last collector poll — for
// the "Quản lý giám sát" tab to show what's actually being tailed, since one VM commonly serves
// several domains each with its own access_log.
router.get('/vms/:id/domains', async (req, res) => {
  const rows = await db.prepare(`
    SELECT id, domain, log_path, conf_file, discovered_at FROM waf_domain_logs WHERE vm_id = ? ORDER BY domain ASC
  `).all(req.params.id);
  res.json(rows);
});

const SAFE_LOG_PATH_RE = wafManager.SAFE_LOG_PATH_RE;

router.patch('/vms/:id', requirePermission('waf.manage'), async (req, res) => {
  const vm = await db.prepare('SELECT id, name FROM vcenter_vms WHERE id = ?').get(req.params.id);
  if (!vm) return res.status(404).json({ error: 'Không tìm thấy VM' });
  const enabled = req.body?.enabled ? 1 : 0;
  const logPath = String(req.body?.logPath || '/var/log/nginx/access.log').trim();
  const autoBlock = req.body?.autoBlock ? 1 : 0;
  const trustXff = req.body?.trustXff ? 1 : 0;
  if (enabled && !SAFE_LOG_PATH_RE.test(logPath)) {
    return res.status(400).json({ error: 'Đường dẫn log không hợp lệ — phải là đường dẫn tuyệt đối, chỉ gồm chữ/số/_-./ ' });
  }
  await db.prepare('UPDATE vcenter_vms SET waf_enabled = ?, waf_log_path = ?, waf_auto_block = ?, waf_trust_xff = ? WHERE id = ?')
    .run(enabled, logPath, autoBlock, trustXff, vm.id);
  await logActivity(req.user, 'UPDATE', 'vcenter_vm', vm.id, vm.name,
    enabled
      ? `Bật giám sát WAF (log dự phòng: ${logPath}, tự động chặn: ${autoBlock ? 'bật' : 'tắt'}, tin X-Forwarded-For: ${trustXff ? 'bật' : 'tắt'})`
      : 'Tắt giám sát WAF');
  res.json({ message: 'OK' });
});

async function getWafVm(req, res) {
  // ssh_credential_id is what waf-manager.js's connect()/sshCredentials.buildConnectOptions actually
  // resolves the SSH connection from — mirrors routes/security.js's getMonitoredVm reasoning.
  const vm = await db.prepare(`
    SELECT id, name, ip_address, ssh_credential_id, waf_log_path, waf_auto_block
    FROM vcenter_vms WHERE id = ?
  `).get(req.params.id);
  if (!vm) { res.status(404).json({ error: 'Không tìm thấy VM' }); return null; }
  if (!vm.ssh_credential_id || !vm.ip_address) { res.status(400).json({ error: 'VM này chưa có tài khoản kết nối SSH — cần cấu hình trước' }); return null; }
  return vm;
}

router.post('/vms/:id/jail/check', requirePermission('waf.jail.check'), async (req, res) => {
  const vm = await getWafVm(req, res);
  if (!vm) return;
  res.json(await wafManager.checkStatus(vm));
});

router.post('/vms/:id/jail/install', requirePermission('waf.jail.manage'), async (req, res) => {
  const vm = await getWafVm(req, res);
  if (!vm) return;
  res.json(await wafManager.installJail(vm, req.user));
});

router.post('/vms/:id/jail/stop', requirePermission('waf.jail.manage'), async (req, res) => {
  const vm = await getWafVm(req, res);
  if (!vm) return;
  res.json(await wafManager.stopJail(vm, req.user));
});

router.get('/vms/:id/banned-ips', requirePermission('waf.jail.check'), async (req, res) => {
  const vm = await getWafVm(req, res);
  if (!vm) return;
  res.json(await wafManager.listBannedIps(vm));
});

router.post('/vms/:id/block-ip', requirePermission('waf.block'), async (req, res) => {
  const vm = await getWafVm(req, res);
  if (!vm) return;
  const ip = String(req.body?.ip || '').trim();
  if (!ip) return res.status(400).json({ error: 'Thiếu địa chỉ IP' });
  const result = await wafManager.banIp(vm, ip);
  if (result.ok) {
    await db.prepare(`
      INSERT INTO waf_events (vm_id, vm_name, event_type, src_ip, blocked, occurred_at)
      VALUES (?, ?, 'manual_block', ?, 1, CURRENT_TIMESTAMP)
    `).run(vm.id, vm.name, ip);
    await logActivity(req.user, 'UPDATE', 'vcenter_vm', vm.id, vm.name, `Chặn thủ công IP ${ip} qua WAF`);
  }
  res.json(result);
});

router.post('/vms/:id/unblock-ip', requirePermission('waf.block'), async (req, res) => {
  const vm = await getWafVm(req, res);
  if (!vm) return;
  const ip = String(req.body?.ip || '').trim();
  if (!ip) return res.status(400).json({ error: 'Thiếu địa chỉ IP' });
  const result = await wafManager.unbanIp(vm, ip);
  if (result.ok) await logActivity(req.user, 'UPDATE', 'vcenter_vm', vm.id, vm.name, `Gỡ chặn IP ${ip} khỏi WAF`);
  res.json(result);
});

module.exports = router;
