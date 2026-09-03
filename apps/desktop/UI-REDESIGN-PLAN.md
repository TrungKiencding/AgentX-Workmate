<!-- Hallmark · pre-emit critique: P5 H5 E4 S5 R4 V4 · plan document (design-system evolution, no page emitted) -->
<!-- Scope: apps/desktop (AgentX Workmate). Managed project: đọc apps/desktop/design.md TRƯỚC KHI làm bất cứ việc gì. -->

# AgentX Workmate — Kế hoạch nâng cấp giao diện (UI Uplift Plan)

**Phiên bản:** 1.0 · 2026-08-26
**Phạm vi:** `apps/desktop` (renderer — sản phẩm AgentX Workmate). `web/` và `ui-tui` kế thừa token sau, ngoài phạm vi.
**Người thực thi:** AI Agent. Mỗi phase là một đơn vị giao việc độc lập, kết thúc bằng app chạy được + đã kiểm chứng bằng screenshot.

**Định hướng đã chốt (suy ra từ yêu cầu, nêu rõ để có thể chỉnh):**
- **Đối tượng:** developer / knowledge worker dùng AI agent làm việc hằng ngày, ngồi nhiều giờ trong app.
- **Việc chính của giao diện:** đưa người dùng vào cuộc hội thoại làm việc nhanh nhất, đọc kết quả dễ nhất.
- **Tone:** *modern-minimal có chính kiến* — trường phái Linear / Stripe / Raycast / Claude desktop: nền tĩnh lặng, hệ phân cấp rõ, một khoảnh khắc "người" duy nhất (lời chào serif ở màn hình trống). Không trang trí, không hiệu ứng phô diễn. Đột phá đến từ **tỷ lệ, chất liệu và nhịp** — không phải từ gradient.

---

## 0 · Giao thức cho agent thực thi (đọc trước, áp dụng cho MỌI phase)

1. **Đọc `apps/desktop/design.md` trước mỗi phase.** Đây là dự án có design system được quản lý. Kế hoạch này *tiến hoá* hệ thống đó, không thay thế. Khi kế hoạch và `design.md` vênh nhau về nguyên tắc bất biến (flat-not-boxed, one-primitive-per-concern, tokens-not-literals, motion-follows-state) → `design.md` thắng. Khi vênh về **giá trị cụ thể** (cỡ chữ, cỡ nút, màu) → kế hoạch này thắng, và agent phải **cập nhật `design.md` trong cùng một change** (luật named-contract sẵn có của dự án).
2. **Không xoá tính năng, không xoá file production, không đổi kiến trúc.** Chỉ sửa lớp thị giác/tương tác. Không đụng: gateway/transport, state (nanostores), keyboard system, virtual list, logic phiên. Nếu một thay đổi thị giác đòi sửa hành vi → dừng, ghi chú lại, hỏi người dùng.
3. **Token, không literal.** Mọi màu/cỡ/bo góc/easing mới phải khai báo thành CSS custom property trong `src/styles.css` (hoặc theme presets) rồi mới dùng. Thấy cần một giá trị chưa có token → tạo token trước, đặt tên theo hệ `--ui-*` / `--dt-*` sẵn có. Cấm hex/oklch inline trong component.
4. **Primitive sở hữu style.** Sửa cỡ nút = sửa `components/ui/button.tsx`, không sửa call site. Call site nào đang override `h-* px-* py-*` trái luật → đưa về variant/size chuẩn (dọn dần theo phase, không dọn ồ ạt).
5. **i18n ×4.** Mọi chuỗi mới/đổi phải vào đủ `en`, `ja`, `zh`, `zh-hant` (`src/i18n/`). Chuỗi tiếng Anh dùng dấu typography chuẩn: `' ' " " — …` (không dùng `'`, `--`, `...`).
6. **Kiểm chứng mỗi phase:** `npm run typecheck && npm run test` (workspace desktop) + chạy app (`npm run dev` hoặc `dev:mock`) + chụp screenshot các bề mặt bị ảnh hưởng ở **1280×800 và 1512×982, cả light lẫn dark**, tự soi theo checklist §5. E2E baseline nào lệch do chủ đích → cập nhật baseline trong cùng PR.
7. **Một phase = một PR/commit gọn.** Mô tả PR ghi rõ: token đổi gì, bề mặt nào ảnh hưởng, screenshot before/after.
8. **Thứ tự bắt buộc:** Phase 0 → 1 → 2 trước; 3–6 có thể đổi chỗ; 7–8 sau cùng; 9 chốt. Không gộp phase.
9. **Sau Phase 0**, ghi stamp vào đầu `src/styles.css`:
   `/* Hallmark · genre: modern-minimal · design-system: design.md · designed-as-app · uplift-plan: UI-REDESIGN-PLAN.md */`
   và tạo `apps/desktop/.hallmark/log.json`: `[{ "date": "<ngày>", "scope": "app", "genre": "modern-minimal", "theme": "nous-refined", "brief": "AgentX Workmate desktop UI uplift" }]`.
10. **Cấm tuyệt đối (danh sách "nhìn-là-biết-AI" — áp mọi phase):**
    - Gradient chữ (`background-clip: text`), gradient tím→xanh/tím→hồng, aurora blob, orb 3D trôi nổi.
    - Glassmorphism trang trí (blur chỉ được dùng đúng chỗ đang có: backdrop overlay).
    - Bounce/overshoot trên UI state (`cubic-bezier(.34,1.56,…)` chỉ được sống ở tương tác vật lý: thả kéo-thả, reaction pop).
    - `transition-all` (thay bằng transition liệt kê property).
    - Glow màu quanh card trên nền tối; shadow nhiều lớp mới; đổ bóng thay cho phân cấp.
    - Toast "Done!" cho hành động người dùng nhìn thấy kết quả (silent success — đã là luật dự án).
    - Emoji làm icon chức năng; icon set thứ ba (chỉ Tabler + Codicon như `design.md` quy định).
    - Heading nghiêng (italic) ở mọi cấp; emphasis bằng weight/màu, không bằng italic.
    - Số liệu bịa trong copy UI ("10× faster"…). Copy chỉ nói điều app thật sự làm.
    - Font thứ tư trong text sống. Trần: UI sans + mono + serif-outlier (§Phase 0).

