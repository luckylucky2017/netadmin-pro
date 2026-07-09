const express = require('express');
const router = express.Router();
const db = require('../database');
const { requirePermission, wouldOrphanPermission, logActivity } = require('../auth');
const { PERMISSIONS, PERMISSION_KEYS } = require('../permissions-catalog');

// Every route here needs roles.manage — including read (GET /permissions exposes the full
// permission taxonomy, no reason to show that to a session without role-management access).
router.use(requirePermission('roles.manage'));

async function withPermissions(role) {
  const permissions = (await db.prepare('SELECT permission FROM role_permissions WHERE role_id = ?').all(role.id)).map(r => r.permission);
  const userCount = (await db.prepare("SELECT COUNT(*) as cnt FROM users WHERE role_id = ? AND status = 'active'").get(role.id)).cnt;
  return { ...role, permissions, userCount };
}

router.get('/', async (req, res) => {
  const roles = await db.prepare('SELECT * FROM roles ORDER BY is_system DESC, name ASC').all();
  res.json(await Promise.all(roles.map(withPermissions)));
});

router.get('/permissions', (req, res) => {
  res.json(PERMISSIONS);
});

router.post('/', async (req, res) => {
  const { name, permissions } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Thiếu tên vai trò' });
  const perms = Array.isArray(permissions) ? permissions : [];
  const invalid = perms.filter(p => !PERMISSION_KEYS.has(p));
  if (invalid.length) return res.status(400).json({ error: `Khóa quyền không hợp lệ: ${invalid.join(', ')}` });
  try {
    const createRole = db.transaction(async () => {
      const info = await db.prepare('INSERT INTO roles (name, is_system) VALUES (?, 0)').run(name.trim());
      const insertPerm = db.prepare('INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)');
      for (const p of perms) await insertPerm.run(info.lastInsertRowid, p);
      return info.lastInsertRowid;
    });
    const roleId = await createRole();
    await logActivity(req.user, 'CREATE', 'role', roleId, name.trim(), `Tạo vai trò tùy biến với ${perms.length} quyền`);
    res.status(201).json(await withPermissions(await db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId)));
  } catch (e) {
    if (/Duplicate entry/.test(e.message)) return res.status(400).json({ error: 'Tên vai trò đã tồn tại' });
    res.status(500).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  const role = await db.prepare('SELECT * FROM roles WHERE id = ?').get(req.params.id);
  if (!role) return res.status(404).json({ error: 'Không tìm thấy vai trò' });
  if (role.is_system) return res.status(400).json({ error: 'Không thể sửa vai trò hệ thống (Admin/Operator/Viewer)' });
  const { name, permissions } = req.body || {};
  const perms = Array.isArray(permissions) ? permissions : null;
  if (perms) {
    const invalid = perms.filter(p => !PERMISSION_KEYS.has(p));
    if (invalid.length) return res.status(400).json({ error: `Khóa quyền không hợp lệ: ${invalid.join(', ')}` });
    // Would this edit drop users.manage/roles.manage to zero active holders anywhere in the system?
    for (const guarded of ['users.manage', 'roles.manage']) {
      const stillGranted = perms.includes(guarded);
      if (!stillGranted && await wouldOrphanPermission(guarded, { excludeRoleId: role.id })) {
        return res.status(400).json({ error: `Không thể bỏ quyền "${guarded}" khỏi vai trò này — sẽ không còn ai trong hệ thống có quyền đó.` });
      }
    }
  }
  try {
    const updateRole = db.transaction(async () => {
      if (name && name.trim()) await db.prepare('UPDATE roles SET name = ? WHERE id = ?').run(name.trim(), role.id);
      if (perms) {
        await db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(role.id);
        const insertPerm = db.prepare('INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)');
        for (const p of perms) await insertPerm.run(role.id, p);
      }
    });
    await updateRole();
    await logActivity(req.user, 'UPDATE', 'role', role.id, name?.trim() || role.name, 'Cập nhật vai trò');
    res.json(await withPermissions(await db.prepare('SELECT * FROM roles WHERE id = ?').get(role.id)));
  } catch (e) {
    if (/Duplicate entry/.test(e.message)) return res.status(400).json({ error: 'Tên vai trò đã tồn tại' });
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  const role = await db.prepare('SELECT * FROM roles WHERE id = ?').get(req.params.id);
  if (!role) return res.status(404).json({ error: 'Không tìm thấy vai trò' });
  if (role.is_system) return res.status(400).json({ error: 'Không thể xóa vai trò hệ thống (Admin/Operator/Viewer)' });
  const userCount = (await db.prepare('SELECT COUNT(*) as cnt FROM users WHERE role_id = ?').get(role.id)).cnt;
  if (userCount > 0) {
    return res.status(400).json({ error: `Còn ${userCount} user đang dùng vai trò này — chuyển họ sang vai trò khác trước khi xóa.` });
  }
  await db.prepare('DELETE FROM roles WHERE id = ?').run(role.id); // ON DELETE CASCADE cleans up role_permissions
  await logActivity(req.user, 'DELETE', 'role', role.id, role.name, 'Xóa vai trò');
  res.json({ message: 'Đã xóa' });
});

module.exports = router;
