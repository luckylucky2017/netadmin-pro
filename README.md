# NetAdmin Pro

Nền tảng giám sát & quản trị hạ tầng CNTT tập trung: máy chủ vật lý, thiết bị mạng, VM vCenter, uptime website/API, cảnh báo theo ngưỡng, bảo mật SSH/fail2ban — kèm trợ lý AI có thể tra cứu và thực thi hành động qua hội thoại tự nhiên.

## Tính năng chính

- **Máy chủ & thiết bị mạng** — theo dõi CPU/RAM/Disk, trạng thái online/offline, ping thủ công, phân trang & tìm kiếm.
- **Sức khỏe phần cứng qua IPMI** — trạng thái từng linh kiện (DIMM/CPU/ổ đĩa/quạt/nguồn) và SEL log lỗi qua `ipmitool`.
- **Giám sát SNMP** — CPU, RAM, uptime, lưu lượng interface cho máy chủ và thiết bị mạng.
- **vCenter / VM đa cụm** — kết nối nhiều hệ thống vCenter cùng lúc (trang **Cụm vCenter**), đồng bộ inventory theo từng cụm, tạo/clone VM, bật/tắt/khởi động lại, console WebMKS, xóa.
- **pfSense (tường lửa)** — kết nối firewall pfSense qua REST API (`pfSense-pkg-API`, yêu cầu pfSense ≥ 2.8.0 CE), xem trạng thái hệ thống/interface/gateway kèm băng thông in/out theo thời gian thực, quản lý rule tường lửa (xem/thêm/sửa/bật-tắt/xóa + áp dụng thay đổi), xem kết nối VPN (OpenVPN/IPsec) đang hoạt động kèm băng thông chi tiết từng IP client (đang gửi/nhận bao nhiêu, tổng đã truyền) và sửa cấu hình OpenVPN server.
- **Giám sát Uptime** — kiểm tra định kỳ website/API theo khoảng thời gian tùy chọn, biểu đồ thời gian phản hồi, cảnh báo hết hạn SSL.
- **Cảnh báo (Alerts)** — ngưỡng cấu hình theo CPU/RAM/Disk, xử lý đơn lẻ hoặc hàng loạt (ghi nhận/xử lý xong theo checkbox).
- **Bảo mật** — nhật ký đăng nhập SSH thật, phát hiện đăng nhập từ nước ngoài, kết nối outbound đáng ngờ, quản lý fail2ban (kiểm tra/bật/tắt) trên từng VM.
- **Tài khoản kết nối SSH** — quản lý tập trung nhiều tài khoản (private key hoặc mật khẩu), gán riêng cho từng máy chủ/VM thay vì 1 key dùng chung toàn hệ thống.
- **Nhật ký hoạt động** — ai làm gì, trên đối tượng nào, lúc nào — có bộ lọc, tìm kiếm, phân trang.
- **RBAC chi tiết** — 3 vai trò hệ thống (Admin/Operator/Viewer) + vai trò tùy biến, phân quyền theo từng hành động cụ thể.
- **Đăng nhập** — tài khoản cục bộ, SSO qua SAML, bind-auth qua LDAP/Active Directory (cấu hình trong trang **Cài đặt**).
- **Trợ lý AI (Chatbot)** — hỏi trạng thái máy chủ/VM/cảnh báo/uptime bằng ngôn ngữ tự nhiên, hoặc yêu cầu hành động (vd: "bật fail2ban trên VM web-01"); mọi hành động thay đổi hạ tầng đều có bước xác nhận trước khi thực thi.
- **Cài đặt hệ thống** — Anthropic API Key (chatbot) và cấu hình SSO (SAML/LDAP) quản lý ngay trong ứng dụng, lưu ở MySQL, có hiệu lực ngay không cần khởi động lại server.
- Toàn bộ mốc thời gian hiển thị theo **GMT+7 (Asia/Ho_Chi_Minh)**.

## Kiến trúc & công nghệ

| Thành phần | Công nghệ |
|---|---|
| Backend | Node.js + Express |
| Cơ sở dữ liệu | MySQL (qua `mysql2/promise`) |
| Frontend | HTML/CSS/JS thuần (không framework, không build step) — SPA điều hướng qua `navigate()` |
| Xác thực | Session cookie (MySQL session store) + bcrypt, SAML, LDAP |
| AI | Anthropic Claude (`@anthropic-ai/sdk`) — chatbot tool-calling |
| Thu thập dữ liệu nền | Các collector chạy định kỳ độc lập (xem bên dưới) |

Ứng dụng không có bước build — sửa file trong `public/` là thấy ngay khi tải lại trang; chỉ các thay đổi ở backend (`server.js`, `routes/*.js`, các collector) mới cần khởi động lại tiến trình Node.

### Các collector chạy nền

| Collector | Nhiệm vụ |
|---|---|
| `metrics-simulator.js` | Sinh số liệu CPU/RAM/Disk mô phỏng cho máy chủ chưa cấu hình SSH |
| `ssh-collector.js` | Thu thập CPU/RAM/Disk thật qua SSH |
| `snmp-collector.js` | Thu thập chỉ số qua SNMP (máy chủ & thiết bị mạng) |
| `ipmi-collector.js` | Trạng thái nguồn, sức khỏe linh kiện, SEL log qua IPMI |
| `vcenter-collector.js` | Đồng bộ inventory & chỉ số VM từ vCenter |
| `ssh-security-collector.js` | Phân tích log đăng nhập SSH thật (auth.log) |
| `outbound-connection-collector.js` | Theo dõi kết nối mạng outbound của VM |
| `fail2ban-collector.js` | Đọc trạng thái ban của fail2ban trên các VM đã cài |
| `uptime-collector.js` | Kiểm tra định kỳ các monitor uptime (website/API) |
| `alert-engine.js` | Đánh giá ngưỡng cảnh báo đã cấu hình, mở/đóng alert tương ứng |
| `pfsense-collector.js` | Đồng bộ trạng thái interface/gateway, rule tường lửa, VPN từ các firewall pfSense |

