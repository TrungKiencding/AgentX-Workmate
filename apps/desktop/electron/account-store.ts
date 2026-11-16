/**
 * account-store.ts
 *
 * Remembers which account this app last signed in as, so the NEXT launch can
 * spawn the backend straight into that person's home.
 *
 * This exists to solve an ordering problem. The realm config the app
 * authenticates against is published by the backend (`/api/auth/providers`),
 * so on a machine that has never signed in there is no way to know who is
 * about to sign in before something is already running. Without a memory the
 * app would boot into the shared home, sign in, discover the account, and have
 * to respawn — every single launch. With one, that respawn happens once per
 * person per machine and never again.
 *
 * It holds no secret. Tokens stay in the OS keychain
 * (`keycloak-session-store.ts`); this is a name-to-directory map plus a
 * pointer at the current one, and it lives in Electron's `userData` rather
 * than in any AgentX home because it has to be readable before we know which
 * home to read.
 */

import { isAccountSlug } from './account-slug'

export interface AccountRecord {
  slug: string
  subject: string
  email?: string
  displayName?: string
  issuer?: string
  /** Whether a LiteLLM key has ever been provisioned for this account. */
  provisioned?: boolean
  lastSignInAt?: string
}

export interface AccountStoreState {
  /** The `sub` of the account the app is currently using, or '' for the shared home. */
  activeSubject: string
  accounts: Record<string, AccountRecord>
}

export interface AccountStoreIo {
  readText(): string | null
  writeText(text: string): void
  rememberLog?(message: string): void
}

export const EMPTY_ACCOUNT_STATE: AccountStoreState = Object.freeze({
  activeSubject: '',
  accounts: {}
})

/**
 * Parse the stored state, discarding anything that does not survive validation.
 *
 * Deliberately total: a truncated or hand-edited file returns the empty state
 * rather than throwing. Every field here is a convenience — losing it costs
 * one extra respawn after the next sign-in, while a throw at this point in
 * boot would cost the user their app.
 */
export function parseAccountState(raw: string | null | undefined): AccountStoreState {
  if (!raw) {
    return { activeSubject: '', accounts: {} }
  }

  let parsed: any

  try {
    parsed = JSON.parse(raw)
  } catch {
    return { activeSubject: '', accounts: {} }
  }

  if (!parsed || typeof parsed !== 'object') {
    return { activeSubject: '', accounts: {} }
  }

  const accounts: Record<string, AccountRecord> = {}
  const source = parsed.accounts && typeof parsed.accounts === 'object' ? parsed.accounts : {}

  for (const [subject, value] of Object.entries<any>(source)) {
    if (!subject || !value || typeof value !== 'object') {
      continue
    }

    // A slug that fails validation is the one field we cannot shrug off: it
    // becomes a path segment and a command-line argument.
    if (!isAccountSlug(value.slug)) {
      continue
    }

    accounts[subject] = {
      slug: value.slug,
      subject,
      email: typeof value.email === 'string' ? value.email : '',
      displayName: typeof value.displayName === 'string' ? value.displayName : '',
      issuer: typeof value.issuer === 'string' ? value.issuer : '',
      provisioned: Boolean(value.provisioned),
      lastSignInAt: typeof value.lastSignInAt === 'string' ? value.lastSignInAt : ''
    }
  }

  const activeSubject =
    typeof parsed.activeSubject === 'string' && accounts[parsed.activeSubject] ? parsed.activeSubject : ''

  return { activeSubject, accounts }
}

export function readAccountState(io: AccountStoreIo): AccountStoreState {
  try {
    return parseAccountState(io.readText())
  } catch (error) {
    io.rememberLog?.(
      `[account] could not read the account store: ${error instanceof Error ? error.message : String(error)}`
    )

    return { activeSubject: '', accounts: {} }
  }
}

export function writeAccountState(state: AccountStoreState, io: AccountStoreIo): void {
  io.writeText(JSON.stringify(state, null, 2))
}

/**
 * Return the slug the next backend spawn should use, or null for the shared home.
 *
 * Null is the pre-account behaviour, and it is what every install that has
 * never signed anybody in keeps getting.
 */
export function bootAccountSlug(state: AccountStoreState): string | null {
  const record = state.activeSubject ? state.accounts[state.activeSubject] : null

  return record && isAccountSlug(record.slug) ? record.slug : null
}

/**
 * Record a successful sign-in and make that account current.
 *
 * Returns the new state and whether the ACTIVE account changed — the caller
 * uses that second value to decide whether the running backend is now serving
 * the wrong person and has to be re-homed.
 */
export function rememberSignIn(
  state: AccountStoreState,
  record: AccountRecord
): { state: AccountStoreState; switched: boolean } {
  if (!record?.subject || !isAccountSlug(record.slug)) {
    return { state, switched: false }
  }

  const previous = state.accounts[record.subject]

  const next: AccountStoreState = {
    activeSubject: record.subject,
    accounts: {
      ...state.accounts,
      [record.subject]: {
        ...previous,
        ...record,
        // Once true, stays true: a later sign-in that could not reach LiteLLM
        // must not un-remember that this account has a key.
        provisioned: Boolean(previous?.provisioned || record.provisioned)
      }
    }
  }

  return { state: next, switched: state.activeSubject !== record.subject }
}

/** Mark the active account as having a provisioned LiteLLM key. */
export function markProvisioned(state: AccountStoreState, subject: string): AccountStoreState {
  const record = state.accounts[subject]

  if (!record || record.provisioned) {
    return state
  }

  return {
    ...state,
    accounts: { ...state.accounts, [subject]: { ...record, provisioned: true } }
  }
}

/**
 * Decide whether a backend already running as `spawnedSlug` is the right home
 * for the person who just signed in.
 *
 * Returns null when it is (the overwhelmingly common case, because the store
 * chose that slug at spawn time). Returns the correct slug when it is not —
 * first sign-in on this machine, or a different person signing in.
 */
export function rehomeTarget(spawnedSlug: string | null, signedInSlug: string): string | null {
  if (!isAccountSlug(signedInSlug)) {
    return null
  }

  return spawnedSlug === signedInSlug ? null : signedInSlug
}
