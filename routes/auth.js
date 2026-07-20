const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const db = require('../database');
const { verifyPassword, sanitizeUser, requireAuth, attachPermissions, ldapAuthenticate, getSamlClient, findOrCreateSsoUser, DUMMY_PASSWORD_HASH } = require('../auth');

// Chống brute-force vào chính app này — cùng tinh thần với fail2ban đang bảo vệ SSH ở các VM khác.
const loginLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Thử đăng nhập quá nhiều lần, vui lòng thử lại sau ít phút' } });

// Per-account lockout — the IP-based limiter above doesn't slow an attacker who rotates source IPs
// against one specific target account.
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;

router.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Thiếu email hoặc mật khẩu' });
  const user = await db.prepare('SELECT * FROM users WHERE email = ? AND auth_provider = ?').get(String(email).toLowerCase(), 'local');
  if (user && user.locked_until && new Date(user.locked_until) > new Date()) {
    return res.status(401).json({ error: 'Tài khoản tạm khóa do đăng nhập sai nhiều lần, vui lòng thử lại sau' });
  }
  // Always run a bcrypt compare of the same cost, whether or not the account exists — otherwise the
  // nonexistent-email path returns near-instantly (skipping bcrypt) while a real account with a
  // wrong password takes ~150-250ms, a timing side-channel letting an attacker enumerate valid
  // emails (found during a pentest: a consistent, measurable gap between the two).
  const passwordOk = verifyPassword(password, user ? user.password_hash : DUMMY_PASSWORD_HASH);
  if (!user || user.status !== 'active' || !passwordOk) {
    if (user) {
      const failedCount = user.failed_login_count + 1;
      const lockedUntil = failedCount >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000) : null;
      await db.prepare('UPDATE users SET failed_login_count = ?, locked_until = ? WHERE id = ?').run(failedCount, lockedUntil, user.id);
    }
    return res.status(401).json({ error: 'Email hoặc mật khẩu không đúng' });
  }
  await db.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP, failed_login_count = 0, locked_until = NULL WHERE id = ?').run(user.id);
  req.session.userId = user.id;
  res.json({ user: sanitizeUser(await attachPermissions(user)) });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ message: 'OK' }));
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: sanitizeUser(req.user) });
});

router.get('/saml/login', async (req, res) => {
  const saml = await getSamlClient();
  if (!saml) return res.status(503).json({ error: 'SAML chưa được cấu hình trên server này' });
  saml.getAuthorizeUrlAsync('', req.headers.host, {})
    .then(url => res.redirect(url))
    .catch(e => res.status(502).json({ error: `Không tạo được URL đăng nhập SAML: ${e.message}` }));
});

router.post('/saml/callback', express.urlencoded({ extended: false }), async (req, res) => {
  const saml = await getSamlClient();
  if (!saml) return res.status(503).send('SAML chưa được cấu hình trên server này');
  try {
    const { profile } = await saml.validatePostResponseAsync(req.body);
    const email = (profile.email || profile.nameID || '').toLowerCase();
    if (!email) throw new Error('IdP không trả về email/NameID');
    const user = await findOrCreateSsoUser({
      provider: 'saml',
      externalId: profile.nameID,
      email,
      name: profile.displayName || profile.cn || email
    });
    if (user.status !== 'active') return res.status(403).send('Tài khoản đã bị vô hiệu hóa');
    req.session.userId = user.id;
    res.redirect('/');
  } catch (e) {
    res.status(401).send(`Đăng nhập SAML thất bại: ${e.message}`);
  }
});

router.post('/ldap/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Thiếu username hoặc mật khẩu' });
  try {
    const identity = await ldapAuthenticate(username, password);
    const user = await findOrCreateSsoUser({ provider: 'ldap', externalId: identity.externalId, email: identity.email, name: identity.name });
    if (user.status !== 'active') return res.status(403).json({ error: 'Tài khoản đã bị vô hiệu hóa' });
    req.session.userId = user.id;
    res.json({ user: sanitizeUser(await attachPermissions(user)) });
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

module.exports = router;
