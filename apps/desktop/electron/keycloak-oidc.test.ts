/**
 * Tests for electron/keycloak-oidc.ts — the pure half of the desktop's direct
 * Keycloak sign-in. No network, no Electron.
 */

import assert from 'node:assert/strict'

import { describe, test } from 'vitest'

import {
  buildEndSessionUrl,
  buildKeycloakAuthorizeUrl,
  buildKeycloakRefreshBody,
  buildKeycloakTokenBody,
  callbackRedirectUri,
  discoveryUrl,
  KEYCLOAK_CALLBACK_PATH,
  KEYCLOAK_CALLBACK_PORTS,
  type KeycloakEndpoints,
  type KeycloakOidcConfig,
  nativeOidcFromProviders,
  parseDiscovery,
  parseKeycloakTokenResponse
} from './keycloak-oidc'

const ISSUER = 'https://agentx.example.com/auth/realms/agent-hub'

const CONFIG: KeycloakOidcConfig = {
  issuer: ISSUER,
  clientId: 'agentx-workmate',
  scopes: 'openid profile email'
}

const ENDPOINTS: KeycloakEndpoints = {
  authorizationEndpoint: `${ISSUER}/protocol/openid-connect/auth`,
  tokenEndpoint: `${ISSUER}/protocol/openid-connect/token`,
  endSessionEndpoint: `${ISSUER}/protocol/openid-connect/logout`
}

const DISCOVERY_DOC = {
  issuer: ISSUER,
  authorization_endpoint: ENDPOINTS.authorizationEndpoint,
  token_endpoint: ENDPOINTS.tokenEndpoint,
  end_session_endpoint: ENDPOINTS.endSessionEndpoint
}

