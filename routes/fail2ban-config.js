// Admin page backing "Cấu hình Fail2ban" — read/write the global default detection thresholds +
// bantime (fail2ban_config, id=1) and per-VM overrides (fail2ban_config_overrides), then push the
// result into the actual jail.d files on affected servers (fail2ban-manager.js's/waf-manager.js's
// pushIgnoreIp — despite the name, it now also re-applies the VM's current effective bantime, see
// its own comment). Previously these values were hardcoded module-level constants in
// ssh-security-collector.js/nginx-waf-collector.js — see fail2ban-config.js for how a per-VM
// "effective" value is now resolved (global default, overridden per-field if a row exists here).
const express = require('express');
const router = express.Router();
const db = require('../database');
const { requirePermission, logActivity } = require('../auth');
const fail2banConfig = require('../fail2ban-config');
const fail2banManager = require('../fail2ban-manager');
const wafManager = require('../waf-manager');

// [min, max] for plain-count/window fields; the two *_bantime_sec fields are validated separately
// below (special "-1 or >=60" rule — fail2ban's own sentinel for "never expire").
const FIELD_RANGES = {
  ssh_brute_force_window_sec: [10, 3600],
  ssh_brute_force_threshold: [1, 1000],
  ssh_block_foreign_immediately: [0, 1],
  waf_scan_error_threshold: [1, 10000],
  waf_dos_request_threshold: [1, 10000],
  waf_dos_window_sec: [1, 3600],
  waf_ddos_multiplier: [1, 100],
  waf_ddos_min_total: [1, 1000000],
};
const BANTIME_FIELDS = new Set(['ssh_bantime_sec', 'waf_bantime_sec']);

function validateField(key, value) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return `${key}: phải là số nguyên`;
  if (BANTIME_FIELDS.has(key)) {
    if (n !== -1 && n < 60) return `${key}: phải là -1 (chặn vĩnh viễn) hoặc từ 60 giây trở lên`;
    return null;
  }
  const range = FIELD_RANGES[key];
  if (range && (n < range[0] || n > range[1])) return `${key}: phải trong khoảng ${range[0]}-${range[1]}`;
  return null;
}

// allowNull: overrides support an explicit null ("clear this field, inherit the global default
// again") — the global config itself never allows null, every field there must have a real value.
function validateBody(body, allowNull) {
  const errors = [];
  const clean = {};
  for (const key of fail2banConfig.FIELDS) {
    if (!(key in body)) continue; // partial update — untouched fields keep their current value
    const v = body[key];
    if (v === null) {
      if (!allowNull) { errors.push(`${key}: không được để trống`); continue; }
      clean[key] = null;
      continue;
    }
    const err = validateField(key, v);
    if (err) { errors.push(err); continue; }
    clean[key] = Number(v);
  }
  return { clean, errors };
}

async function pushToVm(vm) {
  const results = {};
  if (vm.fail2ban_status === 'running') results.ssh = await fail2banManager.pushIgnoreIp(vm);
  if (vm.waf_jail_status === 'running') results.waf = await wafManager.pushIgnoreIp(vm);
  return results;
}

router.get('/global', async (req, res) => {
  res.json(await fail2banConfig.getGlobalConfig());
});

