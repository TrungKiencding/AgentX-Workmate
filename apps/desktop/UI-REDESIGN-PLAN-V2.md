<!-- Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V4 · plan document (design-system evolution — no page emitted) -->
<!-- Scope: apps/desktop (AgentX Workmate). Managed project: đọc apps/desktop/design.md TRƯỚC KHI làm bất cứ việc gì. Nối tiếp UI-REDESIGN-PLAN.md (v1, 10 phase, xong 2026-08-27). Bản 2.1: mọi quyết định §6 đã được người dùng chốt ngày 2026-09-06. -->

# AgentX Workmate — Kế hoạch nâng cấp giao diện v2: thân thiện, trực quan, tẩy dấu Hermes

**Phiên bản:** 2.1 · 2026-09-06 · nối tiếp v1 (`UI-REDESIGN-PLAN.md`, đã hoàn tất 10 phase). **Mọi quyết định ở §6 đã chốt** — agent không cần hỏi lại các mục đó.
**Phạm vi:** `apps/desktop` — (1) **giao diện chính**: sidebar, màn hình trống, khung chat, composer, titlebar; (2) trang **Tiện ích** (hiện là "Năng lực") với 4 tab Kỹ năng · Công cụ · MCP · Kho kỹ năng; (3) trang **Tin nhắn**; (4) trang **Artifact**.
**Ngoài phạm vi:** **Cài đặt giữ nguyên** — không đổi bố cục, nội dung, IA hay file trong `src/app/settings/`; Settings chỉ *thừa hưởng* token toàn cục như mọi bề mặt khác. Onboarding, Command Center, Cron, Profiles, Starmap, `web/`, `ui-tui` không đụng.
**Giữ nguyên theo quyết định người dùng:** **bảng màu hiện tại** (preset, band, accent, accent picker, chế độ mặc định — không đổi gì) và **font hiện tại** (Geist · JetBrains Mono · Newsreader 3 slot). Đợt này thay đổi *hình khối, icon, bố cục, tên gọi và lời văn* — không thay đổi màu và chữ.
**Người thực thi:** AI coding agent. Mỗi phase là một đơn vị giao việc độc lập, kết thúc bằng app chạy được + screenshot nghiệm thu. Prompt giao việc ở §7.

**Định hướng (đã xác nhận qua các quyết định §6):**
- **Đối tượng:** nhân viên văn phòng / người dùng phổ thông trong tổ chức, dùng tiếng Việt, không phải developer, có thể ít quen phần mềm. Developer vẫn dùng được nhưng không còn là đối tượng thiết kế chính.
- **Việc chính của giao diện:** trong 5 giây biết gõ vào đâu; hiểu app làm được gì; bật/tắt một tiện ích; kết nối một ứng dụng nhắn tin; tìm lại ảnh/tệp app đã tạo — tất cả **không cần đọc hướng dẫn, không cần phím tắt**.
- **Tone (theo Hallmark):** *soft* — mềm, rõ, chính xác. Trường phái ChatGPT / Claude desktop / Apple / Notion. Không "vui nhộn" kiểu trẻ con, không dev-tool, không trang trí.

---

## 0 · Giao thức cho agent thực thi (đọc trước, áp dụng cho MỌI phase)

1. **Đọc `apps/desktop/design.md` trước mỗi phase.** Đây là dự án có design system được quản lý. Kế hoạch này *tiến hoá* hệ thống đó. Vênh về nguyên tắc bất biến (flat-not-boxed, one-primitive-per-concern, tokens-not-literals, motion-follows-state) → `design.md` thắng. Vênh về **giá trị cụ thể** (cỡ, bo góc, tên gọi, icon) → kế hoạch này thắng và agent **cập nhật `design.md` trong cùng change**.
2. **Không xoá tính năng, không xoá file production, không đổi kiến trúc.** Không đụng gateway/transport, state (nanostores), keyboard system, virtual list, logic phiên, parser/save của MCP, pairing. Thay đổi thị giác nào đòi sửa hành vi ngoài kế hoạch → dừng, ghi chú, hỏi người dùng.
3. **Settings đóng băng.** Không sửa `src/app/settings/**` trừ khi một primitive dùng chung đổi API và cần vá để build xanh — khi đó không được đổi bố cục hay copy của Settings.
4. **Màu và font đóng băng.** Không thêm/đổi preset, band, accent, `DEFAULT_SKIN_NAME`, `normalizeMode`, `--dt-font-*`, `DEFAULT_TYPOGRAPHY`. Việc duy nhất chạm màu: thay Tailwind ramp thô bằng **token semantic đã có** (`--ui-green/yellow/red` + `-foreground`) để pill trạng thái đi theo theme — không tạo màu mới.
5. **Composer giữ nguyên kích thước.** Thanh chat 44px một dòng, mọi token `--composer-*` giữ nguyên (người dùng đã bác bỏ bản hai tầng 03/09/2026). Chỉ được đổi copy, icon, và cách hiển thị các nút phụ.
6. **Token, không literal.** Bao gồm cả Tailwind ramp thô (`emerald-*`, `amber-*`…) và `tracking-[…]` — hiện đang là vi phạm có sẵn, đợt này dọn sạch trong phạm vi. Mọi cỡ/bo góc mới khai báo vào `styles.css` rồi mới dùng.
7. **Primitive sở hữu style.** Nút mới = variant/size của `components/ui/button.tsx`; pill trạng thái = một `StatusPill` (Phase 1); tab = một `PillTabs`; empty state = `EmptyState`/`PanelEmpty`. Không tự chế ở call site.
8. **Bảng thuật ngữ §2.7 là luật.** Mọi chuỗi nhìn thấy đi qua bảng; không tự sáng tác từ mới. **Tiếng Việt là bản gốc**: viết `vi.ts` trước, các locale khác (`en`, `ja`, `zh`, `zh-hant`, `ar` — đủ mọi file trong `src/i18n/`) dịch theo. Dấu typography chuẩn (`' ' " " — …`).
9. **Kiểm chứng mỗi phase:** `npm run typecheck && npm run lint && npm run test` + `npm run check:contrast` (workspace `apps/desktop`); chạy app (`npm run dev`, CDP 9222) và chụp **mọi bề mặt bị ảnh hưởng** ở **1280×800 và 1512×982, cả sáng lẫn tối**; phase có motion chụp thêm `prefers-reduced-motion`. E2E baseline lệch do chủ đích → cập nhật trong cùng PR kèm giải thích.
10. **Một phase = một PR/commit.** Mô tả PR ghi: token/primitive đổi gì, bề mặt nào ảnh hưởng, screenshot before/after, điểm vênh với kế hoạch.
11. **Thứ tự bắt buộc:** Phase 1 → 2 → (3, 4 đổi chỗ được) → 5. Không gộp phase, không làm trước việc của phase sau.
12. **Sau Phase 1**, cập nhật stamp đầu `src/styles.css`:
    `/* Hallmark · genre: playful-soft (shape · icon · copy; palette + type unchanged) · design-system: design.md · designed-as-app · uplift-plan: UI-REDESIGN-PLAN-V2.md */`
    và thêm vào **đầu** mảng `apps/desktop/.hallmark/log.json`: `{ "date": "<ngày>", "scope": "app", "genre": "playful-soft", "theme": "night-owl (unchanged)", "brief": "AgentX Workmate v2 — friendly for non-technical users, Hermes traces removed; palette and type kept" }`.
13. **Cấm tuyệt đối (dấu vân tay AI + dấu vết Hermes) — áp mọi phase:**
    - Gradient chữ, gradient tím→xanh/hồng, aurora blob, orb 3D, glassmorphism trang trí, glow màu trên nền tối.
    - Bounce/overshoot trên UI state (spring chỉ ở 2 tương tác vật lý đã có), `transition-all`, animate layout property.
    - Lưới 3 card đều nhau kiểu icon-trên-tiêu-đề-dưới; card lồng card; viền-stripe dày một cạnh; badge-pill đặt ngay trên tiêu đề; nhãn HOA tracking rộng trên mọi mục.
    - Emoji làm icon; icon set thứ ba ngoài Tabler + Codicon; **Codicon trong chrome trang** (chỉ được ở transcript/tool/terminal/editor/file-tree).
    - Minh hoạ kiểu "AI/stock": nhân vật blob, doodle người, Lottie, ảnh sinh bằng AI. Chỉ dùng bộ `EmptyFigure` tự vẽ (§2.8).
    - Chữ nghiêng ở heading; font thứ tư trong text sống; chữ đọc < 13px; meta < 12px (trừ statusbar/timestamp 11px).
    - Toast "Đã xong!" cho hành động thấy được kết quả; "Oops"; số liệu bịa; tên placeholder bịa.
    - Font pixel (Neuebit/Collapse), trái tim pixel, thuật ngữ trong bảng cấm §2.7 ở chuỗi người dùng nhìn thấy.

---

## 1 · Chẩn đoán hiện trạng (audit có bằng chứng — 2026-09-06)

Bằng chứng: đọc mã + 14 ảnh chụp app dev (`npm run dev`, CDP) ở 1382×793 CSS px, cả sáng lẫn tối, cho 7 bề mặt: home, 4 tab Năng lực, Tin nhắn, Artifact. Ảnh không lưu vào repo — agent chụp lại được bằng script tương tự (§7).

### 1.1 Dấu vết Hermes / Nous Research còn lại (nhìn là nhận ra)