---

## 1 · Chẩn đoán hiện trạng (audit có bằng chứng, ngày 2026-08-26)

Nền móng kỹ thuật **rất tốt** — vấn đề nằm ở *biểu đạt thị giác bị nén*, đúng như phản ánh "đơn điệu, ô thông tin và nút quá nhỏ, không ấn tượng".

### Nghiêm trọng (gây ra cảm giác "nhỏ, đơn điệu")

| # | Phát hiện | Bằng chứng |
|---|---|---|
| A1 | **Chữ hội thoại — bề mặt đọc chính — chỉ 13px**, tool text 11px, caption 12px | `src/styles.css:435-437` (`--conversation-text-font-size: 0.8125rem`, `--conversation-tool-font-size: 0.6875rem`) |
| A2 | **Cả app chạy ở 12px**: ~480 chỗ `text-xs`, chỉ ~24 chỗ ≥ `text-base`. Không tồn tại bậc chữ hiển thị (18/22/28px) cho tiêu đề trang/overlay | grep toàn `src/` |
| A3 | **Button mặc định 12px chữ, ~28px cao, bo 2.5px** — mọi variant đều `text-xs`; `lg` cũng chỉ ~34px | `components/ui/button.tsx:14,37-53` |
| A4 | **Nút gửi tin nhắn — nút quan trọng nhất app — chỉ 24px** (`--composer-control-size: 1.5rem`); model pill 0.68rem ≈ 11px | `styles.css:462`, `composer/controls.tsx:222-237`, `composer/index.tsx:1226` |
| A5 | **Màn hình trống = wordmark pixel + 1 dòng xám** — không lời chào, không hành động gợi ý, không ngữ cảnh gần đây | `components/chat/intro.tsx:159-184` |
| A6 | **Một tông "thì thầm" phủ toàn bộ**: hairline 3–10% alpha, text-tertiary 54%, quaternary 36% — trên màn hình thực gần như tàng hình; không bề mặt nào là tiêu điểm | `styles.css` khối `--ui-stroke-*`, `--ui-text-*` |
| A7 | **Không có font riêng** — system sans (Segoe/SF) toàn app; Neuebit chỉ xuất hiện 1 chỗ; JetBrains Mono chỉ nằm ở terminal | `themes/presets.ts:14-20`, `styles.css` `@font-face` |

### Đáng kể

| # | Phát hiện | Bằng chứng |
|---|---|---|
| B1 | `transition-all` ở 7 nơi — **ngay trong base Button** — trái chính `design.md` ("không transition-all trên hot interaction") | `button.tsx:14` + 6 file khác |
| B2 | Easing tự do rải rác: `0.16,1,0.3,1` / `0.22,1,0.36,1` / bounce `0.34,1.56` — chưa token hoá | `styles.css:1592,1917,1957,2202,2236` |
| B3 | Giọng bo góc mâu thuẫn: nút chữ 2.5px + nút icon 4px nằm trong composer bo 16px — control sắc lạnh giữa vỏ mềm | `button.tsx`, `composer/index.tsx:1117` |
| B4 | Dark theme mặc định (nous dark) là **xanh royal #0D2F86 rực** — lệch chuẩn "tinh tế"; 4/6 preset còn lại là palette hobby-terminal (cyberpunk, ember…) | `themes/presets.ts:65-91,99-277` |
| B5 | Header của Settings/section dùng đúng cỡ chữ hội thoại (13px) + icon 16px — trang cấu hình không có phân cấp tiêu đề | `settings/primitives.tsx:45` |
| B6 | Statusbar/titlebar/sidebar row đều nén ở 11–12px, hàng session không phân tầng title/meta rõ | `shell/statusbar-controls.tsx`, `sidebar/session-row.tsx` |

### Tài sản phải giữ nguyên (điểm mạnh — cấm phá)

- Kiến trúc token 3 lớp `--theme-* seeds → --ui-* → --dt-*` + `color-mix` knobs; z-ladder đặt tên; `--radius-scalar`; `shadow-nous` (bóng lớp rơi xuống rất đẹp).
- Primitive kỷ luật: một `Button`, `SearchField`, `SegmentedControl`, `ListRow`, `Loader` (đường cong toán — **bản sắc riêng, giữ**), `ErrorState`, `LogView`, `WIDGET_SHELL_CLASS`.
- IA đúng đắn: chat là nhà; overlay là việc ngắn; pane là ngữ cảnh; không tự cướp focus.
- `prefers-reduced-motion` toàn cục; focus-ring; no-native-title test; haptics; drag tự viết; i18n ×4; e2e.
- Hệ theme mở: presets + user themes + VSCode import + skin CLI parity.

---

## 2 · Định hướng thiết kế (Design direction — Phase 0 sẽ ghi vào `design.md`)

**Ý một câu:** *Nền im lặng hơn nữa, nhưng mỗi màn hình có đúng MỘT giọng nói rõ: home = lời chào, chat = composer + bài đọc, overlay = tiêu đề trang. To hơn ở đúng chỗ, không to đều.*

### 2.1 Chữ (typography)

Ba họ chữ sống trong text, không hơn (luật 2+1):

