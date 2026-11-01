# AgentX Workmate 1.1.2 — thông tin dành cho BA và truyền thông

Ngày chuẩn bị: 01/11/2026. Phạm vi: thay đổi từ bản 1.1.1 đang phát hành đến bản 1.1.2. Tài liệu này mô tả thay đổi sản phẩm để làm infographic và nội dung truyền thông.

## Thông điệp đề xuất

Workmate 1.1.2 mang đến diện mạo mới **Quiet**: yên tĩnh, dễ đọc, để nội dung công việc là trung tâm. Bản cập nhật cũng giúp thao tác an toàn hơn nhờ nút hoàn tác và hộp thoại xác nhận, gõ tiếng Việt yên tâm hơn và điều hướng nhanh hơn bằng bàn phím.

## Gợi ý bố cục infographic

| Khối | Tiêu đề gợi ý | Nội dung một dòng |
| --- | --- | --- |
| 1 | Diện mạo mới Quiet | Nền xám ấm, gọn gàng, có điểm nhấn màu nhẹ |
| 2 | Dễ đọc hơn | Chữ, nút và hàng danh sách lớn hơn, đậm hơn |
| 3 | Lỡ tay cũng không sao | Lưu trữ có Hoàn tác trong 6 giây, xoá có bước xác nhận |
| 4 | Gõ tiếng Việt yên tâm | Enter khi đang gõ dở không còn gửi nửa chữ |
| 5 | Nhanh hơn với bàn phím | Ẩn/hiện thanh bên, chuyển cuộc trò chuyện bằng phím tắt |

## Tính năng và cải tiến nổi bật

| Thay đổi | Người dùng nhận được gì? |
| --- | --- |
| Diện mạo mới **Quiet** | Giao diện mặc định mới trên toàn ứng dụng: nền xám ấm, bỏ chữ in hoa, thanh bên có nền riêng. Nút chính màu than; công tắc và ô chọn màu xanh; biểu tượng trong Cài đặt đặt trên ô màu. |
| Chữ và nút lớn hơn | Chữ thường 15px, chữ đọc 16px, hàng và nút cao 36px; chữ phụ, biểu tượng và viền đậm hơn. Rõ hơn trên màn hình đời cũ. |
| Hoàn tác khi lưu trữ | Lưu trữ cuộc trò chuyện chạy ngay, kèm thông báo có nút **Hoàn tác** trong 6 giây, khôi phục cả trạng thái ghim. |
| Hộp thoại xác nhận mới | Xoá cuộc trò chuyện và các thao tác quan trọng dùng hộp thoại của ứng dụng thay cho hộp thoại mặc định của hệ thống; khi xoá có gợi ý lưu trữ thay thế. |
| Gõ tiếng Việt an toàn hơn | Nhấn Enter khi bộ gõ chưa chốt chữ không còn gửi tin nhắn dở ở ô sửa tin nhắn và ô trả lời câu hỏi làm rõ. |
| Phím tắt mới | **⌘\\** (Windows: **Ctrl+\\**) ẩn/hiện thanh bên; **⌘[** và **⌘]** chuyển giữa các cuộc trò chuyện. Bảng lệnh có gợi ý phím ở chân. |
| Thanh bên và tài khoản | Thanh bên rộng hơn và kéo đổi được độ rộng; hàng tài khoản ở chân thanh bên. |
| Trong lúc trò chuyện | Ba chấm và dòng **Đang suy nghĩ…** khi chờ trả lời; câu trả lời bỏ logo để gọn hơn; nút **Mới nhất** để về cuối cuộc trò chuyện. |
| Lời chào và màn hình kết nối | Lời chào hiện đủ họ tên; màn hình kết nối làm mới với logo tự vẽ. Menu, hộp thoại và thông báo có hiệu ứng mở mượt. |
| Trợ năng | Nút **Bỏ qua đến nội dung** khi điều hướng bằng phím Tab; trình đọc màn hình báo khi AgentX trả lời xong; viền ô nhập ở chế độ tối rõ hơn. |
| Thuật ngữ thống nhất | Tiếng Việt dùng nhất quán “cuộc trò chuyện”. |
| WebMate 1.0.14 đi kèm | Dùng địa chỉ mới của AI Gateway; khi gateway không phản hồi, WebMate tự hỏi dịch vụ cấp key để lấy địa chỉ hiện tại thay vì báo ngoại tuyến. |

## Các lỗi đã sửa

### Trải nghiệm hằng ngày