| # | Dấu vết | Vì sao nó "Hermes" | Xử lý trong đợt này | Bằng chứng |
|---|---|---|---|---|
| H1 | **Thẩm mỹ 8-bit / terminal**: `@font-face` Neuebit + Collapse nạp thẳng từ gói `@nous-research/ui` (không còn chỗ nào dùng trong `.tsx`), trái tim pixel-art trong reaction, comment `BrandMark` vẫn gọi mark là "8-bit mascot", pet là sprite pixel | Nous xây thương hiệu Hermes trên retro-pixel / hacker-terminal | Gỡ font pixel chết, trái tim pixel → path Tabler, sửa comment; pet giữ opt-in (Q7) | `styles.css:34,48`; `components/chat/vibe-hearts.tsx:37`; `components/brand-mark.tsx:5`; `components/pet/*` |
| H2 | Accent "Nous blue" `#0053FD` là seed của preset `nous` và của accent picker | Màu thương hiệu của Nous Research | **Giữ nguyên** theo Q1 (màu không đổi) | `themes/presets.ts:43,648` |
| H3 | Skin mặc định Night Owl, mở lần đầu ở chế độ tối | Theme editor của cộng đồng dev | **Giữ nguyên** theo Q1 | `presets.ts:640` |
| H4 | **Icon Codicon (bộ icon của VS Code) trong điều hướng chính**: "Phiên mới" là icon `robot`, "Năng lực" là `symbol-misc`, "Tin nhắn" `comment`, "Artifact" `files`; nút "+" là codicon `add`, kebab `kebab-vertical`; còn 13 chỗ trong master-detail/hub/mcp | Codicon là chữ ký của editor code | Thay bằng Tabler trong chrome trang (Phase 1) | `app/chat/sidebar/index.tsx:145-174` (9 chỗ), `app/master-detail.tsx` (4), `app/skills/hub.tsx` (5), `app/skills/mcp-tab.tsx` (4); `styles.css:6` |
| H5 | **Loader "đường cong toán / ASCII"** (`rose-curve`, `lemniscate-bloom`) dùng cho mọi `PageLoader` | Register hacker-terminal | `PageLoader` dùng vòng tròn mềm; curve giữ trong transcript (Q6) | `components/ui/loader.tsx:10-15`; `design.md` §Feedback |
| H6 | **Giọng developer** khắp chuỗi người dùng thấy: "Phiên", "MCP", "Gateway", "token", "ID người dùng", "repo"; tên kỹ năng kebab-case (`agentx-agent-skill-authoring`), nhóm `Autonomous-Ai-Agents`, mô tả công cụ tiếng Anh thuần kỹ thuật, 19 đoạn hướng dẫn nền tảng nhắn tin bằng tiếng Anh cứng trong component, `vi.ts` để `platformIntro: {}` rỗng | Copy là phần Hermes dày nhất — đổi tên sản phẩm không đổi giọng | Bảng thuật ngữ §2.7 + lớp dịch tay (Phase 2–5) | ảnh `skills-skills`, `skills-toolsets`, `messaging`; `app/messaging/index.tsx` (`PLATFORM_INTRO`), `i18n/vi.ts:2037` |
| H7 | **Hình dạng "panel dev"** cho trang cấu hình: master-detail dày, hàng 44px chữ 12px + switch 16×28, thanh tab là chữ gạch chân 13px, tab MCP lấy **editor JSON `mcp.json` + khung log** làm bề mặt chính | Bố cục Hermes = TUI/IDE | Hàng 48px chữ 14px, tab pill, JSON gấp lại (Phase 3) | `app/master-detail.tsx` (`CapRow`), `components/ui/text-tab.tsx` (`h-7`), `app/skills/mcp-tab.tsx`; ảnh `skills-mcp` |
| H8 | **Pet pixel** (nhân vật 8-bit góc phải dưới) | Tính năng "petdex" của Hermes | **Giữ opt-in**, không làm gì (Q7) | `components/pet/*`; chỉ hiện khi người dùng đã nhận pet qua `/pet` |

### 1.2 Rào cản với người dùng phổ thông (theo bề mặt)

**Giao diện chính (ảnh `home-light` = ảnh người dùng gửi, `home-dark`)**

| # | Phát hiện | Bằng chứng |
|---|---|---|
| M1 | **Màn hình trống của một phiên mới không có lời chào, không gợi ý** khi vào bằng route session: `showIntro` đòi `!selectedSessionId && !activeSessionId` → người dùng thấy hoạ tiết nền + thanh chat, không biết bắt đầu từ đâu | `app/chat/index.tsx:409-416` |
| M2 | Sidebar: nhãn nhóm viết HOA tracking ("ĐÃ GHIM", "DỰ ÁN"); gợi ý "Shift-nhấp vào một cuộc trò chuyện để ghim" (thao tác bàn phím + không có nút thay thế); phím tắt `⌘ N` hiện thường trực; "Phiên mới" là từ kỹ thuật; icon `robot` | `app/chat/sidebar/section-states.tsx:49`; `sidebar/index.tsx:1135-1200` |
| M3 | Composer: placeholder trong ảnh là "Chỉnh lại yêu cầu" (không phải lời mời); **ba icon giọng nói** (mic, loa gạch chéo, camera gạch chéo) cạnh nút chính; nút tròn màu nhấn mang icon sóng âm khi ô trống — người phổ thông đọc nhầm là nút gửi bị hỏng | ảnh người dùng gửi; `app/chat/composer/controls.tsx` |
| M4 | Titlebar phải: 5 icon (layout, haptics, bàn phím, cài đặt, sidebar phải) — "bàn phím" và "haptics" là nhu cầu developer | `app/shell/titlebar-controls.tsx:129-202` |
| M5 | Transcript: lượt trả lời không có dấu hiệu "ai đang nói"; dòng công cụ gọi bằng tên tool | `components/assistant-ui/thread/*`, `tool/*` |

**Tiện ích / Năng lực (ảnh `skills-skills`, `skills-toolsets`, `skills-mcp`, `skills-hub`)**

| # | Phát hiện | Bằng chứng |
|---|---|---|
| N1 | Tab Kỹ năng: **84 hàng tên kebab-case tiếng Anh**, nhóm hiển thị thô (`Autonomous-Ai-Agents`, `Software-Development`), chữ 12/11px, sắp "Dùng nhiều nhất" — người mới không biết 84 thứ này để làm gì, không có cách "thử ngay" | `app/skills/index.tsx:118-134` (`skillSubtitle`), `master-detail.tsx` (`CapRow`) |
| N2 | Tab Công cụ: mô tả tiếng Anh kỹ thuật từ backend; meta "5 tools"; pill "Cần key"; chi tiết là đoạn văn dài + chip tên hàm mono | `app/skills/index.tsx:720-790`, ảnh `skills-toolsets` |
| N3 | Tab MCP: tên là viết tắt; bề mặt chính là editor JSON + log; nút thêm là dấu "+" 16px trơ trọi giữa trang | `app/skills/mcp-tab.tsx`, ảnh `skills-mcp` |
| N4 | Tab Kho kỹ năng: card hiện slug thô `agentx-hub-verified`; nút Cài/Gỡ/Xem trước là **chữ 12px không hộp**; màu trạng thái dùng Tailwind ramp `emerald/amber` (không theo theme, sai contrast ở band sáng) | `app/skills/hub.tsx:67-88,190,389-391,438`; `hub-status.tsx:29,36,163,190` |
| N5 | Chung: thanh tab chữ gạch chân 13px (`TextTab h-7`), 20 nút `size="xs"`, 52 chỗ `text-2xs` (11px), 8 `Switch size="xs"` — mọi thứ đều bé | grep trong 11 file phạm vi |

**Tin nhắn (ảnh `messaging`)**

| # | Phát hiện | Bằng chứng |
|---|---|---|
| T1 | 14+ nền tảng xếp ngang hàng (Telegram → Google Chat, DingTalk, Feishu, Matrix, BlueBubbles…) — người dùng phổ thông cần 2–3 cái | `app/messaging/index.tsx` (`PlatformRow` list) |
| T2 | Chi tiết = **form biến môi trường**: "Bot token", "ID người dùng Telegram được phép", placeholder tiếng Anh `Allowed Telegram user IDs (comma-separated)`, hướng dẫn tiếng Anh, mô tả tiếng Anh từ backend; **3 pill trạng thái** xếp cạnh tiêu đề | `messaging/index.tsx:574-590`, `PLATFORM_INTRO` |
| T3 | Nhãn mục HOA `tracking-[0.14em]` literal ("LẤY THÔNG TIN ĐĂNG NHẬP", "BẮT BUỘC", "NÊN CÓ") | `messaging/index.tsx:718,888` |
| T4 | Yêu cầu ghép nối (một người muốn nhắn cho bot) chỉ là con số nhỏ màu vàng trên hàng — dễ bỏ lỡ | `messaging/index.tsx:507-520` |

**Artifact (ảnh `artifacts`)**

| # | Phát hiện | Bằng chứng |
|---|---|---|
| A1 | Trạng thái trống là 2 dòng chữ giữa màn hình, không hình, không hành động, không dùng primitive `EmptyState`; "artifact" là gì thì trang không giải thích | `app/artifacts/index.tsx:262-268` |
| A2 | Danh sách tệp là **bảng** có header HOA `tracking-[0.08em]` ("TIÊU ĐỀ / URL / PHIÊN"), đường dẫn mono; lưới ảnh ô 11rem, nhãn loại HOA | `artifacts/index.tsx:492,661` |
| A3 | Khi trống, hàng tab đếm "Tất cả 0 · Ảnh 0 · Tệp 0 · Liên kết 0" — bốn số 0 | ảnh `artifacts` |

### 1.3 Vi phạm kỷ luật hệ thống có sẵn (dọn trong đợt này, trong phạm vi)

