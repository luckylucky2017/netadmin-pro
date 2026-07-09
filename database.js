// MySQL-backed data layer. Exposes the same shape every consumer already uses —
// db.prepare(sql).get/all/run(...params) and db.transaction(fn) — so the ~200 call sites across
// routes/*.js and the *-collector.js files only needed `await` added, not a rewrite to a different
// query API. The one thing that genuinely can't be preserved is synchronicity: better-sqlite3 was a
// native, in-process, blocking binding; MySQL is a network service, so every call here is async.
const mysql = require('mysql2/promise');
const { AsyncLocalStorage } = require('async_hooks');
const { PERMISSIONS, OPERATOR_EXCLUDED } = require('./permissions-catalog');

let pool;
// Holds the active transaction's connection for the duration of a db.transaction(fn) call, so that
// db.prepare(sql).run(...) calls made anywhere inside fn — including via closures captured before
// the transaction started, exactly how the existing call sites are written — transparently run on
// that same connection instead of a random one from the pool (required for real atomicity).
const txContext = new AsyncLocalStorage();

function executor() {
  return txContext.getStore() || pool;
}

function prepare(sql) {
  return {
    async get(...params) {
      const [rows] = await executor().query(sql, params);
      return rows[0];
    },
    async all(...params) {
      const [rows] = await executor().query(sql, params);
      return rows;
    },
    async run(...params) {
      const [result] = await executor().query(sql, params);
      return { lastInsertRowid: result.insertId, changes: result.affectedRows };
    }
  };
}

async function exec(sql) {
  await executor().query(sql);
}

