# Workmate 1.1.1 — hồ sơ kiểm chứng phát hành

Ngày kiểm tra: 16/10/2026. Mốc đối chiếu trước nâng cấp: `ed5751c8c08e4be8efd82c5593cd66f503def622` (main, bản 1.1.0 đang phân phối).

## Kiểm tra trước đóng gói

- Desktop: 6.244 test đạt, 2 test bỏ qua theo cấu hình; kiểm tra kiểu dữ liệu, lint và độ tương phản đạt. Lint còn cảnh báo hiện có, không có lỗi chặn.
- TUI: 1.561 test đạt, 1 test bỏ qua; build, kiểm tra kiểu dữ liệu và lint đạt. Test tiến trình nền được đổi sang kiểm tra vòng đời tiến trình, bỏ giả định phải khởi chạy dưới 500 ms.
- Python liên quan trực tiếp đến thay đổi: 69 tệp, 2.472 test đạt; tệp kiểm tra credential của metadata endpoint được chạy riêng và đạt trong đợt kiểm tra lại môi trường.
- Python tổng thể qua runner cô lập chuẩn: 2.975 tệp, 32.677 test đạt, 120 test lỗi. **Đây không phải một lượt full suite xanh.** Đã đối chiếu từng ID lỗi với checkout main độc lập: 112 lỗi cũng xảy ra trên main; 6 lỗi do thiếu ACP/setuptools trong môi trường phát triển đã được bổ sung và chạy lại đạt; 2 phép quét mã nguồn đọc nhầm các checkout/bộ cài cũ trong thư mục bị Git bỏ qua, trong khi checkout main sạch đạt. Không còn lỗi Python chưa phân loại.
- `uv lock --check --offline` đạt. Các manifest Python, npm, Tauri, Cargo và lockfile được đồng bộ bằng hàm phát hành hiện có.
- Kiểm tra thương hiệu đạt; phép thử canary của trình quét bí mật và quét 35 commit tính năng đạt, không phát hiện bí mật.
- Landing page: build đạt; 24 cấu hình trình duyệt (4 ngôn ngữ × 6 chiều rộng) đạt, không tràn ngang hoặc lỗi JavaScript; các đường tài liệu trong danh mục được kiểm tra HTTP thành công.

## Sửa phép đo và dữ liệu kiểm thử giao diện

Những thay đổi dưới đây chỉ thuộc bộ kiểm thử, không được quảng bá thành tính năng sản phẩm:

- Giữ tác vụ terminal bằng sentinel trong ca chuyển hội thoại, thay vì đua với `sleep 5`; tìm hội thoại theo tiền tố riêng vì tên dài được rút gọn.
- Tìm phiên đính kèm ảnh theo tiêu đề mà fixture đã đặt; xác minh caption và thumbnail trong transcript sau mở lại.
- Dùng phím Command trên macOS cho thao tác tạo worktree và chọn trường nhập theo vai trò, không theo bản dịch placeholder.
- Đếm việc dựng các phần tử tin nhắn để kiểm tra khôi phục hội thoại dài, thay vì đếm cả loading row và nút điều khiển trong viewport; vẫn giữ giới hạn hai đợt dựng.
- Ca E2E tự nén rồi xếp hàng bằng Enter vẫn timeout 90 giây trên cả checkout main và bản mới; chưa được tính là đạt. Giữ nguyên test gốc, không đổi ngưỡng kiểm tra để làm xanh. Ca nén thủ công rồi gửi tiếp, các test hàng đợi và các test đơn vị Desktop đã đạt.

Các ca giao diện ban đầu lỗi còn lại đã chạy lại đạt sau khi sửa fixture/phép đo: gửi tin nhắn, chuyển hội thoại, ảnh đính kèm sau mở lại, khôi phục hội thoại dài và tạo worktree. Tổng hợp các ca riêng biệt: 46 đạt, 9 bỏ qua theo cấu hình, 1 timeout đã tái hiện trên main. Không tuyên bố toàn bộ E2E xanh.

## Điều kiện công bố bộ cài

Workflow Release Desktop phải chạy trên main với cùng commit sạch cho macOS ARM64 và Windows x64. Bộ cài phải chứa bundled-runtime phù hợp version/commit/OS/kiến trúc. Windows kiểm tra nâng từ 1.0.10 và từ bản 1.1.0 đang phân phối, giữ đăng nhập/dữ liệu, khởi động lại và chạy backend khi chặn mạng bên ngoài. macOS kiểm tra ứng dụng lấy từ DMG sau khi di chuyển, backend thật và giữ dữ liệu qua khởi động lại; kiểm tra updater thật từ 1.1.0 được chạy trên máy phát hành.

Chỉ sau các kiểm tra native mới tạo tag `desktop-v1.1.1`, công bố bộ cài, ký feed bằng khoá Ed25519 hiện có và chuyển landing page sang bản mới. URL và bộ cài cũ được giữ để đối chiếu và quay lui. Hồ sơ triển khai của AgentX-Landing lưu SHA-256, kích thước, workflow và kết quả kiểm tra công khai sau khi công bố.
