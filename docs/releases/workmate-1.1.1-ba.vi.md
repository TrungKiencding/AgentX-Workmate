# AgentX Workmate 1.1.1 — thông tin dành cho BA và truyền thông

Ngày chuẩn bị: 16/10/2026. Phạm vi: thay đổi từ bản 1.1.0 đang phát hành đến nhánh 1.1.1. Tình trạng kiểm thử và phát hành được ghi riêng trong hồ sơ phát hành; tài liệu này mô tả thay đổi sản phẩm.

## Thông điệp đề xuất

Workmate 1.1.1 giúp người dùng chủ động kiểm soát những gì trợ lý ghi nhớ, làm việc với nhiều hội thoại thuận tiện hơn và nhận phản hồi rõ ràng hơn khi công cụ đang chạy, cần duyệt hoặc gặp lỗi. Bản cập nhật đồng thời cải thiện độ ổn định của model, đăng nhập và kết nối WebMate.

## Tính năng và cải tiến nổi bật

| Thay đổi | Người dùng nhận được gì? |
| --- | --- |
| Quản lý nội dung bộ nhớ | Trong **Cài đặt → Bộ nhớ**, xem từng ghi nhớ và thông tin hồ sơ, xem dung lượng đã dùng, sửa nội dung hoặc xoá sau bước xác nhận. |
| Thao tác nhiều tab thuận tiện hơn | Tab có nút đóng trực tiếp; mở hội thoại trong tab mới đưa người dùng đến hội thoại đó; khi chia đôi trò chuyện, mỗi vùng vẫn có tên tab, nút đóng và nút thêm tab. |
| Artifacts tập trung vào sản phẩm đầu ra | Danh sách ưu tiên tệp và nội dung AgentX thực sự tạo hoặc bàn giao, giảm các liên kết và đoạn đường dẫn lẫn trong hội thoại. |
| Phản hồi công cụ dễ hiểu hơn | Hiển thị đúng hành động, kết quả, nội dung lỗi và trạng thái **Chờ phê duyệt**; nội dung chi tiết và số lượng theo ngôn ngữ đang dùng. |
| Màn hình trò chuyện trống mới | Hiệu ứng ký tự tương tác khi nhấp và dấu thương hiệu chuyển động trong lúc suy nghĩ; tôn trọng cài đặt giảm chuyển động. |
| WebMate 1.0.13 đi kèm | Bao gồm các cải tiến về cài đặt, kết nối trình duyệt, cập nhật tiện ích và đồng bộ trạng thái kết nối MCP với phiên làm việc đang mở. |
| Tên sản phẩm thống nhất | Dùng tên **AgentX AgentHub** trong giao diện và tài liệu hiện hành. |

## Các lỗi đã sửa

### Hội thoại, tab và hiển thị

- Hội thoại vừa xoá có thể xuất hiện trở lại dưới dạng rỗng do tác vụ đặt tên hoàn tất muộn; lần mở ứng dụng sau có thể tiếp tục trỏ vào hội thoại đã xoá.
- Chọn **Đóng** trong menu tab có thể thu gọn vùng làm việc thay vì đóng tab.
- **Mở trong tab mới** có thể không đưa người dùng đến hội thoại khi đang ở trang Artifacts hoặc Tiện ích.
- Thanh tab có thể biến mất ở vùng trò chuyện chính khi chia đôi màn hình.
- Chữ gợi ý **Sửa tin nhắn** có thể đè lên phần đang gõ, bao gồm nhập bằng bộ gõ IME.
- Tên dự án dài có thể tràn dưới các nút thao tác; tên tab hội thoại mới có thể vẫn hiện bằng tiếng Anh.
- Artifacts có thể thu thập nhầm liên kết được nhắc đến, đoạn biểu thức hoặc kết quả liệt kê tệp.

### Bộ nhớ, kỹ năng và công cụ

