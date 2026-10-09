/**
 * keycloak-desktop-session.ts
 *
 * One question, answered in one place: "give me a valid Keycloak session for
 * this backend, signing in if you have to."
 *
 * The backend of an AgentX Workmate desktop install runs on loopback with the
 * auth gate switched on (`dashboard.require_auth`), so the app has to prove who
 * the user is before it can talk to its own backend. That decision has several
 * branches — is this backend even gated, is there a stored session, is it
 * expired, is the refresh a dead session or just a flaky network — and every
 * one of them changes whether the user sees a sign-in prompt. Keeping them here
 * as a pure-ish, dependency-injected unit means the ordering is testable
 * instead of being spread through main.ts's boot path.
 *
 * The one distinction worth stating plainly: a rejected refresh means the
 * session is over and the user must sign in again; a refresh that could not be
 * ATTEMPTED (offline, DNS down, Keycloak restarting) means keep what we have
 * and try later. Conflating them signs people out every time their wifi
 * hiccups.
 *
 * How long a sign-in lasts is this install's decision, published by the backend
 * as `sessionDays`. A plain Keycloak refresh token cannot carry it. That token
 * is bound to the browser's SSO session, and on the AgentX realm that session
 * does not last a night. So when `sessionDays` is set, the sign-in asks for an
 * offline session, and this module ends it itself once the days are up.
 */

import {
  type KeycloakLoginDeps,
  logoutKeycloakSession,
  refreshKeycloakSession,
  runKeycloakLogin
} from './keycloak-login'
import {
  type KeycloakOidcConfig,
  nativeOidcFromProviders,
  signInLimitAt,
  wantsOfflineSession,
  withOfflineAccess
} from './keycloak-oidc'
import { loadKeycloakSession, persistKeycloakSession } from './keycloak-session-store'
import { type NativeTokenSet, tokenNeedsRefresh } from './native-oauth'
import { type NativeTokenStoreIo } from './native-token-store'

export interface KeycloakSessionDeps extends KeycloakLoginDeps {
  store: NativeTokenStoreIo
  /** Set false to report "sign-in needed" instead of opening a browser. */
  interactive?: boolean
  /**
   * Hold the stored session to this install's sign-in policy (`sessionDays`).
   *
   * On by default. The token top-up that runs while the app is open turns it
   * off. A sign-in that reaches its limit mid-session then ends at the next
   * launch, where the Sign in screen is, instead of failing requests in the
   * middle of someone's work.
   */
  enforceSignInPolicy?: boolean
}

export interface KeycloakSessionResult {
  config: KeycloakOidcConfig
  tokens: NativeTokenSet | null
  /** How the session was obtained — drives what the boot overlay says. */
  outcome: 'stored' | 'refreshed' | 'signed-in' | 'needs-login' | 'stale-offline'
}

/**
 * Read the backend's public provider list and return its native-OIDC config.
 *
 * Returns null when the backend advertises none — an ungated backend, a
 * different provider, or one configured as a confidential client. Every one of
 * those means "this is not our flow", so the caller falls back rather than
 * failing the boot.
 */
export async function discoverKeycloakConfig(
  baseUrl: string,
  deps: Pick<KeycloakSessionDeps, 'getJson' | 'rememberLog'>
): Promise<KeycloakOidcConfig | null> {
  try {
    const body = await deps.getJson(`${baseUrl}/api/auth/providers`, { timeoutMs: 10_000 })

    return nativeOidcFromProviders(body)
  } catch (error) {
    deps.rememberLog?.(
      `[keycloak] could not read /api/auth/providers: ${error instanceof Error ? error.message : String(error)}`
    )

    return null
  }
}

/**
 * Produce a usable Keycloak session for `config`, signing in if needed.
 *
 * Ladder:
 *   0. stored session past this install's policy → end it, sign in again
 *   1. stored session still valid            → use it
 *   2. stored session near expiry, refreshed → use the rotated one
 *   3. refresh REJECTED (session over)       → forget it, sign in again
 *   4. refresh UNREACHABLE (offline)         → keep the stored one, carry on
 *   5. nothing stored                        → sign in
 *
 * With `interactive: false`, rungs 0, 3 and 5 report `needs-login` and return no
 * tokens instead of opening a browser — that is what lets the boot path put a
 * "Sign in" button in front of the user rather than launching a browser at them
 * unannounced.
 */
