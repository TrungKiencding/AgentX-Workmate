# WebMate lifecycle invariants

`WebmateService` serializes bootstrap, update, pending swap, pairing reset and
browser open/close operations. Both signed bundled upgrades and feed upgrades
use `applyWebmateUpdate`; there is one drain/swap/reload/confirm/rollback path.

- Drain every connection using the managed folder. A timeout is a failure unless
  a fresh bridge status proves those browsers disconnected. Older bridges must
  acknowledge every participant before a multi-browser swap is allowed.
- Close the CDP browser window before replacing files or requesting external
  reloads. Reopen it through `Extensions.loadUnpacked`, never `runtime.reload`.
  Read its persistent extension instance ID over its private CDP pipe and confirm
  that exact identity, along with every original managed browser.
- A token reset requires a fresh paired hello from all original participants.
  Failure restores the previous token and attempts browser recovery.
- Keep a verified blocked swap staged with `pendingVersion` and current pairing.
  Pending swaps revalidate identity, pairing and connection state. A rolled-back
  release stays in `failedVersions` across startup and cannot be applied pending.
- Feed checks write only fields they own and reevaluate installation/failure
  state after fetching. They cannot overwrite a concurrent apply's result.
- File command outcomes use durable per-ID receipts; `lastCommand` remains the
  UI summary and compatibility fallback. Cancel unclaimed timed-out commands so
  they cannot run against a later reopened window.
- Renderer enable/disable operations require a successful explicit MCP reload.
  They include the active chat's runtime ID and verify authoritative backend
  state before reporting success. Background chat tool snapshots remain intact.

Tests cover these invariants in the colocated suites, the renderer store tests,
and `tests/tui_gateway/test_mcp_reload_rev.py`. Native smoke testing uses temporary
homes and browser profiles and never changes the user's installed WebMate.
