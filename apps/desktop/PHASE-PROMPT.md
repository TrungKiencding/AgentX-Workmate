# Prompt giao việc theo phase — UI Uplift

Dán nguyên khối dưới đây cho AI coding agent, thay `{N}` bằng số phase (0–9).
Thứ tự bắt buộc: 0 → 1 → 2 trước, rồi 3–6, rồi 7 → 8 → 9. Kế hoạch gốc: `apps/desktop/UI-REDESIGN-PLAN.md`.
Muốn dặn riêng cho phase nào, thêm một dòng `GHI CHÚ RIÊNG: …` ngay dưới dòng NHIỆM VỤ.

```text
Bạn là AI coding agent thực thi nâng cấp giao diện cho AgentX Workmate
(Electron + React 19 + Tailwind v4, toàn bộ công việc nằm trong apps/desktop).

NHIỆM VỤ: Thực hiện ĐÚNG và CHỈ Phase {N} trong kế hoạch apps/desktop/UI-REDESIGN-PLAN.md.

TRÌNH TỰ BẮT BUỘC TRƯỚC KHI SỬA CODE
1. Đọc toàn bộ apps/desktop/design.md — design system đang quản lý dự án; nguyên tắc bất biến ở đó luôn thắng.
2. Đọc apps/desktop/UI-REDESIGN-PLAN.md: §0 (giao thức), §2 (định hướng token), phần Phase {N}, §5 (checklist).
3. Đọc code hiện trạng của các file Phase {N} nêu ra. Nếu Phase {N} > 0: kiểm tra token/kết quả của các
   phase trước đã có trong code chưa — chưa có thì DỪNG và báo, không tự làm bù.
4. Liệt kê danh sách file dự kiến sửa/tạo (tuyệt đối không xoá file nào) trước khi viết dòng code đầu tiên.

PHẠM VI
- Làm đủ mục "Việc chính" của Phase {N}. Không làm trước việc của phase sau, không tiện tay refactor ngoài phạm vi.
- Chỉ sửa lớp thị giác/tương tác. Cấm đụng: gateway/transport, state nanostores, keyboard system,
  virtual list, logic session. Thay đổi thị giác nào đòi sửa hành vi → dừng lại, ghi chú, hỏi tôi.
- Không xoá tính năng, không đổi kiến trúc, không đổi route/overlay ownership.

LUẬT CHẤT LƯỢNG (tóm tắt §0 — bản đầy đủ trong kế hoạch, tuân thủ cả hai)
- Token, không literal: mọi màu/cỡ/bo góc/easing mới khai báo thành CSS custom property trong styles.css
  (hoặc theme presets) trước khi dùng; cấm hex/oklch/px "mồ côi" trong component.
- Primitive sở hữu style: sửa cỡ nút = sửa components/ui/button.tsx; cấm override h-*/px-*/py-* ở call site.
- i18n ×4: mọi chuỗi mới/đổi vào đủ en, ja, zh, zh-hant; dấu typography chuẩn (' ' " " — …).
- design.md là named contract: đổi primitive/token/variant nào → cập nhật mục tương ứng trong design.md
  TRONG CÙNG change.
- Cấm dấu vân tay AI: gradient chữ hay tím→xanh, aurora blob, glassmorphism trang trí, bounce trên UI state,
  transition-all, glow màu trên nền tối, toast "Done!" cho việc thấy được kết quả, emoji làm icon,
  icon set thứ ba ngoài Tabler + Codicon, heading nghiêng, font thứ tư, số liệu bịa trong copy.

NGHIỆM THU (DoD của Phase {N} trong kế hoạch + các bước sau, đủ mới được coi là xong)
1. npm run typecheck && npm run test && npm run lint (workspace apps/desktop) xanh;
   e2e baseline lệch do chủ đích → cập nhật kèm giải thích trong cùng change.
2. Chạy app (npm run dev hoặc dev:mock), chụp screenshot MỌI bề mặt bị ảnh hưởng
   ở 1280×800 và 1512×982, cả light lẫn dark (thêm reduced-motion nếu phase có motion).
3. Tự soi kết quả theo checklist §5 của kế hoạch — mọi câu phải trả lời được "KHÔNG".
4. Một commit/PR duy nhất cho phase; message ghi: Phase {N}, token nào đổi, bề mặt nào ảnh hưởng.

BÁO CÁO CUỐI (bắt buộc)
- Danh sách file đã sửa/tạo, đối chiếu từng mục "Việc chính": đã làm gì, ở đâu.
- Kết quả từng ý DoD: đạt/không đạt kèm bằng chứng (output lệnh, screenshot before/after).
- Điểm vênh giữa kế hoạch và code thực tế (nếu có) và cách bạn xử lý.
- Việc còn nợ hoặc câu hỏi cần tôi quyết. Không tự quyết việc ngoài phạm vi.

Khi kế hoạch và code vênh nhau (file đã đổi tên, giá trị đã khác): giữ đúng Ý ĐỒ của kế hoạch,
ghi chú điểm vênh vào báo cáo. Khi mơ hồ về thẩm mỹ: luôn chọn phương án ÍT trang trí hơn.

Bắt đầu: trả lời trước bằng 5–7 dòng kế hoạch làm việc của bạn cho Phase {N}
(file sẽ sửa, thứ tự làm), rồi thực hiện một mạch đến hết nghiệm thu.
```
