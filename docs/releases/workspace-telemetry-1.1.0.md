# Workmate 1.1.0 — workspace usage rebuild

This operator-requested rebuild integrates the first-party SSO usage Dashboard and bundles WebMate 1.0.11. Workmate retains version 1.1.0. Previous installer URLs and release tags remain immutable; publish new installers under a revision path and replace only the landing page's latest download aliases and signed feed.

Main process owns token refresh and a bounded reporter. Renderer IPC contains only session/profile lifecycle signals. One completed chat turn records the authenticated account/workspace, version, operating system, native environment, duration and outcome. Multiple windows are deduplicated while a turn is active. Cancelled/interrupted turns, disconnected activity without completion and account changes are excluded. Generic errors are counted without transcripts, prompts, tool data, URLs or raw errors. Three bounded retries retain one event UUID. A collection outage never changes a turn or prompts sign-in.

The server operator enabled first-party usage monitoring by allowing agentx-workmate in SSO_TELEMETRY_CLIENTS. Removing the client disables ingestion. Metrics start with new operations after installing this rebuild and cannot reconstruct past product usage.

Validation: full desktop Vitest suite (5,699 passed, two pre-existing skipped tests), typecheck and lint. Dedicated sender tests include a real HTTP request, token headers, retry deduplication, account isolation and cancellation. Native release CI exercises install/update regressions and packaged runtime startup on macOS and Windows before publication. Verify both installers and the signed feed against their build commit and bundled WebMate hash.

Installed 1.1.0 uses semantic-version update checks; customers already on 1.1.0 install this rebuild from the refreshed landing download. Do not advertise a same-version automatic update.

## Correction in 1.1.1

The 1.1.0 rebuild sent the ID token the desktop keeps for its own backend. The SSO console's usage endpoint accepts only Keycloak access tokens, so it answered every Workmate event with 401: production logged 67 refusals from 7 installs on 12–13 October 2026, and no Workmate usage reached the Dashboard. Those events cannot be recovered.

1.1.1 keeps Keycloak's access token beside the ID token and sends it with usage metrics; the backend still receives the ID token. A session saved by 1.1.0 gets its access token from one refresh. If that refresh fails, the session is left as it is, and metrics never sign anyone out. The desktop log records each distinct delivery failure once per launch. Ship it with a version above 1.1.0 so installed apps offer the update.

Validation: unit tests on both sides of the token change, and a contract test that applies the console's acceptance rules. A local end-to-end run used Keycloak 26.0.8 with the agent-hub realm, the agentx-workmate client configured as in production, and both 14-day offline and browser-bound sessions, against the real SSO console. The console stored the events with product and workspace and listed agentx-workmate on the Dashboard. A 1.1.0-style ID token got 401, and a session Keycloak had ended stayed signed in.

## Failed turns say why in 1.1.1

1.1.0 sent every failed turn as `operation_failed`, and counted a turn that ended without its answer as a success. In 1.1.1 the backend's terminal `message.complete` frame carries `failure_code` (`tui_gateway/usage_outcome.py`), and the desktop sends it as `error_code`, in the words AgentX Chat and WebMate use (AgentX-sso `docs/dashboard.md`, "Mã lỗi"): the classified provider error (`rate_limited`, `auth_failed`, `timeout`, `context_too_long`…), the license's state (`license_expired`, `license_revoked`, `license_required`), or why the turn ended without its answer (`max_steps`, `empty_response`, `no_response`, `stream_interrupted`, `guardrail_halt`). `operation_failed` remains for what nothing classifies. The code comes from the turn's result, never its text.

A turn now ends only at that frame: a warning the backend sends mid-turn no longer counts it as failed, and a turn whose end was lost no longer stretches the next one's duration.

Validation: unit tests for the mapping and for the frame each ending emits, including a real agent refused by an expired license, plus the desktop's signal and sender tests.
