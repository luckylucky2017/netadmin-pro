# PROJECT_CONTEXT.md — NetAdmin Pro

> Ngữ cảnh cố định của dự án. Đọc file này trước khi bắt đầu bất kỳ task nào.
> Ít thay đổi — chỉ cập nhật khi tech stack/kiến trúc/convention thực sự đổi.

## Bài toán

Nền tảng giám sát & quản trị hạ tầng CNTT tập trung: máy chủ vật lý, thiết bị
mạng, VM vCenter, firewall pfSense/MikroTik, uptime website/API, cảnh báo theo
ngưỡng, bảo mật SSH/fail2ban/CrowdSec/WAF, quét lỗ hổng (Trivy/Harbor) — kèm
chatbot AI (Claude) có thể tra cứu và thực thi hành động qua hội thoại tự nhiên.

Toàn bộ giao diện, thông báo lỗi, log hoạt động: **tiếng Việt**.
Mốc thời gian hiển thị: **GMT+7 (Asia/Ho_Chi_Minh)**.

## Tech Stack

| Thành phần | Công nghệ |
|---|---|
| Backend | Node.js + Express |
| Database | MySQL 8.x (qua `mysql2/promise`) — không ORM, raw SQL |
| Frontend | HTML/CSS/JS thuần — **không framework, không build step** |
| Session/Auth | `express-session` (MySQL store) + `bcryptjs`; SSO qua SAML (`@node-saml/node-saml`) và LDAP (`ldapjs`) |
| AI | `@anthropic-ai/sdk` — chatbot tool-calling |
| Tích hợp hạ tầng | `node-ssh` (SSH), `net-snmp`/`snmp-native` (SNMP), `node-routeros` (MikroTik), `ping`, `geoip-lite`, `nodemailer` |
| Bảo mật app | `helmet`, `express-rate-limit` |

Sửa file trong `public/` → thấy ngay khi F5 (không build). Chỉ backend
(`server.js`, `routes/*.js`, `*-collector.js`) mới cần restart process
(`npm run dev` dùng nodemon tự restart).

## Kiến trúc thư mục

```
netadmin-pro/
├── server.js              # Entry point, mount route, khởi động collector
├── database.js            # Kết nối MySQL, schema, migration, seed mặc định
├── schema.sql              # Dump cấu trúc DB (mysqldump --no-data), tham khảo
├── auth.js                 # Login, session, requirePermission, logActivity
├── settings.js              # Đọc/cache app_settings (AI key, SAML/LDAP)
├── permissions-catalog.js   # Danh mục quyền RBAC dùng chung
├── chatbot-tools.js / chatbot-engine.js   # Tool-calling chatbot AI
├── *-collector.js           # Tiến trình thu thập dữ liệu nền (chạy định kỳ)
├── ssh-credentials.js       # Giải quyết tài khoản SSH cho collector
├── vcenter-*.js             # Tích hợp vCenter đa cụm
├── pfsense-*.js             # Tích hợp firewall pfSense (REST API)
├── mikrotik-*.js            # Tích hợp MikroTik (RouterOS API)
├── crowdsec-*.js            # CrowdSec (cscli qua SSH)
├── fail2ban-*.js            # fail2ban qua SSH
├── waf-manager.js / nginx-waf-collector.js   # WAF (ModSecurity/nginx)
├── trivy-scanner.js / harbor-scanner.js      # Quét lỗ hổng container
├── routes/                  # REST API — 1 file / nhóm tài nguyên, mount ở server.js
└── public/
    ├── index.html            # Shell duy nhất (login screen + #app)
    ├── css/style.css          # 1 file CSS toàn app, design tokens qua CSS vars
    └── js/app.js              # Toàn bộ logic SPA — render trang, gọi API, state
```

## Conventions

- **SPA điều hướng qua `navigate('<page>')`** trong `app.js` — mỗi trang có
  1 hàm `renderXxx()` build `innerHTML` cho `#pageContent`, không có router lib.
- **API helper `api(path, opts)`** trong `app.js` — mọi gọi REST đi qua đây
  (xử lý lỗi, JSON, credentials).
- **RBAC**: `requirePermission('<perm.key>')` ở route backend;
  `data-permission="<perm.key>"` ở element frontend để ẩn/hiện theo quyền.
  Danh mục quyền tập trung ở `permissions-catalog.js`.
