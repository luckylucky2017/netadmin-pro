// Single source of truth for every permission key in the app — consumed by database.js (seeding
// system roles), routes/roles.js (GET /permissions, for the role-editor checkbox matrix), and
// auth.js (dev-time assertion that every requirePermission() call site uses a real key). Keeping
// this in one place is what stops the seed list and the UI catalog from silently drifting apart.
const PERMISSIONS = [
  { key: 'servers.write', label: 'Tạo/sửa máy chủ', group: 'Máy chủ' },
  { key: 'servers.delete', label: 'Xóa máy chủ', group: 'Máy chủ' },
  { key: 'servers.ipmi_config', label: 'Cấu hình IPMI (host/username/password)', group: 'Máy chủ' },
  { key: 'servers.snmp_config', label: 'Cấu hình SNMP v3 cho máy chủ', group: 'Máy chủ' },
  { key: 'devices.write', label: 'Tạo/sửa thiết bị mạng', group: 'Thiết bị mạng' },
  { key: 'devices.delete', label: 'Xóa thiết bị mạng', group: 'Thiết bị mạng' },
  { key: 'devices.snmp_config', label: 'Cấu hình SNMP v3 cho thiết bị mạng', group: 'Thiết bị mạng' },
  { key: 'vcenter.sync', label: 'Đồng bộ vCenter', group: 'vCenter / VM' },
  { key: 'vcenter.cluster.manage', label: 'Quản lý kết nối cụm vCenter (thêm/sửa/xóa)', group: 'vCenter / VM' },
  { key: 'vcenter.vm.create', label: 'Tạo VM (rỗng hoặc clone)', group: 'vCenter / VM' },
  { key: 'vcenter.vm.console', label: 'Mở console VM', group: 'vCenter / VM' },
  { key: 'vcenter.vm.power', label: 'Bật/tắt/khởi động lại VM', group: 'vCenter / VM' },
  { key: 'vcenter.vm.edit', label: 'Sửa cấu hình / đổi tên VM', group: 'vCenter / VM' },
  { key: 'vcenter.vm.delete', label: 'Xóa VM', group: 'vCenter / VM' },
  { key: 'rules.write', label: 'Tạo/sửa/bật-tắt ngưỡng cảnh báo', group: 'Ngưỡng cảnh báo' },
  { key: 'rules.delete', label: 'Xóa ngưỡng cảnh báo', group: 'Ngưỡng cảnh báo' },
  { key: 'alerts.write', label: 'Ghi nhận / xử lý cảnh báo', group: 'Cảnh báo' },
  { key: 'alerts.delete', label: 'Xóa cảnh báo', group: 'Cảnh báo' },
  { key: 'security.ssh_config', label: 'Bật/tắt giám sát SSH cho VM', group: 'Bảo mật' },
  { key: 'security.fail2ban.check', label: 'Kiểm tra trạng thái fail2ban', group: 'Bảo mật' },
  { key: 'security.fail2ban.manage', label: 'Bật/tắt (cài đặt) fail2ban', group: 'Bảo mật' },
  { key: 'security.block', label: 'Chặn/gỡ chặn IP thủ công (SSH) & quản lý ngoại lệ IP', group: 'Bảo mật' },
  { key: 'waf.manage', label: 'Bật/tắt giám sát WAF, cấu hình đường dẫn log & tự động chặn', group: 'Bảo mật' },
  { key: 'waf.jail.check', label: 'Kiểm tra trạng thái jail WAF', group: 'Bảo mật' },
  { key: 'waf.jail.manage', label: 'Cài đặt/dừng jail WAF', group: 'Bảo mật' },
  { key: 'waf.block', label: 'Chặn/gỡ chặn IP thủ công (WAF)', group: 'Bảo mật' },
  { key: 'fail2ban.config.manage', label: 'Cấu hình ngưỡng phát hiện & bantime cho fail2ban (sshd + WAF)', group: 'Bảo mật' },
  { key: 'vuln.scan.manage', label: 'Bật/tắt quét lỗ hổng (CVE) & quét ngay cho VM', group: 'Bảo mật' },
  { key: 'vuln.update.manage', label: 'Kiểm tra & cài đặt bản cập nhật gói (apt), quản lý ngoại lệ', group: 'Bảo mật' },
  { key: 'trivy.scan.manage', label: 'Bật/tắt quét mã nguồn ứng dụng (Trivy), cấu hình đường dẫn, cài đặt Trivy', group: 'Bảo mật' },
  { key: 'ping.write', label: 'Ping thủ công', group: 'Ping' },
  { key: 'users.manage', label: 'Quản lý người dùng', group: 'Quản trị' },
  { key: 'roles.manage', label: 'Quản lý vai trò', group: 'Quản trị' },
  { key: 'monitors.write', label: 'Tạo/sửa/kiểm tra ngay monitor uptime', group: 'Giám sát Uptime' },
  { key: 'monitors.delete', label: 'Xóa monitor uptime', group: 'Giám sát Uptime' },
  { key: 'ssh_credentials.manage', label: 'Quản lý tài khoản kết nối SSH (private key/mật khẩu)', group: 'Quản trị' },
  { key: 'settings.manage', label: 'Quản lý cài đặt hệ thống (AI key, SSO)', group: 'Quản trị' },
  { key: 'pfsense.manage', label: 'Quản lý kết nối firewall pfSense (thêm/sửa/xóa)', group: 'pfSense' },
  { key: 'pfsense.sync', label: 'Đồng bộ dữ liệu pfSense', group: 'pfSense' },
  { key: 'pfsense.rules.write', label: 'Tạo/sửa rule tường lửa pfSense', group: 'pfSense' },
  { key: 'pfsense.rules.delete', label: 'Xóa rule tường lửa pfSense', group: 'pfSense' },
  { key: 'pfsense.vpn.manage', label: 'Quản trị cấu hình OpenVPN trên pfSense', group: 'pfSense' },
  { key: 'mikrotik.manage', label: 'Quản lý kết nối firewall MikroTik (thêm/sửa/xóa)', group: 'MikroTik' },
  { key: 'mikrotik.sync', label: 'Đồng bộ dữ liệu MikroTik', group: 'MikroTik' },
  { key: 'mikrotik.rules.write', label: 'Tạo/sửa/bật-tắt rule tường lửa MikroTik', group: 'MikroTik' },
  { key: 'mikrotik.rules.delete', label: 'Xóa rule tường lửa MikroTik', group: 'MikroTik' },
];

const PERMISSION_KEYS = new Set(PERMISSIONS.map(p => p.key));

// Excluded from Operator: every *.delete key, plus the "keys to the kingdom" admin-only actions —
// exactly what requireRole('admin') vs requireRole('admin','operator') already encoded before this
// migration, preserved here so the seeded Operator role has zero behavior change.
const OPERATOR_EXCLUDED = new Set([
  'servers.delete', 'devices.delete', 'vcenter.vm.delete', 'rules.delete', 'alerts.delete',
  'security.ssh_config', 'security.fail2ban.manage', 'security.block', 'waf.manage', 'waf.jail.manage', 'waf.block', 'fail2ban.config.manage', 'vuln.scan.manage', 'vuln.update.manage', 'trivy.scan.manage', 'users.manage', 'roles.manage',
  'servers.ipmi_config', 'monitors.delete', 'servers.snmp_config', 'devices.snmp_config',
  'vcenter.cluster.manage', 'ssh_credentials.manage', 'settings.manage',
  'pfsense.manage', 'pfsense.rules.delete', 'pfsense.vpn.manage',
  'mikrotik.manage', 'mikrotik.rules.delete',
]);

module.exports = { PERMISSIONS, PERMISSION_KEYS, OPERATOR_EXCLUDED };