```css
/* Bundle local (offline-first, Electron không fetch CDN lúc chạy):
   - Geist (Sans) 400/500/600 — vendor woff2 vào src/fonts/ (npm: geist hoặc @fontsource)
   - Instrument Serif 400 (roman, KHÔNG italic) — chỉ 2 chỗ: lời chào home + hero onboarding
   - JetBrains Mono 400/700 — đã bundle sẵn, thăng cấp thành mono mặc định (code, kbd, path, terminal) */
--dt-font-sans: 'Geist', 'Segoe WPC', 'Segoe UI', -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif, <emoji-fallback>;
--dt-font-serif-display: 'Instrument Serif', Georgia, serif;   /* outlier — tối đa 2 slot */
--dt-font-mono: 'JetBrains Mono', Menlo, Monaco, 'SF Mono', monospace, <emoji-fallback>;
```

- Neuebit rút khỏi màn hình trống; chỉ còn sống trong `BrandMark`/About như brand plate.
- `font-display: swap`; số liệu dùng `font-variant-numeric: tabular-nums` (usage, token, thời gian).
- Theme của người dùng vẫn được override font qua pipeline hiện có — chỉ đổi *default*.

**Bậc chữ (type ramp)** — token mới trong `styles.css`, map vào Tailwind theme:

| Token | Cỡ | Dùng cho |
|---|---|---|
| `--text-2xs` | 11px | statusbar, badge, timestamp |
| `--text-xs` | 12px | caption, meta, keybind hint |
| `--text-sm` | 13px | **UI chrome mặc định**: nút, menu, sidebar, tab |
| `--text-base` | 14px | nội dung hàng: settings row label, card title phụ |
| `--text-md` | 15px | **chat prose mặc định** (`--conversation-text-font-size: 0.9375rem`, user chỉnh được như cũ) |
| `--text-lg` | 18px | tiêu đề section trong trang |
| `--text-xl` | 22px | tiêu đề overlay/page (Settings, Command Center…) |
| `--text-2xl` | 28px | lời chào home (serif) |
| `--text-3xl` | 36px | hero onboarding/update |

Line-height: chrome 1.4 · prose 1.6 · display 1.15–1.25. Tracking: `-0.01em` từ 18px, `-0.02em` từ 28px. **Sàn:** không chữ nào < 11px; nội dung đọc ≥ 14px; đo dòng prose ≤ 72ch.

### 2.2 Màu (OKLCH hoá, giữ hồn Nous blue)

- **Accent duy nhất:** Nous blue `#0053FD` → chuyển token gốc sang OKLCH (≈ `oklch(50% 0.27 264)` — agent convert chính xác). Hover −4% L, active −7% L. Accent là bút dạ quang: active state, focus ring, primary button, arc-đang-chạy — **không** phủ nền lớn.
- **Light (mặc định):** paper `oklch(98.5% 0.004 262)`, sidebar thấp hơn ~1%, card trắng gần tinh `oklch(99.4% 0.002 262)`. Neutrals pha 0.003–0.006 chroma về hue 262 (cấm xám 0-chroma).
- **Dark mặc định mới — "Graphite":** nền `oklch(17% 0.012 262)`, sidebar 15%, card 20%, elevated 23% — **elevation bằng độ sáng (+3%/bậc), không glow**. Chữ 93% L. Dark royal-blue hiện tại giữ nguyên thành preset "Nous Classic" (không mất gì của người thích nó).
- **Semantic:** success `oklch(64% 0.14 155)` · danger giữ `#CF2D56` (OKLCH hoá) · warning `oklch(75% 0.12 80)`; mỗi màu định nghĩa cặp `-foreground` đạt APCA Lc ≥ 60.
- **Độ nhìn thấy:** nâng knob sẵn có — `--ui-text-tertiary` 54%→60%, `--ui-text-quaternary` 36%→44%, stroke-tertiary mix 5%→8% (hairline phải *thấy được* trên màn thường, vẫn mảnh).

### 2.3 Hình khối & chất liệu

- **Bo góc một giọng:** control 6px · card/widget 10px · overlay/popover 12px · composer giữ 16px. (Chỉnh qua hệ `--radius-*` sẵn có; retire 2.5px/4px lệch.)
- **Chiều cao control:** token mới `--control-h-sm: 28px · md: 32px · lg: 36px · xl: 40px`. Input = button cùng hàng thì cùng cao (luật no-layout-shift: border 1px cố định mọi state, focus bằng outline).
- **Đổ bóng:** giữ đúng bộ `--shadow-xs/sm/md/nous` — không thêm bóng mới; dark mode ưu tiên sáng-hơn-thay-vì-bóng.

### 2.4 Chuyển động

Token hoá và chỉ dùng:

```css
--ease-out: cubic-bezier(0.16, 1, 0.3, 1);
--ease-in: cubic-bezier(0.7, 0, 0.84, 0);
--ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);
--dur-micro: 100ms;  /* press, toggle, màu */
--dur-short: 200ms;  /* hover, menu, tooltip */
--dur-long: 320ms;   /* overlay, entrance */
```

Exit ≈ 75% enter. Spring chỉ cho tương tác vật lý (thả drag, reaction pop — giữ). Focus ring hiện **tức thời**, không bao giờ transition. Mỗi bề mặt ≤ 3 primitive chuyển động. Reduced-motion toàn cục đã có — giữ.

---

## 3 · Các phase

> Mỗi phase: **Mục tiêu → Việc chính → File đụng tới → Definition of Done (DoD) → Guardrails.** Agent làm xong DoD mới được sang phase sau.

---

### Phase 0 — Nền móng: token, font, `design.md`

**Mục tiêu:** đặt toàn bộ token của §2 vào codebase, chưa đổi layout. App sau phase này chỉ khác: font Geist, chữ chrome 12→13px, bo góc nút thống nhất tạm thời.

