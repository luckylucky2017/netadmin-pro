// Tool catalog for the AI chatbot's agentic tool-calling loop (routes/chat.js). Each tool wraps
// existing business logic (fail2ban-manager, alerts/monitors query patterns) rather than
// reimplementing it, so behavior — and activity_logs auditing — stays identical to the equivalent
// HTTP route. `mutating: true` tools are never auto-executed by the loop; routes/chat.js pauses
// and waits for an explicit UI confirmation before calling `execute()` on them.
const db = require('./database');
const { logActivity } = require('./auth');
const fail2banManager = require('./fail2ban-manager');

function hasPermission(user, key) {
  return !key || (user?.permissions || []).includes(key);
}

// Fuzzy target lookup by name/IP/URL — used by every tool that takes a natural-language target
// instead of a numeric ID. Returns {found:false, ambiguous:true, candidates} on multiple matches
// so the model can ask the user to disambiguate instead of guessing which one was meant.
async function resolveOne(table, query, matchCols = ['name', 'ip_address']) {
  const where = matchCols.map(c => `${c} LIKE ?`).join(' OR ');
  const params = matchCols.map(() => `%${query}%`);
  const rows = await db.prepare(`SELECT * FROM ${table} WHERE ${where} LIMIT 5`).all(...params);
  if (!rows.length) return { found: false, error: `Không tìm thấy "${query}"` };
  if (rows.length > 1) return { found: false, ambiguous: true, candidates: rows.map(r => ({ id: r.id, name: r.name, ip_address: r.ip_address })) };
  return { found: true, row: rows[0] };
}

async function computeUptimePct(monitorId, days) {
  const row = await db.prepare(`
    SELECT AVG(status='up') * 100 as pct, COUNT(*) as cnt FROM monitor_checks
    WHERE monitor_id = ? AND checked_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
  `).get(monitorId, days);
  return row.cnt > 0 ? Math.round(row.pct * 10) / 10 : null;
}

// Same ping-or-simulate fallback as routes/ping.js — duplicated locally (rather than importing
// that router) since it's a plain function, not something exported from an Express Router.
let pingLib;
try { pingLib = require('ping'); } catch (e) { pingLib = null; }
async function pingHost(host) {
  if (!pingLib) return { alive: Math.random() > 0.2, time: Math.floor(Math.random() * 50) + 1 };
  try {
    const res = await pingLib.promise.probe(host, { timeout: 3, min_reply: 1 });
    return { alive: res.alive, time: res.time === 'unknown' ? null : parseFloat(res.time) };
  } catch {
    return { alive: false, time: null };
  }
}