function b64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** A structurally-valid unsigned JWT. Signature is never checked client-side. */
function fakeIdToken(claims: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}.sig`
}

describe('discoveryUrl', () => {
  test('appends the well-known path', () => {
    assert.equal(discoveryUrl(ISSUER), `${ISSUER}/.well-known/openid-configuration`)
  })

  test('tolerates a trailing slash', () => {
    assert.equal(discoveryUrl(`${ISSUER}/`), `${ISSUER}/.well-known/openid-configuration`)
  })
})

describe('callback ports', () => {
  test('are fixed, because Keycloak has to have them pre-registered', () => {
    assert.deepEqual([...KEYCLOAK_CALLBACK_PORTS], [47821, 47822, 47823])
    assert.equal(KEYCLOAK_CALLBACK_PATH, '/callback')
  })

  test('build a loopback redirect URI', () => {
    assert.equal(callbackRedirectUri(47821), 'http://127.0.0.1:47821/callback')
  })
})

describe('parseDiscovery', () => {
  test('extracts the endpoints', () => {
    const parsed = parseDiscovery(DISCOVERY_DOC, ISSUER)

    assert.equal(parsed.tokenEndpoint, ENDPOINTS.tokenEndpoint)
    assert.equal(parsed.authorizationEndpoint, ENDPOINTS.authorizationEndpoint)
    assert.equal(parsed.endSessionEndpoint, ENDPOINTS.endSessionEndpoint)
  })

  test('tolerates a trailing-slash difference on the issuer', () => {
    const parsed = parseDiscovery({ ...DISCOVERY_DOC, issuer: `${ISSUER}/` }, ISSUER)

    assert.equal(parsed.tokenEndpoint, ENDPOINTS.tokenEndpoint)
  })

  test('rejects an issuer mismatch', () => {
    assert.throws(
      () => parseDiscovery({ ...DISCOVERY_DOC, issuer: 'https://evil.example/realms/agent-hub' }, ISSUER),
      /issuer mismatch/
    )
  })

  test('rejects a cleartext endpoint', () => {
    assert.throws(
      () => parseDiscovery({ ...DISCOVERY_DOC, token_endpoint: 'http://agentx.example.com/token' }, ISSUER),
      /must be https/
    )
  })

  test('allows http on loopback, for a local dev realm', () => {
    const local = 'http://localhost:8080/realms/agent-hub'
    const parsed = parseDiscovery(
      {
        issuer: local,
        authorization_endpoint: `${local}/protocol/openid-connect/auth`,
        token_endpoint: `${local}/protocol/openid-connect/token`
      },
      local
    )

    assert.equal(parsed.tokenEndpoint, `${local}/protocol/openid-connect/token`)
  })

  test('rejects a document missing the endpoints', () => {
    assert.throws(() => parseDiscovery({ issuer: ISSUER }, ISSUER), /missing/)
  })

  test('rejects a non-object body', () => {
    assert.throws(() => parseDiscovery(null, ISSUER), /missing/)
  })

  test('an absent end_session_endpoint is empty, not an error', () => {
    const parsed = parseDiscovery(
      { ...DISCOVERY_DOC, end_session_endpoint: undefined },
      ISSUER
    )

    assert.equal(parsed.endSessionEndpoint, '')
  })
})

describe('buildKeycloakAuthorizeUrl', () => {
  const url = buildKeycloakAuthorizeUrl(ENDPOINTS, CONFIG, {
    codeChallenge: 'chal',
    state: 'st8',
    redirectUri: 'http://127.0.0.1:47821/callback',
    nonce: 'n0nce'
  })
  const params = new URL(url).searchParams

  test('requests an authorization code with PKCE S256', () => {
    assert.equal(params.get('response_type'), 'code')
    assert.equal(params.get('code_challenge'), 'chal')
    assert.equal(params.get('code_challenge_method'), 'S256')
  })

  test('carries client, redirect, scope, state and nonce', () => {
    assert.equal(params.get('client_id'), 'agentx-workmate')
    assert.equal(params.get('redirect_uri'), 'http://127.0.0.1:47821/callback')
    assert.equal(params.get('scope'), 'openid profile email')
    assert.equal(params.get('state'), 'st8')
    assert.equal(params.get('nonce'), 'n0nce')
  })

  test('never sends a client secret', () => {
    assert.equal(params.get('client_secret'), null)
  })

  test('defaults the scope when none is configured', () => {
    const bare = buildKeycloakAuthorizeUrl(
      ENDPOINTS,
      { ...CONFIG, scopes: '' },
      { codeChallenge: 'c', state: 's', redirectUri: 'http://127.0.0.1:47821/callback', nonce: 'n' }
    )

    assert.equal(new URL(bare).searchParams.get('scope'), 'openid profile email')
  })

  test('appends to an endpoint that already has a query string', () => {
    const withQuery = buildKeycloakAuthorizeUrl(
      { ...ENDPOINTS, authorizationEndpoint: `${ENDPOINTS.authorizationEndpoint}?tab=1` },
      CONFIG,
      { codeChallenge: 'c', state: 's', redirectUri: 'http://127.0.0.1:47821/callback', nonce: 'n' }
    )
    const q = new URL(withQuery).searchParams

    assert.equal(q.get('tab'), '1')
    assert.equal(q.get('response_type'), 'code')
  })
})

describe('token request bodies', () => {
  test('the code exchange carries the verifier and no secret', () => {
    const body = buildKeycloakTokenBody(CONFIG, {
      code: 'the-code',
      codeVerifier: 'the-verifier',
      redirectUri: 'http://127.0.0.1:47821/callback'
    })

    assert.equal(body.grant_type, 'authorization_code')
    assert.equal(body.code, 'the-code')
    assert.equal(body.code_verifier, 'the-verifier')
    assert.equal(body.redirect_uri, 'http://127.0.0.1:47821/callback')
    assert.equal(body.client_secret, undefined)
  })

  test('the refresh grant carries no secret either', () => {
    const body = buildKeycloakRefreshBody(CONFIG, 'rt-1')

    assert.equal(body.grant_type, 'refresh_token')
    assert.equal(body.refresh_token, 'rt-1')
    assert.equal(body.client_secret, undefined)
  })
})

describe('parseKeycloakTokenResponse', () => {
  const exp = 1_800_000_000

  test('stores the ID token, not the opaque access token', () => {
    const idToken = fakeIdToken({ sub: 'user-1', exp })
    const parsed = parseKeycloakTokenResponse(
      { access_token: 'opaque-at', id_token: idToken, refresh_token: 'rt', expires_in: 1800 },
      1_000
    )

    // The backend verifies the ID token — its aud is our client_id, which is
    // the check that stops another client's token being replayed here.
    assert.equal(parsed.accessToken, idToken)
    assert.notEqual(parsed.accessToken, 'opaque-at')
    assert.equal(parsed.refreshToken, 'rt')
    assert.equal(parsed.provider, 'keycloak')
    assert.equal(parsed.userId, 'user-1')
  })

  test('takes expiry from the token exp, not from expires_in', () => {
    const parsed = parseKeycloakTokenResponse(
      { id_token: fakeIdToken({ sub: 's', exp }), expires_in: 1800 },
      1_000
    )

    // expires_in would have produced 2800 — and drifted against clock skew.
    assert.equal(parsed.expiresAt, exp)
  })

  test('falls back to expires_in when the token carries no exp', () => {
    const parsed = parseKeycloakTokenResponse({ id_token: fakeIdToken({ sub: 's' }), expires_in: 1800 }, 1_000)

    assert.equal(parsed.expiresAt, 2_800)
  })

  test('throws when there is no id_token', () => {
    assert.throws(() => parseKeycloakTokenResponse({ access_token: 'at' }, 0), /openid/)
  })

  test('throws on a malformed id_token', () => {
    assert.throws(() => parseKeycloakTokenResponse({ id_token: 'nope' }, 0), /malformed/)
  })

  test('carries the identity claims the account panel shows', () => {
    // Without these the app can only show an opaque subject UUID, which is not
    // an answer to "who am I signed in as".
    const idToken = fakeIdToken({
      sub: 'kc-sub-1',
      exp,
      email: 'kienlt1@astralx.com.vn',
      name: 'Le Trung Kien',
      preferred_username: 'kienlt1'
    })
    const parsed = parseKeycloakTokenResponse({ id_token: idToken }, 0)

    assert.equal(parsed.email, 'kienlt1@astralx.com.vn')
    assert.equal(parsed.displayName, 'Le Trung Kien')
  })

  test('falls back to preferred_username, then email, for the display name', () => {
    const noName = parseKeycloakTokenResponse(
      { id_token: fakeIdToken({ sub: 's', exp, email: 'a@b.c', preferred_username: 'kienlt1' }) },
      0
    )
    assert.equal(noName.displayName, 'kienlt1')

    const emailOnly = parseKeycloakTokenResponse({ id_token: fakeIdToken({ sub: 's', exp, email: 'a@b.c' }) }, 0)
    assert.equal(emailOnly.displayName, 'a@b.c')
  })

  test('omits identity keys entirely when the realm withholds them', () => {
    // Absent, not blank: the brokered flow's token set has no identity at all,
    // and empty keys would change a shape other code round-trips and compares.
    const parsed = parseKeycloakTokenResponse({ id_token: fakeIdToken({ sub: 's', exp }) }, 0)

    assert.equal('email' in parsed, false)
    assert.equal('displayName' in parsed, false)
  })

  test('a missing refresh token is empty, not undefined', () => {
    const parsed = parseKeycloakTokenResponse({ id_token: fakeIdToken({ sub: 's', exp }) }, 0)

    assert.equal(parsed.refreshToken, '')
  })
})

describe('nativeOidcFromProviders', () => {
  const entry = {
    name: 'keycloak',
    display_name: 'AgentX',
    supports_native_oidc: true,
    native_oidc: { issuer: ISSUER, client_id: 'agentx-workmate', scopes: 'openid email', confidential: false }
  }

  test('picks the first usable provider', () => {
    const cfg = nativeOidcFromProviders({ providers: [{ name: 'basic', native_oidc: null }, entry] })

    assert.deepEqual(cfg, { issuer: ISSUER, clientId: 'agentx-workmate', scopes: 'openid email' })
  })

  test('skips a confidential client', () => {
    // A public-client PKCE exchange cannot authenticate as a confidential
    // client, so this must fall back to the brokered flow rather than start a
    // sign-in that can only fail at the token endpoint.
    const confidential = { ...entry, native_oidc: { ...entry.native_oidc, confidential: true } }

    assert.equal(nativeOidcFromProviders({ providers: [confidential] }), null)
  })

  test('skips an entry missing issuer or client_id', () => {
    const noIssuer = { ...entry, native_oidc: { ...entry.native_oidc, issuer: '' } }

    assert.equal(nativeOidcFromProviders({ providers: [noIssuer] }), null)
  })

  test('returns null for a body with no providers', () => {
    assert.equal(nativeOidcFromProviders({ providers: [] }), null)
    assert.equal(nativeOidcFromProviders({}), null)
    assert.equal(nativeOidcFromProviders(null), null)
  })

  test('defaults the scopes when the backend omits them', () => {
    const noScopes = { ...entry, native_oidc: { ...entry.native_oidc, scopes: '' } }

    assert.equal(nativeOidcFromProviders({ providers: [noScopes] })?.scopes, 'openid profile email')
  })
})

describe('buildEndSessionUrl', () => {
  test('carries the id_token_hint Keycloak needs to end the SSO session', () => {
    const url = buildEndSessionUrl(ENDPOINTS, 'the-id-token')

    assert.equal(new URL(url).searchParams.get('id_token_hint'), 'the-id-token')
  })

  test('is empty when the realm advertises no endpoint', () => {
    assert.equal(buildEndSessionUrl({ ...ENDPOINTS, endSessionEndpoint: '' }, 'tok'), '')
  })

  test('omits the hint when there is no token to give', () => {
    assert.equal(buildEndSessionUrl(ENDPOINTS, ''), ENDPOINTS.endSessionEndpoint)
  })
})
