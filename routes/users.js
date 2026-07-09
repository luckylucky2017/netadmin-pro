const express = require('express');
const router = express.Router();
const db = require('../database');
const { hashPassword, sanitizeUser, wouldOrphanPermission, logActivity } = require('../auth');

// This whole router is mounted behind requireAuth + requirePermission('users.manage') in
// server.js — every route here already assumes req.user holds users.manage.

const GET_USER_WITH_ROLE = `SELECT u.*, r.name as roleName FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = ?`;
const permsOfRole = async (roleId) => roleId ? (await db.prepare('SELECT permission FROM role_permissions WHERE role_id = ?').all(roleId)).map(r => r.permission) : [];

router.get('/', async (req, res) => {
  const users = await db.prepare(`SELECT u.*, r.name as roleName FROM users u LEFT JOIN roles r ON r.id = u.role_id ORDER BY u.name ASC`).all();
  res.json(users.map(sanitizeUser));
});

router.post('/', async (req, res) => {
  const { email, password, name, roleId } = req.body || {};
  if (!email || !name) return res.status(400).json({ error: 'Thiếu email hoặc tên' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'Mật khẩu cần ít nhất 8 ký tự' });
  const role = roleId ? await db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId) : await db.prepare("SELECT * FROM roles WHERE name = 'Viewer'").get();
  if (!role) return res.status(400).json({ error: 'Vai trò không hợp lệ' });
  try {
    const info = await db.prepare(`
      INSERT INTO users (email, password_hash, name, role_id, auth_provider, status)
      VALUES (?, ?, ?, ?, 'local', 'active')
    `).run(String(email).toLowerCase(), hashPassword(password), name, role.id);
    await logActivity(req.user, 'CREATE', 'user', info.lastInsertRowid, name, `Tạo user local (${email}), vai trò ${role.name}`);
    res.status(201).json(sanitizeUser(await db.prepare(GET_USER_WITH_ROLE).get(info.lastInsertRowid)));
  } catch (e) {
    if (/Duplicate entry/.test(e.message)) return res.status(400).json({ error: 'Email đã tồn tại' });
    res.status(500).json({ error: e.message });
  }
});

router.patch('/:id', async (req, res) => {
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Không tìm thấy user' });
  const { name, roleId, status } = req.body || {};
  if (status && !['active', 'disabled'].includes(status)) return res.status(400).json({ error: 'Trạng thái không hợp lệ' });
  let newRole = null;
  if (roleId) {
    newRole = await db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId);
    if (!newRole) return res.status(400).json({ error: 'Vai trò không hợp lệ' });
  }

  // Would this edit (role change and/or disabling) drop users.manage/roles.manage to zero active
  // holders system-wide? Applies uniformly whether editing self or another user — for self-edits
  // this is what stops an admin demoting/disabling their own only-admin account; for others it
  // closes the gap where editing someone else's role could silently lock a third party out.
  const currentPerms = await permsOfRole(user.role_id);
  const resultingStatus = status || user.status;
  const resultingPerms = resultingStatus === 'active' ? await permsOfRole(roleId || user.role_id) : [];
  for (const guarded of ['users.manage', 'roles.manage']) {
    if (currentPerms.includes(guarded) && !resultingPerms.includes(guarded) && await wouldOrphanPermission(guarded, { excludeUserId: user.id })) {
      return res.status(400).json({ error: `Không thể thực hiện — sẽ không còn ai trong hệ thống có quyền "${guarded}".` });
    }
  }

  await db.prepare('UPDATE users SET name = COALESCE(?, name), role_id = COALESCE(?, role_id), status = COALESCE(?, status), updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(name || null, roleId || null, status || null, user.id);
  await logActivity(req.user, 'UPDATE', 'user', user.id, name || user.name, `Cập nhật thông tin user${newRole ? `, vai trò mới: ${newRole.name}` : ''}`);
  res.json(sanitizeUser(await db.prepare(GET_USER_WITH_ROLE).get(user.id)));
});

router.post('/:id/reset-password', async (req, res) => {
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Không tìm thấy user' });
  if (user.auth_provider !== 'local') return res.status(400).json({ error: 'Chỉ tài khoản local mới có mật khẩu để đặt lại' });
  const { password } = req.body || {};
  if (!password || password.length < 8) return res.status(400).json({ error: 'Mật khẩu cần ít nhất 8 ký tự' });
  await db.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(hashPassword(password), user.id);
  await logActivity(req.user, 'UPDATE', 'user', user.id, user.name, 'Đặt lại mật khẩu');
  res.json({ message: 'OK' });
});

router.delete('/:id', async (req, res) => {
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Không tìm thấy user' });
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'Không thể tự xóa chính mình' });
  const currentPerms = await permsOfRole(user.role_id);
  for (const guarded of ['users.manage', 'roles.manage']) {
    if (currentPerms.includes(guarded) && await wouldOrphanPermission(guarded, { excludeUserId: user.id })) {
      return res.status(400).json({ error: `Không thể xóa — sẽ không còn ai trong hệ thống có quyền "${guarded}".` });
    }
  }
  await db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  await logActivity(req.user, 'DELETE', 'user', user.id, user.name, 'Xóa user');
  res.json({ message: 'Đã xóa' });
});

module.exports = router;