export async function ensureKeycloakSession(
  config: KeycloakOidcConfig,
  deps: KeycloakSessionDeps
): Promise<KeycloakSessionResult> {
  const log = deps.rememberLog || (() => undefined)
  const now = deps.now || (() => Math.floor(Date.now() / 1000))
  const interactive = deps.interactive !== false

  let stored = loadKeycloakSession(config, deps.store)

  if (stored && deps.enforceSignInPolicy !== false) {
    const reason = policyEndsSession(stored, config, now())

    if (reason) {
      log(`[keycloak] ${reason}; a new sign-in is needed`)
      persistKeycloakSession(config, null, deps.store)
      // An offline session stays live in the realm until it is ended. Not
      // awaited: a Keycloak that cannot be reached must not hold up the Sign in
      // screen, and the logout never throws.
      void logoutKeycloakSession(config, stored.refreshToken, deps)
      stored = null
    }
  }

  if (stored) {
    if (!tokenNeedsRefresh(stored, now())) {
      return { config, tokens: stored, outcome: 'stored' }
    }

    if (stored.refreshToken) {
      try {
        // An offline session asks for offline_access again, so Keycloak keeps
        // handing back an offline token instead of narrowing the scope.
        const refreshConfig = stored.offline ? withOfflineAccess(config) : config
        const rotated = carrySignIn(stored, await refreshKeycloakSession(refreshConfig, stored.refreshToken, deps))

        persistKeycloakSession(config, rotated, deps.store)
        log('[keycloak] refreshed the stored session')

        return { config, tokens: rotated, outcome: 'refreshed' }
      } catch (error) {
        if (isRefreshUnreachable(error)) {
          // Offline, not signed out. Hand back what we have; the backend will
          // reject it if it really is dead, and the next attempt can refresh.
          log('[keycloak] refresh could not reach Keycloak; keeping the stored session')

          return { config, tokens: stored, outcome: 'stale-offline' }
        }

        log('[keycloak] Keycloak rejected the refresh token; a new sign-in is needed')
        persistKeycloakSession(config, null, deps.store)
      }
    } else {
      // Expired with nothing to rotate.
      persistKeycloakSession(config, null, deps.store)
    }
  }

  if (!interactive) {
    return { config, tokens: null, outcome: 'needs-login' }
  }

  const tokens = await signIn(config, deps, log)

  log('[keycloak] browser round trip complete; storing the session')

  // A store failure must not throw away a sign-in the user just completed.
  // The OS keychain can be locked or unavailable, and losing the session over
  // that would send them back to the sign-in screen in a loop, with the OAuth
  // exchange succeeding every time — the failure has to be visible, and the
  // tokens still usable for this run.
  try {
    persistKeycloakSession(config, tokens, deps.store)
    log('[keycloak] signed in')
  } catch (error) {
    log(
      '[keycloak] signed in, but the session could not be saved (you will be ' +
        `asked again next launch): ${error instanceof Error ? error.message : String(error)}`
    )
  }

  return { config, tokens, outcome: 'signed-in' }
}

/** Drop the stored session. The caller opens the end-session URL separately. */
export function forgetKeycloakSession(config: KeycloakOidcConfig, deps: Pick<KeycloakSessionDeps, 'store'>): void {
  persistKeycloakSession(config, null, deps.store)
}

/**
 * Run the browser sign-in, asking for an offline session when this install
 * keeps sign-ins for days.
 *
 * A realm can refuse one. The client may lack the offline_access scope
 * (`invalid_scope`), or the person may lack the role (`not_allowed`). Failing
 * the sign-in over that would lock them out of the app completely. So it is
 * retried once as a browser-bound session: the app works, and the sign-in ends
 * with the browser's Keycloak session, as it did before offline sessions.
 */
async function signIn(
  config: KeycloakOidcConfig,
  deps: KeycloakSessionDeps,
  log: (line: string) => void
): Promise<NativeTokenSet> {
  if (!wantsOfflineSession(config)) {
    return runKeycloakLogin(config, deps)
  }

  try {
    return await runKeycloakLogin(withOfflineAccess(config), deps)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    if (!/\b(invalid_scope|not_allowed)\b/.test(message)) {
      throw error
    }

    log(
      `[keycloak] Keycloak refused an offline session (${message}); signing in without one, so this ` +
        "sign-in ends with the browser's Keycloak session"
    )

    return runKeycloakLogin(config, deps)
  }
}

/**
 * Why this install's sign-in policy ends the stored session, or '' when it
 * does not.
 */
function policyEndsSession(stored: NativeTokenSet, config: KeycloakOidcConfig, nowSeconds: number): string {
  const limitAt = signInLimitAt(stored, config)

  if (limitAt > 0 && nowSeconds >= limitAt) {
    return `the sign-in has reached this install's ${config.sessionDays}-day limit`
  }

  // With session_days turned off, an offline session would still carry on for
  // as long as Keycloak allows. Turning the setting off is meant to stop that.
  if (stored.offline && !wantsOfflineSession(config)) {
    return 'this install no longer keeps sign-ins for days (session_days is off)'
  }

  return ''
}

/**
 * Carry through a refresh what only the browser sign-in can establish: when it
 * happened, which starts the `sessionDays` clock, and that it was offline.
 */
function carrySignIn(stored: NativeTokenSet, refreshed: NativeTokenSet): NativeTokenSet {
  return {
    ...refreshed,
    ...(stored.signedInAt ? { signedInAt: stored.signedInAt } : {}),
    ...(refreshed.offline || stored.offline ? { offline: true } : {})
  }
}

/**
 * True when a failed refresh means "couldn't ask", not "the answer was no".
 *
 * Keycloak answers a dead or revoked refresh token with HTTP 400/401 and an
 * OAuth `invalid_grant`. Anything else — a socket error, a timeout, a 5xx from
 * a restarting realm, a captive portal — is the network, and must not cost the
 * user their session.
 *
 * Deliberately fails toward "unreachable" for an error it cannot classify: the
 * cost of guessing wrong that way is one extra request later, while guessing
 * wrong the other way is a spurious sign-out.
 */
function isRefreshUnreachable(error: unknown): boolean {
  const status = Number((error as any)?.statusCode ?? (error as any)?.status)

  if (Number.isFinite(status) && status > 0) {
    return !(status === 400 || status === 401 || status === 403)
  }

  const message = String((error as any)?.message || error || '')

  return !/invalid_grant|invalid_token|session[ _-]?expired|No Keycloak refresh token/i.test(message)
}

export { isRefreshUnreachable as _isRefreshUnreachable }