**Việc chính**
1. Vendor font: Geist 400/500/600 + Instrument Serif 400 (woff2, license OFL — ghi vào `src/fonts/README` nếu có tiền lệ), `@font-face` trong `styles.css` cạnh JetBrains Mono hiện có.
2. Thêm khối token vào `:root` của `styles.css` (append đúng chỗ, **không** clobber file): type ramp `--text-*`, `--control-h-*`, `--ease-*`, `--dur-*`; OKLCH hoá `--theme-*` seeds light; chỉnh knob text/stroke (§2.2); map vào `@theme inline` để Tailwind ăn (`--text-*`, `--font-*`).
3. `--dt-font-sans/mono` đổi default (Geist / JetBrains Mono); thêm `--dt-font-serif-display`. `themes/presets.ts`: `DEFAULT_TYPOGRAPHY` cập nhật; `themes/types.ts` thêm field optional (không breaking cho user themes/VSCode import — có fallback).
4. Đổi `--conversation-text-font-size` 0.8125rem → 0.9375rem; `--conversation-tool-font-size` 0.6875 → 0.75rem; `--conversation-caption-font-size` 0.75 → 0.8125rem.
5. Ghi stamp + `.hallmark/log.json` (§0.9). Cập nhật `design.md`: mục "Tokens", "Typography", "Motion" mới.

**File:** `src/styles.css`, `src/fonts/*`, `src/themes/presets.ts`, `src/themes/types.ts`, `design.md`.

**DoD:** typecheck + tests xanh; app render đủ light/dark; font Geist hiển thị (kiểm tra glyph tiếng Việt — Geist hỗ trợ Latin mở rộng, xác nhận bằng screenshot chuỗi "Tiếng Việt đầy đủ ăằẳẵắặâầẩẫấậêềểễếệôồổỗốộơờởỡớợưừửữứựđ"); không còn fetch font CDN lúc runtime cho default theme; mọi token mới có comment 1 dòng nói nó dùng cho gì.

**Guardrails:** không đổi component nào ngoài chỗ token chạm tới; user theme cũ load lên không vỡ (test `themes/*.test.ts` phải xanh, thêm case cho field mới).

---

### Phase 1 — Control tự tin: Button, Input, Composer controls

**Mục tiêu:** xoá cảm giác "nút quá nhỏ". Control mặc định 32px/13px, bo 6px, đủ 8 trạng thái.

**Việc chính**
1. `components/ui/button.tsx` — ramp mới (giữ nguyên tên variant/size để call site không vỡ):
   - base: `text-sm(13px) font-medium rounded-[6px]`, bỏ `transition-all` → `transition-[background-color,border-color,color,box-shadow,transform] duration-(--dur-micro)`; `:active` `translate-y-px`; focus ring giữ cơ chế hiện tại (tức thời).
   - `default`: `h-(--control-h-md) px-3.5` (32px) · `sm`: `h-(--control-h-sm) px-3` (28px) · `lg`: `h-(--control-h-lg) px-4 text-base` (36px) · **mới `xl`**: `h-(--control-h-xl) px-5 text-base` (40px — CTA onboarding/dialog chính) · `xs`: giữ cho ngữ cảnh dense thật sự (statusbar) nhưng nâng chữ 11→12px.
   - icon: `icon-xs` 24 → dành riêng inline; `icon-sm` 28; `icon` 32; `icon-lg` 36; đồng bộ `rounded-[6px]`.
   - Thêm prop/pattern `loading` (spinner thay label trong nút, giữ width — không đổi layout).
2. `components/ui/control.ts` (`controlVariants`): input/textarea/select cao bằng button cùng bậc; border 1px cố định; focus = outline 2px accent offset 1px; giữ knob `--dt-input-*`.
3. Composer (`app/chat/composer/controls.tsx`, `styles.css:462`): `--composer-control-size` 1.5rem → **2rem (32px)**; nút gửi = nút primary tròn 32px, icon 16px; hàng control gap thoáng hơn (`--composer-control-gap` kiểm tra và nâng nếu < 6px); model pill lên 12px chữ, cao 24→28px.
4. Quét call site override trái luật (`h-* px-* py-*` đè lên Button/Input) — sửa về variant đúng; chạy test `no-native-title` + toàn bộ unit tests.
5. `SegmentedControl`, `Switch`, `SearchField`: nâng đồng bộ theo `--control-h-*` (SearchField giữ ngôn ngữ borderless-underline).

**File:** `components/ui/button.tsx`, `components/ui/control.ts`, `components/ui/switch*`, `segmented*`, `search-field*`, `app/chat/composer/controls.tsx`, `styles.css`, `design.md` (mục Buttons — bảng size mới).

**DoD:** không còn `transition-all` trong `components/ui/` và `composer/`; mọi control mặc định ≥ 28px, primary flow ≥ 32px; screenshot composer trước/sau; 8 trạng thái Button demo được (viết story/test snapshot nếu dự án có tiền lệ, không thì screenshot đủ default/hover/focus/active/disabled/loading).

**Guardrails:** `icon-titlebar` giữ nguyên (chrome hệ điều hành); không phá dense-mode compact variant của sidebar; không đổi hành vi phím.

---

### Phase 2 — Chất liệu & chiều sâu: bề mặt, viền, dark "Graphite"

**Mục tiêu:** hết "phẳng một màu". Ba lớp nền phân biệt được; viền thấy được; composer là tiêu điểm của màn chat.

