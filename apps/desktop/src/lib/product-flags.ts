// Product switches for surfaces that are BUILT and working but deliberately
// not shipped right now.
//
// Each one is a module constant rather than a user setting: the call is the
// product's, not the user's, so no door — no toggle, no deep link, no hotkey —
// may be left standing behind the hidden UI.
//
// They are annotated `: boolean` on purpose. Without it TypeScript narrows each
// to the literal `false`, and the code on the other side of every gate stops
// being type-checked — which is how a hidden branch rots. This costs nothing
// but a dead `if` in the bundle.
//
// Nothing is deleted. Flip a flag back to `true` and every surface it gates
// returns; grep the flag name to see exactly which ones those are.

/**
 * Profile create / edit / import: the sidebar profile rail (`+`, import,
 * "…" manage), the `/profiles` overlay, the palette's "Import profile…", and
 * the `profile.create` / `nav.profiles` hotkeys.
 *
 * Off because a profile is provisioned FOR the signed-in account: signing in
 * lands you in that account's profile folder — created on first sign-in — and
 * a second account on the same machine gets its own folder. Nobody hand-makes
 * a profile any more, so hand-managing one is only a way into someone else's.
 */
export const PROFILE_MANAGEMENT_ENABLED: boolean = false

/**
 * Settings → Providers → "Accounts": the OAuth provider sign-in picker.
 *
 * Off because models now reach the app through the account's own AI Gateway
 * key, so there is no upstream provider account left to connect. The API-keys
 * and custom-endpoint sub-views stay — those are how someone points the app at
 * an endpoint of their own.
 */
export const PROVIDER_ACCOUNTS_ENABLED: boolean = false

/** Settings → Billing (plan, balance, top-ups). Temporarily hidden. */
export const BILLING_ENABLED: boolean = false
