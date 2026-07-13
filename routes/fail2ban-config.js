// Admin page backing "Cấu hình Fail2ban" — read/write the global default detection thresholds +
// bantime (fail2ban_config, id=1), named reusable profiles (fail2ban_config_profiles) assignable to
// any server, and per-VM field-level overrides (fail2ban_config_overrides) — then push the result
// into the actual jail.d files on affected servers (fail2ban-manager.js's/waf-manager.js's
// pushIgnoreIp — despite the name, it now also re-applies the VM's current effective bantime, see
// its own comment). Previously these values were hardcoded module-level constants in
// ssh-security-collector.js/nginx-waf-collector.js — see fail2ban-config.js for how a per-VM
// "effective" value is now resolved (global default, overridden by an assigned profile, overridden
// again by a per-VM field-level override — in that precedence).
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

async function pushToVms(vms) {
  const results = await Promise.allSettled(vms.map(pushToVm));
  const ok = results.filter(r => r.status === 'fulfilled' && (r.value.ssh?.ok || r.value.waf?.ok)).length;
  return { ok, total: vms.length };
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
  res.json({ config: await fail2banConfig.getGlobalConfig(), pushed: await pushToVms(allVms) });
});

// ── Profiles: named, reusable presets assignable to any server (vcenter_vms.fail2ban_profile_id) ──
function validateProfileBody(body) {
  const errors = [];
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) errors.push('name: bắt buộc nhập tên hồ sơ');
  if (name.length > 100) errors.push('name: tối đa 100 ký tự');
  const description = typeof body.description === 'string' ? body.description.trim().slice(0, 255) : '';
  const { clean, errors: fieldErrors } = validateBody(body, false);
  errors.push(...fieldErrors);
  // A profile must define every field (it's a complete bundle, not a partial override) — reject if
  // any of the 10 required fields is missing from the request entirely.
  const missing = fail2banConfig.FIELDS.filter(k => !(k in clean));
  if (missing.length) errors.push(`Thiếu trường bắt buộc: ${missing.join(', ')}`);
  return { name, description, clean, errors };
}

router.get('/profiles', async (req, res) => {
  res.json(await fail2banConfig.getAllProfiles());
});

