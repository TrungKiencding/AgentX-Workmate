# Tích hợp upstream — 10/11/2026

- Nhánh đích: `version-1.1.3`, điểm xuất phát `6526ed48f1`.
- Upstream: `upstream/main` tại `0d20e9caee` (10/11/2026). Cửa sổ xét: `c419cf7c86..0d20e9caee`, 5.146 commit first-parent.
- Phân loại theo đường dẫn: 2.788 không liên quan (catalog, plugin-catalog, website, docs…), 1.907 chạm file fork không có, 409 ứng viên (63 merge sạch, phần lớn là test; 346 xung đột). Thêm 362 commit chỉ thiếu file test upstream.
- Bốn lượt phân tích đọc diff từng commit và đối chiếu điều kiện lỗi trên code fork. Chỉ lấy lỗi có thật trên fork, giá trị cao hoặc trung bình, port được mà không cần kéo refactor nền của upstream.

## Đã lấy

Mỗi commit ghi rõ nguồn upstream trong message. Port một phần ghi "Port from upstream …" (không dùng trailer cherry-pick).

**Bảo mật**
- `agent/redact.py`: đưa module che bí mật lên bản upstream hiện tại (51 commit) kèm `redact_connstr.py`, `redact_headers.py`. Bản fork hụt 211/632 test của upstream: mật khẩu truyền qua cờ (`--password x`), chuỗi kết nối DB (PGPASSWORD, MYSQL_PWD, libpq), khoá PGP/PuTTY/age, YAML có ngoặc, cookie/header, mật khẩu trong URL, token bot Telegram sát định danh.
- Dashboard: `fetchJSON`/`authedFetch` từ chối URL khác origin và ghim `mode: "same-origin"` (token phiên không lọt sang host lạ).
- `skills_guard`: cache quét bị bỏ khi trust level của nguồn thay đổi.

**Lỗi ảnh hưởng trực tiếp người dùng**
- MiniMax M3 (model mặc định): ẩn `<mm:think>` và thẻ suy nghĩ tiếng Trung ở mọi bề mặt (stream, câu trả lời cuối, Telegram, CLI, aux). Danh sách thẻ gom về một chỗ.
- Patch: `old_string` dán kèm gutter `N|` của `read_file` từng bị ghi `41|` vào file mà vẫn báo thành công.
- Kết quả tool lớn bị lưu thành một dòng JSON, nên `read_file` không phân trang được. Nay lưu phần văn bản bên trong.
- Ghim `av==18.0.0`: PyAV 19 làm faster-whisper 1.2.1 lỗi mọi lần chép âm (tin nhắn thoại).
- Rà soát nền không còn bật hộp nhập API key của skill sau khi lượt đã xong, và chỉ ghi vào bộ nhớ điều người dùng thật sự nói.
- `trim_memory` trên các đường bận bỏ `gc.collect()` toàn phần (macOS không có `malloc_trim`, nên trước đây lệnh này chỉ gây đứng GIL).
- Lỗi "is not a multimodal model" được nhận diện. Lỗi 400 do request vượt giới hạn byte được phân loại `payload_too_large`.
- Memo định nghĩa tool hết hạn cùng verdict `check_fn` (MCP kết nối lại không còn phải khởi động lại app).
- Vision đọc file cục bộ có giới hạn ngay trong lúc đọc.
- `send_message` tới kênh home giữ `thread_id`. Mô tả prompt của cron không chép lịch chạy vào prompt. Key `providers:` viết hoa được nhận.
- Cảnh báo "Compression refused" vô hại không còn bị gửi vào chat. SSRF-safe client gửi User-Agent nhận diện.
- Desktop: nút Ghim trên tile hoạt động; toast hiện `detail.message` thay cho JSON; tệp media có `#` trong tên được nhận đúng loại; entitlement Apple Events cho macOS. Web: Tailwind quét bundle design-system ở `node_modules` gốc.

