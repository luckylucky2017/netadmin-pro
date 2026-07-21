require('dotenv').config();

// Last-resort safety net: this app is a long-running daemon polling 100+ VMs/servers over SSH every
// 30-60s (ssh-collector.js, ssh-security-collector.js, fail2ban-collector.js, outbound-connection-
// collector.js). The underlying ssh2 library occasionally emits a raw 'error' event directly on a
// Socket (e.g. EADDRNOTAVAIL after a network blip/sleep-wake) that isn't wrapped into node-ssh's
// Promise-based .connect() rejection — Node treats an unhandled EventEmitter 'error' as fatal by
// default, which previously took the ENTIRE app down over one bad connection attempt among many.
// This one process-level handler is a deliberately broad backstop: log and keep running, since a
// single VM's transient socket error has nothing to do with the rest of the app's state.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] Lỗi nghiêm trọng chưa được xử lý — server vẫn tiếp tục chạy:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection] Promise bị reject không được xử lý:', reason);
});

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const { execSync } = require('child_process');
const db = require('./database');
const { getSettings } = require('./settings');
const { requireAuth, requirePermission } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

// Computed once at boot (not per-request — git rev-parse is cheap but pointless to re-run on every
// page load). Deploys here are `git pull && systemctl restart`, so the exact commit HEAD points at
// IS the deployed version — far more precise than package.json's never-bumped "1.0.0", and exactly
// what you need to confirm local and prod (two independent instances/databases pointed at the same
// real infrastructure) are actually running the same code. Falls back gracefully if .git is missing
// (e.g. a tarball deploy with no git history) rather than crashing boot over a cosmetic feature.
let APP_VERSION = { commit: 'unknown', commitDate: null };
try {
  const commit = execSync('git rev-parse --short HEAD', { cwd: __dirname, encoding: 'utf8' }).trim();
  const commitDate = execSync("git log -1 --format=%cd --date=format:'%Y-%m-%d %H:%M'", { cwd: __dirname, encoding: 'utf8' }).trim();
  APP_VERSION = { commit, commitDate };
} catch (e) {
  console.warn('[server] Không đọc được git commit hiện tại (không có .git?):', e.message);
}

if (!process.env.SESSION_SECRET) {
  console.warn('[auth] SESSION_SECRET chưa đặt trong .env — dùng giá trị mặc định KHÔNG an toàn cho production, chỉ nên dùng khi phát triển local.');
}

