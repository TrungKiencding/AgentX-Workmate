/**
 * Tests for electron/keycloak-desktop-session.ts — the ladder that decides
 * whether the user is signed in, refreshed, or prompted.
 *
 * The branch that gets the most attention here is refresh failure: a rejected
 * refresh token means the session is over, while an unreachable Keycloak means
 * the network is down. Treating the second like the first signs people out
 * every time their wifi drops.
 */

import assert from 'node:assert/strict'

import { beforeEach, describe, test } from 'vitest'

import {
  _isRefreshUnreachable,
  discoverKeycloakConfig,
  ensureKeycloakSession,
  forgetKeycloakSession
} from './keycloak-desktop-session'
import type { KeycloakOidcConfig } from './keycloak-oidc'
import { keycloakStorageKey, persistKeycloakSession } from './keycloak-session-store'
import type { NativeTokenStoreIo } from './native-token-store'

const ISSUER = 'https://agentx.example.com/auth/realms/agent-hub'

const CONFIG: KeycloakOidcConfig = { issuer: ISSUER, clientId: 'agentx-workmate', scopes: 'openid profile email' }

const DISCOVERY_DOC = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
  token_endpoint: `${ISSUER}/protocol/openid-connect/token`
}

const NOW = 1_700_000_000

function b64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function idTokenExpiring(at: number): string {
  return `${b64url(JSON.stringify({ alg: 'RS256' }))}.${b64url(JSON.stringify({ sub: 'kien', exp: at }))}.sig`
}

function tokenSet(overrides: Record<string, unknown> = {}) {
  return {
    accessToken: idTokenExpiring(NOW + 3_600),
    refreshToken: 'rt-stored',
    expiresAt: NOW + 3_600,
    provider: 'keycloak',
    userId: 'kien',
    ...overrides
  } as any
}

function makeStore(): NativeTokenStoreIo & { text: string } {
  const io: any = {
    text: '',
    encrypt: (plaintext: string) => ({ encoding: 'test', value: `enc:${plaintext}` }),
    decrypt: (secret: any) => String(secret?.value || '').replace(/^enc:/, ''),
    readStoreText: () => io.text,
    writeStoreText: (text: string) => {
      io.text = text
    },
    rememberLog: () => undefined
  }

  return io
}

class HttpError extends Error {
  statusCode: number

  constructor(message: string, statusCode: number) {
    super(message)
    this.statusCode = statusCode
  }
}

describe('discoverKeycloakConfig', () => {
  test('returns the native config the backend publishes', async () => {
    const cfg = await discoverKeycloakConfig('http://127.0.0.1:1234', {
      getJson: async () => ({
        providers: [
          {
            name: 'keycloak',
            native_oidc: { issuer: ISSUER, client_id: 'agentx-workmate', scopes: 'openid', confidential: false }
          }
        ]
      })
    } as any)

    assert.deepEqual(cfg, { issuer: ISSUER, clientId: 'agentx-workmate', scopes: 'openid' })
  })

  test('an ungated backend reports no config rather than failing', async () => {
    const cfg = await discoverKeycloakConfig('http://127.0.0.1:1234', {
      getJson: async () => {
        throw new HttpError('Unauthorized', 401)
      },
      rememberLog: () => undefined
    } as any)

    assert.equal(cfg, null)
  })

  test('a 503 (no providers registered) reports no config', async () => {
    const cfg = await discoverKeycloakConfig('http://127.0.0.1:1234', {
      getJson: async () => {
        throw new HttpError('no auth providers registered', 503)
      },
      rememberLog: () => undefined
    } as any)

    assert.equal(cfg, null)
  })
})

