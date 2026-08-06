/**
 * Tests for electron/keycloak-login.ts — the loopback-listener orchestration of
 * the desktop's direct Keycloak sign-in, with every side effect injected (fake
 * http server, fake openExternal, fake discovery GET and token POST) so no real
 * socket or browser is involved.
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { describe, test } from 'vitest'

import { refreshKeycloakSession, runKeycloakLogin } from './keycloak-login'
import { KEYCLOAK_CALLBACK_PORTS, type KeycloakOidcConfig } from './keycloak-oidc'

const ISSUER = 'https://agentx.example.com/auth/realms/agent-hub'

const CONFIG: KeycloakOidcConfig = {
  issuer: ISSUER,
  clientId: 'agentx-workmate',
  scopes: 'openid profile email'
}

const DISCOVERY_DOC = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
  token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
  end_session_endpoint: `${ISSUER}/protocol/openid-connect/logout`
}

function b64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fakeIdToken(claims: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: 'RS256' }))}.${b64url(JSON.stringify(claims))}.sig`
}

const ID_TOKEN = fakeIdToken({ sub: 'kien-uuid', exp: 1_800_000_000 })

/**
 * A fake http.Server that records which ports were attempted and lets a test
 * drive a synthetic browser callback.
 *
 * `busyPorts` makes `listen` emit EADDRINUSE so the port-fallback ladder can be
 * exercised without occupying real sockets.
 */
function makeFakeServerFactory(opts: { busyPorts?: number[] } = {}) {
  const busy = new Set(opts.busyPorts || [])
  const state: any = { handler: null, attempted: [], boundPort: null, closed: false, responses: [] }

  const createServer: any = (handler: any) => {
    state.handler = handler
    const server: any = new EventEmitter()

    server.listen = (port: number, _host: string, cb: () => void) => {
      state.attempted.push(port)

      if (busy.has(port)) {
        const err: NodeJS.ErrnoException = new Error(`listen EADDRINUSE :::${port}`)

        err.code = 'EADDRINUSE'
        // Async, like the real thing.
        setImmediate(() => server.emit('error', err))

        return server
      }

      state.boundPort = port
      setImmediate(cb)

      return server
    }

    server.close = () => {
      state.closed = true
    }

    state.server = server

    return server
  }

  /** Drive a browser hitting the loopback callback. */
  state.callback = (query: string) => {
    const res = { writeHead: () => undefined, end: (body: string) => state.responses.push(body) }

    state.handler({ url: `/callback${query}` }, res)
  }

  return { createServer, state }
}

function makeDeps(overrides: Record<string, any> = {}) {
  const openedUrls: string[] = []
  const posted: any[] = []

  return {
    openedUrls,
    posted,
    deps: {
      openExternal: async (url: string) => {
        openedUrls.push(url)
      },
      getJson: async () => DISCOVERY_DOC,
      postForm: async (url: string, form: Record<string, string>) => {
        posted.push({ url, form })

        return { id_token: ID_TOKEN, refresh_token: 'rt-1', expires_in: 1800 }
      },
      now: () => 1_000,
      timeoutMs: 50,
      rememberLog: () => undefined,
      ...overrides
    } as any
  }
}

/** Let the fake server's setImmediate callbacks run. */
const tick = () => new Promise(resolve => setImmediate(resolve))

