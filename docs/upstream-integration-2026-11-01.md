# Tích hợp upstream — 01/11/2026

- Nhánh đích: `version-1.1.2`, điểm xuất phát `9bfae15955`.
- Upstream: `upstream/main` tại `c419cf7c86` (31/10/2026). Cửa sổ xét: `79b45d1647..c419cf7c86`, 9.200 commit (5.542 first-parent).
- Phân loại tự động: 6.019 chạm file fork không có, 2.107 chỉ chạm đường dẫn không dùng, 1.045 ứng viên (168 merge sạch, 877 xung đột). Đây là sàng lọc theo đường dẫn và tiêu đề; chỉ các commit được chọn mới đọc diff.

## Đã lấy

- Bảo mật phụ thuộc: tornado 6.5.10, oauthlib 4.0.0, axios, joi, shell-quote, follow-redirects.
- Lấy nguyên: che khoá Context7, session id theo từng lượt của gateway, `gc.collect` trên mọi nền tảng, 3 sửa TUI, 3 sửa desktop/web, sửa test SIGTERM pytest.
- Port tay vì code fork đã lệch (mỗi commit ghi rõ trong message): Enter trên PTY, allowlist MCP của cron không bị nới, chữ ký quét skill, tiền tố `plugin:` khi gọi skill, đóng response store ngoài event loop, alias Windows khi xoá hồ sơ, đường dẫn Docker trên gateway Windows, wake nội bộ không reply-anchor.

## Đã thử và bỏ

- `ba7bfeadb1`: gọi `_strip_trailing_silence_marker` fork không có.
- `e03c9c668b`: cần gói dùng chung của upstream và `composerPlainText`.
- `554695ed4b`: cần browser bridge của Webapp.
- `ac50e08b54`: chỉ gán `_backend_settled`, thuộc tính fork không đọc ở đâu.
- `86a61729d3`, `a5d3c25664`, `cfe79177a3`: test mới đỏ trên fork.
- `5a6907154d`: cần `connection_profile_home`.

## Để lại

Khoảng 90 bản sửa nhỏ đã chọn nhưng nhắm vào code fork không có (patch không áp được): chuỗi memory stuck-call, redact đệ quy của trình duyệt, MCP approval trong `tools/mcp_tool_handlers.py`, `agent/deadline.py` cho tải models.dev, RPC stdin trên Windows (`be95d40a7e`), delegation redaction. Muốn lấy phải đưa các refactor nền của upstream vào trước.

## Kiểm thử

- Python, 607 file test theo blast-radius, chạy tuần tự: baseline 73 failed / 8.043 passed; nhánh 73 failed / 8.055 passed; tập test đỏ giống hệt, 0 lỗi mới.
- Desktop: `tsc` sạch (renderer + electron); vitest 6.261 passed, 1 failed (`electron/webmate/service.integration.test.ts`, đỏ cả trên baseline vì thiếu `apps/desktop/build/webmate`).
- TUI: vitest 1.562 passed. Web: `PageHeaderProvider` 3 passed.
- `npm ci`, `uv lock --check`, ruff F821/F601/F811 không đổi so với baseline.
- oauthlib 4.0.0 chỉ thử trong venv riêng với `requests-oauthlib` 2.0.0; `venv` dev vẫn ở 3.3.1, nên phần lớn test Python chưa chạy trên oauthlib 4.
- Chưa chạy trên Windows thật: các sửa Windows chỉ có test giả lập trên macOS.
