# Workmate 1.1.0 — workspace usage rebuild

This operator-requested rebuild integrates the first-party SSO usage Dashboard and bundles WebMate 1.0.10. Workmate retains version 1.1.0. Previous installer URLs and release tags remain immutable; publish new installers under a revision path and replace only the landing page's latest download aliases and signed feed.

Main process owns token refresh and a bounded reporter. Renderer IPC contains only session/profile lifecycle signals. One completed chat turn records the authenticated account/workspace, version, operating system, native environment, duration and outcome. Multiple windows are deduplicated while a turn is active. Cancelled/interrupted turns, disconnected activity without completion and account changes are excluded. Generic errors are counted without transcripts, prompts, tool data, URLs or raw errors. Three bounded retries retain one event UUID. A collection outage never changes a turn or prompts sign-in.

The server operator enabled first-party usage monitoring by allowing agentx-workmate in SSO_TELEMETRY_CLIENTS. Removing the client disables ingestion. Metrics start with new operations after installing this rebuild and cannot reconstruct past product usage.

Validation: full desktop Vitest suite (5,699 passed, two pre-existing skipped tests), typecheck and lint. Dedicated sender tests include a real HTTP request, token headers, retry deduplication, account isolation and cancellation. Native release CI exercises install/update regressions and packaged runtime startup on macOS and Windows before publication. Verify both installers and the signed feed against their build commit and bundled WebMate hash.

Installed 1.1.0 uses semantic-version update checks; customers already on 1.1.0 install this rebuild from the refreshed landing download. Do not advertise a same-version automatic update.