- **17 dòng Tailwind ramp thô** `emerald-*`/`amber-*` — `hub.tsx` (8), `hub-status.tsx` (4), `mcp-tab.tsx` (3), `messaging/index.tsx:52` (`PILL_TONE`), `components/status-dot.tsx:11` — trái `design.md` §Chat tools ("Never a raw Tailwind ramp"). Thay bằng token semantic **đã có** — đây không phải đổi màu, mà là cho pill đi theo theme đang dùng.
- **4 chỗ `tracking-[…]` literal** (artifacts 492, 661; messaging 718, 888) — trái luật `--tracking-label` là tracking duy nhất.
- **22 chỗ Codicon trong chrome trang** (sidebar nav, master-detail, hub, mcp) thay vì Tabler.
- **Chuỗi tiếng Anh cứng trong component**: `PLATFORM_INTRO` (19 mục) và `platform.description`/`toolset.description` từ backend không có lớp dịch.
- `text-2xs` (11px) dùng cho chữ *đọc* (mô tả card, subtitle hàng) thay vì chỉ meta.

### 1.4 Tài sản giữ nguyên (điểm mạnh — cấm phá)

- **Toàn bộ bảng màu và font hiện tại** (Q1, Q2): preset Night Owl mặc định + 7 preset, accent picker, band Paper/Graphite, Geist · JetBrains Mono · Newsreader, `scripts/check-theme-contrast.mjs`.
- Nền tảng v1: ramp chữ `--text-*`, control ramp `--control-h-*`, motion token + `lib/motion.ts`, focus ring toàn app, `OverlayPageHeader`, `CommandSelectionIndicator`, `CodeCard`, bong bóng người dùng, lời chào serif + chip khởi động lấy từ dữ liệu thật (`intro-chips.ts`).
- **Hoạ tiết nền chat** (`chat-watermark.tsx`, logo dựng hình học `buildMark()`) — đã brand-native, giữ và tái dùng làm nguồn cho minh hoạ.
- Khung trang: `PageSearchShell`, `MasterDetail`/`ListColumn`/`DetailColumn`, `DetailPane` — giữ khung, thay da.
- `BrandMark` PNG (`public/brand-mark.png`) đã là mark hình học trên nền đen — chỉ sửa comment "8-bit" cho đúng.
- Composer 44px (khoá), hệ theme mở, i18n, e2e.

---

## 2 · Định hướng thiết kế v2

**Ý một câu:** *Giữ bộ xương và bảng màu v1, thay cách sắp và cách nói: góc mềm hơn, icon nét tròn, chữ to hơn ở chỗ người ta đọc, tên gọi và câu chữ nói tiếng người, phần kỹ thuật gấp lại sau một cú bấm — để một nhân viên văn phòng mở app lần đầu biết ngay phải làm gì.*

**Genre (Hallmark):** *playful — nhánh soft* ở lớp **hình khối, icon, bố cục và lời văn**; **bảng màu và font giữ nguyên v1** theo quyết định người dùng (Q1, Q2). Giữ toàn bộ kỷ luật restraint của v1. Không đi tới Hum (đa accent, spring, nhân vật) — đây là công cụ làm việc trong tổ chức.

**Diversification so với v1** (`log.json`: modern-minimal · nous-refined): theme không đổi (dự án quản lý bằng `design.md` — nhất quán thắng đa dạng); khác ở hình khối (bo góc 8/12/14/18, hàng 44–48px), bộ icon chrome, cấu trúc 3 trang, và giọng.

### 2.1 Tham chiếu sản phẩm nổi tiếng (mượn *nguyên tắc*, không chép pixel, không nhắc tên trong UI)

| Bề mặt | Tham chiếu | Điều mượn |
|---|---|---|
| Màn hình trống & composer | ChatGPT, Claude desktop, Gemini | Một lời chào là câu hỏi + 3–4 gợi ý là *việc thật*; composer là CTA duy nhất; nút gửi mũi tên lên tròn; không chrome thừa quanh ô nhập |
| Sidebar | ChatGPT / Claude, Slack | Hàng 36px chữ 14px; nhóm theo thời gian ("Hôm nay / Hôm qua / 7 ngày qua"); nhãn nhóm sentence case; mọi hành động hover đều có trong menu ⋯ |
| Tiện ích | App Store, Slack App Directory, Chrome Web Store, Notion Integrations | Tên đẹp + một dòng "làm được gì"; nhóm theo việc; nút "Thử ngay"; nút Cài/Bật là nút thật; kho có phần "Nổi bật" (chỉ khi có dữ liệu) |
| Tin nhắn | Slack "Add apps", Notion Connections, Zalo OA, trình hướng dẫn 3 bước kiểu Apple | Tile thương hiệu lớn; 3 bước đánh số dọc; phần nâng cao gấp lại; trạng thái = chữ + chấm, một pill duy nhất |
| Artifact | Google Drive "Gần đây", Apple Files, Slack Files, Finder gallery | Nhóm theo ngày; thumbnail lớn; icon loại tệp; một cú nhấp để mở; menu ⋯ cho việc phụ |
| Chất liệu chung | macOS System Settings / Messages, Notion, Material 3 (chip lọc, tab pill) | Góc 8–12px; phân tầng bằng độ sáng + hairline; chip lọc pill; toggle 22px; bóng chỉ khi hover |

### 2.2 Màu — giữ nguyên (Q1)

- Preset mặc định, band sáng/tối, accent, accent picker, chế độ mặc định: **không đổi một giá trị nào**. Không thêm preset, không đổi `index.html` first-paint, không đổi `normalizeMode`.
- Việc duy nhất chạm màu: **pill trạng thái đi theo theme**. 17 dòng `emerald-*`/`amber-*` cố định (không đổi theo skin, fail contrast trên band sáng) thay bằng token semantic đã có `--ui-green / --ui-yellow / --ui-red` + `-foreground` (design.md §Stroke & color tokens) qua một primitive `StatusPill`. Cần thêm tone "info" (xanh nhạt cho "Đang kết nối") → dùng `--theme-primary`/`--ui-accent` pha nền bằng `color-mix` như các knob sẵn có, **không** thêm hue mới.
- Watermark, focus ring, selection, semantic trio: giữ. `scripts/check-theme-contrast.mjs` vẫn chạy mỗi phase để bảo đảm không ai vô tình chạm preset.

### 2.3 Chữ — font giữ nguyên (Q2), đổi chỗ dùng cỡ

- **Ramp và font giữ nguyên** (Geist · JetBrains Mono · Newsreader 3 slot; `--text-2xs` … `--text-3xl`). Không vendor font mới, không đổi `--dt-font-*`.
- Đổi *chỗ dùng* trong phạm vi: chữ chrome của hàng nav / sidebar / danh sách = **14px** (`text-base`); mô tả card & chi tiết = **13–14px**; meta sàn = **12px** (`text-xs`); `text-2xs` (11px) chỉ còn ở statusbar và timestamp. Prose chat giữ 15px/1.6.
- Trong chrome người dùng phổ thông, mono chỉ xuất hiện trong phần "Chi tiết kỹ thuật".
- **Neuebit / Collapse gỡ hoàn toàn** (hai `@font-face` chết ở `styles.css:30-50`, không ảnh hưởng font đang dùng); nếu `grep -rn "@nous-research/ui" src` chỉ còn `vibe-hearts.tsx` thì thay trái tim pixel bằng path Tabler `Heart` và gỡ gói khỏi `package.json`.
- **Nhãn nhóm**: sentence case, 12px semibold, `--ui-text-tertiary`, **không tracking**. `--tracking-label` không dùng nữa trong phạm vi (token giữ lại cho Settings và statusbar).

### 2.4 Hình khối & chất liệu

- Bo góc: `--radius-control` 6 → **8px** · `--radius-card` 10 → **12px** · `--radius-overlay` 12 → **14px** · `--radius-bubble` 14 → **18px** · pill 999. Composer giữ 16px. Trong transcript giữ luật "bên trong tròn ít hơn vỏ một bậc".
- **Switch** thêm size `md`: track 22×38, thumb 18 — mặc định cho mọi hàng bật/tắt trong phạm vi; `xs` chỉ còn trong menu và hàng dense. Hit target ≥ 24px giữ.
- Control: `default` 32px giữ; hàng danh sách trong trang 44–48px; **hành động chính trong card ≥ `sm` 28px và có hộp** (secondary/outline) — không còn chữ trần 12px.
- Bóng: giữ ladder `--shadow-xs/sm/md/nous`; card kho/artifact: rest `--shadow-xs`, hover `--shadow-sm` + viền `--ui-stroke-secondary`. Không thêm bóng mới, không glow.
- **Loader (Q6):** `Loader` thêm `variant="ring"` — vòng tròn mềm 20px quay bằng `transform` (token motion sẵn có, reduced-motion → đứng yên với opacity nhấp nháy ≤ 150ms) — dùng cho `PageLoader` và mọi trạng thái tải trang trong phạm vi; các curve toán giữ nguyên cho transcript/long ops.

### 2.5 Icon

- **Tabler cho toàn bộ chrome trong phạm vi** (nav, tab, nút trang, empty state), nạp qua alias trong `src/lib/icons.ts` (đã kiểm: `IconMessagePlus`, `IconPuzzle`, `IconPhoto`, `IconPlug`, `IconApps`, `IconRefresh`, `IconHeart`, `IconMessageCircle`, `IconFiles`, `IconPin`, `IconDots`, `IconMicrophone`, `IconArrowUp` có trong `@tabler/icons-react` 3.44). Cỡ: nav 18px (`size-4.5`), nút 16px, hàng danh sách 20px (`iconSize.lg`); stroke 1.75.
- Codicon chỉ còn trong transcript / tool / terminal / editor / file-tree (đúng `design.md`).
- Nav: Trò chuyện mới → `MessagePlus`; Tiện ích → `Puzzle`; Tin nhắn → `MessageCircle`; Artifact → `Files`; MCP → `Plug`; Kho → `Apps`.
- Thương hiệu: `BrandMark` giữ asset hiện tại (đã là mark hình học), sửa comment; thêm `BrandGlyph` SVG 20px từ `buildMark()` (tách path ra `lib/brand-mark-path.ts` dùng chung với watermark) để dùng ở đầu lượt trả lời và trong `EmptyFigure`.

