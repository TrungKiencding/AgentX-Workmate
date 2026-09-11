/**
 * keycloak-oidc.ts
 *
 * Pure, electron-free helpers for signing the desktop app in to Keycloak
 * directly — the flow AgentX Workmate uses so an employee's local install
 * accepts the account they already have in AgentX.
 *
 * Why direct-to-Keycloak and not the gateway-brokered /auth/native/* flow the
 * sibling native-oauth.ts drives: in the brokered flow the URL Keycloak
 * redirects to is the *backend's* own /auth/callback, and the desktop spawns
 * its backend with `--host 127.0.0.1 --port 0` — an ephemeral port that is a
 * different number every launch, once per profile. Keycloak's Valid Redirect
 * URIs only support a trailing `*`, so `http://127.0.0.1:<random>/auth/callback`
 * cannot be registered in any reviewable way. Running the flow ourselves moves
 * the redirect URI onto a listener we control and can pin to a handful of fixed
 * ports (see KEYCLOAK_CALLBACK_PORTS).
 *
 * The brokered flow stays exactly as it was, and stays the right answer for a
 * REMOTE gateway, which has a stable public URL.
 *
 * Nothing here hard-codes a Keycloak URL. The backend publishes issuer +
 * client_id on its public /api/auth/providers, so a realm migration needs no
 * desktop rebuild.
 *
 * Kept standalone (no `import 'electron'`) so it unit-tests in the `electron`
 * vitest project — same pattern as native-oauth.ts. keycloak-login.ts is the
 * I/O shell around it.
 */

import type { NativeTokenSet } from './native-oauth'

/**
 * Fixed loopback ports for the redirect URI, tried in order.
 *
 * These are the values an operator registers in Keycloak as Valid Redirect
 * URIs, so they are a published contract — changing one breaks every install
 * whose realm was configured against the old list. Three of them means a
 * colliding local process (or a second Workmate window mid-login) doesn't dead-
 * end the user. Chosen from the IANA dynamic/private range and not known to
 * collide with common developer tooling.
 */
export const KEYCLOAK_CALLBACK_PORTS = [47821, 47822, 47823] as const

export const KEYCLOAK_CALLBACK_PATH = '/callback'

/** Sign-in must complete inside this window before the listener is torn down. */
export const KEYCLOAK_LOGIN_TIMEOUT_MS = 5 * 60 * 1000

/** What the backend publishes on /api/auth/providers for a native client. */
export interface KeycloakOidcConfig {
  issuer: string
  clientId: string
  scopes: string
}

/** The subset of the OIDC discovery document this flow needs. */
export interface KeycloakEndpoints {
  authorizationEndpoint: string
  tokenEndpoint: string
  endSessionEndpoint: string
}

/** `{issuer}/.well-known/openid-configuration`, trailing slash tolerated. */
export function discoveryUrl(issuer: string): string {
  return `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`
}

export function callbackRedirectUri(port: number): string {
  return `http://127.0.0.1:${port}${KEYCLOAK_CALLBACK_PATH}`
}

/**
 * True for an https URL, or an http one pointed at loopback.
 *
 * Authorization codes and refresh tokens travel over these endpoints, so a
 * discovery document that hands back a cleartext URL is rejected rather than
 * followed. Mirrors the same check on the Python provider.
 */
function isHttpsOrLoopback(raw: string): boolean {
  try {
    const parsed = new URL(raw)

    if (parsed.protocol === 'https:') {
      return true
    }

    return parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.host.split(':')[0])
  } catch {
    return false
  }
}

/**
 * Validate an OIDC discovery document and pull out the endpoints we use.
 *
 * Pins the advertised `issuer` against the configured one: a mismatch means the
 * document came from somewhere other than the realm we asked for (a proxy, a
 * typo, an interception), and following its endpoints would send the user's
 * credentials there. Only a trailing-slash difference is tolerated.
 */
export function parseDiscovery(body: unknown, issuer: string): KeycloakEndpoints {
  const doc = (body || {}) as Record<string, unknown>
  const expected = issuer.replace(/\/+$/, '')
  const advertised = String(doc.issuer || '').replace(/\/+$/, '')

  if (advertised && advertised !== expected) {
    throw new Error(`Keycloak discovery issuer mismatch: realm advertises ${advertised}, expected ${expected}`)
  }

  const authorizationEndpoint = String(doc.authorization_endpoint || '')
  const tokenEndpoint = String(doc.token_endpoint || '')

  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new Error('Keycloak discovery missing authorization_endpoint or token_endpoint')
  }

  for (const [field, url] of [
    ['authorization_endpoint', authorizationEndpoint],
    ['token_endpoint', tokenEndpoint]
  ] as const) {
    if (!isHttpsOrLoopback(url)) {
      throw new Error(`Keycloak ${field} must be https (or http on loopback), got ${url}`)
    }
  }

  return {
    authorizationEndpoint,
    tokenEndpoint,
    endSessionEndpoint: String(doc.end_session_endpoint || '')
  }
}

/**
 * Build the `/protocol/openid-connect/auth` URL the system browser opens.
 *
 * A system browser, never a BrowserWindow: RFC 8252 BCP, and it is what lets
 * an employee who already signed in to AgentX in that browser land straight
 * through on the existing Keycloak SSO cookie.
 */
export function buildKeycloakAuthorizeUrl(
  endpoints: KeycloakEndpoints,
  config: KeycloakOidcConfig,
  args: { codeChallenge: string; state: string; redirectUri: string; nonce: string }
): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: args.redirectUri,
    scope: config.scopes || 'openid profile email',
    state: args.state,
    nonce: args.nonce,
    code_challenge: args.codeChallenge,
    code_challenge_method: 'S256'
  })

  const sep = endpoints.authorizationEndpoint.includes('?') ? '&' : '?'

  return `${endpoints.authorizationEndpoint}${sep}${q.toString()}`
}