// db.transaction(fn) — call the returned function to actually run fn inside a transaction (matches
// better-sqlite3's API shape). fn should be async now and its internal db.prepare(...) calls awaited.
function transaction(fn) {
  return async (...args) => {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const result = await txContext.run(conn, () => fn(...args));
      await conn.commit();
      return result;
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  };
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS servers (
    id INT PRIMARY KEY AUTO_INCREMENT,
    name TEXT NOT NULL,
    hostname TEXT NOT NULL,
    ip_address TEXT NOT NULL,
    type VARCHAR(30) DEFAULT 'server',
    os TEXT,
    cpu TEXT,
    ram TEXT,
    storage TEXT,
    location TEXT,
    rack TEXT,
    status VARCHAR(20) DEFAULT 'unknown',
    last_ping DATETIME,
    ping_ms INT,
    ssh_port INT DEFAULT 22,
    ssh_user TEXT,
    tags TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS network_devices (
    id INT PRIMARY KEY AUTO_INCREMENT,
    name TEXT NOT NULL,
    hostname TEXT,
    ip_address TEXT NOT NULL,
    mac_address TEXT,
    type TEXT NOT NULL,
    brand TEXT,
    model TEXT,
    firmware TEXT,
    location TEXT,
    vlan TEXT,
    ports INT,
    status VARCHAR(20) DEFAULT 'unknown',
    last_ping DATETIME,
    ping_ms INT,
    snmp_community VARCHAR(100) DEFAULT 'public',
    tags TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS ping_history (
    id INT PRIMARY KEY AUTO_INCREMENT,
    device_id INT NOT NULL,
    device_type TEXT NOT NULL,
    status TEXT NOT NULL,
    ping_ms INT,
    checked_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS activity_logs (
    id INT PRIMARY KEY AUTO_INCREMENT,
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id INT,
    entity_name TEXT,
    details TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id INT PRIMARY KEY AUTO_INCREMENT,
    category TEXT NOT NULL,
    severity TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT,
    source_type TEXT,
    source_id INT,
    source_name TEXT,
    metric TEXT,
    metric_value TEXT,
    status VARCHAR(20) DEFAULT 'open',
    acked_by TEXT,
    rule_id INT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    acked_at DATETIME,
    resolved_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS metrics_history (
    id INT PRIMARY KEY AUTO_INCREMENT,
    server_id INT NOT NULL,
    cpu_pct DOUBLE,
    ram_pct DOUBLE,
    disk_pct DOUBLE,
    recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_metrics_server_time (server_id, recorded_at)
  );

  CREATE TABLE IF NOT EXISTS vm_metrics_history (
    id INT PRIMARY KEY AUTO_INCREMENT,
    vm_id INT NOT NULL,
    cpu_pct DOUBLE,
    mem_pct DOUBLE,
    disk_pct DOUBLE,
    recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_vmmetrics_vm_time (vm_id, recorded_at)
  );

  CREATE TABLE IF NOT EXISTS vcenter_vms (
    id INT PRIMARY KEY AUTO_INCREMENT,
    moref VARCHAR(64) NOT NULL UNIQUE,
    name TEXT NOT NULL,
    power_state TEXT,
    cpu_count INT,
    memory_mib INT,
    cpu_pct DOUBLE,
    mem_pct DOUBLE,
    disk_pct DOUBLE,
    stats_updated_at DATETIME,
    last_synced_at DATETIME,
    ip_address TEXT,
    guest_family TEXT,
    ssh_user TEXT,
    ssh_port INT,
    fail2ban_status VARCHAR(30) DEFAULT 'unknown',
    fail2ban_checked_at DATETIME,
    fail2ban_error TEXT
  );

  -- One row per VM/server being SSH-monitored: remembers how many lines of the guest's auth log
  -- have already been parsed, so each collection cycle only reads new lines (never the full log).
  CREATE TABLE IF NOT EXISTS ssh_log_cursor (
    source_type VARCHAR(20) NOT NULL,
    source_id INT NOT NULL,
    last_line_count INT NOT NULL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (source_type, source_id)
  );

  CREATE TABLE IF NOT EXISTS ssh_login_events (
    id INT PRIMARY KEY AUTO_INCREMENT,
    source_type VARCHAR(20) NOT NULL,
    source_id INT NOT NULL,
    source_name TEXT,
    event_type TEXT NOT NULL,
    username TEXT,
    src_ip TEXT,
    country TEXT,
    is_foreign INT NOT NULL DEFAULT 0,
    occurred_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_ssh_events_source_time (source_type, source_id, occurred_at),
    INDEX idx_ssh_events_time (occurred_at)
  );

  -- Outbound (VM-initiated) established TCP connections, refreshed each collection cycle. One row
  -- per unique (vm, remote ip, remote port) currently open — not an ever-growing event log — with
  -- first_seen/last_seen tracking so stale (closed) connections can be pruned.
  CREATE TABLE IF NOT EXISTS outbound_connections (
    id INT PRIMARY KEY AUTO_INCREMENT,
    vm_id INT NOT NULL,
    vm_name TEXT,
    remote_ip VARCHAR(45) NOT NULL,
    remote_port INT,
    country TEXT,
    is_foreign INT NOT NULL DEFAULT 0,
    process_name TEXT,
    pid INT,
    first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_outbound (vm_id, remote_ip, remote_port),
    INDEX idx_outbound_vm (vm_id)
  );

  CREATE TABLE IF NOT EXISTS alert_rules (
    id INT PRIMARY KEY AUTO_INCREMENT,
    name TEXT NOT NULL,
    scope_type VARCHAR(20) NOT NULL DEFAULT 'all',
    scope_id INT,
    metric TEXT NOT NULL,
    operator VARCHAR(5) NOT NULL DEFAULT '>',
    threshold DOUBLE NOT NULL,
    duration_sec INT NOT NULL DEFAULT 60,
    severity VARCHAR(20) NOT NULL DEFAULT 'medium',
    category VARCHAR(30) NOT NULL DEFAULT 'resource',
    enabled INT NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS users (
    id INT PRIMARY KEY AUTO_INCREMENT,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash TEXT,
    name TEXT NOT NULL,
    auth_provider VARCHAR(20) NOT NULL DEFAULT 'local',
    external_id TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    last_login_at DATETIME,
    role_id INT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Granular RBAC: roles are either the 3 immutable system roles (Admin/Operator/Viewer, seeded
  -- below with fixed permission sets) or admin-created custom roles with an arbitrary permission
  -- subset.
  CREATE TABLE IF NOT EXISTS roles (
    id INT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(100) NOT NULL UNIQUE,
    is_system INT NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS role_permissions (
    role_id INT NOT NULL,
    permission VARCHAR(64) NOT NULL,
    PRIMARY KEY (role_id, permission),
    FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
  );

  -- Uptime/SSL monitoring (HTTP/HTTPS, "outside-in" — separate from the internal SSH/vCenter
  -- monitoring elsewhere in the app). current_status/last_*/cert_* are a cache of the most recent
  -- check so GET / doesn't need to aggregate monitor_checks on every page load.
  CREATE TABLE IF NOT EXISTS monitors (
    id INT PRIMARY KEY AUTO_INCREMENT,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    keyword VARCHAR(255),
    keyword_type VARCHAR(20) DEFAULT 'contains',
    check_interval_sec INT NOT NULL DEFAULT 300,
    timeout_sec INT NOT NULL DEFAULT 10,
    ignore_tls_errors INT NOT NULL DEFAULT 0,
    enabled INT NOT NULL DEFAULT 1,
    current_status VARCHAR(20) DEFAULT 'unknown',
    last_checked_at DATETIME,
    last_response_ms INT,
    last_status_code INT,
    last_error TEXT,
    cert_expires_at DATETIME,
    cert_issuer TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS monitor_checks (
    id INT PRIMARY KEY AUTO_INCREMENT,
    monitor_id INT NOT NULL,
    status VARCHAR(20) NOT NULL,
    status_code INT,
    response_ms INT,
    error TEXT,
    checked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_monitor_checks_time (monitor_id, checked_at)
  );
`;

async function ensureSchemaAndMigrations() {
  for (const stmt of SCHEMA_SQL.split(';').map(s => s.trim()).filter(Boolean)) {
    await pool.query(stmt);
  }
  // users.role_id -> roles.id FK added separately (roles must exist first, which it now does).
  await pool.query(`
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'fk_users_role_id'
  `).then(async ([rows]) => {
    if (!rows.length) {
      await pool.query('ALTER TABLE users ADD CONSTRAINT fk_users_role_id FOREIGN KEY (role_id) REFERENCES roles(id)');
    }
  });

  // Columns added after initial release — this MySQL version doesn't support ADD COLUMN IF NOT
  // EXISTS (confirmed by testing directly), so catch the duplicate-column error (1060) instead.
  const migrations = [
    "ALTER TABLE servers ADD COLUMN ipmi_host VARCHAR(255)",
    "ALTER TABLE servers ADD COLUMN ipmi_username VARCHAR(100)",
    "ALTER TABLE servers ADD COLUMN ipmi_password TEXT",
    "ALTER TABLE servers ADD COLUMN ipmi_power_state VARCHAR(20) DEFAULT 'unknown'",
    "ALTER TABLE servers ADD COLUMN ipmi_health VARCHAR(20) DEFAULT 'unknown'",
    "ALTER TABLE servers ADD COLUMN ipmi_checked_at DATETIME",
    "ALTER TABLE servers ADD COLUMN ipmi_error TEXT",
    // SNMP v3 monitoring — shared shape across servers and network_devices (the daemon runs on the
    // entity's existing ip_address, unlike IPMI which needs a separate BMC management IP, so no host
    // column here). snmp_if_prev_snapshot is internal-only (never sent to the client): raw octet
    // counters + timestamp from the previous poll, needed to compute interface bps as a rate.
    "ALTER TABLE servers ADD COLUMN snmp_port INT DEFAULT 161",
    "ALTER TABLE servers ADD COLUMN snmp_username VARCHAR(100)",
    "ALTER TABLE servers ADD COLUMN snmp_auth_protocol VARCHAR(10)",
    "ALTER TABLE servers ADD COLUMN snmp_auth_password TEXT",
    "ALTER TABLE servers ADD COLUMN snmp_priv_protocol VARCHAR(10)",
    "ALTER TABLE servers ADD COLUMN snmp_priv_password TEXT",
    "ALTER TABLE servers ADD COLUMN snmp_status VARCHAR(20) DEFAULT 'unknown'",
    "ALTER TABLE servers ADD COLUMN snmp_uptime_sec BIGINT",
    "ALTER TABLE servers ADD COLUMN snmp_cpu_pct DOUBLE",
    "ALTER TABLE servers ADD COLUMN snmp_mem_used_pct DOUBLE",
    "ALTER TABLE servers ADD COLUMN snmp_interfaces TEXT",
    "ALTER TABLE servers ADD COLUMN snmp_if_prev_snapshot TEXT",
    "ALTER TABLE servers ADD COLUMN snmp_checked_at DATETIME",
    "ALTER TABLE servers ADD COLUMN snmp_error TEXT",
    "ALTER TABLE network_devices ADD COLUMN snmp_port INT DEFAULT 161",
    "ALTER TABLE network_devices ADD COLUMN snmp_username VARCHAR(100)",
    "ALTER TABLE network_devices ADD COLUMN snmp_auth_protocol VARCHAR(10)",
    "ALTER TABLE network_devices ADD COLUMN snmp_auth_password TEXT",
    "ALTER TABLE network_devices ADD COLUMN snmp_priv_protocol VARCHAR(10)",
    "ALTER TABLE network_devices ADD COLUMN snmp_priv_password TEXT",
    "ALTER TABLE network_devices ADD COLUMN snmp_status VARCHAR(20) DEFAULT 'unknown'",
    "ALTER TABLE network_devices ADD COLUMN snmp_uptime_sec BIGINT",
    "ALTER TABLE network_devices ADD COLUMN snmp_cpu_pct DOUBLE",
    "ALTER TABLE network_devices ADD COLUMN snmp_mem_used_pct DOUBLE",
    "ALTER TABLE network_devices ADD COLUMN snmp_interfaces TEXT",
    "ALTER TABLE network_devices ADD COLUMN snmp_if_prev_snapshot TEXT",
    "ALTER TABLE network_devices ADD COLUMN snmp_checked_at DATETIME",
    "ALTER TABLE network_devices ADD COLUMN snmp_error TEXT",
  ];
  for (const m of migrations) {
    try { await pool.query(m); } catch (e) { if (e.errno !== 1060) throw e; }
  }

  // SNMP pivoted from v3 (USM: user/auth/priv) to v1/v2c (community string) — real hardware
  // (iDRAC8 on the Dell R730 fleet) turned out to have no SNMPv3 user/auth option at all, only a
  // community string. Drop the now-unused v3 columns, add snmp_community (servers only —
  // network_devices already had it from the original schema, just never wired to a collector) and
  // snmp_enabled: network_devices.snmp_community defaults to 'public' for every existing row, so
  // "community string is set" can't double as the enable flag or every device would start being
  // polled the moment this migrates — snmp_enabled is the explicit opt-in signal instead.
  const dropCols = [
    'snmp_username', 'snmp_auth_protocol', 'snmp_auth_password', 'snmp_priv_protocol', 'snmp_priv_password',
  ];
  for (const table of ['servers', 'network_devices']) {
    for (const col of dropCols) {
      try { await pool.query(`ALTER TABLE ${table} DROP COLUMN ${col}`); } catch (e) { if (e.errno !== 1091) throw e; }
    }
  }
  const snmpV2Migrations = [
    "ALTER TABLE servers ADD COLUMN snmp_community VARCHAR(100)",
    "ALTER TABLE servers ADD COLUMN snmp_enabled INT DEFAULT 0",
    "ALTER TABLE network_devices ADD COLUMN snmp_enabled INT DEFAULT 0",
  ];
  for (const m of snmpV2Migrations) {
    try { await pool.query(m); } catch (e) { if (e.errno !== 1060) throw e; }
  }

  // activity_logs never recorded who performed an action, only what happened — user_name/
  // user_email are snapshotted at write time (like entity_name already is for the target object)
  // rather than only storing user_id, so history still reads correctly even if that user account
  // is later renamed or deleted.
  const activityLogMigrations = [
    "ALTER TABLE activity_logs ADD COLUMN user_id INT",
    "ALTER TABLE activity_logs ADD COLUMN user_name VARCHAR(255)",
    "ALTER TABLE activity_logs ADD COLUMN user_email VARCHAR(255)",
  ];
  for (const m of activityLogMigrations) {
    try { await pool.query(m); } catch (e) { if (e.errno !== 1060) throw e; }
  }

  // Per-component IPMI sensor breakdown (CPU/DIMM/disk/fan/PSU status) + recent SEL log entries —
  // snapshot of the latest check, not accumulated history (same treatment as snmp_interfaces).
  // ipmi_health (worst-case single value) is unchanged and still drives the list-page badge.
  const ipmiDetailMigrations = [
    "ALTER TABLE servers ADD COLUMN ipmi_sensors TEXT",
    "ALTER TABLE servers ADD COLUMN ipmi_sel_log TEXT",
  ];
  for (const m of ipmiDetailMigrations) {
    try { await pool.query(m); } catch (e) { if (e.errno !== 1060) throw e; }
  }
}

async function seedIfEmpty() {
  const serverCount = await prepare('SELECT COUNT(*) as cnt FROM servers').get();
  if (serverCount.cnt === 0) {
    const insertServer = prepare(`
      INSERT INTO servers (name, hostname, ip_address, type, os, cpu, ram, storage, location, rack, status, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    await insertServer.run('Web Server 01', 'web01.local', '192.168.1.10', 'server', 'Ubuntu 22.04 LTS', 'Intel Xeon E5-2620', '32GB DDR4', '2TB SSD', 'Datacenter A', 'Rack-01', 'online', '["web","production"]');
    await insertServer.run('DB Server 01', 'db01.local', '192.168.1.11', 'server', 'CentOS 7', 'Intel Xeon E5-2680', '64GB DDR4', '4TB HDD', 'Datacenter A', 'Rack-02', 'online', '["database","production"]');
    await insertServer.run('Backup Server', 'backup01.local', '192.168.1.20', 'server', 'Debian 11', 'AMD EPYC 7301', '16GB DDR4', '8TB HDD', 'Datacenter B', 'Rack-05', 'online', '["backup"]');
    await insertServer.run('Dev Server', 'dev01.local', '192.168.1.50', 'vm', 'Ubuntu 20.04', 'Intel i7-10700', '16GB DDR4', '500GB SSD', 'Office', '', 'offline', '["development"]');

    const insertDevice = prepare(`
      INSERT INTO network_devices (name, ip_address, mac_address, type, brand, model, location, vlan, ports, status, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    await insertDevice.run('Core Switch', '192.168.1.1', '00:1A:2B:3C:4D:5E', 'switch', 'Cisco', 'Catalyst 9300', 'Datacenter A', 'ALL', 48, 'online', '["core","critical"]');
    await insertDevice.run('Firewall FW01', '192.168.1.254', '00:1A:2B:3C:4D:FF', 'firewall', 'Fortinet', 'FortiGate 100F', 'Datacenter A', 'ALL', 8, 'online', '["security","critical"]');
    await insertDevice.run('Access Point Floor1', '192.168.1.100', 'AA:BB:CC:DD:EE:01', 'access_point', 'Ubiquiti', 'UniFi AP AC Pro', 'Office Floor 1', 'VLAN10', 0, 'online', '["wifi"]');
    await insertDevice.run('Router ISP', '10.0.0.1', '00:FF:AA:BB:CC:01', 'router', 'MikroTik', 'RB4011', 'Server Room', '1', 10, 'online', '["wan","critical"]');
  }

  const alertCount = await prepare('SELECT COUNT(*) as cnt FROM alerts').get();
  if (alertCount.cnt === 0) {
    const insertAlert = prepare(`
      INSERT INTO alerts (category, severity, title, message, source_type, source_id, source_name, metric, metric_value, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, DATE_SUB(NOW(), INTERVAL ? MINUTE))
    `);
    await insertAlert.run('resource', 'critical', 'CPU vượt ngưỡng', 'CPU sử dụng liên tục >90% trong 5 phút qua', 'server', 2, 'DB Server 01', 'cpu', '94%', 'open', 4);
    await insertAlert.run('security', 'critical', 'Nghi ngờ tấn công brute-force SSH', '27 lần đăng nhập thất bại từ 203.0.113.44 trong 2 phút', 'server', 1, 'Web Server 01', 'ssh_failed_login', '27 lần / 2 phút', 'open', 12);
    await insertAlert.run('resource', 'high', 'Dung lượng ổ đĩa sắp hết', 'Phân vùng /var/lib chỉ còn 8% dung lượng trống', 'server', 2, 'DB Server 01', 'disk', '92%', 'open', 38);
    await insertAlert.run('app_error', 'high', 'Tỷ lệ lỗi ứng dụng tăng đột biến', '46 lỗi 5xx/phút trên dịch vụ API, gấp 9 lần bình thường', 'server', 1, 'Web Server 01', 'error_rate', '46/phút', 'acknowledged', 60);
    await insertAlert.run('resource', 'medium', 'RAM sử dụng cao', 'Bộ nhớ sử dụng 85%, gần ngưỡng cảnh báo', 'server', 3, 'Backup Server', 'ram', '85%', 'open', 120);
    await insertAlert.run('security', 'medium', 'Kết nối bất thường ngoài giờ', 'Đăng nhập SSH thành công lúc 02:14 từ IP chưa từng ghi nhận', 'server', 3, 'Backup Server', 'login_anomaly', '02:14 AM', 'acknowledged', 360);
    await insertAlert.run('app_error', 'low', 'Cảnh báo deprecation trong log', 'Ứng dụng ghi log sử dụng API cũ sẽ ngừng hỗ trợ', 'server', 1, 'Web Server 01', 'log_warning', '12 dòng', 'resolved', 1440);
    await insertAlert.run('resource', 'low', 'Độ trễ ping tăng nhẹ', 'Ping trung bình tăng từ 8ms lên 34ms', 'device', 1, 'Core Switch', 'latency', '34ms', 'resolved', 2880);
  }

  const ruleCount = await prepare('SELECT COUNT(*) as cnt FROM alert_rules').get();
  if (ruleCount.cnt === 0) {
    const insertRule = prepare(`
      INSERT INTO alert_rules (name, scope_type, scope_id, metric, operator, threshold, duration_sec, severity, category)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 'resource')
    `);
    await insertRule.run('CPU quá cao', 'all', 'cpu', '>', 90, 60, 'critical');
    await insertRule.run('RAM quá cao', 'all', 'ram', '>', 85, 60, 'medium');
    await insertRule.run('Ổ đĩa sắp đầy', 'all', 'disk', '>', 90, 30, 'high');
    await insertRule.run('CPU VM quá cao', 'all_vms', 'cpu', '>', 90, 60, 'critical');
    await insertRule.run('RAM VM quá cao', 'all_vms', 'ram', '>', 85, 60, 'medium');
    await insertRule.run('Ổ đĩa VM sắp đầy', 'all_vms', 'disk', '>', 90, 30, 'high');
  }

  // Seed the 3 immutable system roles (Admin/Operator/Viewer) + their permission sets — must run
  // before both the first-admin seed below and any user creation, since those need real role ids.
  const roleCount = await prepare('SELECT COUNT(*) as cnt FROM roles').get();
  if (roleCount.cnt === 0) {
    const seedRoles = transaction(async () => {
      const insertRole = prepare('INSERT INTO roles (name, is_system) VALUES (?, 1)');
      const insertPerm = prepare('INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)');
      const adminId = (await insertRole.run('Admin')).lastInsertRowid;
      const operatorId = (await insertRole.run('Operator')).lastInsertRowid;
      await insertRole.run('Viewer');
      for (const { key } of PERMISSIONS) {
        await insertPerm.run(adminId, key);
        if (!OPERATOR_EXCLUDED.has(key)) await insertPerm.run(operatorId, key);
      }
      // Viewer gets no permission rows — read-only via GET routes, ungated beyond requireAuth.
    });
    await seedRoles();
    console.log('[auth] Đã tạo 3 vai trò hệ thống: Admin, Operator, Viewer');
  } else {
    // Roles already existed (not a fresh install) — but permissions-catalog.js can grow over time
    // (e.g. servers.ipmi_config added later). Without this, a newly-added key would silently never
    // reach the already-seeded Admin/Operator rows, since the block above only runs once ever.
    // INSERT IGNORE makes this a no-op for keys the role already has.
    const adminRole = await prepare("SELECT id FROM roles WHERE name = 'Admin'").get();
    const operatorRole = await prepare("SELECT id FROM roles WHERE name = 'Operator'").get();
    const insertPermIfMissing = prepare('INSERT IGNORE INTO role_permissions (role_id, permission) VALUES (?, ?)');
    for (const { key } of PERMISSIONS) {
      if (adminRole) await insertPermIfMissing.run(adminRole.id, key);
      if (operatorRole && !OPERATOR_EXCLUDED.has(key)) await insertPermIfMissing.run(operatorRole.id, key);
    }
  }

  // Seed the first admin account if no users exist yet.
  const userCount = await prepare('SELECT COUNT(*) as cnt FROM users').get();
  if (userCount.cnt === 0) {
    if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
      const bcrypt = require('bcryptjs');
      const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10);
      const adminRole = await prepare("SELECT id FROM roles WHERE name = 'Admin'").get();
      await prepare(`
        INSERT INTO users (email, password_hash, name, role_id, auth_provider, status)
        VALUES (?, ?, 'Administrator', ?, 'local', 'active')
      `).run(process.env.ADMIN_EMAIL.toLowerCase(), hash, adminRole.id);
      console.log(`[auth] Đã tạo tài khoản admin đầu tiên: ${process.env.ADMIN_EMAIL}`);
    } else {
      console.warn('[auth] Chưa có user nào và thiếu ADMIN_EMAIL/ADMIN_PASSWORD trong .env — đặt 2 biến này rồi khởi động lại server để tạo tài khoản admin đầu tiên.');
    }
  }
}

async function connect() {
  pool = mysql.createPool({
    host: process.env.MYSQL_HOST || 'localhost',
    port: Number(process.env.MYSQL_PORT) || 3306,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit: 10,
    multipleStatements: true,
    // Return DATETIME/TIMESTAMP columns as 'YYYY-MM-DD HH:MM:SS' strings, not JS Date objects —
    // matches how SQLite stored/returned them, so date-formatting/comparison code elsewhere in the
    // app (written against string values) doesn't need to change.
    dateStrings: true,
  });
  try {
    const conn = await pool.getConnection();
    conn.release();
  } catch (e) {
    console.error(`[db] Không kết nối được MySQL (${process.env.MYSQL_HOST}:${process.env.MYSQL_PORT}/${process.env.MYSQL_DATABASE}): ${e.message}`);
    console.error('[db] Kiểm tra MySQL đã chạy chưa và MYSQL_* trong .env đã đúng chưa.');
    process.exit(1);
  }
}

// Normal server boot path: connect + ensure schema + seed demo/system data if tables are empty.
async function init() {
  await connect();
  await ensureSchemaAndMigrations();
  await seedIfEmpty();
}

// Used by migrate-to-mysql.js: connect + ensure schema WITHOUT seeding — real data gets bulk-loaded
// instead, and seedIfEmpty()'s per-table "if count === 0" checks would otherwise race with that.
async function connectAndEnsureSchema() {
  await connect();
  await ensureSchemaAndMigrations();
}

// Only valid after init()/connectAndEnsureSchema() has resolved — used by server.js to hand the
// same pool to express-mysql-session instead of opening a second, redundant connection pool.
function getPool() {
  return pool;
}

module.exports = { prepare, exec, transaction, init, connectAndEnsureSchema, getPool };
