# Kế hoạch tích hợp WebMate vào bộ cài AgentX Workmate (không dùng Chrome Web Store)

Bản đặc tả đã chốt, giữ nguyên nội dung ở đây để mọi giai đoạn tra cùng một nguồn.
Kho WebMate: `AgentX-WebMate` (extension Chrome MV3 + MCP server). Kho Workmate: kho này
(`apps/desktop` Electron + backend Python `hermes_cli/`). Hợp đồng dữ liệu chi tiết ở phía
WebMate: `docs/workmate-integration.md` của kho đó.

## 0. Bối cảnh và mục tiêu

Trước giai đoạn 0, Workmate chỉ "gắn" WebMate ở tầng thấp nhất: một mục catalog kiểu `git`
(`optional-mcps/webmate/manifest.yaml`) clone kho WebMate về `~/.agentx/mcp-installs/webmate`
rồi chạy `npm ci` + `npm run build` trên máy khách, spawn `node` trần. Ứng dụng desktop không
có UI nào cho WebMate. Extension chưa có `key` (ID đổi theo đường dẫn), `hello` không mang phiên
bản hay token, chưa có lệnh reload từ xa, chưa có feed phát hành. Trên máy sạch, người dùng cài
Workmate xong không có WebMate và không được báo gì.

Mục tiêu sản phẩm (ba yêu cầu của chủ dự án):
1. Cài Workmate xong (Windows và macOS) hiện một bước "Kết nối trình duyệt": quét trình duyệt
   trên máy, hỏi cài WebMate vào trình duyệt nào, cài xong là hai bên nối luôn.
2. Bỏ qua lúc đầu thì trong Cài đặt vẫn bật/tắt và cài được, theo mẫu tính năng "Claude in
   Chrome" của Claude Code.
3. WebMate có bản mới thì Workmate báo và cài được, giống cơ chế báo bản mới của chính Workmate.

Quyết định đã chốt (không mở lại):
- **Không** đưa extension lên Chrome Web Store hay Edge Add-ons. **Không** ghi chính sách trình
  duyệt (registry `Software\Policies`, plist, MDM). **Không** dùng `--load-extension` cho profile
  chính của người dùng. **Không** ghi vào tệp cấu hình của Chrome (chỉ đọc).
- Cách cài cho trình duyệt của người dùng: nạp kiểu *unpacked* từ một thư mục do Workmate sở
  hữu. Người dùng làm đúng hai thao tác một lần: bật Developer mode và kéo thư mục vào trang
  `chrome://extensions` (hoặc Load unpacked). Cơ sở: Chromium đã gỡ hộp "Disable developer mode
  extensions" từ 28/11/2023 (Chrome 121+); `InstallVerifier` miễn kiểm extension unpacked;
  Workmate mở được `chrome://extensions` từ dòng lệnh cho đúng profile.
- Đường thứ hai, không thao tác: "Cửa sổ trình duyệt Workmate" chạy chính Chrome/Edge có trên
  máy với profile riêng và nạp extension qua CDP `Extensions.loadUnpacked`.
- Bước cài là một bước trong onboarding ngay sau xác nhận model, ba lối ra: trình duyệt của tôi
  · cửa sổ riêng · để sau.
- Feed bản mới: tệp `release.json` trên nhánh `main` kho WebMate (GitHub), ký Ed25519.
- Ngoài phạm vi: gói doanh nghiệp, Firefox, native messaging. Không đề xuất lại.

## 1. Ràng buộc bắt buộc

1. **Kho WebMate: Chrome trên máy phát triển đang nạp `brand-dist/chrome` làm extension
   unpacked.** `npm run brand:build` và `npm test` ghi đè toàn bộ thư mục đó. `writeAtomic` đã
   có nên được phép chạy, nhưng tuyệt đối không chạy `brand:clean`, và sau mỗi lần build phải
   Reload extension trong chrome://extensions.
2. **Kho Workmate: có tiến trình `agentx update` chạy nền tự `git stash` + `reset --hard`
   working tree vài phút một lần.** Làm trên nhánh riêng, commit sớm và thường xuyên, không chạy
   `agentx update`. Nếu tệp biến mất: `git stash list`, tìm `agentx-update-autostash-<timestamp>`,
   `git stash pop`. Nếu `node_modules` bị prune: `npm install` ở gốc kho.
