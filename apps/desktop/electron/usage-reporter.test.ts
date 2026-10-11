import { createServer } from 'node:http'

import { describe, expect, it, vi } from 'vitest'

import { UsageReporter } from './usage-reporter'

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