### 2.6 Chuyển động

- Giữ toàn bộ token/recipe v1 (`--dur-*`, `--ease-*`, exit = 75%, focus ring tức thời, mở-không-animation cho menu/palette).
- Thêm đúng **2 recipe** cho phạm vi, ghi vào `design.md` §Motion:
  1. **Tab pill trượt**: một element highlight đi theo tab đang chọn, `transform` 160ms `--ease-out` (tái dùng cơ chế MutationObserver của `CommandSelectionIndicator`), reduced-motion → nhảy.
  2. **Card hover**: đổi `background-color` + `border-color` + `box-shadow` (`--shadow-xs` → `--shadow-sm`) 200ms `--ease-out`. **Không translate, không scale.**
- Mỗi bề mặt ≤ 3 primitive động. `EmptyFigure` không animate.

### 2.7 Giọng & bảng thuật ngữ (luật cho mọi chuỗi mới/đổi trong phạm vi — đã chốt Q3)

| Hiện tại | Mới (tiếng Việt, bản gốc) | Ghi chú |
|---|---|---|
| Phiên · Phiên mới | Cuộc trò chuyện · **Trò chuyện mới** | Đã chốt Q3 |
| Năng lực | **Tiện ích** | Đã chốt Q3; tab con giữ "Kỹ năng", "Công cụ" |
| Artifact | **Artifact** (giữ) | Đã chốt Q3; trang tự giải thích bằng dòng mô tả và trạng thái trống |
| Kho kỹ năng | Cài thêm | Động từ, rõ việc |
| MCP (tên tab) | Kết nối nâng cao | "MCP" chỉ còn trong dòng mô tả phụ |
| Tin nhắn · Dự án · Đã ghim | Giữ | Sentence case |
| Gateway (chuỗi người dùng) | AgentX / "dịch vụ nền" | "Gateway tin nhắn đã dừng" → "AgentX đang tắt kết nối tin nhắn" |
| Bot token | Mã bot | Kèm một dòng giải thích lấy ở đâu |
| ID người dùng được phép | Ai được phép nhắn cho bot | Placeholder tiếng Việt |
| Cần key | Cần thiết lập | Kèm nút "Thiết lập" |
| Toolset / bộ công cụ | Công cụ | Số đếm: "5 chức năng" thay "5 tools" |
| ×20 (usage) | Dùng 20 lần | Số thật từ dữ liệu, `tabular-nums` |
| repo / repository | thư mục mã nguồn | Chỉ xuất hiện khi thực sự trong repo |
| Tên kỹ năng kebab-case | Tên hiển thị: `title`/`name` đọc được từ frontmatter SKILL.md nếu có, fallback `prettyName()`; tên gốc trong "Chi tiết kỹ thuật" | Không đổi id/slug ở tầng dữ liệu |
| Nhóm `Autonomous-Ai-Agents`, `Software-Development`… | Bảng dịch nhóm `skills.category.*`: Trợ lý tự động · Văn phòng · Nghiên cứu · Sáng tạo · Phát triển phần mềm · Apple · Chung… | Nhóm không có trong bảng → `prettyName` |
| `agentx-hub-verified`, `builtin/trusted/community` | Đã xác minh · Có sẵn · Tin cậy · Cộng đồng | Không hiện slug |

Luật giọng: câu ngắn; động từ đứng trước ("Kết nối Telegram", "Thử ngay"); không viết tắt; lỗi = chuyện gì / vì sao / làm gì tiếp; không "Oops", không dấu chấm than trong lỗi; số liệu chỉ từ dữ liệu thật.

**Từ cấm trong chuỗi người dùng thấy** (quét bằng grep ở Phase 5): `phiên`, `gateway`, `token`, `repo`, `MCP` (ngoài dòng mô tả phụ của tab), `toolset`, `env`, `key` (nghĩa API key), `Shift`, `⌘` trong câu văn. ("Artifact" được phép — Q3.)

### 2.8 Minh hoạ trạng thái trống — bộ 4 hình tự vẽ

`components/ui/empty-figure.tsx`: SVG monoline 96×96, nét 1.5px, `currentColor` ở `--ui-text-quaternary`, `aria-hidden`, không animation. Mỗi hình = mark AgentX (`buildMark()` đã có) + **một** vật thể: `chat` (bong bóng — trò chuyện trống), `folder` (thư mục — dự án/tệp), `plug` (ổ cắm — kết nối), `box` (hộp mở — tiện ích/artifact). Dùng qua prop `figure` của `EmptyState`/`PanelEmpty`. Cấm mọi minh hoạ khác (§0.13).

---

## 3 · Các phase

> Mỗi phase: **Mục tiêu → Tham chiếu → Việc chính → File đụng tới → Definition of Done → Guardrails.** Xong DoD mới sang phase sau.

---

### Phase 1 — Nền tảng thân thiện & tẩy dấu Hermes: bo góc, icon, primitive, dọn dấu vết

**Mục tiêu:** đặt các primitive và token hình khối mà phase 2–4 cần, thay bộ icon chrome, dọn dấu vết pixel và Tailwind ramp thô — **chưa đổi layout, không đổi màu, không đổi font**. Sau phase này app chỉ khác: bo góc mềm hơn, icon nav Tabler, pill trạng thái đi theo theme, loader trang là vòng mềm.

**Tham chiếu:** Apple System Settings (góc 8–12, toggle rõ), Notion (pill trạng thái chữ + chấm).

**Việc chính**
1. **Bo góc** theo §2.4 (`styles.css:637-643`); kiểm mọi chỗ đọc `--radius-*` không vỡ (menu vẫn `rounded-md` theo `--radius-scalar`).
2. **Dọn dấu vết pixel**: xoá hai `@font-face` Neuebit/Collapse (`styles.css:30-50`); `vibe-hearts.tsx` đổi trái tim pixel sang path Tabler `Heart` (giữ hành vi hearts); gỡ `@nous-research/ui` khỏi `package.json` nếu `grep -rn "@nous-research/ui" src` không còn kết quả; sửa comment "8-bit" trong `brand-mark.tsx`.
3. **Icon**: thêm alias Tabler cần dùng vào `lib/icons.ts`; thay 9 Codicon trong `sidebar/index.tsx` (nav + nút header), 4 trong `master-detail.tsx`, 5 trong `hub.tsx`, 4 chrome trong `mcp-tab.tsx`. Không đụng Codicon trong transcript/terminal/file-tree/editor.
4. **`StatusPill`** mới trong `components/ui/status-pill.tsx`: `tone = good | warn | bad | muted | info`, cỡ `sm` (24px, 12px chữ) và `md` (28px, 13px), luôn **chấm + chữ**, màu từ `--ui-green/yellow/red` + `-foreground`; tone `info` pha từ `--ui-accent` bằng `color-mix` (khai báo `--ui-info`/`--ui-info-foreground` trong `styles.css`, không hue mới). Thay 17 dòng `emerald/amber` (hub, hub-status, mcp-tab), `PILL_TONE` messaging, `StatusDot` (tone `warn` → token), `trustTone`/`verdictTone` hub. Kiểm contrast chữ trên pill ở cả hai band bằng script gate (thêm cặp mới nếu script chưa phủ).
5. **`Switch size="md"`** (§2.4) trong `components/ui/switch.tsx`; chưa đổi call site (phase 3–4 làm).
6. **`Loader variant="ring"`** (§2.4, Q6) + `PageLoader` dùng variant này; các nơi khác không đổi.
7. **`EmptyFigure`** (§2.8) + prop `figure` cho `EmptyState`/`PanelEmpty`; `BrandGlyph` 20px + tách `lib/brand-mark-path.ts` dùng chung với `chat-watermark.tsx` (test watermark phải xanh).
8. **`PillTabs`** (cạnh `text-tab.tsx`/`tab-dropdown.tsx`): hàng tab pill 32px, chữ 13px medium, count 12px `tabular-nums`, highlight trượt (recipe §2.6.1); `ResponsiveTabs` nhận `variant="pill"` và vẫn gập thành dropdown khi hẹp. Chưa bật ở trang nào (phase 3–4).
9. **Nhãn nhóm**: `SidebarPanelLabel`, `SidebarDateDivider`, `PanelSectionLabel`, `SectionTitle` (messaging) → sentence case 12px semibold tertiary, không tracking; cmdk heading trong palette giữ (ngoài phạm vi).
10. Stamp + `log.json` (§0.12); `design.md`: §Typography (nhãn nhóm; Neuebit đã gỡ), §Control & radius (bo góc mới, Switch md), §Stroke & color (StatusPill, `--ui-info`), §Iconography & brand (BrandGlyph, Tabler-only chrome), §Feedback (EmptyFigure, Loader ring), §Motion (2 recipe mới).

