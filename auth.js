// Core auth: password hashing, session-based route guards, LDAP bind-auth, SAML client.
// Every other auth-related file (routes/auth.js, routes/users.js, server.js's per-route guards)
// builds on the primitives here rather than re-implementing them.
const bcrypt = require('bcryptjs');
const ldap = require('ldapjs');
const { SAML } = require('@node-saml/node-saml');
const db = require('./database');
const { getSettings } = require('./settings');
const { PERMISSION_KEYS } = require('./permissions-catalog');

function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}

function verifyPassword(plain, hash) {
  if (!hash) return false; // SSO-only account (no local password set)
  return bcrypt.compareSync(plain, hash);
}

// Drops password_hash AND the legacy `role` TEXT column (superseded by role_id/roleName/permissions
// below) — role is never updated once a user is on a custom role, so forwarding it would show a
// stale/misleading label anywhere the frontend reads it.
function sanitizeUser(u) {
  if (!u) return null;
  const { password_hash, role, ...rest } = u;
  return rest;
}

// Mutates + returns user with .permissions (a plain Array — NOT a Set, which JSON.stringify()s to
// '{}') and .roleName attached. Shared by requireAuth (every authenticated request) AND
// routes/auth.js's /login + /ldap/login handlers, which build their response directly from a fresh
// DB row rather than through requireAuth — those two call sites are easy to forget this on, since
// nothing fails loudly if it's skipped, the client just silently gets permissions: undefined.
async function attachPermissions(user) {
  if (!user) return user;
  user.permissions = user.role_id ? (await db.prepare('SELECT permission FROM role_permissions WHERE role_id = ?').all(user.role_id)).map(r => r.permission) : [];
  user.roleName = user.role_id ? (await db.prepare('SELECT name FROM roles WHERE id = ?').get(user.role_id))?.name : null;
  return user;
}

// Single write path for activity_logs — used at all 25 call sites across routes/*.js,
// vcenter-actions.js, and fail2ban-manager.js instead of each one hand-writing the INSERT.
// user_name/user_email are snapshotted here (not just user_id) so history still reads correctly
// even after that account is later renamed or deleted — same reasoning as entity_name already
// snapshotting the target object's name instead of requiring a JOIN. `user` is null for the (today
// nonexistent, but tolerated) case of an action with no request context — shows as "Hệ thống" in
// the UI rather than crashing.
function logActivity(user, action, entityType, entityId, entityName, details = null) {
  return db.prepare(
    'INSERT INTO activity_logs (action, entity_type, entity_id, entity_name, details, user_id, user_name, user_email) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(action, entityType, entityId, entityName, details, user?.id || null, user?.name || null, user?.email || null);
}

// Attaches req.user from the session; 401s if not logged in or the account was disabled after
// the session was issued (checked against the DB each request, not just trusted from the cookie).
// try/catch here specifically (rather than every route) because this runs on every single
// authenticated request — a transient MySQL hiccup shouldn't hang the request with no response.
async function requireAuth(req, res, next) {
  const userId = req.session?.userId;
  if (!userId) return res.status(401).json({ error: 'Chưa đăng nhập' });
  try {
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user || user.status !== 'active') {
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'Phiên đăng nhập không hợp lệ' });
    }
    req.user = await attachPermissions(user);
    next();
  } catch (e) {
    res.status(500).json({ error: `Lỗi xác thực: ${e.message}` });
  }
}

// requirePermission('vcenter.vm.create') — call after requireAuth. Takes a single key (there's no
// OR-semantics need here — every old 2-role requireRole bundle collapses into exactly one
// permission key by construction).
// Validates the key against the shared catalog at call-registration time (not per-request) so a
// typo'd permission key fails loudly on server startup instead of silently 403ing everyone forever.
function requirePermission(key) {
  if (!PERMISSION_KEYS.has(key)) {
    throw new Error(`requirePermission: khóa quyền không tồn tại trong permissions-catalog.js: "${key}"`);
  }
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Chưa đăng nhập' });
    if (!req.user.permissions.includes(key)) {
      return res.status(403).json({ error: 'Bạn không có quyền thực hiện thao tác này' });
    }
    next();
  };
}

// Guards the two "keys to the kingdom" permissions (users.manage, roles.manage) against being
// dropped to zero holders — via editing a role's permission set, or deleting/disabling a user who
// held one of these through their role. Not applied to the other ~19 permissions: nobody needs a
// hard block on "last person who can delete alerts", and system roles (Admin/Operator/Viewer) are
// immutable anyway so this only ever fires for custom-role edits or user changes.
// excludeUserId: pretend this user no longer holds the permission (simulating their deletion/disable).
// excludeRoleId: pretend this role has none of its current permissions (simulating a role edit).
async function wouldOrphanPermission(permission, { excludeUserId, excludeRoleId } = {}) {
  const holders = await db.prepare(`
    SELECT u.id, u.role_id FROM users u
    JOIN role_permissions rp ON rp.role_id = u.role_id AND rp.permission = ?
    WHERE u.status = 'active'
  `).all(permission);
  const remaining = holders.filter(h => h.id !== excludeUserId && h.role_id !== excludeRoleId);
  return remaining.length === 0;
}