router.post('/profiles', requirePermission('fail2ban.config.manage'), async (req, res) => {
  const { name, description, clean, errors } = validateProfileBody(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  const cols = Object.keys(clean);
  try {
    const result = await db.prepare(`
      INSERT INTO fail2ban_config_profiles (name, description, ${cols.join(', ')})
      VALUES (?, ?, ${cols.map(() => '?').join(', ')})
    `).run(name, description || null, ...cols.map(c => clean[c]));
    await logActivity(req.user, 'CREATE', 'fail2ban_config_profile', result.lastInsertRowid, name, `Tạo hồ sơ cấu hình fail2ban: ${name}`);
    res.json(await fail2banConfig.getProfile(result.lastInsertRowid));
  } catch (e) {
    if (e.errno === 1062) return res.status(400).json({ error: `Đã tồn tại hồ sơ tên "${name}"` });
    throw e;
  }
});

router.patch('/profiles/:id', requirePermission('fail2ban.config.manage'), async (req, res) => {
  const profileId = Number(req.params.id);
  const profile = await fail2banConfig.getProfile(profileId);
  if (!profile) return res.status(404).json({ error: 'Không tìm thấy hồ sơ' });

  const { name, description, clean, errors } = validateProfileBody(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  const cols = Object.keys(clean);
  try {
    await db.prepare(`
      UPDATE fail2ban_config_profiles SET name = ?, description = ?, ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?
    `).run(name, description || null, ...cols.map(c => clean[c]), profileId);
  } catch (e) {
    if (e.errno === 1062) return res.status(400).json({ error: `Đã tồn tại hồ sơ tên "${name}"` });
    throw e;
  }
  await logActivity(req.user, 'UPDATE', 'fail2ban_config_profile', profileId, name, `Cập nhật hồ sơ cấu hình fail2ban: ${name}`);

  // Live reference — every server currently assigned to this profile needs the new values re-pushed.
  const vms = await fail2banConfig.getVmsUsingProfile(profileId);
  res.json({ profile: await fail2banConfig.getProfile(profileId), pushed: await pushToVms(vms) });
});

router.delete('/profiles/:id', requirePermission('fail2ban.config.manage'), async (req, res) => {
  const profileId = Number(req.params.id);
  const profile = await fail2banConfig.getProfile(profileId);
  if (!profile) return res.status(404).json({ error: 'Không tìm thấy hồ sơ' });

  // Every VM using this profile falls back to the global default (or its own override, if any) —
  // unassign first, then delete, then re-push so those servers' real jail.d files reflect the loss
  // of the profile immediately instead of silently drifting until their next unrelated push.
  const vms = await fail2banConfig.getVmsUsingProfile(profileId);
  await db.prepare('UPDATE vcenter_vms SET fail2ban_profile_id = NULL WHERE fail2ban_profile_id = ?').run(profileId);
  await db.prepare('DELETE FROM fail2ban_config_profiles WHERE id = ?').run(profileId);
  await logActivity(req.user, 'DELETE', 'fail2ban_config_profile', profileId, profile.name, `Xóa hồ sơ cấu hình fail2ban: ${profile.name} (${vms.length} server quay lại cấu hình mặc định)`);
  res.json({ pushed: await pushToVms(vms) });
});

// Every VM that's a candidate for an override — SSH-monitored (fail2ban ever checked/installed) or
// WAF-enabled — regardless of current jail status, so an admin can pre-configure an override before
// the jail is even installed; the push simply no-ops for a VM with no running jail yet (pushToVm).
router.get('/overrides', async (req, res) => {
  const vms = await db.prepare(`
    SELECT v.id, v.name, v.fail2ban_profile_id, p.name as profileName FROM vcenter_vms v
    LEFT JOIN fail2ban_config_profiles p ON p.id = v.fail2ban_profile_id
    WHERE v.ssh_credential_id IS NOT NULL AND (v.fail2ban_status IS NOT NULL OR v.waf_enabled = 1)
    ORDER BY v.name ASC
  `).all();
  const overrides = await fail2banConfig.getAllOverrides();
  const byVm = new Map(overrides.map(o => [o.vm_id, o]));
  res.json(vms.map(vm => ({
    vmId: vm.id, vmName: vm.name,
    profileId: vm.fail2ban_profile_id, profileName: vm.profileName || null,
    override: byVm.get(vm.id) || null,
  })));
});

router.get('/effective/:vmId', async (req, res) => {
  res.json(await fail2banConfig.getEffectiveConfig(Number(req.params.vmId)));
});

router.patch('/overrides/:vmId', requirePermission('fail2ban.config.manage'), async (req, res) => {
  const vmId = Number(req.params.vmId);
  const vm = await db.prepare('SELECT id, name, ip_address, ssh_credential_id, ssh_port, fail2ban_status, waf_jail_status FROM vcenter_vms WHERE id = ?').get(vmId);
  if (!vm) return res.status(404).json({ error: 'Không tìm thấy VM' });

  // profileId is optional and independent of the per-field overrides below: undefined = leave the
  // VM's current profile assignment untouched, null = explicitly unassign, a number = assign (must
  // reference a real profile).
  let profileTouched = false;
  if ('profileId' in req.body) {
    const raw = req.body.profileId;
    if (raw === null) {
      await db.prepare('UPDATE vcenter_vms SET fail2ban_profile_id = NULL WHERE id = ?').run(vmId);
      profileTouched = true;
    } else {
      const profile = await fail2banConfig.getProfile(Number(raw));
      if (!profile) return res.status(400).json({ error: 'Hồ sơ cấu hình không tồn tại' });
      await db.prepare('UPDATE vcenter_vms SET fail2ban_profile_id = ? WHERE id = ?').run(profile.id, vmId);
      profileTouched = true;
    }
  }

  const { clean, errors } = validateBody(req.body, true);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  const cols = Object.keys(clean);
  if (!cols.length && !profileTouched) return res.status(400).json({ error: 'Không có trường nào để cập nhật' });

  if (cols.length) {
    await db.prepare(`
      INSERT INTO fail2ban_config_overrides (vm_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})
      ON DUPLICATE KEY UPDATE ${cols.map(c => `${c} = VALUES(${c})`).join(', ')}
    `).run(vmId, ...cols.map(c => clean[c]));
  }

  const changeNote = [profileTouched ? 'hồ sơ' : null, cols.length ? cols.join(', ') : null].filter(Boolean).join('; ');
  await logActivity(req.user, 'UPDATE', 'vcenter_vm', vm.id, vm.name, `Cập nhật cấu hình fail2ban riêng cho VM: ${changeNote}`);
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
