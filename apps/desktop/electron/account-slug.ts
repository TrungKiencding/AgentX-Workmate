/**
 * account-slug.ts
 *
 * Derives the directory name for a signed-in person's AgentX home.
 *
 * This is a PORT, not an original. `hermes_cli/accounts.py`'s
 * `account_slug_for_identity` is the same algorithm, and the two must agree
 * exactly: the app computes the slug to pass `--account`, and Python computes
 * it again to decide which directory that names. A disagreement does not
 * error — it silently gives one person two homes, splitting their sessions
 * and their provider key across both.
 *
 * The shared test vectors in `account-slug.test.ts` and
 * `tests/hermes_cli/test_accounts.py` are what hold the two together; change
 * one side and the other's table fails.
 *
 * Why derive at all, rather than let Keycloak or the user name the directory:
 * the desktop must choose the home BEFORE any backend is running, and the only
 * thing it has at that moment is the token it just received. A derived name
 * needs no lookup, no state, and no round trip — and because it is taken over
 * the immutable `sub` claim, the same person lands in the same home even after
 * they change their name or email.
 */

import { createHash } from 'node:crypto'

/** Longest human-readable prefix kept in a slug; the digest after it is what makes it unique. */
const SLUG_LABEL_MAX = 24

/** Hex characters of the subject digest. Matches _SLUG_DIGEST_CHARS in accounts.py. */
const SLUG_DIGEST_CHARS = 8

/** Matches ACCOUNT_SLUG_RE in accounts.py and _PROFILE_ID_RE in profiles.py. */
export const ACCOUNT_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

export interface AccountIdentityInput {
  subject: string
  username?: string
  email?: string
}

/**
 * Return the readable half of a slug, or '' when the identity offers none.
 *
 * Prefers the username and falls back to the email's local part. Everything
 * outside `[a-z0-9]` becomes a hyphen because the result is a directory name
 * on three operating systems and a token in argv.
 */
export function accountSlugLabel(username = '', email = ''): string {
  let raw = (username || '').trim()

  if (!raw) {
    raw = (email || '').trim().split('@')[0] || ''
  }

  const hyphenated = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return hyphenated.slice(0, SLUG_LABEL_MAX).replace(/^-+|-+$/g, '')
}

/**
 * Return the stable account slug for a verified Keycloak identity.
 *
 * `subject` must be the IdP's immutable `sub` claim. Throws when it is empty:
 * a slug derived from nothing would be one shared directory that every
 * unidentified sign-in fell into, which is the exact opposite of the point.
 */
export function accountSlugForIdentity(identity: AccountIdentityInput): string {
  const subject = (identity?.subject || '').trim()

  if (!subject) {
    throw new Error('cannot derive an account slug without a subject claim')
  }

  const digest = createHash('sha256').update(subject, 'utf8').digest('hex').slice(0, SLUG_DIGEST_CHARS)
  const label = accountSlugLabel(identity.username, identity.email)
  const slug = label ? `${label}-${digest}` : `u-${digest}`

  if (!ACCOUNT_SLUG_RE.test(slug)) {
    throw new Error(`derived an invalid account slug: ${slug}`)
  }

  return slug
}

/**
 * True when `value` is shaped like an account slug we could have written.
 *
 * Used before anything reaches argv or a path join, so a corrupted store can
 * never turn into `--account ../../somewhere`.
 */
export function isAccountSlug(value: unknown): value is string {
  return typeof value === 'string' && ACCOUNT_SLUG_RE.test(value)
}