**Việc chính**
1. Áp giá trị §2.2: chỉnh seeds + knobs trong `styles.css` (light) và khối `.dark` (Graphite mới). Dark elevation: card/popover/elevated tăng L +3%/bậc — kiểm mọi popover/menu/dialog trên dark không còn viền tàng hình.
2. Preset "Nous Classic" (dark royal-blue cũ) thêm vào `themes/presets.ts`; default dark trỏ Graphite. `DEFAULT_SKIN_NAME` giữ `nous`.
3. Composer nổi bật đúng mực: at-rest viền `--ui-stroke-secondary`; focus-within: ring accent mảnh (cơ chế `--composer-ring-strength` sẵn có — tune) + `--shadow-composer` nâng 1 bậc. **Không glow màu.**
4. Focus ring toàn app: chuẩn 2px accent, offset 1–2px, kiểm trên cả nền accent (ring phải đạt 3:1 với cả nút lẫn nền — nếu trùng màu nút primary, dùng ring 2 lớp trắng/accent như Radix pattern sẵn có).
5. Scrollbar, text selection (`--ui-selection-background`), sash hover — tinh chỉnh theo palette mới.

**File:** `styles.css`, `themes/presets.ts`, `app/chat/composer/index.tsx`, `design.md` (mục Surfaces & elevation).

**DoD:** bảng contrast APCA/WCAG cho các cặp chủ chốt (text-primary/secondary/tertiary trên paper+sidebar+card, primary-foreground trên primary, danger pair, light+dark) — tự tính và dán vào PR, mọi cặp body ≥ 4.5:1, boundary ≥ 3:1; screenshot 3 lớp nền phân biệt được ở cả 2 mode.

**Guardrails:** không thêm shadow mới ngoài bộ có sẵn; terminal (`--ui-terminal-surface-background`) đi theo transcript như cũ; xterm probe màu (`terminal/selection.ts`) phải resolve được — chạy thử terminal.

---

### Phase 3 — Home surface: lời chào & khởi động nhanh

**Mục tiêu:** màn hình trống thành khoảnh khắc "người" của sản phẩm — chuẩn Claude desktop / Arc: chào theo thời điểm, gợi ý bước tiếp theo **từ dữ liệu thật**.

**Việc chính**
1. Viết lại `components/chat/intro.tsx`:
   - Dòng 1: **lời chào serif** (`--dt-font-serif-display`, `--text-2xl`, roman): "Chào buổi sáng/chiều/tối" + tên (từ profile nếu có; không có tên → bỏ, không bịa). i18n ×4 (mỗi locale có mẫu chào tự nhiên riêng, không dịch máy).
   - Dòng 2: body 14px muted — tái dùng kho `intro-copy.jsonl` (personality-aware, giữ nguyên cơ chế seed).
   - Wordmark Neuebit: gỡ khỏi intro (Neuebit ở lại BrandMark/About).
2. **Hàng chip khởi động** (mới, dưới lời chào, pointer-events bật):
   - Tối đa 4 chip, `h-9 rounded-full text-sm`, icon Tabler 16px, hover đổi nền+viền, focus-visible chuẩn.
   - Nguồn **dữ liệu thật**: ① Tiếp tục "<tên session gần nhất>" (session index sẵn có) ② Dự án gần đây (Sidebar → Projects) ③ 1–2 starter cố định do product duyệt, lấy từ i18n (không sinh động cơ AI bịa). Không có dữ liệu → chỉ hiện starter; đang onboarding → ẩn hàng chip.
   - Click chip = đúng một action sẵn có (resume session / new chat với cwd project / điền composer). Không thêm state mới ngoài atom nhỏ nếu cần.
3. **Một entrance duy nhất:** chào fade+rise 8px 320ms `--ease-out`, chip stagger 40ms/cái, tổng < 500ms, chạy **một lần mỗi lần mở app** (không chạy lại khi chuyển session); reduced-motion → crossfade 150ms.
4. Composer vẫn là CTA duy nhất — bố cục dẫn mắt từ lời chào xuống composer. Căn giữa cụm là chấp nhận được (đây là canvas-là-thiết-kế), nhưng lời chào **không** all-caps, không tracking rộng.

**File:** `components/chat/intro.tsx` (+ test), `components/assistant-ui/thread/index.tsx` (chỗ gắn `emptyPlaceholder` — bỏ `pointer-events-none` cho vùng chip), `src/i18n/{en,ja,zh,zh-hant}.ts`, atom nhỏ nếu cần trong `src/store`, `design.md` (mục Chat & boot surfaces).

**DoD:** screenshot 4 trạng thái: có tên + có session gần đây / không tên / lần đầu (chỉ starter) / reduced-motion; i18n đủ 4; chip điều hướng đúng (test unit cho nguồn dữ liệu chip); không auto-focus cướp bàn phím ngoài composer (luật sẵn có).

**Guardrails:** không gọi network mới; không thêm "AI suggestions" động (ngoài phạm vi); serif chỉ ở đây + onboarding (slot outlier đã dùng 1/2).

---

### Phase 4 — Điều hướng: sidebar, titlebar, statusbar

**Mục tiêu:** chrome đọc được ngay cấu trúc: đâu là nhóm, đâu là active, đâu là đang chạy.

**Việc chính**
1. Sidebar (`app/chat/sidebar/*`):
   - Section label: 11px, `font-medium`, tracking `0.06em`, text-tertiary(mới 60%) — nhãn *thấy được* nhưng lùi lại.
   - Session row: cao 32px; title 13px medium (đang working → foreground như cũ); meta/timestamp 11px tertiary; active row = nền `--ui-row-active-background` **+ thanh accent 2px cạnh trái** (rõ hơn nền-mờ-đơn-độc hiện tại); giữ nguyên arc-đang-chạy, drag, prewarm, middle-click.
   - Kebab hover-reveal giữ; nâng vùng hit lên 24px.
   - Profile switcher + nút New chat: theo ramp control mới.
2. Titlebar (`app/shell/titlebar-controls.tsx`, tabs): tab active tách nền theo `--ui-tab-hover-darken` logic sẵn có, kiểm với palette mới; icon-titlebar giữ.
3. Statusbar (`app/shell/statusbar-controls.tsx`): cao 26px, chữ 11px sàn, `tabular-nums` cho số (token/context %); màu semantic mới cho cảnh báo.
4. Right-rail/pane tab (`app/chat/right-rail`, `components/pane-shell`): đồng bộ cỡ tab 13px, active rõ.