- Tên ở lời chào và hàng tài khoản có thể không hiện cho đến khi vào Cài đặt. Nay tự hiện khi ứng dụng kết nối xong.
- Cuộc trò chuyện lưu từ trước khi AI Gateway đổi địa chỉ có thể bị từ chối khi tiếp tục.
- Thông báo có thể che mép trên ô soạn tin.
- Giờ ở trang Tác vụ lịch và kho kỹ năng có thể theo ngôn ngữ máy thay vì ngôn ngữ ứng dụng; ô tìm giao diện còn chữ tiếng Anh.
- Đổi hồ sơ khi bản đồ bộ nhớ đang tải có thể hiện dữ liệu của hồ sơ trước.

### Kỹ năng, công cụ và tác vụ lịch

- Kỹ năng của plugin có thể báo không tìm thấy khi được gọi; kỹ năng đã gỡ vẫn còn lệnh `/`.
- Enter gửi vào chương trình tương tác đang chạy trong terminal có thể không được nhận.
- Lệnh chạy nền sau khi bổ sung chỉ dẫn giữa lúc công cụ đang chạy có thể không bao giờ báo hoàn tất.
- Tác vụ lịch nhắm vào một máy chủ MCP đã tắt có thể được dùng cả những máy chủ khác đang bật. Nay không còn bị nới quyền.

### Bảo mật

- Khoá API Context7 được che trong log và nội dung hiển thị.
- Cập nhật 6 thư viện có cảnh báo bảo mật (tornado, oauthlib, axios, joi, shell-quote, follow-redirects). Phần lớn thư viện Node thuộc công cụ phát triển và trang tài liệu.

## Thay đổi tự động khi nâng cấp

Cần nêu rõ để bộ phận hỗ trợ trả lời được người dùng:

- **Giao diện:** ai đang dùng Night Owl được chuyển sang Quiet một lần, kể cả người đã chủ động chọn Night Owl. Night Owl vẫn có trong Cài đặt và nếu chọn lại thì được giữ. Các giao diện khác giữ nguyên.
- **Tỉ lệ giao diện:** cài mới là 100%. Máy đang ở đúng 125% (mặc định cũ) được chuyển về 100% một lần, kể cả người đã chủ động chọn 125%; chọn lại thì được giữ. Các mức khác giữ nguyên.
- **Sáng/tối:** lựa chọn đã lưu được giữ. Người chưa từng chọn sẽ theo chế độ của hệ điều hành, nên máy đang để hệ điều hành ở chế độ tối có thể chuyển sang tối.

## Lưu ý cần truyền đạt chính xác

- Có bộ cài cho **macOS Apple Silicon (ARM64)** và **Windows x64**. Không quảng bá là đã hỗ trợ macOS Intel hoặc Windows ARM64.
- Xác thực hệ điều hành không đổi: macOS dùng chữ ký ad-hoc, chưa có Apple notarization; bộ cài Windows chưa có chữ ký Authenticode.
- Nâng cấp bằng cách **cài đè lên bản hiện tại** hoặc cập nhật trong ứng dụng, giữ hội thoại, cấu hình, bộ nhớ và thông tin đăng nhập. Không hướng dẫn gỡ bản cũ trước. Windows 1.0.x cần tải bộ cài mới và cài đè một lần.
- **WebMate 1.0.14** là bản sửa kết nối AI Gateway, không có tính năng mới. Không quảng bá như một bản nâng cấp tính năng WebMate.
- **Không có** công tắc “chế độ tương phản cao” trong ứng dụng. Ứng dụng chỉ giữ viền và focus khi chế độ tương phản của hệ điều hành bật.
- **Data Hub không có trong bản này.** Không nhắc đến, kể cả khi thấy trong lịch sử thay đổi.
- Không nói bản này nhanh hơn hay nhẹ hơn: không có phép đo hiệu năng đáng quảng bá. Quiet là thay đổi về thiết kế.
- Bản cập nhật thư viện bảo mật nên viết là “cập nhật thư viện có cảnh báo bảo mật”, không viết là “vá lỗ hổng ảnh hưởng người dùng”.
- Số đo cỡ chữ và độ rộng dùng để mô tả nội bộ, không cần đưa vào infographic.

## Nội dung ngắn gợi ý

**Workmate 1.1.2: yên tĩnh hơn, dễ đọc hơn, an tâm hơn.**

Diện mạo mới Quiet với chữ và nút lớn hơn giúp bạn tập trung vào công việc. Lưu trữ nhầm đã có Hoàn tác, xoá có bước xác nhận, gõ tiếng Việt không còn lo gửi nửa chữ, và phím tắt mới giúp chuyển cuộc trò chuyện nhanh hơn. Cập nhật ngay trong ứng dụng hoặc tải bộ cài mới và cài đè để giữ nguyên dữ liệu.