**Telegram** (17 commit)
- Bảo mật: bài đăng kênh (channel) tuân `allowed_chats` và `require_mention`; bỏ qua update Telegram Business (trước đây bot trả lời danh bạ của chủ tài khoản); log không còn lộ token bot (lời gọi redact bị dán nhầm vào chuỗi format, lỗi riêng của fork) và mật khẩu proxy.
- Mất tin: khôi phục lỗi 409 conflict không còn xoá hàng đợi update, bộ đếm retry tăng đúng; hàng đợi bị kẹt được dò lại sau 30 giây (Mac ngủ power-nap); `stop()` khi đang khôi phục mạng không treo 15 giây.
- Nút bấm: mọi lần bấm đều được trả lời, kể cả nút cũ ("Query is too old"), không có dữ liệu hoặc không rõ.
- Định dạng và media: caption đo theo UTF-16 (emoji không làm mất bong bóng thoại), caption mp3/m4a có định dạng, nhận ảnh HEIC/HEIF/AVIF, nhận video note, chừa đủ chỗ cho chỉ số phần đã escape.
- Hành vi: topic do bot tạo không còn bỏ qua `require_mention`; `/cmd@bot` giữ tham số; trả lời vào tin đã bị xoá chỉ bỏ phần neo; IP dự phòng gốc nằm sau IP từ DoH; đoạn dán dài bị client chia nhỏ vẫn là một lượt (văn bản trên 1.024 ký tự chờ 1,5 giây, văn bản ngắn giữ đường nhanh 0,18–0,24 giây).
- Không lấy: `0b96330a14` (lỗi không có trên fork), `bdce549688` (album bị tách khi ảnh tải chậm, cần theo dõi in-flight).

## Không lấy

- Kiểm tra `check_fn` có timeout (chuỗi `8bf50cbdf9`…): khoảng 120 dòng thread và contextvar, rủi ro cao hơn lợi ích.
- Checkpoint (`45bfd0ea40`…): khoảng 250 dòng, và checkpoint trên desktop đang tắt (`AGENTX_TUI_CHECKPOINTS` không được Electron đặt). Cần xem riêng.
- Cụm phục hồi lỗi của auxiliary client, khả thi nén ngữ cảnh, Gemini prompt-block: cần refactor nền của upstream.
- Toàn bộ thay đổi trong module upstream đã tách (`gateway/run_*.py`, `tools/approval_detection.py`, `base_log_safety`…), desktop SSH/gateway registry, preview cookie theo hồ sơ.

## Kiểm thử

Mỗi bản port có test đỏ trên baseline (`version-1.1.3`) và xanh trên nhánh. Hồi quy chạy tuần tự cùng tập file trên hai cây rồi so tập FAILED.

- Python, toàn bộ `scripts/run_tests.sh -j 10` (cô lập từng file): baseline 33.066 passed / 117 failed; nhánh 33.704 passed / 118 failed. Test thêm là `test_prompt_submit_passes_persist_user_message_to_agent`, cùng họ với 5 test đỏ sẵn ở `tests/test_tui_gateway_server.py`. Chạy lại riêng file này 3 lần trên mỗi cây đều ra đúng 5 test đỏ, nên đây là test chập chờn khi máy tải nặng, không phải lỗi mới.
- Từng nhóm theo blast-radius (redact, think tag, patch, spill, registry, classifier, compression, skills, telegram…): tập FAILED giống hệt baseline.
- Desktop: `tsc` sạch (renderer + electron); vitest 6.681 passed, 2 failed (`no-native-title`, `webmate/service.integration`), cả hai đỏ sẵn trên baseline. `tests-js` 17 passed. Web: vitest 189 passed.
- `tests/test_branding_gate.py` 42 passed, `scripts/rebrand/check_branding.py` sạch, `uv lock --check` sạch. Ruff F821/F601/F811/F401 trên các file Python đã đổi không đổi so với baseline.
- Có sẵn, chưa sửa: 3 test ở `tests/test_project_metadata.py` đỏ vì pin lazy_deps lệch `uv.lock` (python-telegram-bot, slack-bolt, mautrix, huggingface-hub).
- Chưa chạy trên Windows thật, chưa thử Telegram với bot thật.