- **Design tokens**: mọi màu/spacing dùng CSS var trong `style.css`
  (`--surface`, `--surface2`, `--border`, `--radius`, `--radius-lg`, `--accent`,
  `--red`/`--red-dim`, `--yellow`/`--yellow-dim`, ...) — **không hardcode hex**
  trong `app.js`, không dùng inline `style="..."` rời rạc cho layout lặp lại;
  tạo class riêng trong `style.css` nếu pattern xuất hiện > 1 chỗ.
- **Nút hành động**: `.btn.btn-primary` (hành động chính), `.btn-secondary`
  (phụ), `.btn-danger` (phá hủy/đóng hàng loạt), `.btn-sm` (nhỏ trong toolbar).
- **Toolbar/card pattern**: `.table-toolbar`, `.alert-list-toolbar`,
  `alertBulkToolbar` — nền `--surface`/`--surface2`, viền `--border`, bo góc
  `--radius-lg`. Theo pattern này khi thêm toolbar mới, không viết flex div trần.
- **Icon**: SVG inline (stroke `currentColor`, stroke-width 2), không dùng emoji
  làm icon chức năng.
- **Secrets/credentials hạ tầng thật** (vCenter, SSH, AI key, LDAP, pfSense,
  MikroTik...) → lưu trong MySQL (`app_settings`, `ssh_credentials`,
  `vcenter_clusters`, `pfsense_firewalls`...), **không** hardcode, **không**
  vào `.env`/git. `.env` chỉ chứa `MYSQL_*`/`PORT`/`SESSION_SECRET`/
  `ADMIN_EMAIL`/`ADMIN_PASSWORD` (2 biến admin chỉ dùng 1 lần lúc bootstrap).
- **Collector nền**: mỗi `*-collector.js` chạy độc lập theo interval riêng,
  khởi động từ `server.js`; đọc `DISABLE_BACKGROUND_COLLECTORS` env để tắt khi
  cần (dev/test không muốn poll thật).

## Môi trường

- **Local (máy dev)**: MySQL local `netadmin_pro`, dùng để code/test — **tách
  biệt hoàn toàn** với prod, không dùng chung DB, không chứa dữ liệu prod thật.
- **Prod**: chạy dưới systemd `netadmin-pro.service`, deploy bằng `git pull`
  (branch `master`) rồi `sudo systemctl restart netadmin-pro`. IP, hostname,
  user SSH, đường dẫn code cụ thể **không lưu ở đây** (repo này là **PUBLIC**
  trên GitHub) — xem mục "Thông tin nhạy cảm" bên dưới.
- **GitHub**: `github.com/luckylucky2017/netadmin-pro` — repo **PUBLIC**.
  KHÔNG chứa `.env`, DB dump có dữ liệu thật, hay bất kỳ secret/IP nội bộ nào
  (đã audit — xem [DECISIONS.md](DECISIONS.md)). Vì public, **không bao giờ**
  ghi IP thật, username SSH, đường dẫn key, hostname nội bộ vào 3 file `.ai/`
  này hay bất kỳ file nào được commit.

## Thông tin nhạy cảm (không lưu trong repo — hỏi người dùng khi cần)

File `.ai/LOCAL_OPS.md` chứa IP prod, user/host SSH, đường dẫn code trên
server, cách lấy quyền sudo... File này **không commit** (đã gitignore) vì
repo public. Trên máy mới sau khi `git pull`:

1. Kiểm tra `.ai/LOCAL_OPS.md` có tồn tại không.
2. **Nếu KHÔNG có** — đây là máy mới hoặc lần đầu cần thao tác prod/SSH: hỏi
   người dùng cung cấp thông tin (IP/host, user SSH, cách xác thực, đường dẫn
   deploy...), rồi tạo lại `.ai/LOCAL_OPS.md` từ mẫu
   [`LOCAL_OPS.md.example`](LOCAL_OPS.md.example) với giá trị họ vừa cho.
   **Không tự đoán hay dùng lại IP/thông tin từ phiên làm việc cũ trong bộ nhớ
   của AI** — luôn hỏi lại vì đây là dữ liệu riêng theo máy/phiên.
3. **Nếu có** — đọc và dùng trực tiếp, không hỏi lại.

## AI đang dùng song song trên repo này

Cả **Claude Code** và **Google Antigravity** đang cùng vibe-code trên project
này. 3 file trong `.ai/` (`PROJECT_CONTEXT.md`, `ACTIVE_TASK.md`,
`DECISIONS.md`) là bộ nhớ dùng chung — **đọc trước khi làm, cập nhật sau khi
xong** task, bất kể đang dùng công cụ nào.
