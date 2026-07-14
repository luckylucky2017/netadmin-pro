// MySQL-backed data layer. Exposes the same shape every consumer already uses —
// db.prepare(sql).get/all/run(...params) and db.transaction(fn) — so the ~200 call sites across
// routes/*.js and the *-collector.js files only needed `await` added, not a rewrite to a different
// query API. The one thing that genuinely can't be preserved is synchronicity: better-sqlite3 was a
// native, in-process, blocking binding; MySQL is a network service, so every call here is async.
const mysql = require('mysql2/promise');
const { AsyncLocalStorage } = require('async_hooks');
const fs = require('fs');
const os = require('os');
const path = require('path');
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

  -- Kết nối tới 1 hệ thống vCenter (đa cụm) — mật khẩu lưu plaintext, cùng cách xử lý như
  -- servers.ipmi_password/snmp_auth_password đã làm, không bao giờ trả về client (xem sanitizeCluster
  -- trong routes/vcenter.js). vcenter_vms.vcenter_cluster_id (thêm ở migration bên dưới) tham chiếu id này.
  CREATE TABLE IF NOT EXISTS vcenter_clusters (
    id INT PRIMARY KEY AUTO_INCREMENT,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    username TEXT NOT NULL,
    password TEXT NOT NULL,
    insecure INT NOT NULL DEFAULT 1,
    enabled INT NOT NULL DEFAULT 1,
    status VARCHAR(20) DEFAULT 'unknown',
    last_synced_at DATETIME,
    last_error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Reusable SSH connection accounts (private key OR password auth) — replaces the old single
  -- global SSH_PRIVATE_KEY_PATH/.env model. Secrets stored plaintext, same treatment as
  -- vcenter_clusters.password/servers.ipmi_password, never returned to the client (see
  -- sanitizeCredential in routes/ssh-credentials.js). servers.ssh_credential_id and
  -- vcenter_vms.ssh_credential_id (added via migration below) reference this table's id.
  CREATE TABLE IF NOT EXISTS ssh_credentials (
    id INT PRIMARY KEY AUTO_INCREMENT,
    name TEXT NOT NULL,
    auth_type VARCHAR(20) NOT NULL DEFAULT 'private_key',
    username TEXT NOT NULL,
    private_key TEXT,
    passphrase TEXT,
    password TEXT,
    is_default INT NOT NULL DEFAULT 0,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Singleton row (id always 1) holding app-level settings that used to live only in .env —
  -- Anthropic API key + SAML/LDAP SSO config. Plain columns rather than a generic key-value table
  -- since the settings list is small and fixed, same reasoning as vcenter_clusters/ssh_credentials
  -- using dedicated columns instead of a JSON blob. Secrets stored plaintext, same treatment as
  -- ssh_credentials.password — never returned to the client (see routes/settings.js).
  -- No column-level DEFAULT on the TEXT fields — MySQL doesn't allow literal defaults on
  -- BLOB/TEXT/GEOMETRY/JSON columns. Not a problem: the one-time seed below always inserts every
  -- column explicitly (falling back to 'netadmin-pro'/the default LDAP filter in JS), and
  -- routes/settings.js's PUT always writes explicit values too.
  CREATE TABLE IF NOT EXISTS app_settings (
    id INT PRIMARY KEY DEFAULT 1,
    anthropic_api_key TEXT,
    saml_idp_entry_point TEXT,
    saml_idp_cert TEXT,
    saml_sp_entity_id TEXT,
    saml_sp_callback_url TEXT,
    ldap_url TEXT,
    ldap_bind_dn TEXT,
    ldap_bind_password TEXT,
    ldap_base_dn TEXT,
    ldap_user_filter TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Kết nối tới 1 firewall pfSense qua REST API (pfSense-pkg-API, /api/v2) — cùng mẫu vcenter_clusters:
  -- mật khẩu/api_key lưu plaintext, không bao giờ trả về client (xem sanitizeFirewall trong routes/pfsense.js).
  CREATE TABLE IF NOT EXISTS pfsense_firewalls (
    id INT PRIMARY KEY AUTO_INCREMENT,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    port INT NOT NULL DEFAULT 443,
    auth_type VARCHAR(20) NOT NULL DEFAULT 'basic',
    username TEXT,
    password TEXT,
    api_key TEXT,
    insecure INT NOT NULL DEFAULT 1,
    enabled INT NOT NULL DEFAULT 1,
    status VARCHAR(20) DEFAULT 'unknown',
    last_synced_at DATETIME,
    last_error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Cache trạng thái interface (WAN/LAN...) đọc từ /api/v2/status/interfaces, đồng bộ định kỳ để
  -- trang Trạng thái không phải gọi API pfSense mỗi lần tải trang.
  CREATE TABLE IF NOT EXISTS pfsense_interfaces (
    id INT PRIMARY KEY AUTO_INCREMENT,
    firewall_id INT NOT NULL,
    if_name VARCHAR(64) NOT NULL,
    description TEXT,
    status VARCHAR(20),
    ip_address TEXT,
    gateway_status VARCHAR(20),
    raw_json TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_pfsense_if (firewall_id, if_name)
  );

  -- Cache rule tường lửa từ /api/v2/firewall/rules. rule_tracker lưu giá trị field "tracker" (ổn định,
  -- không đổi khi rule khác bị thêm/xóa) — dùng để đối chiếu lại "id" (index mảng, có thể lệch) thật
  -- ngay trước khi sửa/xóa. raw_json giữ nguyên response gốc phòng khi tên trường khác giả định.
  CREATE TABLE IF NOT EXISTS pfsense_firewall_rules (
    id INT PRIMARY KEY AUTO_INCREMENT,
    firewall_id INT NOT NULL,
    rule_tracker VARCHAR(64) NOT NULL,
    interface TEXT,
    action VARCHAR(20),
    protocol VARCHAR(20),
    source TEXT,
    destination TEXT,
    description TEXT,
    enabled INT DEFAULT 1,
    sort_order INT,
    raw_json TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_pfsense_rule (firewall_id, rule_tracker)
  );

  -- Cache trạng thái VPN (OpenVPN/IPsec) từ /api/v2/status/openvpn/*, /api/v2/status/ipsec/*.
  CREATE TABLE IF NOT EXISTS pfsense_vpn_status (
    id INT PRIMARY KEY AUTO_INCREMENT,
    firewall_id INT NOT NULL,
    vpn_type VARCHAR(20),
    tunnel_name TEXT,
    status VARCHAR(20),
    remote_info TEXT,
    connected_since DATETIME,
    raw_json TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- pfsense_vpn_status is upsert-by-active-connection and its row is DELETED the moment a client
  -- disconnects (see pfsense-collector.js's stale cleanup), so it can't answer "when did this user
  -- last connect" once they've gone offline. This table is a separate high-water-mark: one row per
  -- (firewall, OpenVPN username) that is only ever written forward (never deleted), updated every
  -- poll a user is seen connected — so it survives disconnects.
  CREATE TABLE IF NOT EXISTS pfsense_ovpn_user_last_conn (
    firewall_id INT NOT NULL,
    username VARCHAR(191) NOT NULL,
    last_connected_at DATETIME,
    last_remote_host VARCHAR(191),
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (firewall_id, username)
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

  -- Suspicious nginx access-log hits detected by nginx-waf-collector.js (dò quét/DoS/DDoS) — only
  -- flagged events are stored here, never every raw access.log line (far too high volume). blocked=1
  -- means waf-manager.js actually banned src_ip via the netadmin-waf fail2ban jail at detection time.
  CREATE TABLE IF NOT EXISTS waf_events (
    id INT PRIMARY KEY AUTO_INCREMENT,
    vm_id INT NOT NULL,
    vm_name VARCHAR(255),
    domain VARCHAR(255),
    event_type VARCHAR(20) NOT NULL,
    src_ip VARCHAR(64),
    country VARCHAR(10),
    is_foreign INT NOT NULL DEFAULT 0,
    method VARCHAR(10),
    path TEXT,
    status_code INT,
    user_agent TEXT,
    hit_count INT,
    blocked INT NOT NULL DEFAULT 0,
    occurred_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    -- event_type='ddos' rows only: JSON array of the top contributing IPs from the batch that
    -- triggered this specific spike ([{ip,country,hits}, ...], capped — see nginx-waf-collector.js's
    -- processHits). src_ip stays NULL for ddos (no single IP is "the" attacker by definition), but an
    -- admin investigating a DDoS alert still needs to know WHICH IPs made up that traffic — this is
    -- what the "DDoS (24h)" stat card's hover list on the WAF page reads.
    top_ips TEXT,
    INDEX idx_waf_events_vm_time (vm_id, occurred_at),
    INDEX idx_waf_events_time (occurred_at)
  );

  -- Global IP/CIDR allowlist (applies across every VM's jail) — checked by waf-manager.js's banIp()
  -- before every ban attempt, auto or manual, so a trusted source (office IP, uptime-check service,
  -- load tester) never gets blocked by mistake regardless of which VM it hits. Global rather than
  -- per-VM: the typical case for an exception (a known-safe source) isn't tied to one server.
  CREATE TABLE IF NOT EXISTS waf_ip_exceptions (
    id INT PRIMARY KEY AUTO_INCREMENT,
    ip VARCHAR(64) NOT NULL,
    note VARCHAR(255),
    created_by VARCHAR(255),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_waf_ip_exception (ip)
  );

  -- Mirrors each VM's netadmin-waf jail "currently banned" list — synced every collector poll
  -- (reuses the SSH session already open for log tailing, see nginx-waf-collector.js's
  -- syncBannedIps) so the "IP đang bị chặn" tab is a fast DB read instead of a live SSH round-trip
  -- per page view. A row disappears the moment fail2ban's bantime expires it (default 3600s) or it's
  -- unbanned — the sync deletes any (vm, ip) no longer in the live list, same staleness-pruning
  -- pattern as fail2ban-collector.js's ban-alert reconciliation.
  CREATE TABLE IF NOT EXISTS waf_banned_ips (
    vm_id INT NOT NULL,
    ip VARCHAR(64) NOT NULL,
    first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (vm_id, ip)
  );

  -- SSH-side counterparts of waf_ip_exceptions/waf_banned_ips above, for the sshd jail (brute-force
  -- protection) on "Giám sát bất thường" — a deliberately SEPARATE exception list from the WAF one
  -- (an admin may trust an IP for SSH but not WAF, or vice versa), checked by fail2ban-manager.js's
  -- banIp() before every sshd-jail ban attempt, same as waf_ip_exceptions gates waf-manager.js's.
  CREATE TABLE IF NOT EXISTS ssh_ip_exceptions (
    id INT PRIMARY KEY AUTO_INCREMENT,
    ip VARCHAR(64) NOT NULL,
    note VARCHAR(255),
    created_by VARCHAR(255),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_ssh_ip_exception (ip)
  );

  -- Mirrors each VM's sshd jail "currently banned" list — synced every fail2ban-collector.js poll
  -- (that collector already fetches every jail's banned list for the alerts mirror, this extracts
  -- just the sshd one) so the "IP đang bị chặn" tab on the Security page is a fast DB read, same
  -- staleness-pruning shape as waf_banned_ips.
  CREATE TABLE IF NOT EXISTS ssh_banned_ips (
    vm_id INT NOT NULL,
    ip VARCHAR(64) NOT NULL,
    first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (vm_id, ip)
  );

  -- One row per (VM, access_log file) discovered by parsing that VM's /etc/nginx/**/*.conf files
  -- (server_name + access_log directives per server block) — a VM commonly hosts several domains,
  -- each logging to its own file. Re-synced every collector poll: rows for logs no longer present in
  -- the current config are deleted (see nginx-waf-collector.js's discoverAndSyncDomainLogs) — deleting
  -- the row naturally discards its cursor too, since last_byte_offset lives right on this row (not a
  -- separate cursor table), so a re-added domain starts its lookback fresh rather than resuming a
  -- stale position. domain is NULL for the single-path fallback used when no server_name could be
  -- parsed (or /etc/nginx isn't readable at all) — falls back to vcenter_vms.waf_log_path.
  -- last_byte_offset (NULL until first poll) is a BYTE offset, not a line count — deliberately not
  -- reusing ssh_log_cursor's line-count-based tracking, which requires an O(file size) "wc -l" on
  -- every poll, see nginx-waf-collector.js's header comment for the real-world load this caused.
  CREATE TABLE IF NOT EXISTS waf_domain_logs (
    id INT PRIMARY KEY AUTO_INCREMENT,
    vm_id INT NOT NULL,
    domain VARCHAR(255),
    log_path VARCHAR(255) NOT NULL,
    conf_file VARCHAR(255),
    last_byte_offset BIGINT,
    discovered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_waf_domain_log (vm_id, log_path)
  );

  -- Per-poll total request count per (VM, log file), used as the rolling baseline
  -- nginx-waf-collector.js compares each new poll's total against to flag a distributed (DDoS)
  -- spike on that specific domain — short-lived, only the last ~20 samples per log file are kept
  -- (pruned by the collector itself), not a long-term history table.
  CREATE TABLE IF NOT EXISTS waf_traffic_stats (
    domain_log_id INT NOT NULL,
    sample_ts DATETIME NOT NULL,
    request_count INT NOT NULL,
    PRIMARY KEY (domain_log_id, sample_ts)
  );

  -- Long-lived daily rollup per (VM, domain) for the "Báo cáo lưu lượng" traffic report page —
  -- unlike waf_traffic_stats above (short DDoS-baseline window, ~20 samples), this accumulates across
  -- the retention period (pruned at 90 days by nginx-waf-collector.js). One row per (vm,domain,day)
  -- regardless of how many requests that domain actually saw that day — a busy proxy can see hundreds
  -- of thousands of requests/day across potentially hundreds of real hosted domains, so this is
  -- intentionally NOT one row per request — every poll's batch just increments these counters.
  CREATE TABLE IF NOT EXISTS waf_traffic_daily (
    vm_id INT NOT NULL,
    domain VARCHAR(255) NOT NULL DEFAULT '',
    day DATE NOT NULL,
    request_count INT NOT NULL DEFAULT 0,
    bytes_sum BIGINT NOT NULL DEFAULT 0,
    status_2xx INT NOT NULL DEFAULT 0,
    status_3xx INT NOT NULL DEFAULT 0,
    status_4xx INT NOT NULL DEFAULT 0,
    status_5xx INT NOT NULL DEFAULT 0,
    PRIMARY KEY (vm_id, domain, day)
  );

  -- Top-N breakdowns (page/IP/country/browser/OS) backing the traffic report, rolled up per day so
  -- any date-range query is a cheap SUM+GROUP BY+ORDER BY+LIMIT over this table instead of ever
  -- touching raw per-request data. stat_type separates the 5 dimensions sharing this one table rather
  -- than 5 near-identical ones. New distinct stat_key values are capped per (vm,domain,day,stat_type)
  -- by the collector (see TOP_STAT_CAP in nginx-waf-collector.js) — without that, scanner noise
  -- hitting thousands of distinct one-off paths would blow up row count — already-tracked keys keep
  -- incrementing past the cap, only brand-new long-tail keys get dropped once it's reached.
  CREATE TABLE IF NOT EXISTS waf_traffic_top (
    vm_id INT NOT NULL,
    domain VARCHAR(255) NOT NULL DEFAULT '',
    day DATE NOT NULL,
    stat_type VARCHAR(16) NOT NULL,
    stat_key VARCHAR(255) NOT NULL,
    hit_count INT NOT NULL DEFAULT 0,
    bytes_sum BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (vm_id, domain, day, stat_type, stat_key),
    INDEX idx_waf_traffic_top_lookup (vm_id, day, stat_type)
  );

  -- Single global row (id fixed at 1) holding the site-wide default detection thresholds + bantime
  -- for both the sshd jail and the netadmin-waf jail — see fail2ban-config.js for how this is merged
  -- with a per-VM override (fail2ban_config_overrides below) into one "effective config", and
  -- ssh-security-collector.js/nginx-waf-collector.js for where these used to be hardcoded module-
  -- level constants before this table existed. Previously changing any of these values required a
  -- code edit + redeploy — this table is what the "Cấu hình Fail2ban" admin page reads/writes.
  CREATE TABLE IF NOT EXISTS fail2ban_config (
    id INT PRIMARY KEY,
    ssh_brute_force_window_sec INT NOT NULL DEFAULT 60,
    ssh_brute_force_threshold INT NOT NULL DEFAULT 5,
    ssh_block_foreign_immediately TINYINT NOT NULL DEFAULT 1,
    ssh_bantime_sec INT NOT NULL DEFAULT -1,
    waf_scan_error_threshold INT NOT NULL DEFAULT 20,
    waf_dos_request_threshold INT NOT NULL DEFAULT 50,
    waf_dos_window_sec INT NOT NULL DEFAULT 10,
    waf_ddos_multiplier INT NOT NULL DEFAULT 5,
    waf_ddos_min_total INT NOT NULL DEFAULT 200,
    waf_bantime_sec INT NOT NULL DEFAULT -1,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  );

  -- Per-VM override of the same fields — every column is NULLABLE, and NULL means "inherit the
  -- global fail2ban_config value" (not "use 0"). A VM only gets a row here once an admin has
  -- overridden at least one of its fields — a VM with no row here is 100% governed by the global
  -- config. See fail2ban-config.js's mergeConfig for the exact per-field fallback logic.
  CREATE TABLE IF NOT EXISTS fail2ban_config_overrides (
    vm_id INT PRIMARY KEY,
    ssh_brute_force_window_sec INT,
    ssh_brute_force_threshold INT,
    ssh_block_foreign_immediately TINYINT,
    ssh_bantime_sec INT,
    waf_scan_error_threshold INT,
    waf_dos_request_threshold INT,
    waf_dos_window_sec INT,
    waf_ddos_multiplier INT,
    waf_ddos_min_total INT,
    waf_bantime_sec INT
  );

  -- Named, reusable presets ("profiles") of the same 10 fields — unlike fail2ban_config_overrides
  -- above, every column here is NOT NULL: a profile is a complete, self-contained bundle an admin
  -- defines once (e.g. "High traffic", "Strict") and then assigns to any number of servers via
  -- vcenter_vms.fail2ban_profile_id, rather than re-entering the same 10 values as a one-off override
  -- on every server that needs them. A profile is a live reference, not a one-time copy — editing it
  -- re-pushes the new values to every VM currently assigned to it (see routes/fail2ban-config.js's
  -- PATCH /profiles/:id). Effective-config precedence (fail2ban-config.js's getEffectiveConfig):
  -- per-VM override > assigned profile > global default — a profile replaces every field it defines
  -- (all of them, since NOT NULL), an override on top of that is still an escape hatch for a single
  -- field that needs to differ from the profile without forking a whole new profile for it.
  CREATE TABLE IF NOT EXISTS fail2ban_config_profiles (
    id INT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(100) NOT NULL,
    description VARCHAR(255),
    ssh_brute_force_window_sec INT NOT NULL DEFAULT 60,
    ssh_brute_force_threshold INT NOT NULL DEFAULT 5,
    ssh_block_foreign_immediately TINYINT NOT NULL DEFAULT 1,
    ssh_bantime_sec INT NOT NULL DEFAULT -1,
    waf_scan_error_threshold INT NOT NULL DEFAULT 20,
    waf_dos_request_threshold INT NOT NULL DEFAULT 50,
    waf_dos_window_sec INT NOT NULL DEFAULT 10,
    waf_ddos_multiplier INT NOT NULL DEFAULT 5,
    waf_ddos_min_total INT NOT NULL DEFAULT 200,
    waf_bantime_sec INT NOT NULL DEFAULT -1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_fail2ban_profile_name (name)
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
    cmdline TEXT,
    cwd TEXT,
    first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_outbound (vm_id, remote_ip, remote_port),
    INDEX idx_outbound_vm (vm_id)
  );

  -- Known-vulnerable installed packages, per VM — see vuln-scanner.js for how these are found
  -- (dpkg/rpm package list from each opted-in VM, matched against the OSV.dev public vulnerability
  -- database). One row per distinct (vm, package, vulnerability) combination currently detected, not
  -- an ever-growing event log — resolved_at is set once a later scan no longer finds this specific
  -- vulnerability on this VM (the package was upgraded past the affected version, or removed), the
  -- same "still open until proven otherwise" shape as alerts elsewhere in this app.
  CREATE TABLE IF NOT EXISTS vuln_findings (
    id INT PRIMARY KEY AUTO_INCREMENT,
    vm_id INT NOT NULL,
    vm_name VARCHAR(255),
    package_name VARCHAR(255) NOT NULL,
    package_version VARCHAR(150) NOT NULL,
    vuln_id VARCHAR(100) NOT NULL,
    summary TEXT,
    -- 'critical'|'high'|'medium'|'low'|'negligible'|'unknown' — prefers the distro-provided
    -- categorical rating (e.g. Ubuntu Security Notices already classify this way) over parsing a raw
    -- CVSS vector string ourselves — see vuln-scanner.js's extractSeverity.
    severity VARCHAR(20) DEFAULT 'unknown',
    reference_url TEXT,
    first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME,
    UNIQUE KEY uq_vuln_finding (vm_id, package_name, vuln_id)
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
    -- type: 'http' (default, checks the url column) | 'tcp' (connects to host:port) | 'ping'
    -- (ICMP via the ping npm package, host only) — see uptime-collector.js's performCheck
    -- dispatcher. The url column stays NOT NULL for backward compatibility with the pre-existing
    -- column — non-http monitors just store an empty string there instead of relaxing the
    -- constraint, and use host/port instead.
    type VARCHAR(20) NOT NULL DEFAULT 'http',
    url TEXT NOT NULL,
    host VARCHAR(255),
    port INT,
    -- HTTP-only: NULL (default) keeps the original "any 2xx/3xx counts as up" behavior — a non-null
    -- value requires the response's status code to match EXACTLY that number instead — see
    -- uptime-collector.js's performHttpCheck for where this is applied.
    expected_status_code INT,
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

  // Multi-vCenter support: a VM's moref ("vm-123") is only unique WITHIN the vCenter that issued
  // it — two different vCenter installs can easily reuse the same moref — so the old single-column
  // UNIQUE(moref) has to go, replaced with UNIQUE(vcenter_cluster_id, moref). Order matters: add the
  // column first (existing rows get NULL), THEN drop the old index, THEN add the composite one —
  // NULL cluster_id values don't collide with each other under a composite UNIQUE, so this is safe
  // to run before the one-time backfill in seedIfEmpty() assigns real cluster ids.
  try { await pool.query("ALTER TABLE vcenter_vms ADD COLUMN vcenter_cluster_id INT"); } catch (e) { if (e.errno !== 1060) throw e; }
  try { await pool.query("ALTER TABLE vcenter_vms DROP INDEX moref"); } catch (e) { if (e.errno !== 1091) throw e; }
  try { await pool.query("ALTER TABLE vcenter_vms ADD UNIQUE KEY uq_vcenter_vm (vcenter_cluster_id, moref)"); } catch (e) { if (e.errno !== 1061) throw e; }

  // ssh_user/ssh_port stay as-is (denormalized display cache, kept in sync whenever
  // ssh_credential_id changes — see routes/servers.js and routes/security.js) so every existing
  // read site (RBAC checks, table displays, chatbot-tools.js) keeps working unchanged; only the
  // actual SSH connect() call sites (ssh-credentials.js) resolve key/password from the credential.
  try { await pool.query("ALTER TABLE servers ADD COLUMN ssh_credential_id INT"); } catch (e) { if (e.errno !== 1060) throw e; }
  try { await pool.query("ALTER TABLE vcenter_vms ADD COLUMN ssh_credential_id INT"); } catch (e) { if (e.errno !== 1060) throw e; }

  // WAF monitoring opt-in, per VM — mirrors the ssh_user/fail2ban_status triplet pattern exactly.
  // waf_enabled gates whether nginx-waf-collector.js tails this VM's log at all; waf_auto_block is a
  // separate opt-in (defaults off) for whether a detected attacker IP gets actually banned via the
  // netadmin-waf fail2ban jail, or only raises an alert — see waf-manager.js/nginx-waf-collector.js.
  const wafMigrations = [
    "ALTER TABLE vcenter_vms ADD COLUMN waf_enabled INT DEFAULT 0",
    "ALTER TABLE vcenter_vms ADD COLUMN waf_log_path VARCHAR(255) DEFAULT '/var/log/nginx/access.log'",
    "ALTER TABLE vcenter_vms ADD COLUMN waf_auto_block INT DEFAULT 0",
    "ALTER TABLE vcenter_vms ADD COLUMN waf_jail_status VARCHAR(20)",
    "ALTER TABLE vcenter_vms ADD COLUMN waf_jail_checked_at DATETIME",
    "ALTER TABLE vcenter_vms ADD COLUMN waf_jail_error TEXT",
    // Off by default — only meaningful when this VM sits behind a reverse proxy/load balancer that
    // sets X-Forwarded-For, in which case $remote_addr in the access log is always the proxy, not
    // the real client. Turning this on makes nginx-waf-collector.js use the first XFF hop as the
    // detection/ban IP instead — turning it on for a VM that ISN'T behind a proxy would let a client
    // spoof the XFF header to frame/ban an arbitrary IP, so it must stay an explicit per-VM opt-in.
    "ALTER TABLE vcenter_vms ADD COLUMN waf_trust_xff INT DEFAULT 0",
  ];
  for (const m of wafMigrations) {
    try { await pool.query(m); } catch (e) { if (e.errno !== 1060) throw e; }
  }

  // Which named attack signature (sqli/xss/lfi/rce/sensitive_file/cms_scan — see
  // nginx-waf-collector.js's ATTACK_SIGNATURES) triggered a 'scan' event, so the UI can show WHY a
  // request was flagged instead of just "scan". Nullable — a plain volume/4xx-based scan detection
  // (no specific payload signature matched) or a dos/ddos/manual_block row leaves this null.
  try { await pool.query("ALTER TABLE waf_events ADD COLUMN attack_category VARCHAR(30)"); } catch (e) { if (e.errno !== 1060) throw e; }

  // Byte-offset cursor, replacing the O(file-size) wc-l/tail-n approach — see waf_domain_logs'
  // CREATE TABLE comment and nginx-waf-collector.js's header comment for why.
  try { await pool.query("ALTER TABLE waf_domain_logs ADD COLUMN last_byte_offset BIGINT"); } catch (e) { if (e.errno !== 1060) throw e; }

  // Interface + OpenVPN client bandwidth (in/out bps) — pfSense's API only exposes cumulative byte
  // counters, not a rate, so bps is derived from the delta against the previous poll's snapshot,
  // same convention as servers.snmp_if_prev_snapshot in snmp-collector.js. Snapshots live on
  // pfsense_firewalls (one row per firewall) rather than per-interface/per-connection, since the
  // whole snapshot is replaced as a unit each sync anyway. client_key identifies one OpenVPN
  // connection instance across polls so its rate can be computed the same way; pfsense_vpn_status
  // switches from wipe+reinsert to upsert-by-client_key so a row survives between polls long enough
  // to compute a delta.
  const pfsenseBandwidthMigrations = [
    "ALTER TABLE pfsense_firewalls ADD COLUMN if_bandwidth_snapshot TEXT",
    "ALTER TABLE pfsense_firewalls ADD COLUMN vpn_bandwidth_snapshot TEXT",
    "ALTER TABLE pfsense_interfaces ADD COLUMN in_bytes BIGINT",
    "ALTER TABLE pfsense_interfaces ADD COLUMN out_bytes BIGINT",
    "ALTER TABLE pfsense_interfaces ADD COLUMN in_bps BIGINT",
    "ALTER TABLE pfsense_interfaces ADD COLUMN out_bps BIGINT",
    "ALTER TABLE pfsense_vpn_status ADD COLUMN client_key VARCHAR(191)",
    "ALTER TABLE pfsense_vpn_status ADD COLUMN bytes_recv BIGINT",
    "ALTER TABLE pfsense_vpn_status ADD COLUMN bytes_sent BIGINT",
    "ALTER TABLE pfsense_vpn_status ADD COLUMN rate_recv_bps BIGINT",
    "ALTER TABLE pfsense_vpn_status ADD COLUMN rate_sent_bps BIGINT",
  ];
  for (const m of pfsenseBandwidthMigrations) {
    try { await pool.query(m); } catch (e) { if (e.errno !== 1060) throw e; }
  }
  // client_key was originally added as VARCHAR(64) before switching its derivation from client_id
  // (confirmed unstable across polls) to common_name+remote_host, which can exceed 64 chars —
  // MODIFY is safe/idempotent to re-run even once every install is already on VARCHAR(191).
  await pool.query("ALTER TABLE pfsense_vpn_status MODIFY COLUMN client_key VARCHAR(191)");
  try { await pool.query("ALTER TABLE pfsense_vpn_status ADD UNIQUE KEY uq_pfsense_vpn (firewall_id, vpn_type, client_key)"); } catch (e) { if (e.errno !== 1061) throw e; }

  // Same offline GeoIP classification already used for SSH logins (ssh-security-collector.js's
  // classifyIp, reused directly) — flags a VPN client's remote IP as foreign (outside Vietnam) so
  // the UI can warn on connections from an unexpected country.
  try { await pool.query("ALTER TABLE pfsense_vpn_status ADD COLUMN country VARCHAR(10)"); } catch (e) { if (e.errno !== 1060) throw e; }
  try { await pool.query("ALTER TABLE pfsense_vpn_status ADD COLUMN is_foreign INT DEFAULT 0"); } catch (e) { if (e.errno !== 1060) throw e; }

  // The virtual/tunnel IP pfSense actually assigned this OpenVPN client for the current session
  // (status/openvpn/servers' conns[].virtual_addr) — distinct from pfsense_vpn_status.remote_info,
  // which is the client's real-world source IP:port, not its address inside the VPN.
  try { await pool.query("ALTER TABLE pfsense_vpn_status ADD COLUMN tunnel_ip VARCHAR(64)"); } catch (e) { if (e.errno !== 1060) throw e; }

  // Full command line + working directory for an outbound connection's owning process — lets the
  // "Báo cáo kết nối nước ngoài" report show exactly what a curl/wget download's URL and destination
  // path were, not just the bare process name. See outbound-connection-collector.js's SCAN_SCRIPT
  // (ps -eo pid=,args= + readlink /proc/<pid>/cwd for curl/wget PIDs specifically) and
  // parseDownloadDetail() for how these are captured/parsed.
  try { await pool.query("ALTER TABLE outbound_connections ADD COLUMN cmdline TEXT"); } catch (e) { if (e.errno !== 1060) throw e; }
  try { await pool.query("ALTER TABLE outbound_connections ADD COLUMN cwd TEXT"); } catch (e) { if (e.errno !== 1060) throw e; }

  // Seed the single global fail2ban_config row (id=1) with the same defaults that used to be
  // hardcoded module-level constants in ssh-security-collector.js/nginx-waf-collector.js — INSERT
  // IGNORE so this is a no-op on every restart after the first.
  await pool.query('INSERT IGNORE INTO fail2ban_config (id) VALUES (1)');

  // Which fail2ban_config_profiles row (if any) this VM is assigned to — NULL means "no profile,
  // governed by the global default (or a per-VM override)". See fail2ban_config_profiles' own
  // comment above for the full effective-config precedence.
  try { await pool.query("ALTER TABLE vcenter_vms ADD COLUMN fail2ban_profile_id INT"); } catch (e) { if (e.errno !== 1060) throw e; }

  // Uptime monitors gain non-HTTP check types (TCP port connect, ICMP ping) — see monitors' own
  // comment above and uptime-collector.js's performCheck dispatcher. Existing rows implicitly stay
  // type='http' via the column default, so no backfill needed beyond adding the columns themselves.
  try { await pool.query("ALTER TABLE monitors ADD COLUMN type VARCHAR(20) NOT NULL DEFAULT 'http'"); } catch (e) { if (e.errno !== 1060) throw e; }
  try { await pool.query("ALTER TABLE monitors ADD COLUMN host VARCHAR(255)"); } catch (e) { if (e.errno !== 1060) throw e; }
  try { await pool.query("ALTER TABLE monitors ADD COLUMN port INT"); } catch (e) { if (e.errno !== 1060) throw e; }

  // HTTP monitors gain an optional exact-status-code requirement (NULL keeps the original 2xx/3xx
  // "up" range) — see monitors' own comment above and uptime-collector.js's performHttpCheck.
  try { await pool.query("ALTER TABLE monitors ADD COLUMN expected_status_code INT"); } catch (e) { if (e.errno !== 1060) throw e; }

  // ddos-type waf_events rows gain the top contributing IPs from the batch that triggered them —
  // see waf_events' own comment above and nginx-waf-collector.js's processHits.
  try { await pool.query("ALTER TABLE waf_events ADD COLUMN top_ips TEXT"); } catch (e) { if (e.errno !== 1060) throw e; }

  // Vulnerability scanning opt-in and status, per VM — mirrors the ssh_user/fail2ban_status/
  // waf_enabled triplet pattern already used for the other opt-in SSH-based collectors on this VM.
  // See vuln-scanner.js for how these are populated.
  try { await pool.query("ALTER TABLE vcenter_vms ADD COLUMN vuln_scan_enabled TINYINT DEFAULT 0"); } catch (e) { if (e.errno !== 1060) throw e; }
  try { await pool.query("ALTER TABLE vcenter_vms ADD COLUMN vuln_last_scanned_at DATETIME"); } catch (e) { if (e.errno !== 1060) throw e; }
  try { await pool.query("ALTER TABLE vcenter_vms ADD COLUMN vuln_scan_status VARCHAR(20)"); } catch (e) { if (e.errno !== 1060) throw e; }
  try { await pool.query("ALTER TABLE vcenter_vms ADD COLUMN vuln_scan_error TEXT"); } catch (e) { if (e.errno !== 1060) throw e; }
  try { await pool.query("ALTER TABLE vcenter_vms ADD COLUMN vuln_package_count INT"); } catch (e) { if (e.errno !== 1060) throw e; }
  // 'auto' (default — collectAll's 12h due-check picks it up) or 'manual' (never auto-scheduled,
  // only scanned via the explicit "Quét ngay" action) — see vuln-scanner.js's collectAll query.
  try { await pool.query("ALTER TABLE vcenter_vms ADD COLUMN vuln_scan_mode VARCHAR(10) DEFAULT 'auto'"); } catch (e) { if (e.errno !== 1060) throw e; }
}

async function seedIfEmpty() {
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

  // One-time migration: vCenter connection info used to live only in .env (single cluster, read at
  // process start). Now it's managed from the UI and stored in vcenter_clusters instead — so on the
  // first boot after this change, if no cluster row exists yet but .env still has VCENTER_* set,
  // create one from it and reattach every pre-existing vcenter_vms row (the real 106 VMs already
  // being tracked) to it. .env's VCENTER_* is never read again after this runs once.
  const clusterCount = await prepare('SELECT COUNT(*) as cnt FROM vcenter_clusters').get();
  if (clusterCount.cnt === 0 && process.env.VCENTER_HOST && process.env.VCENTER_USER && process.env.VCENTER_PASSWORD) {
    const result = await prepare(`
      INSERT INTO vcenter_clusters (name, host, username, password, insecure, enabled)
      VALUES ('Mặc định (từ .env)', ?, ?, ?, ?, 1)
    `).run(process.env.VCENTER_HOST, process.env.VCENTER_USER, process.env.VCENTER_PASSWORD, process.env.VCENTER_INSECURE !== 'false' ? 1 : 0);
    await prepare('UPDATE vcenter_vms SET vcenter_cluster_id = ? WHERE vcenter_cluster_id IS NULL').run(result.lastInsertRowid);
    console.log(`[vcenter] Đã tạo cụm "Mặc định (từ .env)" (id=${result.lastInsertRowid}) và gán lại các VM đã đồng bộ trước đó.`);
  }

  // Same one-time migration idea as vCenter above, for SSH: everything used to share 1 private key
  // from SSH_PRIVATE_KEY_PATH/.env + a per-row ssh_user string. Now credentials are managed from the
  // UI (ssh_credentials table) — on first boot after this change, read that same key file (if it
  // exists) into a "dev" credential (matching the real data: every currently-monitored server/VM
  // uses ssh_user='dev') and reattach every row that has ssh_user='dev' to it, preserving exactly
  // the SSH monitoring that's already running today.
  const credCount = await prepare('SELECT COUNT(*) as cnt FROM ssh_credentials').get();
  if (credCount.cnt === 0) {
    const keyPath = process.env.SSH_PRIVATE_KEY_PATH || path.join(os.homedir(), '.ssh', 'id_rsa');
    let keyContent = null;
    try { keyContent = fs.readFileSync(keyPath, 'utf8'); } catch { /* key file not readable — credential created empty, editable later from the UI */ }
    const result = await prepare(`
      INSERT INTO ssh_credentials (name, auth_type, username, private_key, passphrase, is_default)
      VALUES ('dev', 'private_key', 'dev', ?, ?, 1)
    `).run(keyContent, process.env.SSH_PASSPHRASE || null);
    await prepare("UPDATE servers SET ssh_credential_id = ? WHERE ssh_user = 'dev' AND ssh_credential_id IS NULL").run(result.lastInsertRowid);
    await prepare("UPDATE vcenter_vms SET ssh_credential_id = ? WHERE ssh_user = 'dev' AND ssh_credential_id IS NULL").run(result.lastInsertRowid);
    console.log(`[ssh] Đã tạo tài khoản kết nối "dev" (id=${result.lastInsertRowid})${keyContent ? '' : ' — KHÔNG đọc được private key tại ' + keyPath + ', cần dán lại nội dung key trong trang Tài khoản kết nối'} và gán lại các server/VM đã cấu hình ssh_user=dev trước đó.`);
  }

  // Same one-time idea again for the last of .env's runtime settings: AI key + SAML/LDAP SSO used
  // to live only in .env, read fresh on every call. Now they live in app_settings (editable from
  // the UI without a restart) — seed the singleton row from whatever .env still has set, so an
  // in-progress SSO setup isn't silently dropped by this migration.
  const settingsCount = await prepare('SELECT COUNT(*) as cnt FROM app_settings').get();
  if (settingsCount.cnt === 0) {
    await prepare(`
      INSERT INTO app_settings (id, anthropic_api_key, saml_idp_entry_point, saml_idp_cert, saml_sp_entity_id, saml_sp_callback_url, ldap_url, ldap_bind_dn, ldap_bind_password, ldap_base_dn, ldap_user_filter)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      process.env.ANTHROPIC_API_KEY || null,
      process.env.SAML_IDP_ENTRY_POINT || null, process.env.SAML_IDP_CERT || null,
      process.env.SAML_SP_ENTITY_ID || 'netadmin-pro', process.env.SAML_SP_CALLBACK_URL || null,
      process.env.LDAP_URL || null, process.env.LDAP_BIND_DN || null, process.env.LDAP_BIND_PASSWORD || null,
      process.env.LDAP_BASE_DN || null, process.env.LDAP_USER_FILTER || '(sAMAccountName={{username}})'
    );
    console.log('[settings] Đã tạo cài đặt hệ thống (AI key/SAML/LDAP) từ .env hiện có — sửa tiếp trong trang Cài đặt, không cần .env nữa.');
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