// MySQL connects asynchronously (unlike the old in-process SQLite file, which was ready the moment
// require('./database') returned) — everything that touches the DB, directly or via express-session's
// store, must wait for db.init() to resolve before the app starts accepting requests.
(async () => {
  await db.init();

  // Reuses database.js's own pool rather than opening a second one just for sessions.
  const sessionStore = new MySQLStore({}, db.getPool());

  // This is a single-origin app (the SPA in public/ and the API are served by this same Express
  // instance), so there's no legitimate need for cross-origin API access — the previous open
  // `cors()` (Access-Control-Allow-Origin: *, found during a pentest) is removed by default rather
  // than scoped down, closing off unneeded attack surface entirely. Set CORS_ALLOWED_ORIGIN in .env
  // only if a separate frontend (e.g. a local dev server on another port) genuinely needs
  // cross-origin access.
  if (process.env.CORS_ALLOWED_ORIGIN) {
    app.use(cors({ origin: process.env.CORS_ALLOWED_ORIGIN, credentials: true }));
  }
  // CSP tắt vì toàn bộ frontend dùng inline onclick="..." (không phải Content-Security-Policy
  // friendly) — vẫn giữ các header bảo vệ khác của helmet (X-Frame-Options chống clickjacking...).
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(session({
    store: sessionStore,
    secret: process.env.SESSION_SECRET || 'dev-only-insecure-secret-set-SESSION_SECRET-in-env',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000,
      // Off by default since this deployment currently runs over plain HTTP (found during a pentest
      // — credentials/session cookie transmitted in cleartext). Set COOKIE_SECURE=true in .env once
      // this is served over HTTPS (directly or via a TLS-terminating reverse proxy) — until then, a
      // Secure cookie would never reach the browser at all and no one could log in.
      secure: process.env.COOKIE_SECURE === 'true',
    }
  }));
  app.use(express.static(path.join(__dirname, 'public')));

  // Public (no requireAuth) — shown on both the login screen and the sidebar, so which
  // commit/deploy is running is visible without needing to log in first.
  app.get('/api/version', (req, res) => res.json(APP_VERSION));

  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/servers', requireAuth, require('./routes/servers'));
  app.use('/api/devices', requireAuth, require('./routes/devices'));
  app.use('/api/ping', requireAuth, require('./routes/ping'));
  app.use('/api/alerts', requireAuth, require('./routes/alerts'));
  app.use('/api/rules', requireAuth, require('./routes/rules'));
  app.use('/api/vcenter', requireAuth, require('./routes/vcenter'));
  app.use('/api/security', requireAuth, require('./routes/security'));
  app.use('/api/users', requireAuth, requirePermission('users.manage'), require('./routes/users'));
  app.use('/api/roles', requireAuth, require('./routes/roles'));
  app.use('/api/monitors', requireAuth, require('./routes/monitors'));
  app.use('/api/chat', requireAuth, require('./routes/chat'));
  app.use('/api/ssh-credentials', requireAuth, require('./routes/ssh-credentials'));
  app.use('/api/settings', requireAuth, require('./routes/settings'));
  app.use('/api/pfsense', requireAuth, require('./routes/pfsense'));
  app.use('/api/waf', requireAuth, require('./routes/waf'));
  app.use('/api/reports', requireAuth, require('./routes/reports'));
  app.use('/api/fail2ban-config', requireAuth, require('./routes/fail2ban-config'));
  app.use('/api/vuln', requireAuth, require('./routes/vuln'));
  app.use('/api/trivy', requireAuth, require('./routes/trivy'));
  app.use('/api/harbor', requireAuth, require('./routes/harbor'));

  app.get('/api/dashboard', requireAuth, async (req, res) => {
    const [serverStats, deviceStats, recentActivity, deviceTypes, serverTypes] = await Promise.all([
      db.prepare("SELECT status, COUNT(*) as cnt FROM servers GROUP BY status").all(),
      db.prepare("SELECT status, COUNT(*) as cnt FROM network_devices GROUP BY status").all(),
      db.prepare("SELECT * FROM activity_logs ORDER BY created_at DESC LIMIT 20").all(),
      db.prepare("SELECT type, COUNT(*) as cnt FROM network_devices GROUP BY type").all(),
      db.prepare("SELECT type, COUNT(*) as cnt FROM servers GROUP BY type").all(),
    ]);

    res.json({ serverStats, deviceStats, recentActivity, deviceTypes, serverTypes });
  });

  app.get('/api/activity', requireAuth, async (req, res) => {
    const { user_id, entity_type, action, search } = req.query;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;

    let where = 'WHERE 1=1';
    const params = [];
    if (user_id) { where += ' AND user_id = ?'; params.push(user_id); }
    if (entity_type) { where += ' AND entity_type = ?'; params.push(entity_type); }
    if (action) { where += ' AND action = ?'; params.push(action); }
    if (search) { where += ' AND entity_name LIKE ?'; params.push(`%${search}%`); }

    const total = (await db.prepare(`SELECT COUNT(*) as cnt FROM activity_logs ${where}`).get(...params)).cnt;
    const logs = await db.prepare(`SELECT * FROM activity_logs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    res.json({ logs, total });
  });

  // Distinct actors seen in the log, for the filter dropdown — a separate lightweight endpoint
  // rather than reusing GET /api/users, since that one requires users.manage (Operator/Viewer
  // couldn't filter their own visible history by user otherwise).
  app.get('/api/activity/users', requireAuth, async (req, res) => {
    const users = await db.prepare("SELECT DISTINCT user_id, user_name FROM activity_logs WHERE user_id IS NOT NULL ORDER BY user_name ASC").all();
    res.json(users);
  });

  app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

  const settings = await getSettings();
  app.listen(PORT, () => {
    console.log(`NetAdmin Pro running at http://localhost:${PORT}`);
    console.log(`Chatbot AI: ${settings.anthropic_api_key ? 'đã cấu hình Anthropic API Key' : 'chưa cấu hình — vào trang Cài đặt để bật'}`);
    console.log('Metrics: SSH collector (server có ssh_user) + simulator (server chưa cấu hình SSH) + alert rule engine đang chạy');
  });

  // DISABLE_BACKGROUND_COLLECTORS: set to 'true' in a machine's own .env (never committed — see
  // .gitignore) to stop this instance's periodic polling/auto-block loops. Meant for a local dev
  // instance pointed at the SAME real infrastructure a prod instance also manages — every one of
  // these collectors opens real SSH connections to real VMs, and 3 of them (ssh-security-collector,
  // fail2ban-collector, nginx-waf-collector) actively call fail2ban-client banip/unbanip/reload —
  // running both instances' collectors unattended in parallel means two independent processes
  // deciding to mutate the same real fail2ban jails, based on two different (local vs prod)
  // databases' worth of exceptions/state, which can race or disagree. Manually invoking a specific
  // collector's collectVm()/collectAll() from a one-off script still works regardless of this flag —
  // it only gates the automatic setInterval loop below, so on-demand testing of a single VM is
  // unaffected.
  if (process.env.DISABLE_BACKGROUND_COLLECTORS !== 'true') {
    require('./metrics-simulator').start();
    require('./ssh-collector').start();
    require('./vcenter-collector').start();
    require('./ssh-security-collector').start();
    require('./outbound-connection-collector').start();
    require('./fail2ban-collector').start();
    require('./alert-engine').start();
    require('./ipmi-collector').start();
    require('./uptime-collector').start();
    require('./snmp-collector').start();
    require('./pfsense-collector').start();
    require('./nginx-waf-collector').start();
    require('./vuln-scanner').start();
    require('./trivy-scanner').start();
    require('./trivy-scanner').startVersionCheckScheduler();
    require('./harbor-scanner').start();
    require('./vcenter-load-collector').start();
  } else {
    console.log('[server] DISABLE_BACKGROUND_COLLECTORS=true — periodic polling/auto-block loops NOT started (see server.js)');
  }
})();