**File:** `src/styles.css`, `lib/icons.ts`, `lib/brand-mark-path.ts` (mới), `components/ui/{status-pill,switch,loader,empty-state,empty-figure,tab-dropdown,text-tab}.tsx`, `components/page-loader.tsx`, `components/status-dot.tsx`, `components/brand-mark.tsx`, `components/chat/{chat-watermark,vibe-hearts}.tsx`, `app/chat/sidebar/{index,chrome}.tsx`, `app/shell/sidebar-label.tsx`, `app/master-detail.tsx`, `app/skills/{hub,hub-status,mcp-tab}.tsx`, `app/messaging/index.tsx` (chỉ pill + SectionTitle), `app/overlays/panel.tsx` (label), `scripts/check-theme-contrast.mjs` (nếu thêm cặp), `design.md`, `package.json`.

**DoD:** `grep -rn "emerald-\|amber-" src/app src/components` = 0 (ngoài `src/app/settings/`); `grep -c Codicon` = 0 trong nav block của `sidebar/index.tsx`, `master-detail.tsx`, `hub.tsx`, chrome của `mcp-tab.tsx`; không còn `@font-face` Neuebit/Collapse; `check:contrast` xanh; screenshot 7 bề mặt sáng/tối chỉ khác bo góc / icon / pill / loader (layout, màu, font y nguyên — so ảnh before/after cạnh nhau); Night Owl và user theme hiện tại render đúng như trước; `themes/*.test.ts`, `chat-watermark.test.tsx`, `no-native-title` xanh.

**Guardrails:** không đổi layout/copy ở phase này; không đụng `themes/presets.ts`, `--theme-*`, `--dt-font-*`, `--composer-*`; Settings chỉ thừa hưởng; `RAIL_GAP` không đổi.

---

### Phase 2 — Giao diện chính: sidebar, màn hình trống, khung chat, composer, titlebar

**Mục tiêu:** người mới mở app thấy ngay: một lời chào là câu hỏi, 3–4 việc có thể làm, một ô để gõ. Sidebar đọc như danh sách cuộc trò chuyện của ChatGPT/Claude, không như cây thư mục của IDE.

**Tham chiếu:** ChatGPT, Claude desktop (home + sidebar), Slack (nhóm + badge).

**Việc chính**
1. **Sidebar nav** (`sidebar/index.tsx:145-174` + render): 4 mục **Trò chuyện mới · Tiện ích · Tin nhắn · Artifact** (Q3); token mới `--sidebar-nav-row-height: 36px`; chữ 14px medium; icon Tabler 18px; active = nền `--ui-row-active-background` + thanh accent 2px (cơ chế `--ui-row-active-bar` sẵn có); chip `⌘ N` chỉ hiện khi hover/focus-within (không hiện thường trực). Cập nhật `sidebar.nav.*` + `commandCenter`/palette label tương ứng trong mọi locale.
2. **Nhãn nhóm & gợi ý**: "Đã ghim", "Dự án", "Gần đây" sentence case (Phase 1 primitive); thay `shiftClickHint` bằng "Ghim những cuộc trò chuyện bạn hay quay lại." và đảm bảo "Ghim / Bỏ ghim" có trong menu ⋯ của hàng (`session-actions-menu.tsx` đã có `onPin` — kiểm tra hiển thị); Shift-click vẫn hoạt động, không còn là cách duy nhất.
3. **Hàng cuộc trò chuyện**: `--sidebar-row-height` 32 → **36px**, tiêu đề 14px, meta 12px `tabular-nums`; date divider sentence case ("Hôm nay", "Hôm qua", "7 ngày qua", tháng). Virtual list giữ nguyên (`VIRTUALIZE_THRESHOLD`, `virtual-session-list.tsx` — chỉ đổi token chiều cao).
4. **Màn hình trống** (`components/chat/intro.tsx`, `app/chat/index.tsx:409-416`): nới điều kiện `showIntro` để lời chào hiện **cả khi đang ở một cuộc trò chuyện mới rỗng** (routed session, 0 message, không busy) — thay đổi hiển thị, không đụng runtime; giữ "một entrance mỗi lần mở app". Bố cục: lời chào serif 28px (giữ) → một dòng dẫn 15px (giữ `intro-copy.jsonl`, rà giọng theo §2.7) → **hàng gợi ý = tối đa 4 thẻ việc** thay chip pill: thẻ "Tiếp tục «…»" (khi có) rộng gấp đôi và đứng đầu (bất đối xứng chủ đích); các thẻ còn lại: icon Tabler 20px **đặt trước** tiêu đề (không đặt trên), tiêu đề 14px medium, mô tả 13px một dòng; nguồn dữ liệu giữ nguyên `introChipSources()`; copy starter văn phòng dẫn đầu ngoài repo ("Tóm tắt một tài liệu", "Soạn một email", "Lập kế hoạch tuần", "Giải thích thư mục này"), trong repo giữ cặp coding. Thẻ = `Button variant="card"` (thêm vào button.tsx) — không chế ở call site.
5. **Composer** (kích thước giữ; Q4 đã chốt): placeholder = "Bạn cần làm gì hôm nay?" ngoài repo / "Hỏi về mã nguồn hoặc giao việc…" trong repo (`repoStatusForCwd` đã quyết); **nút chính = mũi tên lên tròn 32px primary** khi có chữ; khi ô trống hiển thị nút mic (một icon); loa/camera của chế độ giọng nói gom vào một menu "⋯" **chỉ xuất hiện khi voice mode đang bật**; nút "+" có tooltip "Đính kèm tệp, ảnh hoặc thư mục". Pill model giữ tên ngắn ngoài repo (đã có).
6. **Titlebar** (`shell/titlebar-controls.tsx`; Q5 đã chốt): gom "Phím tắt" và "Âm thanh" vào một nút "⋯" (menu) cạnh nút Cài đặt; nút toggle sidebar trái/phải giữ. Tooltip 500ms giữ.
7. **Transcript** (chỉ hai việc, còn lại giữ v1): (a) `BrandGlyph` 20px ở đầu **mỗi lượt** trả lời (một lần/lượt, căn cột prose, cách lề 8px, không trong bubble); (b) dòng công cụ hiển thị **nhãn tiếng người** theo bảng `tools.friendly.*` trong i18n (đọc tệp · tìm trên web · chạy lệnh · sửa tệp · mở trình duyệt…), tên tool gốc vào tooltip/expand — chỉ đổi nhãn, không đổi cấu trúc scaffold.
8. Watermark giữ (đã brand-native).

**File:** `app/chat/sidebar/{index,chrome,section-states,session-row,session-actions-menu}.tsx`, `components/chat/{intro,intro-chips}.ts(x)` (+ test), `components/chat/intro-copy.jsonl`, `app/chat/index.tsx`, `app/chat/composer/{controls,index}.tsx`, `app/shell/titlebar-controls.tsx`, `components/assistant-ui/thread/assistant-message.tsx`, `components/assistant-ui/tool/*` (nhãn), `components/ui/button.tsx` (variant `card`), `src/styles.css` (token mới), `src/i18n/*` (đủ locale), `design.md` (§Navigation chrome, §Chat tools & boot surfaces).

**DoD:** screenshot sáng/tối: home có tên & có "Tiếp tục" · home không tên · home trong repo · home cuộc trò chuyện mới rỗng (điều kiện mới) · sidebar đầy (active/hover/working/needs-input) · chat đang stream với BrandGlyph · composer voice mode với menu ⋯ · titlebar mới; e2e `sidebar-states`, `chat` xanh (cập nhật baseline nếu chủ đích); `intro-chips.test.ts` thêm case thẻ rộng; keyboard nav, `⌘N` và mọi phím tắt cũ không đổi (menu ⋯ chỉ là chỗ ở mới của hai nút); **3 giây test**: người xem home nói được "gõ vào ô dưới cùng, hoặc bấm một thẻ".

**Guardrails:** không đổi `--composer-*`, không thêm tầng cho composer; không auto-focus/steal focus; không thêm "AI suggestions" động; không đụng virtual list logic; serif chỉ ở 3 slot; không đổi màu nào.

---

### Phase 3 — Tiện ích: 4 tab đọc như một cửa hàng ứng dụng

**Mục tiêu:** người phổ thông vào trang và hiểu: đây là những việc AgentX làm được; bật cái cần, tắt cái không dùng, cài thêm từ kho, thử ngay một cái. Phần kỹ thuật (MCP, tên hàm, JSON) vẫn đầy đủ nhưng gấp lại.

**Tham chiếu:** App Store (chi tiết + nút Cài thật), Slack App Directory (nhóm theo việc), Chrome Web Store (card kho), Notion Integrations (trạng thái Đã cài).

**Việc chính**
1. **Khung trang chung** (`app/page-search-shell.tsx`): thêm prop `title`/`description` render qua `OverlayPageHeader` phía trên hàng tìm-kiếm/tab ("Tiện ích" 22px · "Những việc AgentX làm được cho bạn. Bật thứ bạn cần, tắt thứ không dùng." 13px); hàng dưới: tìm kiếm trái (giữ `SearchField`), **`PillTabs`** giữa, hành động phải. Thứ tự tab: **Kỹ năng · Công cụ · Cài thêm · Kết nối nâng cao** (`SKILLS_MODES` chỉ đổi thứ tự hiển thị; id giữ để deep link `?tab=` không vỡ).
2. **Tab Kỹ năng** (`app/skills/index.tsx`, `master-detail.tsx`):
   - `CapRow` → **48px**: icon nhóm Tabler 20px (map `category → icon` trong `lib/skill-categories.ts`, mới) · tên hiển thị 14px medium · mô tả 13px một dòng (từ `skill.description`) · meta "Dùng 20 lần" 12px · `Switch size="md"`; badge Tự học / Từ kho sentence case qua `StatusPill tone="muted"`.
   - Không tìm kiếm → **nhóm theo category** (heading sentence case 13px semibold + số lượng, sort trong nhóm theo usage); có tìm kiếm → danh sách phẳng. `ListStrip` "↓ Dùng nhiều nhất" chữ 11px → nút `sm` ghost "Sắp xếp"; menu ⋯ giữ "Tắt mục không dùng", công tắc "Tất cả".
   - **Chi tiết** (`DetailColumn`, ~40% chiều rộng, `split="wide"` giữ): tên 18px · mô tả 14px/1.5 · chip nhóm · **nút "Thử ngay" `default` 32px primary** → chuyển về màn chat mới và điền `/<tên-kỹ-năng> ` vào composer bằng action có sẵn (`onNavigate new-session` + `requestComposerInsert(..., { target: 'main' })`). *Điểm cần kiểm:* nếu `requestComposerInsert` không hàng đợi được khi composer chưa mount → thay nút bằng dòng hướng dẫn "Gõ `/tên-kỹ-năng` trong ô trò chuyện" và báo cáo. Disclosure "Chi tiết kỹ thuật": tên gốc, nguồn (`provenance`), đường dẫn; kỹ năng tự học: Sửa (mở editor `DetailPane` như cũ) / Lưu trữ / Tải lên kho — nút `sm` có hộp.
