const express = require('express');
const router = express.Router();
const db = require('../database');
const { requirePermission, logActivity } = require('../auth');
const sshCredentials = require('../ssh-credentials');

// private_key/passphrase/password are credentials — never returned to the client, same treatment
// as servers.ipmi_password/vcenter_clusters.password.
function sanitizeCredential(c) {
  if (!c) return c;
  const { private_key, passphrase, password, ...rest } = c;
  return { ...rest, has_private_key: !!private_key, has_password: !!password };
}

async function usageCount(id) {
  const [servers, vms] = await Promise.all([
    db.prepare('SELECT COUNT(*) as cnt FROM servers WHERE ssh_credential_id = ?').get(id),
    db.prepare('SELECT COUNT(*) as cnt FROM vcenter_vms WHERE ssh_credential_id = ?').get(id),
  ]);
  return servers.cnt + vms.cnt;
}

router.get('/', requirePermission('ssh_credentials.manage'), async (req, res) => {
  const creds = await db.prepare('SELECT * FROM ssh_credentials ORDER BY is_default DESC, name ASC').all();
  const withUsage = await Promise.all(creds.map(async c => ({ ...sanitizeCredential(c), usage_count: await usageCount(c.id) })));
  res.json(withUsage);
});

// Lighter, read-open list for the credential-select dropdowns on the Server form and the Security
// page's "Quản lý VM giám sát" tab — any authenticated role that can edit a server/VM's SSH config
// needs to see credential names, without needing ssh_credentials.manage itself (matches how
// GET /vcenter/clusters is open to any role while only its CRUD is Admin-gated).
router.get('/options', async (req, res) => {
  const creds = await db.prepare('SELECT id, name, auth_type, username, is_default FROM ssh_credentials ORDER BY is_default DESC, name ASC').all();
  res.json(creds);
});

router.post('/', requirePermission('ssh_credentials.manage'), async (req, res) => {
  const { name, auth_type, username, private_key, passphrase, password, is_default, notes } = req.body;
  if (!name || !username) return res.status(400).json({ error: 'Thiếu name/username' });
  if (auth_type === 'password' && !password) return res.status(400).json({ error: 'Thiếu password' });
  if (auth_type !== 'password' && !private_key) return res.status(400).json({ error: 'Thiếu private_key' });
  const run = db.transaction(async () => {
    if (is_default) await db.prepare('UPDATE ssh_credentials SET is_default = 0').run();
    return db.prepare(`
      INSERT INTO ssh_credentials (name, auth_type, username, private_key, passphrase, password, is_default, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, auth_type === 'password' ? 'password' : 'private_key', username,
      auth_type === 'password' ? null : private_key, auth_type === 'password' ? null : (passphrase || null),
      auth_type === 'password' ? password : null, is_default ? 1 : 0, notes || null);
  });
  const result = await run();
  await logActivity(req.user, 'CREATE', 'ssh_credential', result.lastInsertRowid, name);
  res.status(201).json({ id: result.lastInsertRowid, message: 'Đã tạo tài khoản kết nối' });
});

router.put('/:id', requirePermission('ssh_credentials.manage'), async (req, res) => {
  const cred = await db.prepare('SELECT id, name FROM ssh_credentials WHERE id = ?').get(req.params.id);
  if (!cred) return res.status(404).json({ error: 'Không tìm thấy tài khoản kết nối' });
  const { name, auth_type, username, private_key, passphrase, password, is_default, notes } = req.body;
  if (!name || !username) return res.status(400).json({ error: 'Thiếu name/username' });
  const run = db.transaction(async () => {
    if (is_default) await db.prepare('UPDATE ssh_credentials SET is_default = 0 WHERE id != ?').run(req.params.id);
    // Blank private_key/passphrase/password = keep existing — same COALESCE/NULLIF pattern
    // routes/servers.js uses for ipmi_password.
    await db.prepare(`
      UPDATE ssh_credentials SET name=?, auth_type=?, username=?,
        private_key = CASE WHEN ? = 'password' THEN NULL ELSE COALESCE(NULLIF(?, ''), private_key) END,
        passphrase = CASE WHEN ? = 'password' THEN NULL ELSE COALESCE(NULLIF(?, ''), passphrase) END,
        password = CASE WHEN ? = 'password' THEN COALESCE(NULLIF(?, ''), password) ELSE NULL END,
        is_default=?, notes=?, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(name, auth_type === 'password' ? 'password' : 'private_key', username,
      auth_type, private_key || '', auth_type, passphrase || '', auth_type, password || '',
      is_default ? 1 : 0, notes || null, req.params.id);
  });
  await run();
  // No cache to invalidate — getCredential() always reads fresh from the DB (unlike
  // vcenter-registry.js's per-cluster session cache), so an edit takes effect on the very next call.
  await logActivity(req.user, 'UPDATE', 'ssh_credential', req.params.id, name);
  res.json({ message: 'Đã cập nhật' });
});

router.delete('/:id', requirePermission('ssh_credentials.manage'), async (req, res) => {
  const cred = await db.prepare('SELECT id, name FROM ssh_credentials WHERE id = ?').get(req.params.id);
  if (!cred) return res.status(404).json({ error: 'Không tìm thấy tài khoản kết nối' });
  const [servers, vms] = await Promise.all([
    db.prepare('SELECT name FROM servers WHERE ssh_credential_id = ?').all(req.params.id),
    db.prepare('SELECT name FROM vcenter_vms WHERE ssh_credential_id = ?').all(req.params.id),
  ]);
  const inUse = [...servers, ...vms];
  if (inUse.length) {
    return res.status(400).json({
      error: `Đang được dùng bởi ${inUse.length} máy chủ/VM — gỡ hết trước khi xóa: ${inUse.slice(0, 5).map(r => r.name).join(', ')}${inUse.length > 5 ? '...' : ''}`
    });
  }
  await db.prepare('DELETE FROM ssh_credentials WHERE id = ?').run(req.params.id);
  await logActivity(req.user, 'DELETE', 'ssh_credential', req.params.id, cred.name);
  res.json({ message: 'Đã xóa' });
});

router.post('/test', requirePermission('ssh_credentials.manage'), async (req, res) => {
  const { credentialId, host, port } = req.body;
  if (!credentialId || !host) return res.status(400).json({ error: 'Thiếu credentialId/host' });
  try {
    const result = await sshCredentials.testConnection({ credentialId, host, port });
    res.json(result);
  } catch (e) {
    res.json({ ok: false, message: e.message });
  }
});

module.exports = router;