**File:** như trên + `styles.css`, `design.md` (mục Layout nếu chạm `PAGE_INSET`… — không đổi trừ khi cần).

**DoD:** screenshot sidebar đủ trạng thái (active/hover/working/needs-input/drag); virtual list vẫn mượt với 200+ session (chạy `dev:mock` hoặc fixture e2e lớn sẵn có); keyboard nav không đổi.

**Guardrails:** không đổi cấu trúc section/order logic; không thêm divider giữa row (luật flat); compact variant (`@custom-variant compact`) phải được kiểm ở cửa sổ thấp.

---

### Phase 5 — Overlay & pages: Settings, Command Center, pickers ("ô thông tin")

**Mục tiêu:** các trang cấu hình/thông tin có phân cấp thật: tiêu đề trang 22px, hàng thoáng, control chuẩn — hết cảm giác "ô thông tin nhỏ lép".

**Việc chính**
1. `app/overlays/overlay-view.tsx` + `overlay-split-layout.tsx`: chuẩn hoá header block — page title `--text-xl(22px) font-semibold tracking-[-0.01em]`, mô tả 13px muted, hàng action phải; sườn `OverlaySidebar` item 13px/32px.
2. Settings (`app/settings/primitives.tsx`):
   - `SectionHeading`: 15px semibold + icon 18px (thay 13px hiện tại), khoảng cách trên 24px/dưới 12px (nhịp không đều chủ đích).
   - `ListRow`: min-height 44px; label 14px; description 12.5px tertiary; control bên phải theo ramp mới; giữ flat không viền giữa hàng.
3. Command Center + các page (`app/command-center`, `skills`, `artifacts`, `agents`, `cron`, `profiles`, `learning`, `messaging`, `webhooks`): áp cùng header block + `PAGE_INSET_X`/`PAGE_MAX_W` sẵn có; card/tile trong trang: radius 10px, padding 16–20px, title 14px semibold, **một** cấp viền (`--ui-stroke-tertiary`) — cấm card-in-card; số liệu nếu có → `tabular-nums`, cho phép đúng **một** con số lớn (24–28px) mỗi trang làm anchor — số thật từ dữ liệu, không bịa.
4. Command palette (`app/command-palette`, cmdk): mở **tức thời** không animation; row 36px, text 13px; selection indicator trượt `translateY` 120ms `--ease-out` (kiểu Linear/Raycast); footer hint 11px.
5. Model picker / session picker / dialogs (`components/model-picker.tsx`, `session-picker.tsx`, `prompt-overlays.tsx`, updates/install/gateway overlays): đồng bộ title 18–22px, nút `lg/xl`, spacing mới. Boot chain (connecting → onboarding → setup → crash) giữ ngữ nghĩa recovery, chỉ nâng type/spacing; hero onboarding được dùng slot serif thứ 2/2.
6. `EmptyState`/`PanelEmpty`/`ErrorState`: chuẩn 3 nhịp copy — dòng gọi tên (14px medium), dòng vì-sao (13px muted), một nút hành động (`default` 32px). Rà toàn bộ copy theo chuẩn động từ (`copy.md` spirit): nút = động từ cụ thể, lỗi = what/why/how-to-fix, không "Oops".

**File:** như liệt kê + i18n ×4 cho copy chỉnh, `design.md` (mục Feedback states + Layout).

**DoD:** screenshot Settings (2 trang), Command Center, palette, model picker — before/after; không hàng nào < 40px trong settings; palette mở < 1 frame perceived (không animation entry).

**Guardrails:** không đổi cấu trúc route/overlay ownership; Esc/close-x giữ luật; không thêm tooltip cho kebab (luật sẵn có).

---

### Phase 6 — Transcript & tool cards: trải nghiệm đọc

**Mục tiêu:** cuộc hội thoại đọc như tài liệu tốt: prose 15px/1.6, tool card gọn mà rõ, code block chuẩn editor.

**Việc chính**
1. Prose: xác nhận `--conversation-text-font-size` 15px (đã đổi P0) chảy đúng vào markdown (`markdown-text.tsx`, typography plugin); heading trong markdown theo ramp (h1 trong chat ≈ 18px, h2 16px — chat không cần to hơn); measure ≤ 72ch (kiểm `--composer-width`/cột transcript); list/blockquote/spacing nhịp 4pt.
2. User bubble: nền `--ui-chat-bubble-*` theo palette mới, radius 10px, padding 10×14px; metadata 11px.
3. Tool cards & scaffold (`assistant-ui/tool/*`, `thread/status.tsx`, `timeline.tsx`): scaffold text dùng token sẵn có (đã nâng độ sáng P0); tool card = `WIDGET_SHELL_CLASS` radius 10, tên tool 13px medium + path mono 12px tertiary; trạng thái chạy/xong/lỗi bằng icon + màu semantic (không chỉ màu — kèm glyph); diff dùng `--ui-diff-*` (kiểm APCA với palette mới).
4. Code block: JetBrains Mono 12.5px/1.55; header mảnh: label ngôn ngữ 11px mono + nút copy `icon-sm`; copy feedback = label đổi "Copied ✓" 2s (không toast). Không vẽ fake window chrome (chấm đỏ vàng xanh) — đang không có, cấm thêm.
5. Artifact card / clarify widget (`artifact-card.tsx`, `clarify-tool.tsx`): theo widget shell chuẩn, action nằm ngoài panel (luật sẵn có), nút theo ramp mới.
6. Kiểm streaming: `use-stick-to-bottom`, shimmer (`tw-shimmer`) — shimmer chỉ trên placeholder đang stream, không trang trí.