3. **Tab Công cụ**: hàng như Kỹ năng; "5 tools" → "5 chức năng"; mô tả tiếng Anh từ backend → lớp dịch `toolsetCopy` trong i18n (`skills.toolsets.<name>.{label,description}`) cho các toolset desktop-visible (24 mục trên máy này — viết tay tiếng Việt, ngắn, nói *việc*: "Đọc, ghi và tìm trong tệp của bạn"); thiếu bản dịch → dùng mô tả backend. Pill "Cần key" → `StatusPill warn` "Cần thiết lập" + nút `sm` "Thiết lập" cuộn tới `ToolsetConfigPanel` (đã có, không đổi logic). Chip tên hàm mono → disclosure "Chi tiết kỹ thuật". Vision/Computer use/Terminal panel giữ, chỉ nhận header mới.
4. **Tab Kết nối nâng cao (MCP)** (`mcp-tab.tsx`): đầu tab một dòng 13px "Kết nối AgentX với phần mềm khác qua chuẩn MCP. Dành cho người quản trị." · danh sách server hàng 48px: `McpAvatar` 32px, tên 14px, trạng thái chữ 12px + chấm (StatusPill), `Switch md`, hành động hover giữ · **nút "Thêm kết nối" `default`** thay dấu "+" trơ, mở menu 2 lựa chọn: "Từ danh mục" (view Catalog sẵn có) / "Dán cấu hình" (mở editor) · editor JSON + log gom vào `DetailPane` **mặc định gấp** tiêu đề "Cấu hình nâng cao (mcp.json)"; view Catalog: card theo chuẩn tab Cài thêm. Không đổi parse/save/probe/OAuth.
5. **Tab Cài thêm (Hub)** (`hub.tsx`): store front = tiêu đề "Kho tiện ích AgentX" 15px semibold + `StatusPill` (Đã kết nối / Không tới được / Đang đồng bộ) + host dạng link + nút `sm` outline "Đồng bộ" · dòng "N tiện ích · Đồng bộ lần cuối 14:42" 13px · lưới `repeat(auto-fill, minmax(18rem, 1fr))` gap 12 · card `--radius-card` padding 16: tên 14px semibold + phiên bản 12px mono tertiary, mô tả 13px 2 dòng, hàng chip: loại (Desktop / Trình duyệt), tin cậy (dịch — không slug), lượt tải; chân card: **"Cài" `sm` primary** / "Đã cài" `StatusPill good` + ⋯ (Gỡ) / "Xem trước" `sm` text; card hover theo recipe §2.6.2. `HubStatus` giữ, đổi pill sang `StatusPill`. Dialog xem trước: tiêu đề 18px + pill tin cậy, SKILL.md render bằng `CompactMarkdown` (sẵn có) thay `<pre>` mono, kết quả quét = `StatusPill` + danh sách phát hiện 13px; nút Quét `sm` text, Cài `default`. Phần "Nổi bật" **chỉ** khi catalog trả dữ liệu featured — không bịa.
6. Trạng thái trống/lỗi của 4 tab qua `PanelEmpty` + `EmptyFigure box`, 3 nhịp (tên · vì sao · một nút); tải trang qua `PageLoader` ring (Phase 1).

**File:** `app/page-search-shell.tsx`, `app/master-detail.tsx`, `app/skills/{index,hub,hub-status,mcp-tab,publish-dialog}.tsx`, `lib/skill-categories.ts` (mới), `app/settings/helpers.ts` (chỉ **đọc** `prettyName`/`toolsetDisplayLabel` — không sửa), `components/ui/{pill-tabs,status-pill,switch}.tsx`, `src/i18n/*`, `design.md` (§Layout: page header cho page, §Rows), `src/styles.css`.

**DoD:** screenshot 4 tab sáng/tối + trạng thái trống + dialog xem trước + Thử ngay; `skills/*.test.tsx`, `hub.test.tsx`, `mcp` test xanh; deep link `#/skills?tab=mcp` vẫn mở đúng tab; không hàng nào < 44px, không chữ đọc < 13px, không nút hành động chữ trần; toggle vẫn optimistic + im lặng khi thành công; **3 giây test** trên tab Kỹ năng: người xem nói được "bật/tắt bằng công tắc, bấm Thử ngay để dùng".

**Guardrails:** không đổi query key/cache/optimistic logic; không gộp skills và toolsets thành một danh sách dữ liệu; không đổi format `mcp.json`; không tự dịch bằng máy — bản dịch toolset/category viết tay, ghi rõ trong PR mục nào chưa có bản dịch.

---

### Phase 4 — Tin nhắn & Artifact: từ form kỹ thuật thành hướng dẫn 3 bước và thư viện

**Mục tiêu:** Tin nhắn đọc như "kết nối ứng dụng" của Slack/Notion: chọn ứng dụng → làm 3 bước → xong. Artifact đọc như "Gần đây" của Google Drive: thấy ngay ảnh/tệp, một cú nhấp để mở, và trang tự nói "artifact" là gì.

**Tham chiếu:** Slack "Add apps", Notion Connections, Zalo OA; Google Drive "Gần đây", Apple Files, Finder gallery.

**Việc chính — Tin nhắn** (`app/messaging/index.tsx`)
1. Tiêu đề trang qua khung Phase 3: "Tin nhắn" · "Nhắn cho AgentX từ ứng dụng bạn đang dùng."
2. **Danh sách trái** thành hai nhóm: **"Đang dùng"** (enabled hoặc configured) và **"Có thể kết nối"** — 6 nền tảng phổ biến trước theo hằng UI `POPULAR_PLATFORMS = ['telegram','whatsapp','email','slack','discord','sms']`, phần còn lại gấp dưới "Xem thêm N nền tảng" (disclosure, nhớ trạng thái mở trong session). Hàng 44px: `PlatformAvatar` 28px, tên 14px, trạng thái 12px chữ + chấm (`StatusPill sm`), badge số yêu cầu ghép nối 12px `bad`. Tìm kiếm mở toàn bộ danh sách.
3. **Chi tiết = trình hướng dẫn 3 bước** đánh số dọc (mỗi bước: số trong vòng 24px + tiêu đề 15px semibold + nội dung; bước xong có dấu check thay số):
   - **1 · Tạo bot / lấy quyền** — đoạn hướng dẫn **tiếng Việt viết tay** cho từng nền tảng (`vi.ts messaging.platformIntro.<id>`, 19 mục theo `PLATFORM_INTRO`; các locale khác dịch) + nút `sm` textStrong "Mở hướng dẫn" (giữ `openExternalLink`); `platform.description` tiếng Anh → lớp dịch `messaging.platformTagline.<id>` (fallback backend).
   - **2 · Dán mã** — các trường bắt buộc: nhãn theo §2.7 ("Mã bot", "Ai được phép nhắn cho bot"), help 13px, placeholder tiếng Việt, `Input size="lg"` 36px, trạng thái "Đã lưu" = `StatusPill good sm`; "Nên có" và "Nâng cao (N)" gấp dưới bước này bằng disclosure sentence case (bỏ `tracking-[0.14em]`).
   - **3 · Bật** — `Switch md` + câu "Bật để AgentX bắt đầu nhận tin nhắn từ …" + khi `pending_restart`: nút `default` "Khởi động lại AgentX" ngay tại chỗ (gọi `runGatewayRestart` sẵn có) thay vì chỉ nói "khởi động lại từ thanh trạng thái" (thanh trạng thái mặc định ẩn!).
   `PlatformActionBar` (Lưu thay đổi) giữ, đưa xuống footer như hiện nay.
4. **Header chi tiết**: avatar 40px + tên 18px + **một** `StatusPill md` tổng hợp theo ưu tiên: Lỗi (`fatal/startup_failed`) › Cần khởi động lại › Đang kết nối › Đã kết nối › Chưa thiết lập › Đã tắt; các thông tin còn lại thành một dòng 13px dưới tên. `ErrorBanner` giữ cho `error_message`.
5. **Yêu cầu ghép nối**: banner đầu cột chi tiết (và đầu danh sách khi có yêu cầu ở nền tảng khác): "«Nguyễn A» muốn nhắn với AgentX qua Telegram" + nút `sm` "Cho phép" primary / "Từ chối" text; badge số trên mục nav "Tin nhắn" ở sidebar (nếu chưa có atom cho pending → nâng dữ liệu `getPairing` đã có trong trang lên atom hiển thị; **hỏi trước** nếu cần thêm polling). Danh sách "Người đã cho phép" thành `ListRow` 44px như cũ, tiêu đề sentence case.
6. Toast sau lưu/bật: giữ (kết quả không thấy ngay), nhưng copy theo §2.7 và luôn có nút "Khởi động lại AgentX".