describe('ensureKeycloakSession', () => {
  let store: ReturnType<typeof makeStore>
  let calls: string[]

  function deps(overrides: Record<string, any> = {}) {
    return {
      store,
      now: () => NOW,
      getJson: async () => DISCOVERY_DOC,
      postForm: async () => {
        calls.push('refresh')

        return { id_token: idTokenExpiring(NOW + 7_200), refresh_token: 'rt-rotated' }
      },
      openExternal: async () => {
        calls.push('browser')
      },
      createServer: (() => {
        throw new Error('interactive login not expected in this test')
      }) as any,
      rememberLog: () => undefined,
      ...overrides
    } as any
  }

  beforeEach(() => {
    store = makeStore()
    calls = []
  })

  test('a valid stored session is used as-is', async () => {
    persistKeycloakSession(CONFIG, tokenSet(), store)

    const result = await ensureKeycloakSession(CONFIG, deps())

    assert.equal(result.outcome, 'stored')
    assert.equal(result.tokens?.refreshToken, 'rt-stored')
    assert.deepEqual(calls, [], 'no network needed for a live session')
  })

  test('a near-expiry session is refreshed and persisted', async () => {
    persistKeycloakSession(CONFIG, tokenSet({ expiresAt: NOW + 10 }), store)

    const result = await ensureKeycloakSession(CONFIG, deps())

    assert.equal(result.outcome, 'refreshed')
    assert.equal(result.tokens?.refreshToken, 'rt-rotated')
    assert.deepEqual(calls, ['refresh'])
    // Persisted, so the next launch doesn't refresh again.
    assert.ok(store.text.includes(keycloakStorageKey(CONFIG)))
  })

  test('an offline refresh keeps the stored session instead of signing out', async () => {
    persistKeycloakSession(CONFIG, tokenSet({ expiresAt: NOW + 10 }), store)

    const result = await ensureKeycloakSession(
      CONFIG,
      deps({
        postForm: async () => {
          throw new Error('connect ECONNREFUSED')
        }
      })
    )

    assert.equal(result.outcome, 'stale-offline')
    assert.equal(result.tokens?.refreshToken, 'rt-stored')
    // Crucially, the session survived on disk.
    assert.ok(store.text.includes(keycloakStorageKey(CONFIG)))
  })

  test('a rejected refresh clears the session and asks for a sign-in', async () => {
    persistKeycloakSession(CONFIG, tokenSet({ expiresAt: NOW + 10 }), store)

    const result = await ensureKeycloakSession(
      CONFIG,
      deps({
        interactive: false,
        postForm: async () => {
          throw new HttpError('invalid_grant', 400)
        }
      })
    )

    assert.equal(result.outcome, 'needs-login')
    assert.equal(result.tokens, null)
    assert.ok(!store.text.includes(keycloakStorageKey(CONFIG)), 'the dead session must be dropped')
  })

  test('an expired session with no refresh token asks for a sign-in', async () => {
    persistKeycloakSession(CONFIG, tokenSet({ expiresAt: NOW - 10, refreshToken: '' }), store)

    const result = await ensureKeycloakSession(CONFIG, deps({ interactive: false }))

    assert.equal(result.outcome, 'needs-login')
    assert.deepEqual(calls, [], 'nothing to refresh with, so no call')
  })

  test('nothing stored, non-interactive, reports needs-login without a browser', async () => {
    const result = await ensureKeycloakSession(CONFIG, deps({ interactive: false }))

    assert.equal(result.outcome, 'needs-login')
    assert.equal(result.tokens, null)
    assert.deepEqual(calls, [], 'must not launch a browser at the user unannounced')
  })

  test('nothing stored, interactive, signs in and persists', async () => {
    let handler: any = null

    const createServer: any = (h: any) => {
      handler = h

      const server: any = {
        listen: (_port: number, _host: string, cb: () => void) => {
          setImmediate(cb)

          return server
        },
        once: () => server,
        on: () => server,
        removeListener: () => server,
        close: () => undefined
      }

      return server
    }

    const pending = ensureKeycloakSession(
      CONFIG,
      deps({
        createServer,
        openExternal: async (url: string) => {
          calls.push('browser')

          // Answer the loopback callback with the state the flow just generated.
          const state = new URL(url).searchParams.get('state') || ''

          setImmediate(() =>
            handler(
              { url: `/callback?code=c&state=${encodeURIComponent(state)}` },
              { writeHead: () => undefined, end: () => undefined }
            )
          )
        },
        postForm: async () => ({ id_token: idTokenExpiring(NOW + 7_200), refresh_token: 'rt-fresh' })
      })
    )

    const result = await pending

    assert.equal(result.outcome, 'signed-in')
    assert.equal(result.tokens?.refreshToken, 'rt-fresh')
    assert.deepEqual(calls, ['browser'])
    assert.ok(store.text.includes(keycloakStorageKey(CONFIG)))
  })

  test('a store failure does not throw away the sign-in the user just completed', async () => {
    // A locked or unavailable OS keychain must not undo a successful browser
    // round trip. Rethrowing here sent the user back to the sign-in screen in a
    // loop: the OAuth exchange succeeded every time, and nothing said why.
    let handler: any = null

    const createServer: any = (h: any) => {
      handler = h

      const server: any = {
        listen: (_port: number, _host: string, cb: () => void) => {
          setImmediate(cb)

          return server
        },
        once: () => server,
        on: () => server,
        removeListener: () => server,
        close: () => undefined
      }

      return server
    }

    const logs: string[] = []

    store.encrypt = () => {
      throw new Error('keychain is locked')
    }

    const result = await ensureKeycloakSession(
      CONFIG,
      deps({
        createServer,
        rememberLog: (line: string) => logs.push(line),
        openExternal: async (url: string) => {
          const state = new URL(url).searchParams.get('state') || ''

          setImmediate(() =>
            handler(
              { url: `/callback?code=c&state=${encodeURIComponent(state)}` },
              { writeHead: () => undefined, end: () => undefined }
            )
          )
        },
        postForm: async () => ({ id_token: idTokenExpiring(NOW + 7_200), refresh_token: 'rt-fresh' })
      })
    )

    // The session is usable for this run even though it could not be saved…
    assert.equal(result.outcome, 'signed-in')
    assert.equal(result.tokens?.refreshToken, 'rt-fresh')
    // …and the reason is on the record rather than swallowed.
    assert.ok(logs.some(line => line.includes('could not be saved')))
  })
})

describe('forgetKeycloakSession', () => {
  test('drops the stored session', () => {
    const store = makeStore()

    persistKeycloakSession(CONFIG, tokenSet(), store)
    forgetKeycloakSession(CONFIG, { store })

    assert.ok(!store.text.includes(keycloakStorageKey(CONFIG)))
  })
})

describe('isRefreshUnreachable', () => {
  test('an OAuth rejection is reachable — the session really is over', () => {
    assert.equal(_isRefreshUnreachable(new HttpError('invalid_grant', 400)), false)
    assert.equal(_isRefreshUnreachable(new HttpError('unauthorized', 401)), false)
    assert.equal(_isRefreshUnreachable(new Error('invalid_grant')), false)
  })

  test('transport failures and 5xx are unreachable', () => {
    assert.equal(_isRefreshUnreachable(new Error('connect ECONNREFUSED 10.0.0.1:443')), true)
    assert.equal(_isRefreshUnreachable(new Error('socket hang up')), true)
    assert.equal(_isRefreshUnreachable(new HttpError('Bad Gateway', 502)), true)
    assert.equal(_isRefreshUnreachable(new HttpError('Service Unavailable', 503)), true)
  })

  test('an unclassifiable error is treated as unreachable', () => {
    // Fail toward one wasted request, never toward a spurious sign-out.
    assert.equal(_isRefreshUnreachable(new Error('something went sideways')), true)
    assert.equal(_isRefreshUnreachable(null), true)
  })
})