const TOOLS = [
  {
    name: 'list_servers',
    description: 'Liệt kê tất cả máy chủ vật lý và trạng thái tổng quan (online/offline, ping, sức khỏe IPMI).',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    mutating: false,
    permission: null,
    execute: async () => {
      const servers = await db.prepare('SELECT id, name, ip_address, status, ping_ms, ipmi_health, last_ping FROM servers ORDER BY name').all();
      return { count: servers.length, servers };
    }
  },
  {
    name: 'get_server_status',
    description: 'Tra cứu chi tiết trạng thái 1 máy chủ theo tên hoặc IP: online/offline, CPU/RAM/Disk mới nhất, tình trạng IPMI, SNMP.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Tên hoặc địa chỉ IP của máy chủ' } },
      required: ['query'], additionalProperties: false
    },
    mutating: false,
    permission: null,
    execute: async ({ query }) => {
      const r = await resolveOne('servers', query);
      if (!r.found) return r;
      const server = r.row;
      const latest = await db.prepare('SELECT cpu_pct, ram_pct, disk_pct, recorded_at FROM metrics_history WHERE server_id=? ORDER BY recorded_at DESC LIMIT 1').get(server.id);
      return {
        id: server.id, name: server.name, ip_address: server.ip_address, status: server.status,
        ping_ms: server.ping_ms, last_ping: server.last_ping,
        ipmi: { power_state: server.ipmi_power_state, health: server.ipmi_health, checked_at: server.ipmi_checked_at, error: server.ipmi_error },
        snmp: { status: server.snmp_status, cpu_pct: server.snmp_cpu_pct, mem_used_pct: server.snmp_mem_used_pct, checked_at: server.snmp_checked_at },
        latest_metrics: latest || null
      };
    }
  },
  {
    name: 'list_devices',
    description: 'Liệt kê tất cả thiết bị mạng (switch/router/firewall...) và trạng thái online/offline.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    mutating: false,
    permission: null,
    execute: async () => {
      const devices = await db.prepare('SELECT id, name, ip_address, type, status, ping_ms, last_ping FROM network_devices ORDER BY name').all();
      return { count: devices.length, devices };
    }
  },
  {
    name: 'get_alerts',
    description: 'Tra cứu danh sách cảnh báo, có thể lọc theo trạng thái (open/acknowledged/resolved) và mức độ (critical/high/medium/low).',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'acknowledged', 'resolved'] },
        severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
        limit: { type: 'number', description: 'Số lượng tối đa, mặc định 20, tối đa 100' }
      },
      additionalProperties: false
    },
    mutating: false,
    permission: null,
    execute: async ({ status, severity, limit } = {}) => {
      let q = 'SELECT id, category, severity, title, message, source_name, status, created_at FROM alerts WHERE 1=1';
      const params = [];
      if (status) { q += ' AND status=?'; params.push(status); }
      if (severity) { q += ' AND severity=?'; params.push(severity); }
      q += " ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, created_at DESC LIMIT ?";
      params.push(Math.min(Number(limit) || 20, 100));
      const alerts = await db.prepare(q).all(...params);
      return { count: alerts.length, alerts };
    }
  },
  {
    name: 'list_vms',
    description: 'Liệt kê VM trong vCenter, có thể lọc theo trạng thái nguồn (POWERED_ON/POWERED_OFF).',
    input_schema: {
      type: 'object',
      properties: { powerState: { type: 'string', enum: ['POWERED_ON', 'POWERED_OFF', 'SUSPENDED'] } },
      additionalProperties: false
    },
    mutating: false,
    permission: null,
    execute: async ({ powerState } = {}) => {
      let q = 'SELECT id, name, power_state, ip_address, cpu_pct, mem_pct, disk_pct FROM vcenter_vms WHERE 1=1';
      const params = [];
      if (powerState) { q += ' AND power_state=?'; params.push(powerState); }
      q += ' ORDER BY name LIMIT 200';
      const vms = await db.prepare(q).all(...params);
      return { count: vms.length, vms };
    }
  },
  {
    name: 'get_vm_status',
    description: 'Tra cứu chi tiết trạng thái 1 VM vCenter theo tên hoặc IP: nguồn, CPU/RAM/Disk mới nhất, trạng thái fail2ban.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Tên hoặc địa chỉ IP của VM' } },
      required: ['query'], additionalProperties: false
    },
    mutating: false,
    permission: null,
    execute: async ({ query }) => {
      const r = await resolveOne('vcenter_vms', query);
      if (!r.found) return r;
      const vm = r.row;
      const latest = await db.prepare('SELECT cpu_pct, mem_pct, disk_pct, recorded_at FROM vm_metrics_history WHERE vm_id=? ORDER BY recorded_at DESC LIMIT 1').get(vm.id);
      return {
        id: vm.id, name: vm.name, power_state: vm.power_state, ip_address: vm.ip_address,
        cpu_count: vm.cpu_count, memory_mib: vm.memory_mib,
        fail2ban_status: vm.fail2ban_status, fail2ban_checked_at: vm.fail2ban_checked_at,
        latest_metrics: latest || null
      };
    }
  },
  {
    name: 'get_uptime_status',
    description: 'Tra cứu trạng thái 1 monitor giám sát uptime (website/API) theo tên hoặc URL: kết quả kiểm tra gần nhất, tỷ lệ uptime 24h/7 ngày.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Tên hoặc URL của monitor' } },
      required: ['query'], additionalProperties: false
    },
    mutating: false,
    permission: null,
    execute: async ({ query }) => {
      const r = await resolveOne('monitors', query, ['name', 'url']);
      if (!r.found) return r;
      const m = r.row;
      const [uptime_24h, uptime_7d] = await Promise.all([computeUptimePct(m.id, 1), computeUptimePct(m.id, 7)]);
      const lastCheck = await db.prepare('SELECT status, status_code, response_ms, error, checked_at FROM monitor_checks WHERE monitor_id=? ORDER BY checked_at DESC LIMIT 1').get(m.id);
      return { id: m.id, name: m.name, url: m.url, enabled: !!m.enabled, uptime_24h, uptime_7d, last_check: lastCheck || null };
    }
  },
  {
    name: 'get_fail2ban_status',
    description: 'Kiểm tra trực tiếp (SSH) xem fail2ban đã cài đặt và đang chạy trên 1 VM hay chưa. VM phải đã bật giám sát SSH.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Tên hoặc địa chỉ IP của VM' } },
      required: ['query'], additionalProperties: false
    },
    mutating: false,
    permission: 'security.fail2ban.check',
    execute: async ({ query }) => {
      const r = await resolveOne('vcenter_vms', query);
      if (!r.found) return r;
      const vm = r.row;
      if (!vm.ssh_user || !vm.ip_address) return { error: 'VM này chưa bật giám sát SSH (cần cấu hình SSH User trước)' };
      return await fail2banManager.checkStatus(vm);
    }
  },
  {
    name: 'run_ping_check',
    description: 'Ping thủ công 1 máy chủ hoặc thiết bị mạng ngay lập tức để làm mới trạng thái online/offline.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Tên hoặc địa chỉ IP của máy chủ/thiết bị' } },
      required: ['query'], additionalProperties: false
    },
    mutating: false,
    permission: 'ping.write',
    execute: async ({ query }) => {
      let r = await resolveOne('servers', query);
      let type = 'server';
      if (!r.found && !r.ambiguous) { r = await resolveOne('network_devices', query); type = 'device'; }
      if (!r.found) return r;
      const target = r.row;
      const result = await pingHost(target.ip_address);
      const status = result.alive ? 'online' : 'offline';
      const pingMs = result.time ? Math.round(result.time) : null;
      const table = type === 'server' ? 'servers' : 'network_devices';
      await db.prepare(`UPDATE ${table} SET status=?, last_ping=CURRENT_TIMESTAMP, ping_ms=? WHERE id=?`).run(status, pingMs, target.id);
      await db.prepare('INSERT INTO ping_history (device_id, device_type, status, ping_ms) VALUES (?, ?, ?, ?)').run(target.id, type === 'server' ? 'server' : 'network', status, pingMs);
      return { type, id: target.id, name: target.name, ip_address: target.ip_address, status, ping_ms: pingMs };
    }
  },
  {
    name: 'enable_fail2ban',
    description: 'Cài đặt (nếu chưa có) và bật fail2ban trên 1 VM — hành động thật thay đổi hạ tầng, cần xác nhận.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Tên hoặc địa chỉ IP chính xác của VM (đã xác định rõ, không mơ hồ)' } },
      required: ['query'], additionalProperties: false
    },
    mutating: true,
    permission: 'security.fail2ban.manage',
    summary: (input) => `Bật fail2ban trên VM: "${input.query}"`,
    execute: async ({ query }, user) => {
      const r = await resolveOne('vcenter_vms', query);
      if (!r.found) return r;
      const vm = r.row;
      if (!vm.ssh_user || !vm.ip_address) return { error: 'VM này chưa bật giám sát SSH (cần cấu hình SSH User trước)' };
      return await fail2banManager.installFail2ban(vm, user);
    }
  },
  {
    name: 'disable_fail2ban',
    description: 'Dừng dịch vụ fail2ban trên 1 VM (không gỡ cài đặt) — hành động thật thay đổi hạ tầng, cần xác nhận.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Tên hoặc địa chỉ IP chính xác của VM (đã xác định rõ, không mơ hồ)' } },
      required: ['query'], additionalProperties: false
    },
    mutating: true,
    permission: 'security.fail2ban.manage',
    summary: (input) => `Tắt fail2ban trên VM: "${input.query}"`,
    execute: async ({ query }, user) => {
      const r = await resolveOne('vcenter_vms', query);
      if (!r.found) return r;
      const vm = r.row;
      if (!vm.ssh_user || !vm.ip_address) return { error: 'VM này chưa bật giám sát SSH (cần cấu hình SSH User trước)' };
      return await fail2banManager.stopFail2ban(vm, user);
    }
  },
  {
    name: 'acknowledge_alert',
    description: 'Đánh dấu "Ghi nhận" 1 cảnh báo theo ID (lấy ID từ get_alerts) — hành động thật, cần xác nhận.',
    input_schema: {
      type: 'object',
      properties: { alertId: { type: 'number', description: 'ID cảnh báo' } },
      required: ['alertId'], additionalProperties: false
    },
    mutating: true,
    permission: 'alerts.write',
    summary: (input) => `Ghi nhận cảnh báo #${input.alertId}`,
    execute: async ({ alertId }, user) => {
      const alert = await db.prepare('SELECT * FROM alerts WHERE id=?').get(alertId);
      if (!alert) return { error: 'Không tìm thấy cảnh báo' };
      await db.prepare("UPDATE alerts SET status='acknowledged', acked_at=CURRENT_TIMESTAMP WHERE id=?").run(alertId);
      await logActivity(user, 'UPDATE', 'alert', alertId, alert.title, 'Ghi nhận cảnh báo (qua chatbot)');
      return { message: 'Đã ghi nhận cảnh báo', id: alertId, title: alert.title };
    }
  },
  {
    name: 'resolve_alert',
    description: 'Đánh dấu "Đã xử lý" 1 cảnh báo theo ID (lấy ID từ get_alerts) — hành động thật, cần xác nhận.',
    input_schema: {
      type: 'object',
      properties: { alertId: { type: 'number', description: 'ID cảnh báo' } },
      required: ['alertId'], additionalProperties: false
    },
    mutating: true,
    permission: 'alerts.write',
    summary: (input) => `Đánh dấu đã xử lý cảnh báo #${input.alertId}`,
    execute: async ({ alertId }, user) => {
      const alert = await db.prepare('SELECT * FROM alerts WHERE id=?').get(alertId);
      if (!alert) return { error: 'Không tìm thấy cảnh báo' };
      await db.prepare("UPDATE alerts SET status='resolved', resolved_at=CURRENT_TIMESTAMP WHERE id=?").run(alertId);
      await logActivity(user, 'UPDATE', 'alert', alertId, alert.title, 'Xử lý cảnh báo (qua chatbot)');
      return { message: 'Đã xử lý cảnh báo', id: alertId, title: alert.title };
    }
  }
];

const TOOLS_BY_NAME = Object.fromEntries(TOOLS.map(t => [t.name, t]));

module.exports = { TOOLS, TOOLS_BY_NAME, hasPermission, resolveOne };
