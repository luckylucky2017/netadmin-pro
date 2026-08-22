# ACTIVE_TASK.md — NetAdmin Pro

> Trạng thái công việc hiện tại. Đọc đầu tiên khi tiếp quản task.
> Cập nhật NGAY sau mỗi phiên làm việc (Claude Code hoặc Antigravity) —
> file này phải luôn phản ánh đúng "đang làm tới đâu", không phải nhật ký lịch sử.

## Đang làm / vừa xong (2026-08-22)

- [x] Trang **Cảnh báo**: restyle toolbar "Chọn tất cả + Đóng tất cả cảnh báo
      đang mở" — chuyển từ inline `style="..."` sang class `.alert-list-toolbar`
      (`public/css/style.css`) để đồng bộ pattern card-toolbar với
      `.table-toolbar`/`alertBulkToolbar` đã dùng ở nơi khác.
      - Commit: `485e35d` — đã push GitHub, đã deploy + verify trên prod
        (chi tiết server ở [`LOCAL_OPS.md`](LOCAL_OPS.md), không commit).
- [x] Audit bảo mật: xác nhận `.env`, `*.db*`, dữ liệu thật không lọt vào git
      (xem chi tiết ở [DECISIONS.md](DECISIONS.md)).
- [x] Thiết lập bộ nhớ dùng chung `.ai/` cho Claude Code + Google Antigravity.

## Việc chưa làm / có thể làm tiếp

- [ ] Chưa review toàn bộ UI trang Cảnh báo theo ui-ux-pro-max checklist
      (mới xử lý riêng nút "Đóng tất cả", chưa audit accessibility/contrast/
      touch-target cho cả `.alert-card`, filter row, bulk toolbar).
- [ ] Chưa có test tự động (unit/e2e) cho flow bulk-resolve alerts.
- [ ] Danh sách các trang khác trong app (Dashboard, vCenter, pfSense,
      MikroTik, CrowdSec, WAF, Fail2ban...) chưa được audit UI/UX gần đây —
      xem README.md để biết đầy đủ tính năng nếu cần chọn trang tiếp theo.

## Việc KHÔNG cần làm lại (đã quyết định/đã kiểm tra, tránh làm trùng)

- KHÔNG cần audit lại `.gitignore`/secrets — đã kiểm tra kỹ ngày 2026-08-22,
  sạch (`.env`, `*.db*` chưa từng commit, `schema.sql` không có `INSERT`).
- KHÔNG dùng `chromium-cli` để test UI trong sandbox này — không có sẵn, phải
  cài Playwright qua `npx playwright install chromium` (mất ~1-2 phút tải
  ~180MB). Cách verify UI đã dùng: script Playwright thủ công, login bằng
  tài khoản admin, `navigate('<page>')` qua `window` global, screenshot.

## Ghi chú vận hành khi cần deploy/test tiếp

- IP prod, user SSH, đường dẫn deploy, port local bị chiếm, v.v. → xem
  [`LOCAL_OPS.md`](LOCAL_OPS.md) (gitignore, không có trên máy mới — AI phải
  hỏi người dùng và tạo lại file này từ [`LOCAL_OPS.md.example`](LOCAL_OPS.md.example)
  nếu chưa tồn tại). Không đoán/dùng lại giá trị từ bộ nhớ hội thoại cũ.
- Chỉ ghi ở đây (an toàn để commit): trên máy dev đã dùng tính tới
  2026-08-22, mật khẩu admin trên DB **local** đã được reset về đúng giá trị
  `ADMIN_PASSWORD` trong `.env` của máy đó — không phải mật khẩu thật trên
  prod, và không áp dụng cho máy khác.