describe('runKeycloakLogin', () => {
  test('completes the round trip and returns the token set', async () => {
    const { createServer, state } = makeFakeServerFactory()
    const { deps, openedUrls, posted } = makeDeps({ createServer, timeoutMs: 5_000 })

    const pending = runKeycloakLogin(CONFIG, deps)

    await tick()
    await tick()

    const authorizeUrl = new URL(openedUrls[0])
    const stateParam = authorizeUrl.searchParams.get('state') || ''

    state.callback(`?code=the-code&state=${encodeURIComponent(stateParam)}`)

    const tokens = await pending

    assert.equal(tokens.accessToken, ID_TOKEN)
    assert.equal(tokens.userId, 'kien-uuid')
    assert.equal(tokens.provider, 'keycloak')
    assert.equal(posted[0].form.code, 'the-code')
    assert.equal(posted[0].form.grant_type, 'authorization_code')
    assert.equal(state.closed, true)
  })

  test('redirect_uri is the port actually bound, and matches the token exchange', async () => {
    const { createServer, state } = makeFakeServerFactory({ busyPorts: [KEYCLOAK_CALLBACK_PORTS[0]] })
    const { deps, openedUrls, posted } = makeDeps({ createServer, timeoutMs: 5_000 })

    const pending = runKeycloakLogin(CONFIG, deps)

    await tick()
    await tick()
    await tick()

    const authorizeUrl = new URL(openedUrls[0])
    const expected = `http://127.0.0.1:${KEYCLOAK_CALLBACK_PORTS[1]}/callback`

    assert.equal(authorizeUrl.searchParams.get('redirect_uri'), expected)

    state.callback(`?code=c&state=${encodeURIComponent(authorizeUrl.searchParams.get('state') || '')}`)
    await pending

    // Keycloak requires the redirect_uri on the exchange to match the one on
    // the authorize request exactly.
    assert.equal(posted[0].form.redirect_uri, expected)
  })

  test('falls through every busy port in order', async () => {
    const { createServer, state } = makeFakeServerFactory({
      busyPorts: [KEYCLOAK_CALLBACK_PORTS[0], KEYCLOAK_CALLBACK_PORTS[1]]
    })

    const { deps } = makeDeps({ createServer, timeoutMs: 5_000 })

    const pending = runKeycloakLogin(CONFIG, deps)

    await tick()
    await tick()
    await tick()
    await tick()

    assert.deepEqual(state.attempted, [...KEYCLOAK_CALLBACK_PORTS])
    assert.equal(state.boundPort, KEYCLOAK_CALLBACK_PORTS[2])

    pending.catch(() => undefined)
  })

  test('names the ports when all of them are taken', async () => {
    const { createServer } = makeFakeServerFactory({ busyPorts: [...KEYCLOAK_CALLBACK_PORTS] })
    const { deps } = makeDeps({ createServer })

    await assert.rejects(runKeycloakLogin(CONFIG, deps), /47821, 47822, 47823/)
  })

  test('a mismatched state aborts before the code is redeemed', async () => {
    const { createServer, state } = makeFakeServerFactory()
    const { deps, posted } = makeDeps({ createServer, timeoutMs: 5_000 })

    const pending = runKeycloakLogin(CONFIG, deps)

    await tick()
    await tick()

    state.callback('?code=injected&state=attacker-supplied')

    await assert.rejects(pending, /state mismatch/)
    assert.equal(posted.length, 0, 'a forged callback must never reach the token endpoint')
  })

  test('surfaces an error param from Keycloak', async () => {
    const { createServer, state } = makeFakeServerFactory()
    const { deps } = makeDeps({ createServer, timeoutMs: 5_000 })

    const pending = runKeycloakLogin(CONFIG, deps)

    await tick()
    await tick()

    state.callback('?error=access_denied&error_description=User%20said%20no')

    await assert.rejects(pending, /access_denied/)
  })

  test('times out and tears the listener down', async () => {
    const { createServer, state } = makeFakeServerFactory()
    const { deps } = makeDeps({ createServer, timeoutMs: 10 })

    await assert.rejects(runKeycloakLogin(CONFIG, deps), /timed out/)
    assert.equal(state.closed, true)
  })

  test('the browser page never contains a token', async () => {
    const { createServer, state } = makeFakeServerFactory()
    const { deps, openedUrls } = makeDeps({ createServer, timeoutMs: 5_000 })

    const pending = runKeycloakLogin(CONFIG, deps)

    await tick()
    await tick()

    const stateParam = new URL(openedUrls[0]).searchParams.get('state') || ''

    state.callback(`?code=the-code&state=${encodeURIComponent(stateParam)}`)
    await pending

    const page = state.responses.join('')

    assert.ok(!page.includes(ID_TOKEN))
    assert.ok(!page.includes('rt-1'))
    assert.ok(!page.includes('the-code'))
  })

  test('ignores favicon noise and keeps waiting for the code', async () => {
    const { createServer, state } = makeFakeServerFactory()
    const { deps, openedUrls } = makeDeps({ createServer, timeoutMs: 5_000 })

    const pending = runKeycloakLogin(CONFIG, deps)

    await tick()
    await tick()

    state.handler({ url: '/favicon.ico' }, { writeHead: () => undefined, end: () => undefined })

    const stateParam = new URL(openedUrls[0]).searchParams.get('state') || ''

    state.callback(`?code=c&state=${encodeURIComponent(stateParam)}`)

    assert.equal((await pending).accessToken, ID_TOKEN)
  })

  test('a failed browser launch fails the login instead of hanging', async () => {
    const { createServer } = makeFakeServerFactory()

    const { deps } = makeDeps({
      createServer,
      timeoutMs: 5_000,
      openExternal: async () => {
        throw new Error('no browser')
      }
    })

    await assert.rejects(runKeycloakLogin(CONFIG, deps), /Could not open the system browser/)
  })

  test('a bad discovery document fails before any listener is bound', async () => {
    const { createServer, state } = makeFakeServerFactory()

    const { deps } = makeDeps({
      createServer,
      getJson: async () => ({ ...DISCOVERY_DOC, issuer: 'https://evil.example/realms/x' })
    })

    await assert.rejects(runKeycloakLogin(CONFIG, deps), /issuer mismatch/)
    assert.deepEqual(state.attempted, [])
  })
})

describe('refreshKeycloakSession', () => {
  test('exchanges the refresh token for a new set', async () => {
    const { deps, posted } = makeDeps()
    const tokens = await refreshKeycloakSession(CONFIG, 'rt-old', deps)

    assert.equal(tokens.accessToken, ID_TOKEN)
    assert.equal(tokens.refreshToken, 'rt-1')
    assert.equal(posted[0].form.grant_type, 'refresh_token')
    assert.equal(posted[0].form.refresh_token, 'rt-old')
  })

  test('keeps the old refresh token when the realm does not rotate', async () => {
    const { deps } = makeDeps({
      postForm: async () => ({ id_token: ID_TOKEN })
    })

    assert.equal((await refreshKeycloakSession(CONFIG, 'rt-old', deps)).refreshToken, 'rt-old')
  })

  test('refuses without a stored refresh token', async () => {
    const { deps } = makeDeps()

    await assert.rejects(refreshKeycloakSession(CONFIG, '', deps), /No Keycloak refresh token/)
  })

  test('propagates a rejection so the caller can distinguish dead from offline', async () => {
    const { deps } = makeDeps({
      postForm: async () => {
        throw new Error('invalid_grant')
      }
    })

    await assert.rejects(refreshKeycloakSession(CONFIG, 'rt', deps), /invalid_grant/)
  })
})