- Sửa hoặc xoá từ bản đồ bộ nhớ có thể tác động nhầm mục sau khi danh sách thay đổi. Bản mới kiểm tra đúng nội dung đã hiển thị và báo khi mục đó đã thay đổi.
- Một thao tác ghi bộ nhớ hoặc kỹ năng đang chờ duyệt có thể bị hiển thị như đã lưu thành công.
- Các lệnh duyệt kỹ năng như `/skills pending`, `/skills approve`, `/skills diff` có thể bị chặn ở ô nhập Desktop.
- Công cụ thất bại có thể mang tiêu đề giống như đã thành công, lặp thông báo lỗi hoặc cắt mất phần cuối traceback.
- URL chứa dấu ngoặc có thể bị cắt sai; địa chỉ không có `https://` có thể bị từ chối nhầm; tên miền không phân giải được có thể bị báo nhầm là địa chỉ nội bộ.
- Việc lấy tiêu đề liên kết tự động được siết chặt để tránh truy cập mạng riêng hoặc địa chỉ metadata qua tên miền hay chuyển hướng.
- Công cụ Python chạy riêng, trình duyệt và các tiến trình con có thể nhận nhầm đường dẫn Python của Workmate rồi lỗi ngay lúc khởi động.
- TUI có thể giữ dòng trạng thái “đang chạy” phía trên kết quả lệnh đã hoàn tất.

### Model và đăng nhập

- Danh sách model có thể không theo kịp quyền được cấp mới. Bản mới làm mới danh sách theo vòng đời trò chuyện, giữ lựa chọn còn hợp lệ và xử lý lựa chọn đã mất quyền.
- Cấu hình có thể giữ model không còn được phép dùng qua các lần khởi động, ảnh hưởng cả hội thoại mới, tác vụ lịch, CLI và kênh nhắn tin.
- Một số model từ chối tham số reasoning hoặc gateway thêm tham số không được hỗ trợ, khiến lượt trả lời dừng dù có thể phục hồi.
- Tra cứu thông tin model có thể thiếu xác thực, ghi nhận lỗi 401 và làm trống bộ nhớ đệm; cửa sổ ngữ cảnh qua LiteLLM có thể được tra cứu sai cơ chế.
- Nhiều yêu cầu làm mới SSO cùng lúc có thể dùng lại refresh token và làm mất phiên khi hệ thống bật thu hồi refresh token. Các yêu cầu nay dùng chung một lần làm mới.

### Báo cáo vận hành dành cho quản trị

- Sửa token gửi báo cáo sử dụng để SSO tiếp nhận thay vì từ chối 401. Dữ liệu từng bị từ chối trước đây không được tái tạo.
- Lượt trả lời thất bại được phân loại bằng mã nguyên nhân; lượt kết thúc mà không có câu trả lời không còn được tính là thành công.
- Cảnh báo giữa lượt không còn kết thúc phép đo quá sớm; lượt bị mất tín hiệu kết thúc không kéo dài thời lượng của lượt tiếp theo.

## Lưu ý cần truyền đạt chính xác

- Có bộ cài cho **macOS Apple Silicon (ARM64)** và **Windows x64**. Không quảng bá là đã hỗ trợ macOS Intel hoặc Windows ARM64.
- Runtime có sẵn trong bộ cài là nền tảng đã có từ **1.1.0**, được tiếp tục duy trì ở 1.1.1. Người dùng không cần tự cài Python/Node để mở ứng dụng; đăng nhập và dịch vụ trực tuyến vẫn cần mạng.
- Nâng cấp bằng cách **cài đè lên bản hiện tại**, giữ hội thoại, cấu hình, bộ nhớ và thông tin đăng nhập. Không hướng dẫn gỡ bản cũ trước khi nâng cấp.
- Windows 1.0.x cần tải bộ cài mới và cài đè một lần do lỗi bàn giao cập nhật của bản cũ.
- Dịch vụ **Second Brain** và cơ chế đồng bộ hội thoại cũ đã được loại bỏ. Hội thoại và bộ nhớ cục bộ được giữ lại; đây không phải tính năng đồng bộ hội thoại mới.
- Không mô tả bản vá là xử lý mọi lỗi model hoặc bảo đảm đăng nhập không bao giờ hết hạn. Các thay đổi nhắm vào những trường hợp cụ thể nêu trên.

## Nội dung ngắn gợi ý

**Workmate 1.1.1: chủ động hơn với bộ nhớ, thuận tiện hơn khi làm nhiều việc.**

Bạn có thể xem, sửa và xoá từng điều Workmate ghi nhớ ngay trong Cài đặt; quản lý tab rõ ràng hơn; tìm đúng sản phẩm AgentX tạo trong Artifacts. Bản cập nhật cũng làm rõ trạng thái công cụ, cải thiện model và đăng nhập, đồng thời tích hợp WebMate 1.0.13. Tải bộ cài mới và cài đè để giữ dữ liệu hiện tại.