**File:** `components/assistant-ui/**`, `styles.css` (khối conversation), `design.md` (mục Chat, tools & boot surfaces).

**DoD:** một transcript dài thật (fixture e2e `large-session-resume` sẵn có) đọc mượt, screenshot; đo lại perf render (không regression theo `perf-probe`/`npm run perf` nếu chạy được); mọi trạng thái tool (running/success/error/cancelled) có glyph + màu.

**Guardrails:** không fork renderer thứ hai (luật); `transcript-window` windowing giữ nguyên; không animate layout khi stream.

---

### Phase 7 — Chuyển động & vi tương tác (quét toàn app)

**Mục tiêu:** mọi chuyển động dùng token, đúng ngữ nghĩa; app cảm giác "ăn tay" chứ không "nhiều hiệu ứng".

**Việc chính**
1. Thay 7 chỗ `transition-all` còn lại; quét `duration-*` ad-hoc → `--dur-*`; quét cubic-bezier rải rác → `--ease-*` (giữ 2 spring vật lý: pet-reveal, reaction-pop — token hoá tên riêng `--spring-pop`).
2. Recipe chuẩn (ghi vào `design.md`): hover = đổi nền/viền 200ms; press = translate-y 1px 100ms; menu/popover mở 180ms `--ease-out`, đóng 140ms `--ease-in`; dialog scale 0.98→1 + fade 240ms, đóng 180ms; toast trượt vào 320ms không đẩy layout.
3. Tooltip: hover delay 200ms hiện tại → nâng 500ms cho icon chrome (đỡ nhấp nháy khi quét chuột), focus = 0ms (giữ); kiểm `skipDelayDuration` logic sẵn có.
4. Silent-success sweep: rà mọi toast/notification — hành động thấy được kết quả thì im lặng; lỗi luôn có hành động (retry/undo). Hành động đảo ngược được → optimistic + Undo (pattern sẵn có, mở rộng nơi còn confirm thừa; confirm chỉ giữ cho destructive thật — restore/delete đã đúng).
5. Kiểm từng bề mặt ≤ 3 primitive động; bỏ mọi loop vô hạn ngoài Loader/caret/streaming.

**File:** toàn `src/` (sweep có kiểm soát), `design.md` (mục Motion — bảng recipe).

**DoD:** `grep -r "transition-all" src/` = 0; `grep -rn "cubic-bezier" src/` chỉ còn token định nghĩa; video/gif ngắn 3 tương tác chính (mở palette, gửi tin, mở settings) đính PR; reduced-motion vẫn phủ (bật `prefers-reduced-motion` chụp lại).

**Guardrails:** không animate layout property; không đụng logic cancel/keyboard; hot path (composer typing, stream) không thêm transition.

---

### Phase 8 — Theme 2.0: hệ preset tinh tế

**Mục tiêu:** bộ theme mặc định đạt chuẩn big-tech, pipeline theme người dùng không vỡ.

**Việc chính**
1. Rebuild presets trên OKLCH + axis metadata (paper-band/display/accent ghi comment từng theme): **Nous** (light, refined — mặc định) · **Graphite** (dark mặc định) · **Nous Classic** (dark royal cũ) · **Midnight** (tím than — tinh chỉnh contrast) · **Slate** · **Mono** · **Ember**, **Cyberpunk** giữ như "fun skins" nhưng sửa các cặp màu fail contrast (cyberpunk mutedForeground 1a8a30 trên 000a00 ≈ quá thấp — nâng).
2. Script kiểm contrast tự động: node script nhỏ (đặt `scripts/check-theme-contrast.mjs`) tính WCAG/APCA cho các cặp bắt buộc của mọi preset (foreground/background, muted/bg, primary pair, destructive pair, border/bg ≥ 3:1) — chạy trong `npm run check`; fail = build đỏ.
3. Kiểm VSCode import + user themes + skin CLI parity với field typography/token mới (fallback đủ); cập nhật test `REST parity`/`skin`.
4. (Stretch — làm nếu còn thời gian) Accent picker: cho phép người dùng đổi accent trên preset Nous/Graphite (cơ chế `--theme-midground`/seed đã sẵn — chỉ thêm UI nhỏ trong Settings → Appearance).

**File:** `themes/*`, `scripts/check-theme-contrast.mjs`, settings appearance page, `design.md`.

**DoD:** script contrast xanh cho cả 8+ preset ở cả light/dark variant; screenshot lưới 8 theme (cùng một màn chat) — nhìn phân biệt rõ, không theme nào "bể" chữ.

**Guardrails:** không retire tên theme cũ (persisted name phải resolve — cơ chế `DEFAULT_SKIN_NAME` fallback sẵn có); không đổi format lưu user theme.

---

### Phase 9 — QA chốt: "Impression pass" + slop-test bản app

**Mục tiêu:** nghiệm thu toàn cục bằng checklist §5, sửa hết vi phạm, đồng bộ tài liệu.

**Việc chính**
1. Chạy đủ checklist §5 trên 6 bề mặt: Home trống · Chat đang stream · Sidebar đầy · Settings · Command palette · Onboarding — mỗi bề mặt ở 1280×800 + 1512×982 + cửa sổ hẹp 900×700, light + dark, reduced-motion on/off.
2. **Impression test 3 giây** (mỗi bề mặt): mở lên trong 3 giây trả lời được — *tiêu điểm là gì? hành động chính ở đâu?* Không trả lời được → quay lại phase liên quan.
3. Sửa mọi finding; cập nhật e2e screenshot baselines lần cuối; `design.md` đọc lại từ đầu — mọi named contract khớp code.
4. Viết `apps/desktop/CHANGELOG-UI.md` tóm tắt trước/sau (kèm ảnh) cho người dùng.

**DoD:** checklist §5 toàn "pass"; typecheck/test/lint/e2e xanh; CHANGELOG-UI.md có ảnh before/after từng bề mặt.

