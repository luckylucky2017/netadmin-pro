const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const db = require('../database');
const { verifyPassword, sanitizeUser, requireAuth, attachPermissions, ldapAuthenticate, getSamlClient, findOrCreateSsoUser } = require('../auth');

// Chống brute-force vào chính app này — cùng tinh thần với fail2ban đang bảo vệ SSH ở các VM khác.
const loginLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Thử đăng nhập quá nhiều lần, vui lòng thử lại sau ít phút' } });

router.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Thiếu email hoặc mật khẩu' });
  const user = await db.prepare('SELECT * FROM users WHERE email = ? AND auth_provider = ?').get(String(email).toLowerCase(), 'local');
  if (!user || user.status !== 'active' || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Email hoặc mật khẩu không đúng' });
  }
  await db.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
  req.session.userId = user.id;
  res.json({ user: sanitizeUser(await attachPermissions(user)) });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ message: 'OK' }));
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: sanitizeUser(req.user) });
});

router.get('/saml/login', (req, res) => {
  const saml = getSamlClient();
  if (!saml) return res.status(503).json({ error: 'SAML chưa được cấu hình trên server này' });
  saml.getAuthorizeUrlAsync('', req.headers.host, {})
    .then(url => res.redirect(url))
    .catch(e => res.status(502).json({ error: `Không tạo được URL đăng nhập SAML: ${e.message}` }));
});

router.post('/saml/callback', express.urlencoded({ extended: false }), async (req, res) => {
  const saml = getSamlClient();
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