/**
 * The form body for the authorization-code exchange.
 *
 * No `client_secret`: the client is public and PKCE is what authenticates the
 * exchange. A desktop binary on an employee's machine cannot hold a secret, so
 * there is deliberately no code path here that would send one.
 */
export function buildKeycloakTokenBody(
  config: KeycloakOidcConfig,
  args: { code: string; codeVerifier: string; redirectUri: string }
): Record<string, string> {
  return {
    grant_type: 'authorization_code',
    client_id: config.clientId,
    code: args.code,
    code_verifier: args.codeVerifier,
    redirect_uri: args.redirectUri
  }
}

/** The form body for a refresh-token grant. Public client, so no secret. */
export function buildKeycloakRefreshBody(config: KeycloakOidcConfig, refreshToken: string): Record<string, string> {
  return {
    grant_type: 'refresh_token',
    client_id: config.clientId,
    refresh_token: refreshToken,
    scope: config.scopes || 'openid profile email'
  }
}

/**
 * Decode a JWT payload WITHOUT verifying it.
 *
 * Safe here and only here: this runs on a token Keycloak just handed us over
 * TLS, and the only things read out are `exp` (when to refresh) and `sub` (a
 * display/telemetry id). Nothing is authorised on the strength of it — the
 * backend re-verifies the signature, issuer and audience on every request. Do
 * not reach for this to make a trust decision.
 */
function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.')

  if (parts.length !== 3) {
    throw new Error('Keycloak returned a malformed ID token')
  }

  const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/')
  const json = Buffer.from(padded + '='.repeat((4 - (padded.length % 4)) % 4), 'base64').toString('utf8')
  const parsed = JSON.parse(json)

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Keycloak ID token payload is not an object')
  }

  return parsed as Record<string, unknown>
}

/**
 * Normalize a Keycloak token response into the NativeTokenSet the rest of the
 * desktop already speaks.
 *
 * The ID TOKEN goes in the `accessToken` slot, deliberately. That is the token
 * the backend's Keycloak provider verifies — it is the one whose `aud` is our
 * client_id, which is the check that stops a token minted for another client
 * being replayed. Keycloak's OAuth access token has `aud: account` and would
 * fail that check.
 *
 * Expiry comes from the ID token's own `exp` rather than `expires_in`, because
 * `exp` is what the backend enforces; deriving it from a duration would drift
 * against clock skew and let us present a token the backend already considers
 * dead.
 */
export function parseKeycloakTokenResponse(body: unknown, nowSeconds: number): NativeTokenSet {
  const payload = (body || {}) as Record<string, unknown>
  const idToken = String(payload.id_token || '')

  if (!idToken) {
    throw new Error('Keycloak token response carried no id_token — check that the client requests the "openid" scope.')
  }

  const claims = decodeJwtPayload(idToken)
  const exp = Number(claims.exp)
  const expiresIn = Number(payload.expires_in)

  const expiresAt = Number.isFinite(exp) && exp > 0 ? exp : Number.isFinite(expiresIn) ? nowSeconds + expiresIn : 0

  // Identity for display. Same precedence the Python provider uses, so the same
  // person reads identically in the desktop app and the dashboard. Omitted
  // rather than blanked when the realm withholds the claim.
  const email = String(claims.email || '')
  const displayName = String(claims.name || claims.preferred_username || claims.email || '')

  return {
    accessToken: idToken,
    refreshToken: String(payload.refresh_token || ''),
    expiresAt,
    provider: 'keycloak',
    userId: String(claims.sub || ''),
    ...(email ? { email } : {}),
    ...(displayName ? { displayName } : {})
  }
}

/**
 * Pick the native-OIDC config out of a `/api/auth/providers` body.
 *
 * Returns null when no provider advertises one, when the flow is unusable
 * (a confidential client cannot complete a public-client PKCE exchange), or
 * when the payload is malformed — every one of which means "fall back to the
 * brokered flow", not "crash the boot".
 */
export function nativeOidcFromProviders(body: unknown): KeycloakOidcConfig | null {
  const providers = (body as any)?.providers

  if (!Array.isArray(providers)) {
    return null
  }

  for (const entry of providers) {
    const native = entry?.native_oidc

    if (!native || native.confidential) {
      continue
    }

    const issuer = String(native.issuer || '')
    const clientId = String(native.client_id || '')

    if (!issuer || !clientId) {
      continue
    }

    return { issuer, clientId, scopes: String(native.scopes || 'openid profile email') }
  }

  return null
}

/**
 * RP-initiated logout URL, so signing out of Workmate also drops the Keycloak
 * SSO session rather than silently signing straight back in.
 *
 * Needs `id_token_hint`, which is why this lives here and not in the Python
 * provider's `revoke_session` — that method is only ever handed a refresh token.
 * Returns '' when the realm advertises no end-session endpoint; the caller then
 * just clears local state.
 */
export function buildEndSessionUrl(endpoints: KeycloakEndpoints, idToken: string): string {
  if (!endpoints.endSessionEndpoint) {
    return ''
  }

  const q = new URLSearchParams()

  if (idToken) {
    q.set('id_token_hint', idToken)
  }

  const query = q.toString()
  const sep = endpoints.endSessionEndpoint.includes('?') ? '&' : '?'

  return query ? `${endpoints.endSessionEndpoint}${sep}${query}` : endpoints.endSessionEndpoint
}