---

## 4 · Thứ tự, phụ thuộc, khối lượng ước tính

```
P0 Nền móng ──► P1 Controls ──► P2 Chất liệu ──► { P3 Home · P4 Điều hướng · P5 Overlays · P6 Transcript }  ──► P7 Motion ──► P8 Themes ──► P9 QA
                                                   (4 phase giữa làm tuần tự bất kỳ, khuyến nghị đúng thứ tự 3→6)
```

| Phase | Khối lượng | Rủi ro chính |
|---|---|---|
| 0 | Vừa | Tailwind `@theme` mapping; user theme fallback |
| 1 | Vừa | Call site override rải rác; e2e baseline |
| 2 | Vừa | Contrast dark; xterm color probe |
| 3 | Vừa | i18n chào tự nhiên 4 ngữ; nguồn dữ liệu chip |
| 4 | Nhỏ–vừa | Virtual list perf |
| 5 | **Lớn** (nhiều trang) | Sót trang; copy sweep i18n |
| 6 | Vừa–lớn | Perf transcript dài |
| 7 | Vừa (sweep) | Regression tinh vi |
| 8 | Vừa | Parity CLI/VSCode themes |
| 9 | Nhỏ | — |

---

## 5 · Slop-test bản app (checklist nghiệm thu — mọi câu phải là **KHÔNG**)

*Chuyển thể từ 58 gate của Hallmark cho ngữ cảnh desktop app. Agent tự hỏi từng câu trên từng bề mặt ở Phase 9 (và tinh thần của nó ở mọi phase).*

**Thị giác**
1. Có gradient chữ, gradient tím→xanh/hồng, aurora blob, orb 3D ở đâu không?
2. Có glassmorphism trang trí (blur không phục vụ lớp phủ) không?
3. Có bề mặt dùng #000/#fff thuần làm nền diện rộng không (ngoài BrandMark plate được phép)?
4. Có xám 0-chroma trong token mặc định không?
5. Accent có phủ > ~5% một viewport không (đếm fill lớn, không đếm text/icon)?
6. Có card lồng card, viền-stripe dày một cạnh, glow màu quanh card trên dark không?
7. Heading có chữ nghiêng ở đâu không?
8. Có > 3 họ chữ trong text sống không? Serif outlier có xuất hiện quá 2 chỗ (home + onboarding) không?

**Kích cỡ & phân cấp**
9. Còn chữ nội-dung < 14px, chữ chrome < 12px, hay chữ bất kỳ < 11px không?
10. Còn control tương tác < 24px, control primary-flow < 32px, hit target < 24px không?
11. Mở từng bề mặt 3 giây: có bề mặt nào KHÔNG chỉ ra được tiêu điểm + hành động chính không?
12. Prose có cột đo > 72ch, hay line-height < 1.5 không?
13. Số liệu dạng cột/đếm có thiếu `tabular-nums` không?

**Chuyển động**
14. Còn `transition-all`, easing browser mặc định (`ease`), hay cubic-bezier ngoài token không?
15. Có bounce/overshoot trên UI state (ngoài 2 spring vật lý được phép) không?
16. Focus ring có bị animate lúc xuất hiện không? Có element tương tác thiếu `:focus-visible` không?
17. Bề mặt nào có > 3 primitive chuyển động, hay loop vô hạn ngoài Loader/caret/stream không?
18. Tooltip focus có bị delay không (phải 0ms)?
19. Tắt `prefers-reduced-motion` — có motion không gian nào còn chạy quá crossfade 150ms không?

**Hành vi & phản hồi**
20. Có toast chúc mừng cho hành động thấy được kết quả không?
21. Có confirm dialog cho hành động đảo ngược được (đáng lẽ optimistic + Undo) không?
22. Lỗi nào hiển thị mà thiếu 1 trong 3: chuyện gì / vì sao / làm gì tiếp?
23. Empty state nào thiếu 3 nhịp (tên — vì sao — một nút) không?
24. Có trạng thái chỉ báo hiệu bằng màu (thiếu icon/text) không?
25. Nút nào còn nhãn mơ hồ ("OK", "Submit") thay vì động từ cụ thể không?
26. Có chuỗi UI nào bịa số liệu/tên placeholder (Jane Doe, Acme) không?

**Kỷ luật hệ thống**
27. Có hex/oklch/px "mồ côi" trong component (không qua token) mới thêm không?
28. Có icon emoji, hay icon set thứ ba ngoài Tabler+Codicon không?
29. Bo góc có lệch khỏi thang 6/10/12/16 không?
30. Contrast: cặp text nào < 4.5:1 (body) / 3:1 (large/boundary/focus-ring) ở BẤT KỲ theme mặc định nào không? (chạy `scripts/check-theme-contrast.mjs`)
31. Chuỗi mới nào thiếu 1 trong 4 locale, hay dùng `'` `--` `...` thay dấu chuẩn không?
32. `design.md` có mục nào đang tả sai code sau phase này không?

---

## 6 · Tinh thần cuối cùng (để agent không "sáng tạo lố")

Sản phẩm này thắng bằng **sự tự tin trầm tĩnh**: nền lặng, chữ đủ lớn, một tiêu điểm mỗi màn hình, một khoảnh khắc serif duy nhất khi mở app, mọi phản hồi tức thời và trung thực. Nếu đứng giữa hai lựa chọn — thêm một hiệu ứng hay bỏ một hiệu ứng — **bỏ**. Nếu một chi tiết khiến người xem thốt "đẹp" mà không giải thích được nó giúp gì cho việc dùng — cắt. Đột phá nằm ở chỗ: sau toàn bộ 10 phase, không ai nói "app này trang trí đẹp"; họ nói *"app này nhìn ra là đồ xịn, và tay mình thao tác sướng hơn hẳn."*