router.patch('/global', requirePermission('fail2ban.config.manage'), async (req, res) => {
  const { clean, errors } = validateBody(req.body, false);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  const cols = Object.keys(clean);
  if (!cols.length) return res.status(400).json({ error: 'Không có trường nào để cập nhật' });

  await db.prepare(`UPDATE fail2ban_config SET ${cols.map(k => `${k} = ?`).join(', ')} WHERE id = 1`).run(...cols.map(c => clean[c]));
  await logActivity(req.user, 'UPDATE', 'fail2ban_config', 1, 'Cấu hình chung', `Cập nhật cấu hình fail2ban mặc định: ${cols.join(', ')}`);

  // pushIgnoreIp recomputes each VM's own EFFECTIVE config internally (global + its own override),
  // so pushing to every monitored VM here is correct regardless of which fields just changed and
  // regardless of whether a given VM has any override of its own.
  const sshVms = await db.prepare(`
    SELECT id, name, ip_address, ssh_credential_id, ssh_port, fail2ban_status, waf_jail_status FROM vcenter_vms
    WHERE fail2ban_status = 'running' AND ssh_credential_id IS NOT NULL
  `).all();
  const wafOnlyVms = await db.prepare(`
    SELECT id, name, ip_address, ssh_credential_id, ssh_port, fail2ban_status, waf_jail_status FROM vcenter_vms
    WHERE waf_jail_status = 'running' AND ssh_credential_id IS NOT NULL AND fail2ban_status != 'running'
  `).all();
  const allVms = [...sshVms, ...wafOnlyVms];
  const results = await Promise.allSettled(allVms.map(pushToVm));
  const okCount = results.filter(r => r.status === 'fulfilled' && (r.value.ssh?.ok || r.value.waf?.ok)).length;
  res.json({ config: await fail2banConfig.getGlobalConfig(), pushed: { ok: okCount, total: allVms.length } });
});

// Every VM that's a candidate for an override — SSH-monitored (fail2ban ever checked/installed) or
// WAF-enabled — regardless of current jail status, so an admin can pre-configure an override before
// the jail is even installed; the push simply no-ops for a VM with no running jail yet (pushToVm).
router.get('/overrides', async (req, res) => {
  const vms = await db.prepare(`
    SELECT id, name FROM vcenter_vms
    WHERE ssh_credential_id IS NOT NULL AND (fail2ban_status IS NOT NULL OR waf_enabled = 1)
    ORDER BY name ASC
  `).all();
  const overrides = await fail2banConfig.getAllOverrides();
  const byVm = new Map(overrides.map(o => [o.vm_id, o]));
  res.json(vms.map(vm => ({ vmId: vm.id, vmName: vm.name, override: byVm.get(vm.id) || null })));
});

router.get('/effective/:vmId', async (req, res) => {
  res.json(await fail2banConfig.getEffectiveConfig(Number(req.params.vmId)));
});

router.patch('/overrides/:vmId', requirePermission('fail2ban.config.manage'), async (req, res) => {
  const vmId = Number(req.params.vmId);
  const vm = await db.prepare('SELECT id, name, ip_address, ssh_credential_id, ssh_port, fail2ban_status, waf_jail_status FROM vcenter_vms WHERE id = ?').get(vmId);
  if (!vm) return res.status(404).json({ error: 'Không tìm thấy VM' });

  const { clean, errors } = validateBody(req.body, true);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  const cols = Object.keys(clean);
  if (!cols.length) return res.status(400).json({ error: 'Không có trường nào để cập nhật' });

  await db.prepare(`
    INSERT INTO fail2ban_config_overrides (vm_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})
    ON DUPLICATE KEY UPDATE ${cols.map(c => `${c} = VALUES(${c})`).join(', ')}
  `).run(vmId, ...cols.map(c => clean[c]));

  await logActivity(req.user, 'UPDATE', 'vcenter_vm', vm.id, vm.name, `Ghi đè cấu hình fail2ban riêng cho VM: ${cols.join(', ')}`);
  res.json({ effective: await fail2banConfig.getEffectiveConfig(vmId), pushed: await pushToVm(vm) });
});

router.delete('/overrides/:vmId', requirePermission('fail2ban.config.manage'), async (req, res) => {
  const vmId = Number(req.params.vmId);
  const vm = await db.prepare('SELECT id, name, ip_address, ssh_credential_id, ssh_port, fail2ban_status, waf_jail_status FROM vcenter_vms WHERE id = ?').get(vmId);
  if (!vm) return res.status(404).json({ error: 'Không tìm thấy VM' });
  await db.prepare('DELETE FROM fail2ban_config_overrides WHERE vm_id = ?').run(vmId);
  await logActivity(req.user, 'UPDATE', 'vcenter_vm', vm.id, vm.name, 'Xóa ghi đè cấu hình fail2ban riêng — quay lại dùng cấu hình chung');
  res.json({ effective: await fail2banConfig.getEffectiveConfig(vmId), pushed: await pushToVm(vm) });
});

module.exports = router;
