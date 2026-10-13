import { createServer, type IncomingHttpHeaders } from 'node:http'

import { describe, expect, it, vi } from 'vitest'

import { parseKeycloakTokenResponse } from './keycloak-oidc'
import { loadKeycloakSession, persistKeycloakSession } from './keycloak-session-store'
import type { NativeTokenStoreIo } from './native-token-store'
import { usageIdentityFromSession, UsageReporter } from './usage-reporter'

const identity = { subject: 'alice', token: 'synthetic-access', issuer: 'https://sso.example/auth/realms/test' }
describe('usage reporting', () => {
  it('deduplicates multiple windows and retries an identical event without content', async () => {
    const bodies: string[] = []

    const send = vi.fn(async (_url, init) => {
      bodies.push(init.body)

      return new Response('', { status: bodies.length === 1 ? 503 : 202 })
    })

    let now = 0

    const reporter = new UsageReporter({
      identity: async () => identity,
      version: '1.1.0',
      os: 'macOS',
      fetch: send as typeof fetch,
      now: () => now,
      sleep: async () => {}
    })

    reporter.begin('profile:session')
    reporter.begin('profile:session')
    now = 400
    expect(await reporter.end('profile:session', true)).toBe(true)
    expect(await reporter.end('profile:session', true)).toBe(false)
    expect(bodies[0]).toBe(bodies[1])
    const event = JSON.parse(bodies[0]).events[0]
    expect(event).toMatchObject({
      product: 'agentx-workmate',
      browser: 'Native',
      duration_ms: 400,
      outcome: 'failure',
      error_code: 'operation_failed'
    })
    expect(Object.keys(event).sort()).toEqual(
      [
        'browser',
        'duration_ms',
        'error_code',
        'event_id',
        'feature',
        'occurred_at',
        'os',
        'outcome',
        'product',
        'version'
      ].sort()
    )
  })
  it('does not attribute a completed turn to a different account or a cancellation', async () => {
    let current = identity
    const send = vi.fn()
    const reporter = new UsageReporter({ identity: async () => current, version: '1.1.0', os: 'Windows', fetch: send })
    reporter.begin('s')
    await Promise.resolve()
    current = { ...identity, subject: 'bob' }
    expect(await reporter.end('s', false)).toBe(false)
    reporter.begin('c')
    expect(await reporter.end('c', false, true)).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })
  it('exercises a real HTTP ingestion request and bearer headers', async () => {
    const received: { headers: Record<string, unknown>; body: string }[] = []

    const server = createServer((req, res) => {
      let body = ''
      req.on('data', chunk => (body += chunk))
      req.on('end', () => {
        received.push({ headers: req.headers, body })
        res.writeHead(202)
        res.end('{}')
      })
    })

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))

    try {
      const address = server.address() as { port: number }

      const reporter = new UsageReporter({
        identity: async () => ({ ...identity, issuer: `http://127.0.0.1:${address.port}/auth/realms/test` }),
        version: '1.1.0',
        os: 'Linux'
      })

      reporter.begin('s')
      expect(await reporter.end('s', false)).toBe(true)
      expect(received[0].headers.authorization).toBe('Bearer synthetic-access')
      expect(received[0].headers['x-sso-request']).toBe('1')
      expect(JSON.parse(received[0].body).events[0].outcome).toBe('success')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})

describe('usage identity', () => {
  it('uses the OAuth access token, never the ID token the backend gets', () => {
    const tokens = { userId: 'alice', accessToken: 'the-id-token', oauthAccessToken: 'the-access-token' }

    expect(usageIdentityFromSession(tokens, identity.issuer)).toEqual({
      subject: 'alice',
      token: 'the-access-token',
      issuer: identity.issuer
    })
  })

  it('keeps the account but no token for a session saved by an earlier release', () => {
    expect(usageIdentityFromSession({ userId: 'alice' }, identity.issuer)).toEqual({
      subject: 'alice',
      token: '',
      issuer: identity.issuer
    })
  })

  it('is nobody without a signed-in account', () => {
    expect(usageIdentityFromSession(null, identity.issuer)).toBeNull()
    expect(usageIdentityFromSession({ userId: '', oauthAccessToken: 'at' }, identity.issuer)).toBeNull()
  })

  it('sends nothing while the session has no access token', async () => {
    const send = vi.fn()

    const reporter = new UsageReporter({
      identity: async () => ({ ...identity, token: '' }),
      version: '1.1.1',
      os: 'macOS',
      fetch: send
    })

    reporter.begin('s')
    expect(await reporter.end('s', false)).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('counts a turn that began before the session gained its access token', async () => {
    let current = { ...identity, token: '' }
    const send = vi.fn(async () => new Response('', { status: 202 }))

    const reporter = new UsageReporter({ identity: async () => current, version: '1.1.1', os: 'macOS', fetch: send })

    reporter.begin('s')
    await Promise.resolve()
    current = identity
    expect(await reporter.end('s', false)).toBe(true)
    expect(send).toHaveBeenCalledTimes(1)
  })
})

describe('delivery failures in the desktop log', () => {
  function reporterAnswering(answer: () => Promise<Response>) {
    const lines: string[] = []

    const reporter = new UsageReporter({
      identity: async () => identity,
      version: '1.1.1',
      os: 'Windows',
      fetch: vi.fn(answer) as typeof fetch,
      sleep: async () => {},
      log: line => lines.push(line)
    })

    const turn = async (key: string) => {
      reporter.begin(key)

      return reporter.end(key, false)
    }

    return { lines, turn }
  }

  it('logs a refusal once, however many turns it hits, and never the token', async () => {
    const { lines, turn } = reporterAnswering(async () => new Response('', { status: 401 }))

    expect(await turn('a')).toBe(false)
    expect(await turn('b')).toBe(false)
    expect(lines).toEqual(['[usage] the SSO console refused usage metrics: HTTP 401'])
    expect(lines.join('\n')).not.toContain(identity.token)
  })

  it('logs an outage after the last retry with its status or error kind', async () => {
    const unavailable = reporterAnswering(async () => new Response('', { status: 503 }))

    expect(await unavailable.turn('a')).toBe(false)
    expect(unavailable.lines).toEqual(['[usage] usage metrics could not be delivered after 3 attempts: HTTP 503'])

    const offline = reporterAnswering(async () => {
      throw new TypeError('fetch failed')
    })

    expect(await offline.turn('a')).toBe(false)
    expect(offline.lines).toEqual(['[usage] usage metrics could not be delivered after 3 attempts: TypeError'])
  })

  it('logs nothing when the metrics are accepted', async () => {
    const { lines, turn } = reporterAnswering(async () => new Response('', { status: 202 }))

    expect(await turn('a')).toBe(true)
    expect(lines).toEqual([])
  })
})

/**
 * The SSO console's side of the contract, as its ingestion endpoint applies it.
 *
 * A Keycloak token is verified there, and then only an access token for an
 * allowed client gets in. An ID token is refused with 401. Workmate 1.1.0 sent
 * its ID token, and every event was lost.
 */
describe('SSO console contract', () => {
  const ISSUER = 'https://sso.example/auth/realms/agent-hub'
  const ALLOWED_CLIENTS = ['agentx-chat', 'agentx-workmate']

  function jwt(claims: Record<string, unknown>): string {
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

    return `${part({ alg: 'RS256', typ: 'JWT', kid: 'k1' })}.${part(claims)}.signature`
  }

  function claimsOf(token: string): Record<string, any> {
    return JSON.parse(Buffer.from(token.split('.')[1] || '', 'base64url').toString('utf8'))
  }

  /** A token response shaped like Keycloak's for the agentx-workmate client. */
  function keycloakTokenResponse() {
    const common = { iss: ISSUER, sub: 'kc-user-1', exp: 4_000_000_000, iat: 1_800_000_000, tenant_slug: 'acme' }

    return {
      id_token: jwt({ ...common, typ: 'ID', aud: 'agentx-workmate', azp: 'agentx-workmate' }),
      access_token: jwt({ ...common, typ: 'Bearer', aud: 'account', azp: 'agentx-workmate' }),
      refresh_token: jwt({ iss: ISSUER, sub: 'kc-user-1', typ: 'Refresh' }),
      expires_in: 1800,
      scope: 'openid profile email'
    }
  }

  function memoryStore(): NativeTokenStoreIo {
    let text = ''

    return {
      encrypt: plaintext => ({ encoding: 'test', value: Buffer.from(plaintext).toString('base64') }),
      decrypt: secret => Buffer.from(String(secret?.value || ''), 'base64').toString('utf8'),
      readStoreText: () => text,
      writeStoreText: value => {
        text = value
      }
    }
  }

  async function withConsole(run: (origin: string, seen: IncomingHttpHeaders[]) => Promise<void>) {
    const seen: IncomingHttpHeaders[] = []

    const server = createServer((req, res) => {
      let body = ''
      req.on('data', chunk => (body += chunk))
      req.on('end', () => {
        seen.push(req.headers)

        const claims = claimsOf(String(req.headers.authorization || '').replace(/^Bearer /, ''))
        const product = JSON.parse(body).events[0].product

        const reply = (status: number, value: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(value))
        }

        if (req.url !== '/sso/api/analytics/events' || req.headers['x-sso-request'] !== '1') {
          reply(403, { code: 'forbidden' })
        } else if (!ALLOWED_CLIENTS.includes(claims.azp) || claims.iss !== ISSUER) {
          reply(401, { code: 'telemetry.token_rejected', message: 'invalid or unauthorized token' })
        } else if (claims.typ !== 'Bearer') {
          reply(401, { code: 'telemetry.token_rejected', message: 'an access token is required' })
        } else if (product !== claims.azp && !(claims.azp === 'agentx-workmate' && product === 'agentx-webmate')) {
          reply(403, { code: 'telemetry.product_rejected' })
        } else {
          reply(202, { accepted: 1, duplicates: 0 })
        }
      })
    })

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))

    try {
      await run(`http://127.0.0.1:${(server.address() as { port: number }).port}`, seen)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }

  it('a session from Keycloak, saved and reloaded, delivers with its access token', async () => {
    await withConsole(async (origin, seen) => {
      const config = { issuer: ISSUER, clientId: 'agentx-workmate' }
      const store = memoryStore()

      persistKeycloakSession(config, parseKeycloakTokenResponse(keycloakTokenResponse(), 1_800_000_000), store)

      const session = loadKeycloakSession(config, store)
      const lines: string[] = []

      const reporter = new UsageReporter({
        identity: async () => usageIdentityFromSession(session, ISSUER),
        version: '1.1.1',
        os: 'macOS',
        // Production posts to the issuer's origin; send that request here instead.
        fetch: (url, init) => fetch(String(url).replace(new URL(ISSUER).origin, origin), init),
        log: line => lines.push(line)
      })

      reporter.begin('turn')
      expect(await reporter.end('turn', false)).toBe(true)
      expect(lines).toEqual([])

      const sent = claimsOf(String(seen[0].authorization).replace(/^Bearer /, ''))

      expect(sent).toMatchObject({ typ: 'Bearer', azp: 'agentx-workmate', tenant_slug: 'acme' })
      // The backend keeps getting the ID token.
      expect(claimsOf(session!.accessToken).typ).toBe('ID')
    })
  })

  it('the ID token Workmate 1.1.0 sent is refused, and the refusal is logged', async () => {
    await withConsole(async origin => {
      const session = parseKeycloakTokenResponse(keycloakTokenResponse(), 1_800_000_000)
      const lines: string[] = []

      const reporter = new UsageReporter({
        identity: async () => ({ subject: session.userId, token: session.accessToken, issuer: ISSUER }),
        version: '1.1.0',
        os: 'macOS',
        fetch: (url, init) => fetch(String(url).replace(new URL(ISSUER).origin, origin), init),
        log: line => lines.push(line)
      })

      reporter.begin('turn')
      expect(await reporter.end('turn', false)).toBe(false)
      expect(lines).toEqual(['[usage] the SSO console refused usage metrics: HTTP 401'])
    })
  })
})