3. Giữ nguyên chuỗi `client: "webbrain-extension"` trong `hello`. Đổi là mọi handshake bị từ chối.
4. Đường dev phải tiếp tục chạy: extension nạp từ `brand-dist/chrome` **không có** `workmate.json`
   vẫn quay số về mặc định `ws://127.0.0.1:17374/extension`; MCP server **không có**
   `pairing.json` vẫn nhận `hello` v2 không token như trước.
5. Bảo mật không thương lượng: Workmate chỉ cài gói có sha256 khớp và chữ ký Ed25519 hợp lệ,
   không có nút "cài dù sao"; khi `pairing.json` tồn tại, server từ chối `hello` sai token và
   extension từ chối server không trả lại token; bridge chỉ nghe 127.0.0.1; không bao giờ commit
   khoá bí mật.
6. Windows và macOS là hai nền tảng ngang hàng; mọi đường dẫn qua `path.join`, mọi tệp ghi bằng
   tạm + rename. Mã Electron mới đặt trong `apps/desktop/electron/webmate/` dạng module thuần có
   `*.test.ts` cạnh tệp; chỉ thêm các dòng `ipcMain.handle('agentx:webmate:*', …)` vào
   `apps/desktop/electron/main.ts` và một nhóm `webmate` trong `apps/desktop/electron/preload.ts`
   cạnh nhóm `updates`. Cập nhật `apps/desktop/src/global.d.ts`.
7. i18n desktop: sáu bộ `apps/desktop/src/i18n/{vi,en,zh,zh-hant,ja,ar}.ts`; test
   `catalog.test.ts` bắt parity chặt giữa `en` và `vi`. Thêm khoá cho cả sáu. Backend
   `locales/*.yaml` có test parity 18 ngôn ngữ; chỉ thêm khoá backend khi thật cần.
8. Không sửa số phiên bản bằng tay ở Workmate; nếu cần đổi phiên bản dùng
   `scripts/release.py --sync-versions`. `tests/test_branding_gate.py::test_the_tree_is_clean`
   đang rớt sẵn trên `main`; đừng làm nó rớt thêm (tài liệu mới không dùng tên thương hiệu cũ của
   mã nguồn gốc).
9. Không bao giờ chạy lệnh xoá hay ghi đè tệp ngoài hai kho và `~/.agentx/webmate/`. Mọi thứ ghi
   vào `~/.agentx/webmate/` phải dọn được bằng cách xoá thư mục đó.
10. Thông điệp commit theo phong cách kho (tiền tố conventional + mô tả tiếng Việt).

## 2. Đặc tả kiến trúc đích

### 2.1 Thư mục trên máy người dùng