**Việc chính — Artifact** (`app/artifacts/index.tsx`)
7. Tiêu đề trang "Artifact" (giữ tên — Q3) · mô tả "Ảnh, tệp và liên kết AgentX đã tạo trong các cuộc trò chuyện." — dòng này là chỗ trang tự giải thích từ "artifact". Nút làm mới giữ (icon Tabler `Refresh`, tooltip).
8. **Trống**: `EmptyState` + `EmptyFigure box` · "Chưa có artifact nào" · "Khi AgentX tạo ảnh hay tệp cho bạn, chúng sẽ nằm ở đây." · nút `default` "Bắt đầu trò chuyện" (action `new-session` sẵn có). **Ẩn hàng tab khi tổng = 0** (không hiện bốn số 0).
9. **Lọc** = `PillTabs` với số đếm (Tất cả · Ảnh · Tệp · Liên kết).
10. **Ảnh**: lưới `minmax(14rem, 1fr)` gap 12; card `--radius-card`, thumbnail cao 10rem `object-cover` trên nền `--ui-bg-quinary`, tên 14px medium, dòng phụ 12px "«Tên cuộc trò chuyện» · 14:02"; hover: nút `sm` "Mở" + "Xem cuộc trò chuyện" (focus-visible cũng hiện); bỏ nhãn "ẢNH" HOA.
11. **Tệp & liên kết**: thay `<table>` bằng **hàng 52px nhóm theo ngày** ("Hôm nay", "Hôm qua", "7 ngày qua", rồi theo tháng — dùng `fmtDayTime`/helper sẵn có trong `lib/time.ts`, thêm helper nhóm nếu chưa có, kèm test): trái `FileTypeIcon` 24px (tệp) / brand icon hoặc `Link` (liên kết) · tên 14px · dòng phụ 12px (thư mục cha rút gọn hoặc host) · phải: tên cuộc trò chuyện 12px, nút `sm` "Mở" (hover/focus), ⋯ (Sao chép đường dẫn/URL, Xem cuộc trò chuyện). Phân trang giữ nguyên logic, control theo ramp. Tooltip đường dẫn đầy đủ giữ.
12. Bỏ mọi `tracking-[…]`, `text-2xs` cho chữ đọc.

**File:** `app/messaging/{index,platform-icon}.tsx`, `store/*` (chỉ nếu cần atom pending — hỏi trước), `app/chat/sidebar/index.tsx` (badge nav), `app/artifacts/{index,artifact-utils}.ts(x)`, `lib/time.ts` (helper nhóm ngày, kèm test), `components/ui/{empty-state,pill-tabs,status-pill}.tsx`, `src/i18n/*` (19 platformIntro + tagline + copy mới, đủ locale), `design.md` (§Feedback: banner yêu cầu; §Layout: nhóm theo ngày).

**DoD:** screenshot Tin nhắn (Telegram chưa thiết lập · đã kết nối · có yêu cầu ghép nối · nhóm gấp/mở) và Artifact (trống · có ảnh · có tệp/liên kết · lọc) sáng/tối; `messaging/index.test.tsx`, `artifacts/index.test.ts` xanh; không chuỗi tiếng Anh nào hiện ở locale `vi` trong hai trang (trừ tên thương hiệu); `?platform=` và `?tab=` deep link giữ; **3 giây test** Tin nhắn: người xem nói được "làm 3 bước là xong".

**Guardrails:** không đổi API pairing/updateMessagingPlatform; không bỏ nền tảng nào; không tự thêm polling mới; ảnh vẫn `loading="lazy"` trong lưới (không phải LCP); không dùng favicon từ dịch vụ ngoài cho liên kết nội bộ (luật đã có ở MCP avatar).

---

### Phase 5 — Lời văn, chuyển động, nghiệm thu "người mới"

**Mục tiêu:** đóng đợt: mọi chuỗi đúng giọng, mọi chuyển động đúng token, và một người chưa từng dùng làm được 5 việc cơ bản không cần hướng dẫn.

**Việc chính**
1. **Copy sweep** toàn phạm vi theo §2.7: `vi.ts` là gốc; rà `sidebar`, `assistant.intro`, `skills`, `messaging`, `artifacts`, `tools.friendly`, toast/lỗi trong phạm vi; quét **từ cấm** bằng grep trên các block `vi.ts` thuộc phạm vi (danh sách §2.7) — kết quả grep dán vào PR; đủ mọi locale, dấu chuẩn.
2. **Bản dịch tay còn nợ**: 24 toolset, 19 platformIntro + tagline, bảng category — ghi rõ mục nào còn dùng fallback.
3. **Motion**: xác nhận chỉ 2 recipe mới (§2.6) + recipe v1; `grep -rn "transition-all\|cubic-bezier" src/` chỉ còn `styles.css` + `lib/motion.ts`; mỗi bề mặt ≤ 3 primitive; chụp lại với `prefers-reduced-motion: reduce` (tab pill nhảy, card không đổi bóng, loader ring đứng yên).
4. **Kiểm chứng người mới — 5 nhiệm vụ**, agent tự làm **bằng chuột trên app dev, không phím tắt, không palette**, chụp từng bước, mỗi nhiệm vụ ≤ 3 cú nhấp từ màn hình chính: (a) bắt đầu một cuộc trò chuyện và gửi "Tóm tắt tài liệu này"; (b) bật một kỹ năng và bấm Thử ngay; (c) đi tới bước 2 kết nối Telegram; (d) tìm lại một ảnh đã tạo trong Artifact và mở nó; (e) ghim một cuộc trò chuyện. Nhiệm vụ nào > 3 nhấp hoặc cần đọc chữ kỹ thuật → quay lại phase tương ứng.
5. **Impression test 3 giây** trên 7 bề mặt (home, sidebar đầy, 4 tab, Tin nhắn, Artifact) ở 1280×800 + 1512×982 + cửa sổ hẹp 900×700, sáng/tối: trả lời "tiêu điểm là gì, hành động chính ở đâu".
6. **Đo lại**: hit target ≥ 24px cho mọi control trong phạm vi (đo `getBoundingClientRect` qua CDP); chữ đọc ≥ 13px, meta ≥ 12px; `check:contrast` xanh; e2e baseline cập nhật lần cuối.
7. **Tài liệu**: `design.md` đọc lại từ đầu — mọi named contract khớp code; `CHANGELOG-UI.md` thêm mục "The 2026-09 friendly pass" (before/after mô tả bằng chữ, số liệu thật); `.hallmark/log.json` giữ entry Phase 1; xoá code chết (`PILL_TONE`, `trustTone` cũ, alias không dùng) nếu còn.

**DoD:** checklist §5 toàn "KHÔNG"; 5 nhiệm vụ đạt; typecheck/lint/test/contrast/e2e xanh; CHANGELOG-UI.md + design.md cập nhật.

---

## 4 · Thứ tự, phụ thuộc, khối lượng ước tính

```
P1 Nền tảng (bo góc · icon · primitive · dọn dấu vết) ──► P2 Giao diện chính ──► { P3 Tiện ích · P4 Tin nhắn + Artifact } ──► P5 Lời văn · motion · QA
                                                                                (P3 và P4 độc lập, làm thứ tự nào cũng được)
```

| Phase | Khối lượng | Rủi ro chính |
|---|---|---|
| 1 | Vừa | StatusPill phải đọc được trên mọi preset (chạy gate); gỡ gói `@nous-research/ui`; bo góc mới không phá menu/popover |
| 2 | Vừa | Điều kiện `showIntro` và e2e; thẻ việc vs luật "không bịa gợi ý"; gom nút voice/titlebar không làm mất phím tắt |
| 3 | **Lớn** | Nhiều bề mặt; "Thử ngay" phụ thuộc hàng đợi insert; bản dịch tay 24 toolset |
| 4 | Vừa–lớn | 19 hướng dẫn tiếng Việt; banner pairing cần dữ liệu ở sidebar; đổi bảng → hàng không phá test |
| 5 | Nhỏ–vừa | Sót chuỗi; baseline e2e |

Mọi quyết định §6 đã chốt — không có phase nào bị chặn.

---

## 5 · Slop-test bản app v2 (checklist nghiệm thu — mọi câu phải là **KHÔNG**)

*Giữ nguyên 32 mục của v1 (`UI-REDESIGN-PLAN.md` §5) và thêm 16 mục dưới đây. Agent tự hỏi từng câu trên từng bề mặt ở Phase 5 (và tinh thần của nó ở mọi phase).*

**Thân thiện & giọng**
33. Có từ nào trong bảng cấm §2.7 xuất hiện ở chuỗi người dùng nhìn thấy (locale `vi`) không?
34. Có chuỗi tiếng Anh nào hiện khi locale = `vi` (ngoài tên riêng, thương hiệu, tên tệp, từ "Artifact") không?
35. Có bề mặt nào mà người mới không biết bước tiếp theo trong 3 giây không?
36. Có thao tác nào chỉ làm được bằng phím tắt / Shift-click / bảng lệnh mà không có nút hoặc menu tương đương không?
37. Có nhiệm vụ nào trong 5 nhiệm vụ §3 Phase 5 cần > 3 cú nhấp không?

