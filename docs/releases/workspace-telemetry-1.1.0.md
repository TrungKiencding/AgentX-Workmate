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