// Two-bind pattern: first bind with a service account to search the directory for the user's DN,
// then bind AGAIN using that DN + the password the user actually typed — that second bind is the
// real authentication check (a directory search alone proves nothing about the password).
async function ldapAuthenticate(username, password) {
  const settings = await getSettings();
  return new Promise((resolve, reject) => {
    if (!settings.ldap_url) return reject(new Error('LDAP chưa được cấu hình'));
    const client = ldap.createClient({ url: settings.ldap_url, timeout: 8000, connectTimeout: 8000 });
    client.on('error', (err) => reject(new Error(`Không kết nối được LDAP: ${err.message}`)));

    client.bind(settings.ldap_bind_dn, settings.ldap_bind_password, (bindErr) => {
      if (bindErr) { client.unbind(); return reject(new Error(`LDAP service account bind thất bại: ${bindErr.message}`)); }

      const filter = (settings.ldap_user_filter || '(sAMAccountName={{username}})').replace('{{username}}', ldap.filters.escape(username));
      client.search(settings.ldap_base_dn, { filter, scope: 'sub', attributes: ['dn', 'mail', 'cn', 'displayName'] }, (searchErr, res) => {
        if (searchErr) { client.unbind(); return reject(new Error(`LDAP search thất bại: ${searchErr.message}`)); }
        let entry = null;
        res.on('searchEntry', (e) => { entry = e.pojo || e; });
        res.on('error', (err) => { client.unbind(); reject(new Error(`LDAP search lỗi: ${err.message}`)); });
        res.on('end', () => {
          if (!entry) { client.unbind(); return reject(new Error('Không tìm thấy user trong LDAP')); }
          const dn = entry.objectName || entry.dn;
          const attrs = Object.fromEntries((entry.attributes || []).map(a => [a.type, a.values?.[0]]));

          const userClient = ldap.createClient({ url: settings.ldap_url, timeout: 8000, connectTimeout: 8000 });
          userClient.on('error', (err) => { client.unbind(); reject(new Error(`Không kết nối được LDAP: ${err.message}`)); });
          userClient.bind(dn, password, (authErr) => {
            client.unbind();
            userClient.unbind();
            if (authErr) return reject(new Error('Sai username hoặc mật khẩu LDAP'));
            resolve({
              externalId: dn,
              email: (attrs.mail || `${username}@ldap.local`).toLowerCase(),
              name: attrs.displayName || attrs.cn || username
            });
          });
        });
      });
    });
  });
}

// Built fresh from app_settings on every call (cheap — no network call, just object construction)
// rather than cached like before, so an admin editing SAML settings in the UI takes effect on the
// very next login attempt instead of needing a server restart.
async function getSamlClient() {
  const settings = await getSettings();
  if (!settings.saml_idp_entry_point || !settings.saml_idp_cert) return null;
  return new SAML({
    entryPoint: settings.saml_idp_entry_point,
    issuer: settings.saml_sp_entity_id || 'netadmin-pro',
    callbackUrl: settings.saml_sp_callback_url,
    idpCert: settings.saml_idp_cert,
    wantAssertionsSigned: true,
  });
}

// Finds an existing SSO-linked user or auto-provisions one — first-time SSO logins land as
// 'viewer' by default; an admin has to explicitly promote them, same as any other new account.
async function findOrCreateSsoUser({ provider, externalId, email, name }) {
  const existing = await db.prepare('SELECT * FROM users WHERE auth_provider = ? AND external_id = ?').get(provider, externalId)
    || await db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (existing) {
    await db.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP, external_id = ?, auth_provider = ? WHERE id = ?')
      .run(externalId, provider, existing.id);
    return db.prepare('SELECT * FROM users WHERE id = ?').get(existing.id);
  }
  // role_id (not just the legacy `role` string) must be set here — otherwise a first-time SSO user
  // gets role_id = NULL and silently fails every requirePermission() check with no visible error.
  const viewerRoleId = (await db.prepare("SELECT id FROM roles WHERE name = 'Viewer'").get()).id;
  const info = await db.prepare(`
    INSERT INTO users (email, name, role_id, auth_provider, external_id, status, last_login_at)
    VALUES (?, ?, ?, ?, ?, 'active', CURRENT_TIMESTAMP)
  `).run(email, name, viewerRoleId, provider, externalId);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
}

module.exports = {
  hashPassword, verifyPassword, sanitizeUser, requireAuth, requirePermission, attachPermissions,
  wouldOrphanPermission, ldapAuthenticate, getSamlClient, findOrCreateSsoUser, logActivity
};