Gốc: `<gốc AgentX>/webmate/` — `~/.agentx/webmate/` trên macOS/Linux, cùng gốc với dữ liệu
backend (`%LOCALAPPDATA%\agentx\webmate\` trên Windows theo `hermes_constants.py`; bản đặc tả
gốc ghi `%USERPROFILE%\.agentx\webmate\` — lệch này được chốt theo gốc backend thật), **không**
nằm trong gói app và **không** nằm dưới `accounts/<slug>/` (extension là của máy, không của tài
khoản).

```
~/.agentx/webmate/
  AgentX WebMate/        # thư mục Chrome nạp; tên cố định vì Chrome lưu đường dẫn tuyệt đối
    manifest.json … (nội dung zip agentx-webmate-chrome-<ver>.zip)
    workmate.json        # Workmate ghi; extension đọc khi khởi động
  versions/<ver>/        # dàn bản mới trước khi hoán đổi
  versions/prev/         # bản trước, để rollback
  pairing.json           # token, quyền 0600
  state.json             # MCP server ghi; desktop theo dõi bằng fs.watch
  commands/<uuid>.json   # Workmate ghi lệnh cho server (prepare_update, reload, resume)
  update-check.json      # cache lần kiểm tra feed gần nhất (kể cả pendingVersion)
  profile/               # giai đoạn 3: user-data-dir của cửa sổ riêng
```

Không dùng symlink cho `AgentX WebMate` (Chrome resolve đường dẫn tuyệt đối); đổi phiên bản bằng
hai `rename` giữ nguyên tên.

### 2.2 Hợp đồng dữ liệu

`workmate.json` (Workmate ghi khi cài và mỗi khi đổi cổng/token; UTF-8, không BOM):
```json
{ "schema": 1, "wsUrl": "ws://127.0.0.1:17374/extension", "token": "<base64 32 byte>",
  "installId": "<uuid>", "workmateVersion": "0.21.0", "minServerVersion": "1.1.0" }
```

`pairing.json` (Workmate ghi, 0600):
`{ "schema": 1, "token": "<cùng token>", "port": 17374, "installId": "<uuid>", "createdAt": "<ISO>" }`.

`state.json` (MCP server ghi mỗi khi đổi, tạm + rename; **chỉ server ghi** — `pendingVersion`
của Workmate nằm trong `update-check.json`, không phải ở đây):
`{ "schema": 1, "pid", "port", "serverVersion", "listening": bool, "connected": bool,
"pairingRequired": bool, "browser": "Chrome 152" | null, "extensionVersion": "1.0.4" | null,
"installType": "workmate" | "dev" | null, "signedIn": bool | null, "protocolVersion": 3 | 2 | null,
"lastHelloAt": "<ISO>" | null, "error": string | null, "lastCommand": {...} | null, "updatedAt": "<ISO>" }`.

`hello` v3 (extension → server):
```json
{ "type": "hello", "client": "webbrain-extension", "protocolVersion": 3,
  "version": "<chrome.runtime.getManifest().version>", "browser": "<từ navigator.userAgentData.brands, ví dụ 'Chrome 152'>",
  "installType": "workmate" | "dev", "token": "<từ workmate.json hoặc vắng>", "signedIn": true | false,
  "capabilities": [...], "status": {...} }
```
`hello_ack` (server → extension): `{ "type": "hello_ack", "serverVersion": "1.1.0",
"token": "<echo token>" | null, "minExtensionVersion": "1.0.4", "minProtocol": 3 | 2 }`. Extension có
`workmate.json` mà `hello_ack.token` không khớp thì đóng socket, ghi lỗi, không thử lại trong
60 giây.

Lệnh mới qua bridge:
- `workmate_prepare_update` → extension ngừng nhận run mới, trả `{ ok: true, draining: true,
  busy: <số run đang chạy> }`; server chờ tối đa 60 giây cho tới khi `busy = 0`. `{ resume: true }`
  huỷ drain. Drain tự hết sau 5 phút.
- `workmate_reload` → extension gọi `chrome.runtime.reload()` sau khi trả lời.

Lệnh từ Workmate tới server: tệp `commands/<uuid>.json` `{ "id", "action": "prepare_update" |
"reload" | "resume" }`; server xoá tệp khi nhận, ghi kết quả vào `state.json.lastCommand`.

Mã lỗi có cấu trúc do sáu công cụ `webmate_*` trả về (đầu chuỗi đọc được và
`structuredContent.code`): `WEBMATE_DISABLED` (Workmate tự phát), `WEBMATE_NOT_INSTALLED`,
`WEBMATE_NOT_CONNECTED`, `WEBMATE_OUTDATED`, `WEBMATE_NOT_SIGNED_IN`, `WEBMATE_PORT_IN_USE`.

`release.json` (workflow phát hành của WebMate ghi, ký, đính lên GitHub Release và commit lên
`main`):
```json
{ "schema": 1, "version": "1.0.4", "publishedAt": "<ISO>",
  "chrome": { "url": "https://github.com/astralxkienlt/agentx-webmate/releases/download/v1.0.4/agentx-webmate-chrome-1.0.4.zip", "sha256": "<hex>", "bytes": 5230000 },
  "minWorkmate": "0.21.0", "minProtocol": 3,
  "notes": { "vi": "…", "en": "…" },
  "signature": "ed25519:<base64>" }
```
Chữ ký ký trên JSON chuẩn hoá (khoá sắp xếp mọi cấp, không khoảng trắng) của mọi trường trừ
`signature`. Workmate xác minh bằng khoá công khai hằng số; sai thì coi như không có feed.

### 2.3 Quét trình duyệt (`electron/webmate/browsers.ts`)

Trả về danh sách `{ id: 'chrome'|'edge'|'brave'|'vivaldi'|'opera'|'arc'|'chromium'|'firefox'|'safari',
name, executable, version, isDefault, supported, profiles: [{ dir, displayName, lastActive,
webmate: { installed, path, disabled, disableReasons } }] }`.

- macOS: bundle `com.google.Chrome`, `com.microsoft.edgemac`, `com.brave.Browser`,
  `com.vivaldi.Vivaldi`, `com.operasoftware.Opera`, `company.thebrowser.Browser`,
  `org.chromium.Chromium`, `org.mozilla.firefox`, `com.apple.Safari`; tìm ở `/Applications` và
  `~/Applications`, đọc `CFBundleShortVersionString`; trình duyệt mặc định từ
  `~/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist`
  (`plutil -convert json -o -`, `LSHandlers` với `LSHandlerURLScheme: https`).
- Windows: `HKLM` và `HKCU` `SOFTWARE\Clients\StartMenuInternet\*\shell\open\command`,
  `App Paths\chrome.exe|msedge.exe|brave.exe`; đường dẫn mặc định `%ProgramFiles%`,
  `%ProgramFiles(x86)%`, `%LOCALAPPDATA%`; trình duyệt mặc định từ
  `HKCU\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice\ProgId`
  (`ChromeHTML`, `MSEdgeHTM`, `BraveHTML`). Đọc registry bằng `reg query` qua `child_process`,
  không thêm dependency native.
- Thư mục dữ liệu: Chrome `~/Library/Application Support/Google/Chrome` |
  `%LOCALAPPDATA%\Google\Chrome\User Data`; Edge `…/Microsoft Edge` |
  `%LOCALAPPDATA%\Microsoft\Edge\User Data`; Brave `…/BraveSoftware/Brave-Browser` |
  `%LOCALAPPDATA%\BraveSoftware\Brave-Browser\User Data`; Vivaldi, Opera, Arc (`Arc/User Data`),
  Chromium tương tự.
- Profile: `Local State` → `profile.info_cache` (khoá = tên thư mục; `name`, `active_time`),
  `profile.last_used`.
- "Đã có WebMate": đọc `<profile>/Secure Preferences` rồi `Preferences` →
  `extensions.settings[pfadeibckkgklmmjghiikadphihbpape]`; `location === 4` (unpacked) và `path`
  trùng thư mục của Workmate ⇒ installed; `disable_reasons` khác rỗng hoặc `state === 0` ⇒
  disabled. Chỉ đọc, chịu được tệp đang bị trình duyệt ghi (bắt lỗi parse, thử lại một lần).
- Firefox và Safari: hiện với `supported: false` và lý do.

### 2.4 Mở trang extension và dẫn cài (`electron/webmate/guide.ts`)

- **Đo thật trên Chrome 152 macOS (09/09/2026): URL `chrome://…` truyền qua dòng lệnh bị Chrome
  bỏ qua** — cả khởi động lạnh lẫn khi Chrome đang chạy, `chrome://extensions` và
  `chrome://settings` đều chỉ ra cửa sổ New Tab. Vì vậy `guide.ts` đi hai bước: (1) mở cửa sổ
  mới cho đúng profile trên một trang dòng lệnh chấp nhận, `--profile-directory="<dir>"
  --new-window about:blank` (macOS `open -na "<App>.app" --args …`, Windows/Linux chạy binary
  detached); (2) lái cửa sổ đó tới trang tiện ích từ ngoài dòng lệnh: macOS AppleScript
  `tell application "<App>" to set URL of active tab of front window to "chrome://extensions"`
  (đường Apple Event coi URL là tin cậy; đã kiểm với Chrome và Edge), Windows gõ địa chỉ bằng
  `WScript.Shell` (`AppActivate('about:blank')` → Ctrl+L → URL → Enter; chưa kiểm trên máy
  thật). Bước 2 chỉ chạm cửa sổ có tab đang mở là about:blank / New Tab / What's New của mình,
  không bao giờ đụng tab người dùng đang mở; không lái được thì panel bảo người dùng gõ địa chỉ.
  Không dùng `shell.openExternal`.
- Đồng thời `shell.openPath(<~/.agentx/webmate>)` để thư mục `AgentX WebMate` hiện ra kéo thả
  được; nút "Sao chép đường dẫn" ghi đường dẫn tuyệt đối vào clipboard cho "Load unpacked".
- Phát hiện thành công: `state.json` chuyển `connected: true` với `browser` khớp lựa chọn. Không
  có nút "Tôi đã cài xong". Sau 120 giây chưa nối: hiện nguyên nhân thường gặp và nút "Dùng cửa
  sổ riêng" (giai đoạn 3).

### 2.5 Cập nhật và rollback (`electron/webmate/updater.ts`, `extension-store.ts`)

Kiểm tra: cùng lượt với `agentx:updates:check`; đọc
`https://raw.githubusercontent.com/astralxkienlt/agentx-webmate/main/release.json`, xác minh chữ
ký, so với phiên bản đang cài (`AgentX WebMate/manifest.json`) và đang chạy
(`state.json.extensionVersion`); cache vào `update-check.json`; kiểm `minWorkmate` với phiên bản
app và `minProtocol` với `state.json.protocolVersion`.

Áp bản mới, đúng thứ tự:
1. Tải zip về `versions/<ver>.zip`; kiểm sha256; sai thì dừng, ghi log, không hỏi người dùng.
2. Giải nén vào `versions/<ver>/` (bộ đọc zip thuần JS trong `electron/webmate/zip.ts`, kiểm path
   traversal); kiểm `manifest.json` có đúng `key` và `version`; ghi `workmate.json` vào đó.
3. Nếu `state.json.connected`: gửi lệnh `prepare_update` qua tệp lệnh, chờ `lastCommand` với
   `busy = 0` tối đa 60 giây.
4. Hoán đổi: `rename("AgentX WebMate", "versions/prev")` rồi `rename("versions/<ver>", "AgentX
   WebMate")`. Windows: rename thất bại (EBUSY/EPERM) thì thử lại 5 lần cách 2 giây; vẫn thất
   bại thì ghi `pendingVersion` vào `update-check.json`, theo dõi tiến trình trình duyệt, áp khi
   trình duyệt đóng, và nói rõ trên thẻ.
5. Gửi lệnh `reload`.
6. Chờ `hello` có `version === <ver>` trong 60 giây; không có thì hoán đổi ngược từ
   `versions/prev`, reload lần nữa, ghi phiên bản đó vào danh sách "lỗi" để không tự thử lại.
7. Trình duyệt đang đóng: bỏ bước 3 và 5, hoán đổi ngay.

Ghi nhận từ giai đoạn 0: `chrome.runtime.reload()` trên extension nạp qua CDP
`Extensions.loadUnpacked` (cửa sổ riêng, giai đoạn 3) làm extension **biến mất hẳn**; chế độ đó
phải khởi động lại Chrome / `loadUnpacked` lại sau khi hoán đổi thay vì dựa vào reload.
Extension nạp qua `chrome://extensions` của người dùng reload tại chỗ bình thường.

### 2.6 Cửa sổ trình duyệt riêng (`electron/webmate/browser-window.ts`, giai đoạn 3)

Chạy binary Chrome/Edge/Brave lấy từ kết quả quét (ưu tiên trình duyệt mặc định) với:
`--user-data-dir=<~/.agentx/webmate/profile> --remote-debugging-pipe
--enable-unsafe-extension-debugging --no-first-run --no-default-browser-check --new-window <url>`.
Nói CDP qua pipe (fd 3 ghi, fd 4 đọc; thông điệp JSON kết thúc bằng `\0`) với browser target:
`Target.getTargets`, rồi `Extensions.loadUnpacked { path: "<~/.agentx/webmate/AgentX WebMate>" }`.
Giữ tiến trình con; đóng khi Workmate thoát; khi cập nhật thì chờ hết run, đóng, hoán đổi, mở
lại. Không cần Developer mode. Cần ít nhất một trình duyệt gốc Chromium trên máy.

### 2.7 Bảo mật và khoá

- Cặp khoá RSA-2048 cho trường `key` của manifest: khoá công khai (SPKI DER, base64) ở
  `manifestOverrides.chrome.key` trong `brand/brand.config.json` (WebMate); ID cố định
  `pfadeibckkgklmmjghiikadphihbpape` ở `product.extensionId`. Khoá bí mật ngoài kho
  (`~/.agentx/webmate-keys/manifest-key.pem` trên máy người bảo trì).
- Cặp khoá Ed25519 cho feed: khoá bí mật là secret GitHub Actions `WEBMATE_RELEASE_SIGNING_KEY`
  (PEM) của kho WebMate; khoá công khai là hằng `WEBMATE_RELEASE_PUBLIC_KEY` trong
  `apps/desktop/electron/webmate/release-feed.ts` (bản sao ở
  `scripts/release-signing-key.pub.pem` của WebMate).
- Token ghép đôi: 32 byte ngẫu nhiên, base64; sinh khi cài; đổi được từ Cài đặt ("Đặt lại token"
  ghi lại cả `pairing.json` và `workmate.json`, rồi `reload`).

## 3. Giai đoạn 0 · Kho WebMate: gói cài được

Nhánh `feat/workmate-install`. Manifest có `key` + `minimum_chrome_version` 121; extension đọc
`workmate.json` (qua background, `cloud_bridge_identity`), `hello` v3, xử lý `hello_ack`, hai lệnh
cập nhật; server đọc `pairing.json`, ghi `state.json`, nhận tệp lệnh, mã lỗi `WEBMATE_*`, phiên
bản 1.1.0; `build-zip.mjs` sinh `dist/release.json`, `sign-release.mjs` ký, hai workflow đính và
commit; test mở rộng; e2e Chrome thật `test/workmate-install-e2e.mjs`.

## 4. Giai đoạn 1 · Kho Workmate: hết lỗi trên máy sạch

Nhánh `webmate-install/phase-1`. Catalog kiểu `install.type: bundled` (không clone, không npm),
`command` là Node do Workmate quản lý, fallback `node`; `manifest.yaml` sang `bundled`, giữ `git`
làm `install.dev`; bundle vendor ở `optional-mcps/webmate/server/` kèm `VERSION` và
`SHA256SUMS`; zip extension trong bộ cài (`apps/desktop/build/webmate/` qua
`scripts/fetch-webmate.mjs` theo `optional-mcps/webmate/webmate.lock.json`, `extraResources` thứ
ba); `electron/webmate/extension-store.ts` giải nén vào `~/.agentx/webmate/AgentX WebMate/`;
`pairing.ts` sinh token, ghi `pairing.json` và `workmate.json`; cả hai chạy khi app khởi động
(idempotent); backend `GET /api/webmate/status`; skill `webmate` và `check_bridge.py` cập nhật;
test pytest + vitest.

## 5. Giai đoạn 2 · Kho Workmate: trải nghiệm cài, Cài đặt, bản mới

Nhánh `webmate-install/phase-2`. `browsers.ts`, `guide.ts`, `status.ts` theo 2.3–2.4; IPC
`agentx:webmate:scan|prepare|openGuide|copyPath|status|subscribe|setEnabled|resetToken`; store
renderer `apps/desktop/src/store/webmate.ts`; onboarding `connecting_browser` sau
`confirming_model`; Cài đặt view `browser`; thẻ "Workmate muốn dùng trình duyệt của bạn" bắt mã
`WEBMATE_*`; `updater.ts` theo 2.5 với toast hoãn 24 giờ và banner bắt buộc khi dưới
`minProtocol`; i18n sáu ngôn ngữ; test vitest cho từng module.

## 6. Giai đoạn 3 · Cửa sổ trình duyệt Workmate

Nhánh `webmate-install/phase-3`. `browser-window.ts` theo 2.6 với test cho lớp CDP-qua-pipe; IPC
`agentx:webmate:window:open|close|status`; lựa chọn "Dùng cửa sổ riêng" ở onboarding ghi
`webmate.mode = 'window'`; chế độ đổi qua lại trong Cài đặt; cập nhật ở chế độ này: chờ hết run,
đóng cửa sổ, hoán đổi, mở lại; onboarding nói rõ "phải đăng nhập lại các trang trong cửa sổ này".

## 7. Giai đoạn 4 · Liền mạch

Nhánh `feat/workmate-sso` (WebMate) và `webmate-install/phase-4` (Workmate). Extension thêm lệnh
`auth_hint { loginHint }` (authorize `prompt=none` qua `chrome.identity.launchWebAuthFlow`, redirect
`https://<ID>.chromiumapp.org/` — Keycloak phải đăng ký redirect này, việc của chủ dự án) và
`auth_open`; server giữ nhiều kết nối theo `browser`; Workmate gửi `auth_hint` sau khi nối, "Chọn
trình duyệt" trong Cài đặt, mở đăng nhập Workmate trong trình duyệt đã chọn để cookie SSO khớp.

## Trạng thái

| Giai đoạn | Trạng thái | Ghi chú |
|---|---|---|
| 0 · WebMate gói cài được | **Xong** (09/09/2026) | Nhánh `feat/workmate-install` kho WebMate, 4 commit. `npm test` xanh trừ 1 test CHANGELOG đã đỏ sẵn trên `main` (thiếu mục 1.0.3); mcp-server 73/73; e2e Chrome thật 6/6. Chưa có GitHub Release 1.0.4 (cần chủ dự án chạy workflow với secret `WEBMATE_RELEASE_SIGNING_KEY`). |
| 1 · Workmate hết lỗi máy sạch | **Xong** (09/09/2026) | Nhánh `webmate-install/phase-1`. Catalog `bundled` + `${NODE}`/`${AGENTX_ROOT}`, `agentx mcp install webmate [--dev]`, `GET /api/webmate/status`, `electron/webmate/{paths,zip,release-feed,pairing,extension-store,bootstrap}.ts` chạy khi app khởi động, `scripts/fetch-webmate.mjs` + `extraResources` `build/webmate`, skill/`check_bridge.py` cập nhật. Nghiệm thu tại máy: bootstrap thật tạo `AgentX WebMate/` 1.0.3 (bản build tại máy, ký bằng khoá thật), `pairing.json` 0600, `workmate.json`; server bundled từ chối token sai và ghi `state.json` khi nối. `webmate.lock.json` còn `sha256: null` cho tới khi WebMate 1.0.4 được phát hành (`node scripts/fetch-webmate.mjs --pin 1.0.4`). Chưa kiểm trên Windows thật. |
| 2 · UX cài, Cài đặt, bản mới | **Xong** (09/09/2026) | Nhánh `webmate-install/phase-2`. `electron/webmate/{browsers,guide,status,prefs,commands,updater,service}.ts` + IPC `agentx:webmate:*`; store `src/store/webmate.ts`; bước onboarding `connecting_browser` (`components/onboarding/browser-step.tsx`, ảnh chụp thật Chrome/Edge vi+en); Settings → Trình duyệt (`app/settings/browser-settings.tsx`), thẻ cập nhật chung với Giới thiệu, thẻ nhắc `WEBMATE_*` (`components/webmate-prompt-card.tsx`); i18n 6 ngôn ngữ. Nghiệm thu tại máy: quét ra Edge (mặc định) + Chrome + Safari (chưa hỗ trợ); nút cài mở Finder tại `~/.agentx/webmate` và cửa sổ Chrome mới trên `chrome://extensions` đúng profile qua hai bước; nạp chính thư mục `AgentX WebMate` vào một Chrome profile tạm (CDP `Extensions.loadUnpacked`) → server thật chấp nhận hello v3 có token → bước onboarding chuyển "Đã kết nối · Chrome 152" không cần bấm; feed `release.json` cục bộ ký khoá thử (chỉ dev, `AGENTX_WEBMATE_FEED_URL`/`AGENTX_WEBMATE_FEED_PUBLIC_KEY`) chạy trọn tải → sha256 → giải nén → kiểm key → hoán đổi hai lần (1.0.3→1.0.4 tự động, 1.0.4→1.0.5→1.0.6 bằng nút). **Chưa kiểm sống:** nhánh drain → reload → rollback (chỉ có unit test) vì bản dev `brand-dist/chrome` trong Chrome của chủ dự án còn nói v2 và mỗi lần quay số lại "supersede" socket đã ghép đôi khiến `connected` nhấp nháy 1–3 s (xem ghi chú dưới bảng); Windows/Brave chưa có máy thật. |
| 3 · Cửa sổ trình duyệt Workmate | **Xong** (09/09/2026) | Nhánh `webmate-install/phase-3`. `electron/webmate/{cdp-pipe,browser-window}.ts` (CDP qua `--remote-debugging-pipe` trên fd 3/4, khung JSON kết thúc `\0`, `Extensions.loadUnpacked` chính thư mục `AgentX WebMate`, không mở cổng TCP nào), IPC `agentx:webmate:window:open|close|status`, cửa thứ ba ở bước onboarding Kết nối trình duyệt, Cài đặt → Trình duyệt có hàng chế độ (Trình duyệt của tôi / Cửa sổ riêng của Workmate) + hàng cửa sổ Mở/Đóng, thẻ nhắc có nút "Mở cửa sổ riêng"; bundle MCP server vendor lại (bridge chỉ supersede sau hello hợp lệ). Nghiệm thu tại máy (Chrome 152.0.7977.83, macOS): bấm "Mở cửa sổ riêng" → Chrome mở với profile `~/.agentx/webmate/profile`, extension nạp không cần thao tác (~1 s), `state.json.connected = true`, `installType: "workmate"`, giữ ổn định; quit Workmate (Apple Event) → cửa sổ đóng dưới 1 s; cập nhật bằng relaunch chạy trọn 1.0.3→1.0.4 trong ~3 s (chờ xong việc → đóng → tải/sha256/chữ ký/hoán đổi → mở lại → hello 1.0.4); gói hỏng 1.0.5 và 1.0.6 (service worker không tồn tại) → Chrome từ chối nạp → quay về 1.0.4, `failedVersions` ghi lại, cửa sổ mở lại (2 s sau khi sửa rollback tức thì). Infobar quan sát qua cây Accessibility: chỉ có thanh "Continue where you left off" của chính Chrome (gợi ý khôi phục tab, không do cờ của ta), không có thanh "being controlled by automated test software", không có cảnh báo cờ không hỗ trợ, không có bubble developer mode. **Chưa kiểm:** Windows (spawn + pipe fd 3/4 và `windowsHide`), Edge/Brave làm cửa sổ riêng (máy này chỉ có Chrome đủ điều kiện mặc định). |
| 4 · Liền mạch | Chưa | |

**Ghi chú sau giai đoạn 3:**
- Việc ở kho WebMate nêu sau giai đoạn 2 đã làm (commit `4b7cdcdaf`, nhánh `feat/workmate-install`, vendor lại ở
  `optional-mcps/webmate`): `bridge.ts` chỉ thay socket đang dùng **sau** khi `hello` của kết nối mới được chấp
  nhận; kết nối bị từ chối (v2, sai token) tự đóng một mình. Nhờ vậy bản dev `brand-dist/chrome` còn nói v2
  trong Chrome của chủ dự án không làm `state.json.connected` nhấp nháy nữa — nó chỉ để lại `error` trong
  `state.json` cho tới khi được Reload trong `chrome://extensions`.
- Cửa sổ riêng dùng **pipe, không dùng cổng**: fd 3 (ghi) / fd 4 (đọc) của tiến trình con, mỗi thông điệp JSON
  kết thúc bằng `\0`; `--enable-unsafe-extension-debugging` là điều kiện của `Extensions.loadUnpacked`. Chrome
  tự thoát khi pipe bị đóng, nên Workmate tắt đột ngột cũng không để lại cửa sổ mồ côi.
- Cập nhật ở chế độ cửa sổ đi bằng relaunch (đóng cửa sổ → hoán đổi → mở lại) vì `chrome.runtime.reload()` trên
  extension nạp qua CDP gỡ nó luôn. Nếu Chrome từ chối nạp bản mới, rollback chạy ngay và `lastApply.error` ghi
  lý do Chrome trả về.
- Còn lại cho chủ dự án: kiểm trên Windows thật (spawn với `stdio` 5 phần tử, `windowsHide`, SendKeys của bước dẫn
  cài), thử Edge/Brave làm cửa sổ riêng, phát hành WebMate 1.0.4 thật với secret `WEBMATE_RELEASE_SIGNING_KEY` để
  `release.json` trên GitHub có nội dung, và Reload/tắt bản dev trong Chrome + Edge.
