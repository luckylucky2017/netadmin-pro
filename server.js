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
const db = require('./database');
const { requireAuth, requirePermission } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

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

  app.use(cors());
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
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 } // secure:true khi chạy sau HTTPS/reverse proxy
  }));
  app.use(express.static(path.join(__dirname, 'public')));

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

  app.listen(PORT, () => {
    console.log(`NetAdmin Pro running at http://localhost:${PORT}`);
    console.log(`Phân tích Excel: ${process.env.ANTHROPIC_API_KEY ? 'Claude AI (đã có API key)' : 'Heuristic (chưa cấu hình ANTHROPIC_API_KEY)'}`);
    console.log('Metrics: SSH collector (server có ssh_user) + simulator (server chưa cấu hình SSH) + alert rule engine đang chạy');
  });

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
})();