## Cài đặt

### Yêu cầu

- Node.js ≥ 18
- MySQL 8.x (hoặc tương thích) đã tạo sẵn database + user riêng cho app

### Các bước

```bash
git clone https://github.com/luckylucky2017/netadmin-pro.git
cd netadmin-pro
npm install
cp .env.example .env
```

`.env` giờ chỉ cần thông tin để Node chạy và kết nối MySQL — mọi cấu hình khác (vCenter, tài khoản kết nối SSH, Anthropic API Key, SAML/LDAP) quản lý trong ứng dụng sau khi đăng nhập, không cần đặt trước:

- `PORT` — cổng chạy server, mặc định 3000.
- `MYSQL_HOST` / `MYSQL_PORT` / `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_DATABASE` — bắt buộc.
- `SESSION_SECRET` — bắt buộc, tạo chuỗi ngẫu nhiên (vd `openssl rand -hex 32`).
- `ADMIN_EMAIL` / `ADMIN_PASSWORD` — tài khoản admin đầu tiên, chỉ dùng 1 lần lúc bảng `users` còn rỗng; đổi mật khẩu ngay sau khi đăng nhập lần đầu.

Khởi động:

```bash
npm start        # production
npm run dev       # tự khởi động lại khi sửa code (nodemon)
```

Ứng dụng chạy tại `http://localhost:3000` (đổi qua biến `PORT`). Lần khởi động đầu tiên, schema MySQL, tài khoản admin, và các bảng cấu hình mặc định sẽ tự động được tạo (có thể tạo schema thủ công trước bằng `schema.sql` ở gốc repo nếu muốn, không bắt buộc). Sau khi đăng nhập, vào các trang **Cụm vCenter**, **Tài khoản kết nối**, **Cài đặt**, **pfSense** để cấu hình vCenter/SSH/AI key/SSO/firewall.

## Cấu trúc thư mục

```
netadmin-pro/
├── server.js                  # Điểm khởi động, mount route, khởi động các collector
├── database.js                # Kết nối MySQL, schema, migration, seed dữ liệu mặc định
├── schema.sql                 # Dump cấu trúc DB (không dữ liệu) — tham khảo/khởi tạo thủ công, tùy chọn
├── auth.js                    # Đăng nhập, session, requirePermission, logActivity
├── settings.js                # Đọc/cache cài đặt hệ thống (AI key, SAML/LDAP) từ bảng app_settings
├── permissions-catalog.js     # Danh mục quyền dùng chung cho RBAC
├── chatbot-tools.js           # Danh mục tool cho chatbot AI
├── chatbot-engine.js          # Vòng lặp tool-calling của chatbot (có thể test độc lập)
├── *-collector.js             # Các tiến trình thu thập dữ liệu nền
├── fail2ban-manager.js        # Nghiệp vụ kiểm tra/bật/tắt fail2ban qua SSH
├── ssh-credentials.js         # Giải quyết tài khoản kết nối SSH (private key/mật khẩu) cho collector
├── vcenter-client.js / vcenter-registry.js / vcenter-actions.js   # Tích hợp vCenter đa cụm
├── pfsense-client.js / pfsense-collector.js   # Tích hợp firewall pfSense qua REST API
├── routes/                    # REST API, mỗi file 1 nhóm tài nguyên
└── public/                    # Frontend tĩnh (không build step)
    ├── index.html
    ├── css/style.css
    └── js/app.js               # Toàn bộ logic SPA (render trang, gọi API, state)
```

## Phân quyền (RBAC)

Quyền được định nghĩa tập trung tại `permissions-catalog.js`, nhóm theo khu vực chức năng: **Máy chủ, Thiết bị mạng, vCenter/VM, Ngưỡng cảnh báo, Cảnh báo, Bảo mật, Ping, Giám sát Uptime, pfSense, Quản trị**. 3 vai trò hệ thống (Admin/Operator/Viewer) được seed sẵn khi khởi động lần đầu; có thể tạo thêm vai trò tùy biến trong trang **Vai trò**.

## Lưu ý bảo mật

- `.env` không được commit — xem `.env.example` để biết đầy đủ biến cần cấu hình. `.env` chỉ còn `MYSQL_*`/`PORT`/`SESSION_SECRET`/`ADMIN_EMAIL`/`ADMIN_PASSWORD`.
- Mật khẩu/khóa kết nối hạ tầng thật (vCenter, SSH, AI key, LDAP, pfSense) quản lý trong ứng dụng, lưu trong MySQL (bảng `vcenter_clusters`, `ssh_credentials`, `app_settings`, `pfsense_firewalls`) — không hardcode trong mã nguồn, không nằm trong `.env`/git. `schema.sql` chỉ chứa cấu trúc bảng (`mysqldump --no-data`), không có dữ liệu thật.
- Session ký bằng `SESSION_SECRET` — đổi giá trị này sẽ đăng xuất toàn bộ người dùng đang đăng nhập.
- Chatbot AI chỉ thực thi hành động thay đổi hạ tầng (fail2ban, cảnh báo...) sau bước xác nhận rõ ràng trên giao diện, và luôn kiểm tra quyền của người dùng đang chat trước khi chạy.

## Ngôn ngữ

Toàn bộ giao diện, thông báo lỗi và log hoạt động bằng tiếng Việt.