**Hình thức**
38. Có hành động chính nào là chữ trần < 13px không hộp không?
39. Có trạng thái trống nào thiếu một trong bốn: hình (`EmptyFigure`) · tên · vì sao · một nút không?
40. Có nhãn HOA tracking rộng nào ngoài statusbar không? Có `tracking-[…]` literal không?
41. Có icon Codicon nào ngoài transcript / terminal / editor / file-tree không? Có icon emoji không?
42. Có Tailwind ramp thô (`emerald/amber/rose/sky…`) hay hex/oklch mồ côi mới không?
43. Có minh hoạ nào không phải `EmptyFigure` (stock, blob, Lottie, ảnh AI) không?
44. Có card nào lồng card, có hàng nào < 44px trong 4 trang, có control nào hit target < 24px không?

**Hệ thống**
45. Có preset, band, accent, font hay chế độ mặc định nào bị đổi giá trị không? (phải KHÔNG — Q1, Q2)
46. Composer có đổi kích thước / số tầng không? (phải KHÔNG)
47. Settings có đổi bố cục, copy hay file không? (phải KHÔNG — chỉ thừa hưởng token)
48. Còn dấu vết pixel (Neuebit, Collapse, trái tim pixel), Codicon `robot`, hay chuỗi "Nous" trong bề mặt thuộc phạm vi không?

---

## 6 · Quyết định đã chốt (người dùng, 2026-09-06)

| # | Quyết định | Kết luận | Hệ quả trong kế hoạch |
|---|---|---|---|
| Q1 | Màu nhấn / preset mặc định | **Giữ nguyên màu hiện tại** | Không preset mới, không đổi band/accent/mode; chỉ StatusPill dùng token semantic đã có (§2.2) |
| Q2 | Font UI | **Giữ font hiện tại** (Geist · JetBrains Mono · Newsreader) | Không vendor font; chỉ đổi chỗ dùng cỡ chữ (§2.3); gỡ font pixel chết |
| Q3 | Tên gọi | **"Tiện ích"** thay "Năng lực" · **giữ "Artifact"** · **"Trò chuyện mới"** thay "Phiên mới" | Bảng §2.7; trang Artifact tự giải thích bằng mô tả + trạng thái trống |
| Q4 | Composer: gom loa/camera vào menu ⋯ chỉ hiện khi voice mode bật; nút gửi mũi tên | **Làm** | Phase 2 mục 5 |
| Q5 | Titlebar: gom "Phím tắt" + "Âm thanh" vào một nút ⋯ | **Làm** | Phase 2 mục 6 |
| Q6 | Loader đường cong toán | **Vòng mềm cho `PageLoader`**, giữ curve trong transcript | Phase 1 mục 6; §2.4 |
| Q7 | Pet pixel | **Giữ opt-in**, không làm gì đợt này | H8 không có việc |

---

## 7 · Prompt giao việc theo phase

Dán nguyên khối dưới đây cho AI coding agent, thay `{N}` bằng số phase (1–5). Thứ tự: 1 → 2 → (3, 4) → 5. Bắt đầu với `{N}` = 1.

```text
Bạn là AI coding agent thực thi nâng cấp giao diện v2 cho AgentX Workmate
(Electron + React 19 + Tailwind v4, toàn bộ công việc nằm trong apps/desktop).

NHIỆM VỤ: Thực hiện ĐÚNG và CHỈ Phase {N} trong kế hoạch apps/desktop/UI-REDESIGN-PLAN-V2.md (bản 2.1).

TRÌNH TỰ BẮT BUỘC TRƯỚC KHI SỬA CODE
1. Đọc toàn bộ apps/desktop/design.md — design system đang quản lý dự án; nguyên tắc bất biến ở đó luôn thắng.
2. Đọc apps/desktop/UI-REDESIGN-PLAN-V2.md: §0 (giao thức), §2 (định hướng + bảng thuật ngữ §2.7), phần Phase {N},
   §5 (checklist), §6 (quyết định đã chốt — áp dụng đúng, không hỏi lại, không đề xuất lại).
3. Đọc code hiện trạng của các file Phase {N} nêu ra. Nếu Phase {N} > 1: kiểm tra kết quả các phase trước đã có trong code chưa —
   chưa có thì DỪNG và báo, không tự làm bù.
4. Liệt kê danh sách file dự kiến sửa/tạo (tuyệt đối không xoá file nào) trước khi viết dòng code đầu tiên.

PHẠM VI
- Làm đủ mục "Việc chính" của Phase {N}. Không làm trước việc của phase sau, không tiện tay refactor ngoài phạm vi.
- Chỉ sửa lớp thị giác/tương tác/copy. Cấm đụng: gateway/transport, state nanostores (trừ chỗ kế hoạch nêu rõ),
  keyboard system, virtual list, logic session, parser/save MCP, pairing API. Thay đổi thị giác nào đòi sửa hành vi
  ngoài kế hoạch → dừng lại, ghi chú, hỏi tôi.
- KHÔNG đổi màu: không đụng themes/presets.ts, --theme-*, accent, DEFAULT_SKIN_NAME, normalizeMode, index.html first-paint.
- KHÔNG đổi font: không đụng --dt-font-*, DEFAULT_TYPOGRAPHY, không vendor font mới (chỉ xoá @font-face pixel chết như kế hoạch).
- KHÔNG sửa src/app/settings/** (Settings chỉ thừa hưởng token). KHÔNG đổi kích thước composer (--composer-*).
- Không xoá tính năng, không đổi kiến trúc, không đổi route/overlay ownership, không retire preset cũ.

LUẬT CHẤT LƯỢNG (tóm tắt §0 — bản đầy đủ trong kế hoạch, tuân thủ cả hai)
- Token, không literal: kể cả Tailwind ramp thô (emerald/amber…) và tracking-[…]; mọi cỡ/bo góc mới khai báo
  trong styles.css trước khi dùng; màu chỉ dùng token semantic đã có.
- Primitive sở hữu style: Button/StatusPill/PillTabs/EmptyState/Switch/Loader — không chế ở call site.
- Bảng thuật ngữ §2.7 là luật ("Tiện ích", "Trò chuyện mới", giữ "Artifact"); tiếng Việt là bản gốc; đủ mọi locale
  trong src/i18n/; dấu typography chuẩn.
- Icon: Tabler cho chrome trang; Codicon chỉ trong transcript/terminal/editor/file-tree; không emoji, không set thứ ba.
- design.md là named contract: đổi primitive/token/variant/tên gọi nào → cập nhật mục tương ứng TRONG CÙNG change.
- Cấm dấu vân tay AI và dấu vết Hermes theo §0.13 (gradient, glass, bounce, transition-all, card lồng card,
  lưới 3 card đều, minh hoạ stock/blob/Lottie, font pixel, heading nghiêng, chữ đọc < 13px, số liệu bịa, "Oops").

NGHIỆM THU (DoD của Phase {N} + các bước sau, đủ mới được coi là xong)
1. npm run typecheck && npm run lint && npm run test && npm run check:contrast (workspace apps/desktop) xanh;
   e2e baseline lệch do chủ đích → cập nhật kèm giải thích trong cùng change.
2. Chạy app (npm run dev, CDP 9222), chụp screenshot MỌI bề mặt bị ảnh hưởng ở 1280×800 và 1512×982,
   cả sáng lẫn tối (thêm prefers-reduced-motion nếu phase có motion). Điều hướng bằng location.hash
   (#/skills?tab=…, #/messaging, #/artifacts); đổi sáng/tối bằng localStorage['agentx-desktop-mode-v1'] + reload;
   khôi phục trạng thái ban đầu sau khi chụp. Đặt ảnh before/after cạnh nhau.
3. Tự soi kết quả theo checklist §5 (48 mục) — mọi câu phải trả lời được "KHÔNG".
4. Một commit/PR duy nhất cho phase; message ghi: Phase {N}, token/primitive nào đổi, bề mặt nào ảnh hưởng.

BÁO CÁO CUỐI (bắt buộc)
- Danh sách file đã sửa/tạo, đối chiếu từng mục "Việc chính": đã làm gì, ở đâu.
- Kết quả từng ý DoD: đạt/không đạt kèm bằng chứng (output lệnh, screenshot before/after).
- Chuỗi nào còn dùng fallback tiếng Anh (chưa có bản dịch tay) — liệt kê đủ.
- Điểm vênh giữa kế hoạch và code thực tế và cách bạn xử lý. Việc còn nợ hoặc câu hỏi cần tôi quyết.

Khi kế hoạch và code vênh nhau (file đã đổi tên, giá trị đã khác): giữ đúng Ý ĐỒ của kế hoạch, ghi chú điểm vênh.
Khi mơ hồ về thẩm mỹ: luôn chọn phương án ÍT trang trí hơn và NHIỀU chữ dễ hiểu hơn.

Bắt đầu: trả lời trước bằng 5–7 dòng kế hoạch làm việc của bạn cho Phase {N}
(file sẽ sửa, thứ tự làm), rồi thực hiện một mạch đến hết nghiệm thu.
```

---

## 8 · Tinh thần cuối cùng (để agent không "sáng tạo lố")

Sản phẩm này thắng bằng **sự dễ hiểu**: chữ đủ to, một tiêu điểm mỗi màn hình, mọi nút nói đúng việc nó làm, phần kỹ thuật vẫn còn nhưng nằm sau một cú bấm "Chi tiết kỹ thuật" — và màu sắc, font chữ người dùng đã quen thì giữ nguyên. Nếu đứng giữa hai lựa chọn — thêm một hiệu ứng hay bỏ một hiệu ứng — **bỏ**. Nếu đứng giữa một từ đúng kỹ thuật và một từ mẹ bạn hiểu — **chọn từ mẹ bạn hiểu**. Sau 5 phase, không ai nói "app này giống Hermes" và không ai phải hỏi "bấm vào đâu".
