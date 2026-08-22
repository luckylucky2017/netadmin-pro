# DECISIONS.md — NetAdmin Pro

> Nhật ký quyết định kỹ thuật + tham chiếu nhanh API/schema. Thêm mục mới ở
> TRÊN CÙNG mỗi khi có quyết định logic quan trọng, đổi schema, hoặc thêm
> endpoint mới — không sửa/xoá mục cũ, chỉ bổ sung (trừ khi mục cũ sai/lỗi thời
> thì đánh dấu "(đã thay bằng ...)" chứ không xoá, để giữ lịch sử "vì sao").

## API endpoints (mount tại `server.js`, tất cả `requireAuth` trừ `/api/auth`)

| Prefix | Route file | Ghi chú |
|---|---|---|
| `/api/auth` | `routes/auth.js` | Không yêu cầu auth (login/logout/SSO) |
| `/api/servers` | `routes/servers.js` | Máy chủ vật lý/VM |
| `/api/devices` | `routes/devices.js` | Thiết bị mạng |
| `/api/ping` | `routes/ping.js` | Ping thủ công |
| `/api/alerts` | `routes/alerts.js` | Cảnh báo — `/stats`, list, ack/resolve, bulk |
| `/api/rules` | `routes/rules.js` | Ngưỡng cảnh báo |
| `/api/vcenter` | `routes/vcenter.js` | vCenter đa cụm |
| `/api/security` | `routes/security.js` | SSH login log, outbound, fail2ban status |
| `/api/users` | `routes/users.js` | Cần thêm `requirePermission('users.manage')` |
| `/api/roles` | `routes/roles.js` | RBAC roles |
| `/api/monitors` | `routes/monitors.js` | Uptime monitor |
| `/api/chat` | `routes/chat.js` | Chatbot AI (tool-calling) |
| `/api/ssh-credentials` | `routes/ssh-credentials.js` | Tài khoản kết nối SSH dùng chung |
| `/api/settings` | `routes/settings.js` | app_settings (AI key, SAML/LDAP) |
| `/api/notification-rules` | `routes/notification-rules.js` | Quy tắc thông báo |
| `/api/pfsense` | `routes/pfsense.js` | Firewall pfSense |
| `/api/waf` | `routes/waf.js` | WAF (ModSecurity/nginx) + scheduled IP block |
| `/api/crowdsec` | `routes/crowdsec.js` | CrowdSec (cscli qua SSH) |
| `/api/reports` | `routes/reports.js` | Báo cáo |
| `/api/fail2ban-config` | `routes/fail2ban-config.js` | Cấu hình fail2ban |
| `/api/vuln` | `routes/vuln.js` | Quét lỗ hổng (vuln-scanner/enrichment) |
| `/api/trivy` | `routes/trivy.js` | Trivy scanner |
| `/api/harbor` | `routes/harbor.js` | Harbor registry scanner |
| `/api/mikrotik` | `routes/mikrotik.js` | MikroTik RouterOS |

## DB schema — bảng chính (đầy đủ ở `schema.sql`, sinh bằng `mysqldump --no-data`)

`users`, `roles`, `role_permissions`, `sessions` — auth/RBAC
`servers`, `network_devices`, `metrics_history`, `ping_history` — inventory & metrics
`vcenter_clusters`, `vcenter_vms`, `vm_metrics_history` — vCenter
`alerts`, `alert_rules` — cảnh báo
`monitors`, `monitor_checks` — uptime
`ssh_credentials`, `ssh_login_events`, `ssh_log_cursor` — SSH/bảo mật
`outbound_connections` — kết nối outbound đáng ngờ
`pfsense_firewalls`, `pfsense_interfaces`, `pfsense_firewall_rules`, `pfsense_vpn_status` — pfSense
`app_settings` — cấu hình runtime (AI key, SAML/LDAP...), key-value trong MySQL
`activity_logs` — nhật ký hoạt động (ai/làm gì/khi nào)
`import_logs` — log import dữ liệu

## Quyết định logic quan trọng (mới nhất trên cùng)

### 2026-08-22 — Toolbar "Đóng tất cả cảnh báo" dùng class riêng, không inline style
`renderAlertRows()` trong `public/js/app.js` từng build hàng
"select-all + resolve-all" bằng 1 `<div style="...">` viết tay. Đổi sang class
`.alert-list-toolbar` (định nghĩa cạnh `.alert-list` trong `style.css`) để
match pattern card-toolbar đã dùng ở `.table-toolbar`/`alertBulkToolbar` —
lý do: mọi toolbar khác trong app đều có nền/viền/bo góc nhất quán, div trần
không viền phá vỡ visual rhythm. **Quy tắc rút ra**: khi 1 khối UI lặp lại ở
≥ 2 nơi hoặc cần khớp 1 pattern đã tồn tại, viết class trong `style.css`, không
inline `style="..."` trong `app.js`.

### fail2ban_ban alert hiển thị trạng thái riêng, không dùng `status` thật
`alertDisplayStatus(a)` trong `app.js`: nếu `metric === 'fail2ban_ban'` và
`status === 'open'` → hiển thị badge `auto_blocked` thay vì "Đang mở". Lý do:
fail2ban đã tự chặn IP rồi (hành động khắc phục đã xảy ra), hiển thị "cần chú
ý" như alert resource/app-error là gây hiểu nhầm. `status` thật trong DB
KHÔNG đổi — nút ack/resolve và số liệu thống kê vẫn dựa trên `status` gốc, chỉ
badge hiển thị bị thay, và chỉ tới khi collector tự resolve lúc IP được unban.

### "Chặn theo giờ" (scheduled IP block): window nghĩa là BỊ CHẶN, không phải được phép
Bản đầu tiên hiểu nhầm ngược — sau sửa: khung giờ được chọn trong lịch =
khoảng thời gian IP **bị chặn**, ngoài khung giờ đó = được phép. Scheduled
block được **couple với WAF exceptions** để đảm bảo enforcement thực sự chạy
qua WAF chứ không chỉ là record trong DB.

### `.env` chỉ giữ biến bootstrap, mọi credential hạ tầng thật nằm trong MySQL
Quyết định kiến trúc xuyên suốt README: vCenter/SSH/AI key/LDAP/pfSense config
đều quản lý trong app (lưu MySQL), không hardcode, không vào `.env`/git.
`.env` chỉ còn `MYSQL_*`/`PORT`/`SESSION_SECRET`/`ADMIN_EMAIL`/`ADMIN_PASSWORD`
(2 biến admin chỉ áp dụng 1 lần lúc bảng `users` rỗng — đổi `.env` sau đó
KHÔNG reset lại mật khẩu, phải sửa trực tiếp DB nếu cần).

### Audit bảo mật git — kết quả xác nhận sạch (2026-08-22)
Kiểm tra toàn bộ lịch sử git: `.env` và `*.db*` chưa từng được commit
(`git log --all --full-history` rỗng cho cả 2). `schema.sql` không chứa dòng
`INSERT` nào (chỉ cấu trúc bảng). Không có password/API key hardcode trong
`database.js`/`server.js`/`auth.js`/`settings.js`. IP nội bộ xuất hiện trong
`app.js` chỉ là `placeholder="..."` trong form, không phải dữ liệu thật. IP
prod thật (xem `LOCAL_OPS.md`, không commit) không xuất hiện trong bất kỳ file
tracked nào.
