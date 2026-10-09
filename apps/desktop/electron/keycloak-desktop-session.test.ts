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
import { keycloakStorageKey, loadKeycloakSession, persistKeycloakSession } from './keycloak-session-store'
import type { NativeTokenStoreIo } from './native-token-store'

const ISSUER = 'https://agentx.example.com/auth/realms/agent-hub'

const CONFIG: KeycloakOidcConfig = { issuer: ISSUER, clientId: 'agentx-workmate', scopes: 'openid profile email' }

const DISCOVERY_DOC = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
  token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
  end_session_endpoint: `${ISSUER}/protocol/openid-connect/logout`
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

describe('ensureKeycloakSession with session_days', () => {
  const DAY = 86_400
  const POLICY: KeycloakOidcConfig = { ...CONFIG, sessionDays: 14 }

  let store: ReturnType<typeof makeStore>
  let posts: Array<{ url: string; form: Record<string, string> }>
  let authorizeScopes: string[]
  let logs: string[]

  beforeEach(() => {
    store = makeStore()
    posts = []
    authorizeScopes = []
    logs = []
  })

  /** The background logout is not awaited by the ladder; let it land. */
  const settle = () => new Promise(resolve => setImmediate(resolve))

  /** Deps for paths that must not open a browser. Refreshes answer with no `scope`. */
  function quietDeps(overrides: Record<string, any> = {}) {
    return {
      store,
      now: () => NOW,
      getJson: async () => DISCOVERY_DOC,
      postForm: async (url: string, form: Record<string, string>) => {
        posts.push({ url, form })

        return { id_token: idTokenExpiring(NOW + 900), refresh_token: 'rt-rotated' }
      },
      openExternal: async () => {
        throw new Error('no browser expected in this test')
      },
      createServer: (() => {
        throw new Error('no browser expected in this test')
      }) as any,
      rememberLog: (line: string) => logs.push(line),
      ...overrides
    } as any
  }

  /**
   * Deps that drive the browser round trip. `answer` picks the callback query
   * for the n-th authorize URL opened. The token endpoint grants whatever scope
   * that URL asked for, as Keycloak does.
   */
  function browserDeps(answer: (n: number, state: string) => string, overrides: Record<string, any> = {}) {
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

    return quietDeps({
      createServer,
      openExternal: async (url: string) => {
        const params = new URL(url).searchParams

        authorizeScopes.push(params.get('scope') || '')

        const query = answer(authorizeScopes.length, encodeURIComponent(params.get('state') || ''))

        setImmediate(() => handler({ url: `/callback?${query}` }, { writeHead: () => undefined, end: () => undefined }))
      },
      postForm: async (url: string, form: Record<string, string>) => {
        posts.push({ url, form })

        return {
          id_token: idTokenExpiring(NOW + 900),
          refresh_token: 'rt-new',
          scope: authorizeScopes[authorizeScopes.length - 1]
        }
      },
      ...overrides
    })
  }

  const signInAnswer = (_n: number, state: string) => `code=c&state=${state}`

  test('asks Keycloak for an offline session and starts the clock at the sign-in', async () => {
    const result = await ensureKeycloakSession(POLICY, browserDeps(signInAnswer))

    assert.equal(result.outcome, 'signed-in')
    assert.match(authorizeScopes[0], /\boffline_access\b/)
    assert.equal(result.tokens?.signedInAt, NOW)
    assert.equal(result.tokens?.offline, true)

    // Both survive the encrypted store, or the next launch forgets the limit.
    const reloaded = loadKeycloakSession(POLICY, store)

    assert.equal(reloaded?.signedInAt, NOW)
    assert.equal(reloaded?.offline, true)
  })

  test('without session_days, signs in the browser-bound way it always did', async () => {
    const result = await ensureKeycloakSession(CONFIG, browserDeps(signInAnswer))

    assert.equal(result.outcome, 'signed-in')
    assert.doesNotMatch(authorizeScopes[0], /offline_access/)
    assert.equal(result.tokens?.offline, undefined)
  })

  test('signs in without an offline session when the client may not ask for one', async () => {
    // Keycloak answers invalid_scope before the login page when the client
    // lacks the offline_access scope. Locking the person out over it would be
    // worse than a sign-in that lasts a day.
    const result = await ensureKeycloakSession(
      POLICY,
      browserDeps((n, state) =>
        n === 1 ? `error=invalid_scope&error_description=Invalid+scopes&state=${state}` : `code=c&state=${state}`
      )
    )

    assert.equal(result.outcome, 'signed-in')
    assert.equal(authorizeScopes.length, 2)
    assert.match(authorizeScopes[0], /offline_access/)
    assert.doesNotMatch(authorizeScopes[1], /offline_access/)
    assert.equal(result.tokens?.offline, undefined)
    assert.ok(logs.some(line => line.includes('refused an offline session')))
  })

  test('signs in without an offline session when Keycloak will not give this person one', async () => {
    // A user without the offline_access role passes the login page and is
    // refused at the token endpoint instead.
    let exchanges = 0

    const result = await ensureKeycloakSession(
      POLICY,
      browserDeps(signInAnswer, {
        postForm: async (url: string, form: Record<string, string>) => {
          posts.push({ url, form })
          exchanges += 1

          if (exchanges === 1) {
            throw new HttpError('Keycloak rejected the request: not_allowed', 400)
          }

          return { id_token: idTokenExpiring(NOW + 900), refresh_token: 'rt-bound' }
        }
      })
    )

    assert.equal(result.outcome, 'signed-in')
    assert.equal(authorizeScopes.length, 2)
    assert.equal(result.tokens?.refreshToken, 'rt-bound')
  })

  test('any other sign-in failure is not retried', async () => {
    await assert.rejects(
      ensureKeycloakSession(
        POLICY,
        browserDeps((_n, state) => `error=access_denied&state=${state}`)
      ),
      /access_denied/
    )

    assert.equal(authorizeScopes.length, 1)
  })

  test('refreshing an offline session keeps asking for it and keeps the sign-in time', async () => {
    persistKeycloakSession(POLICY, tokenSet({ expiresAt: NOW + 10, signedInAt: NOW - 3 * DAY, offline: true }), store)

    const result = await ensureKeycloakSession(POLICY, quietDeps())

    assert.equal(result.outcome, 'refreshed')
    assert.match(posts[0].form.scope, /\boffline_access\b/)
    assert.equal(result.tokens?.refreshToken, 'rt-rotated')
    // A refresh is not a sign-in: the 14 days still count from the browser.
    assert.equal(result.tokens?.signedInAt, NOW - 3 * DAY)
    assert.equal(result.tokens?.offline, true)
  })

  test('a sign-in that reached the limit ends at launch, at Keycloak too', async () => {
    // Still valid as far as the token goes; the limit is this install's call.
    persistKeycloakSession(
      POLICY,
      tokenSet({ signedInAt: NOW - 14 * DAY, offline: true, refreshToken: 'rt-old' }),
      store
    )

    const result = await ensureKeycloakSession(POLICY, quietDeps({ interactive: false }))

    assert.equal(result.outcome, 'needs-login')
    assert.equal(result.tokens, null)
    assert.equal(loadKeycloakSession(POLICY, store), null)

    await settle()

    // Ended by refresh token at the logout endpoint, which ends this sign-in
    // only, not the person's sessions on their other machines.
    assert.deepEqual(posts, [
      {
        url: DISCOVERY_DOC.end_session_endpoint,
        form: { client_id: 'agentx-workmate', refresh_token: 'rt-old' }
      }
    ])
    assert.ok(logs.some(line => line.includes('14-day limit')))
  })

  test('a day short of the limit, the sign-in carries on', async () => {
    persistKeycloakSession(POLICY, tokenSet({ signedInAt: NOW - 13 * DAY, offline: true }), store)

    const result = await ensureKeycloakSession(POLICY, quietDeps({ interactive: false }))

    assert.equal(result.outcome, 'stored')
    assert.deepEqual(posts, [])
  })

  test('the limit is not enforced while the app is running', async () => {
    // The Sign in screen lives on the boot path. Ending the sign-in mid-session
    // would only make requests fail in the middle of someone's work.
    persistKeycloakSession(POLICY, tokenSet({ expiresAt: NOW + 10, signedInAt: NOW - 15 * DAY, offline: true }), store)

    const result = await ensureKeycloakSession(POLICY, quietDeps({ interactive: false, enforceSignInPolicy: false }))

    assert.equal(result.outcome, 'refreshed')
  })

  test('turning session_days off ends an offline sign-in at the next launch', async () => {
    persistKeycloakSession(CONFIG, tokenSet({ signedInAt: NOW - DAY, offline: true, refreshToken: 'rt-old' }), store)

    const result = await ensureKeycloakSession(CONFIG, quietDeps({ interactive: false }))

    assert.equal(result.outcome, 'needs-login')

    await settle()

    assert.equal(posts[0]?.form.refresh_token, 'rt-old')
  })

  test('a session stored before the limit existed is left to expire on its own', async () => {
    // No signedInAt, not offline: it is still bound to the browser session and
    // ends within the day, so there is nothing to enforce.
    persistKeycloakSession(POLICY, tokenSet(), store)

    const result = await ensureKeycloakSession(POLICY, quietDeps({ interactive: false }))

    assert.equal(result.outcome, 'stored')
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
