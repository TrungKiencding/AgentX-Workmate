import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { accountSlugForIdentity } from './account-slug'
import { cronUsageHomes, CronUsageOutbox, OUTBOX_DIR, parseCronUsageEvent, PASS_MAX_EVENTS } from './cron-usage-outbox'
import type { UsageDelivery, UsageEventFacts, UsageIdentity } from './usage-reporter'
import { UsageReporter } from './usage-reporter'

/** What the backend writes (cron/usage_outbox.py); its tests check it writes exactly this. */
const FIXTURE_TEXT = readFileSync(path.join(__dirname, 'cron-usage-event.fixture.json'), 'utf8')
const FIXTURE = JSON.parse(FIXTURE_TEXT)
const FIXTURE_NAME = `${FIXTURE.event_id}.json`
const FIXTURE_AT = Date.parse(FIXTURE.occurred_at)

const SUBJECT = 'kc-user-1'

const identity: UsageIdentity = {
  subject: SUBJECT,
  token: 'synthetic-access',
  issuer: 'https://sso.example/auth/realms/agent-hub'
}

const slugOf = (subject: string) => accountSlugForIdentity({ subject, email: `${subject}@example.com`, username: '' })

let root: string

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'cron-usage-outbox-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
}

/** One event file as the backend leaves it, `minutesAgo` before `now`. */
function event(n: number, now: number, extra: Record<string, unknown> = {}) {
  return {
    event_id: uuid(n),
    occurred_at: new Date(now - 60_000).toISOString(),
    feature: 'cron.run',
    outcome: 'success',
    duration_ms: 1000 + n,
    ...extra
  }
}

function queue(home: string, value: Record<string, unknown>, name = `${value.event_id}.json`): string {
  const dir = path.join(home, OUTBOX_DIR)
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  writeFileSync(file, JSON.stringify(value))

  return file
}

const waiting = (home: string) => {
  try {
    return readdirSync(path.join(home, OUTBOX_DIR)).sort()
  } catch {
    return []
  }
}

/** A console stand-in that answers every request with `answer`. */
const answering = (answer: UsageDelivery) =>
  vi.fn(async (_who: UsageIdentity, _events: UsageEventFacts[]): Promise<UsageDelivery> => answer)

describe('an outbox file', () => {
  it('reads what the backend writes', () => {
    expect(parseCronUsageEvent(FIXTURE_TEXT, FIXTURE_NAME, FIXTURE_AT + 60_000)).toEqual(FIXTURE)
  })

  it('takes a success without a code', () => {
    const value = event(1, FIXTURE_AT)
    expect(parseCronUsageEvent(JSON.stringify(value), `${uuid(1)}.json`, FIXTURE_AT)).toEqual(value)
  })

  it.each([
    ['another name', { ...FIXTURE }, `${uuid(9)}.json`],
    ['an extra field', { ...FIXTURE, prompt: 'the job text' }, FIXTURE_NAME],
    ['a failure without its code', { ...FIXTURE, error_code: undefined }, FIXTURE_NAME],
    ['a success with a code', { ...FIXTURE, outcome: 'success' }, FIXTURE_NAME],
    ['a code the console refuses', { ...FIXTURE, error_code: 'has spaces' }, FIXTURE_NAME],
    ['another feature', { ...FIXTURE, feature: 'chat.turn' }, FIXTURE_NAME],
    ['another outcome', { ...FIXTURE, outcome: 'skipped' }, FIXTURE_NAME],
    ['a fractional duration', { ...FIXTURE, duration_ms: 1.5 }, FIXTURE_NAME],
    ['a negative duration', { ...FIXTURE, duration_ms: -1 }, FIXTURE_NAME],
    ['a duration over an hour', { ...FIXTURE, duration_ms: 3_600_001 }, FIXTURE_NAME],
    ['a time without its zone', { ...FIXTURE, occurred_at: '2026-11-15T14:08:03.456' }, FIXTURE_NAME],
    ['no time at all', { ...FIXTURE, occurred_at: 'yesterday' }, FIXTURE_NAME]
  ])('refuses %s', (_label, value, name) => {
    expect(parseCronUsageEvent(JSON.stringify(value), name, FIXTURE_AT)).toBeNull()
  })

  it('refuses what is not an object', () => {
    for (const text of ['', '[]', 'null', '42', '{"event_id":']) {
      expect(parseCronUsageEvent(text, FIXTURE_NAME, FIXTURE_AT)).toBeNull()
    }
  })

  it('refuses what the console would: older than 7 days (with a margin), or ahead of its clock', () => {
    const day = 24 * 60 * 60 * 1000
    expect(parseCronUsageEvent(FIXTURE_TEXT, FIXTURE_NAME, FIXTURE_AT + 7 * day - 11 * 60_000)).not.toBeNull()
    expect(parseCronUsageEvent(FIXTURE_TEXT, FIXTURE_NAME, FIXTURE_AT + 7 * day - 9 * 60_000)).toBeNull()
    expect(parseCronUsageEvent(FIXTURE_TEXT, FIXTURE_NAME, FIXTURE_AT - 4 * 60_000)).not.toBeNull()
    expect(parseCronUsageEvent(FIXTURE_TEXT, FIXTURE_NAME, FIXTURE_AT - 6 * 60_000)).toBeNull()
  })
})

describe('whose homes', () => {
  it("are the signed-in person's account homes and their profiles, never another account's", async () => {
    const mine = path.join(root, 'accounts', slugOf(SUBJECT))
    const theirs = path.join(root, 'accounts', slugOf('someone-else'))
    mkdirSync(path.join(mine, 'profiles', 'tro-ly-ban-hang'), { recursive: true })
    mkdirSync(path.join(mine, 'profiles', 'Not A Profile'), { recursive: true })
    mkdirSync(path.join(theirs, 'profiles', 'x'), { recursive: true })
    mkdirSync(path.join(root, 'accounts', 'not-an-account-home!'), { recursive: true })

    expect(await cronUsageHomes(root, SUBJECT)).toEqual([mine, path.join(mine, 'profiles', 'tro-ly-ban-hang')])
  })

  it('is the root itself on an install from before account homes', async () => {
    mkdirSync(path.join(root, 'profiles', 'work'), { recursive: true })

    expect(await cronUsageHomes(root, SUBJECT)).toEqual([root, path.join(root, 'profiles', 'work')])
  })

  it('is none when accounts exist but none is theirs', async () => {
    mkdirSync(path.join(root, 'accounts', slugOf('someone-else')), { recursive: true })

    expect(await cronUsageHomes(root, SUBJECT)).toEqual([])
  })
})

describe('draining', () => {
  const NOW = Date.parse('2026-11-15T15:00:00Z')

  function outbox(
    deliver: (identity: UsageIdentity, events: UsageEventFacts[]) => Promise<UsageDelivery>,
    who = identity
  ) {
    const log = vi.fn()

    return { log, outbox: new CronUsageOutbox({ root, identity: async () => who, deliver, now: () => NOW, log }) }
  }

  function accountHome(subject = SUBJECT): string {
    const home = path.join(root, 'accounts', slugOf(subject))
    mkdirSync(home, { recursive: true })

    return home
  }

  it("sends every waiting run of the person's homes, then deletes what the console took", async () => {
    const home = accountHome()
    const assistant = path.join(home, 'profiles', 'tro-ly')
    queue(home, event(1, NOW))
    queue(home, event(2, NOW, { outcome: 'failure', error_code: 'rate_limited' }))
    queue(assistant, event(3, NOW))
    const deliver = answering('accepted')

    expect(await outbox(deliver).outbox.drain()).toEqual({ sent: 3, dropped: 0, kept: 0 })

    expect(deliver.mock.calls.map(([who, events]) => [who, events.map(e => e.event_id)])).toEqual([
      [identity, [uuid(1), uuid(2)]],
      [identity, [uuid(3)]]
    ])
    expect(deliver.mock.calls[0][1][1]).toEqual(event(2, NOW, { outcome: 'failure', error_code: 'rate_limited' }))
    expect(waiting(home)).toEqual([])
    expect(waiting(assistant)).toEqual([])
  })

  it('sends at most 100 events a request', async () => {
    const home = accountHome()

    for (let n = 1; n <= 150; n++) {
      queue(home, event(n, NOW))
    }

    const deliver = answering('accepted')

    expect(await outbox(deliver).outbox.drain()).toMatchObject({ sent: 150 })
    expect(deliver.mock.calls.map(([, events]) => events.length)).toEqual([100, 50])
  })

  it('keeps everything while the console cannot take events, and tries no other home', async () => {
    const home = accountHome()
    const assistant = path.join(home, 'profiles', 'tro-ly')
    queue(home, event(1, NOW))
    queue(assistant, event(2, NOW))
    const deliver = answering('failed')

    expect(await outbox(deliver).outbox.drain()).toEqual({ sent: 0, dropped: 0, kept: 1 })
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(waiting(home)).toEqual([`${uuid(1)}.json`])
    expect(waiting(assistant)).toEqual([`${uuid(2)}.json`])
  })

  it.each([401, 403])('keeps them when the console refuses the token (HTTP %i)', async status => {
    const home = accountHome()
    queue(home, event(1, NOW))

    expect(await outbox(async () => ({ refused: status })).outbox.drain()).toMatchObject({ kept: 1 })
    expect(waiting(home)).toEqual([`${uuid(1)}.json`])
  })

  it('drops a batch the console calls malformed, once: sending it again would be refused the same way', async () => {
    const home = accountHome()
    queue(home, event(1, NOW))

    expect(await outbox(async () => ({ refused: 422 })).outbox.drain()).toEqual({ sent: 0, dropped: 1, kept: 0 })
    expect(waiting(home)).toEqual([])
  })

  it('drops only the event the console refuses when a batch is refused as malformed', async () => {
    const home = accountHome()
    queue(home, event(1, NOW))
    queue(home, event(2, NOW))
    queue(home, event(3, NOW))

    const deliver = vi.fn(async (_who: UsageIdentity, events: UsageEventFacts[]): Promise<UsageDelivery> =>
      events.some(e => e.event_id === uuid(2)) ? { refused: 422 } : 'accepted'
    )

    expect(await outbox(deliver).outbox.drain()).toEqual({ sent: 2, dropped: 1, kept: 0 })
    expect(deliver.mock.calls.map(([, events]) => events.map(e => e.event_id))).toEqual([
      [uuid(1), uuid(2), uuid(3)],
      [uuid(1)],
      [uuid(2)],
      [uuid(3)]
    ])
    expect(waiting(home)).toEqual([])
  })

  it.each([404, 405, 409])('keeps them when the console refuses for a reason that is not the events (HTTP %i)', async status => {
    const home = accountHome()
    queue(home, event(1, NOW))
    queue(home, event(2, NOW))

    expect(await outbox(async () => ({ refused: status })).outbox.drain()).toEqual({ sent: 0, dropped: 0, kept: 2 })
    expect(waiting(home)).toEqual([`${uuid(1)}.json`, `${uuid(2)}.json`])
  })

  it('keeps an event dated ahead of the clock (a clock out of step) instead of deleting it', async () => {
    const home = accountHome()
    const tenMinutes = 10 * 60 * 1000
    const eightDays = 8 * 24 * 60 * 60 * 1000
    queue(home, event(1, NOW + tenMinutes))
    queue(home, event(2, NOW + eightDays))
    const deliver = answering('accepted')

    expect(await outbox(deliver).outbox.drain()).toEqual({ sent: 0, dropped: 1, kept: 1 })
    expect(deliver).not.toHaveBeenCalled()
    expect(waiting(home)).toEqual([`${uuid(1)}.json`])
  })

  it(`sends at most ${PASS_MAX_EVENTS} events a pass, so a backlog does not spend the chat turns' rate limit`, async () => {
    const home = accountHome()
    const assistant = path.join(home, 'profiles', 'tro-ly')

    for (let n = 1; n <= PASS_MAX_EVENTS + 50; n++) {
      queue(home, event(n, NOW))
    }

    queue(assistant, event(9999, NOW))
    const deliver = answering('accepted')
    const box = outbox(deliver).outbox

    expect(await box.drain()).toEqual({ sent: PASS_MAX_EVENTS, dropped: 0, kept: 50 })
    expect(waiting(assistant)).toEqual([`${uuid(9999)}.json`])
    expect(await box.drain()).toEqual({ sent: 51, dropped: 0, kept: 0 })
    expect(waiting(home)).toEqual([])
    expect(waiting(assistant)).toEqual([])
  })

  it('deletes unsent what the console would refuse, says so once, and leaves temporary files alone', async () => {
    const home = accountHome()
    const eightDays = 8 * 24 * 60 * 60 * 1000
    queue(home, event(1, NOW - eightDays))
    queue(home, { ...event(2, NOW), prompt: 'Tóm tắt email của sếp' })
    queue(home, event(3, NOW), `${uuid(99)}.json`)
    writeFileSync(path.join(home, OUTBOX_DIR, `${uuid(4)}.json`), 'x'.repeat(5000))
    writeFileSync(path.join(home, OUTBOX_DIR, '.abc.tmp'), '{')
    mkdirSync(path.join(home, OUTBOX_DIR, `${uuid(5)}.json`))
    const deliver = answering('accepted')
    const { log, outbox: box } = outbox(deliver)

    expect(await box.drain()).toEqual({ sent: 0, dropped: 4, kept: 0 })
    await box.drain()

    expect(deliver).not.toHaveBeenCalled()
    expect(waiting(home)).toEqual(['.abc.tmp', `${uuid(5)}.json`])
    expect(log).toHaveBeenCalledTimes(1)
    expect(String(log.mock.calls[0][0])).not.toMatch(/Tóm tắt|prompt/)
  })

  it('touches nothing without a session to send with', async () => {
    const home = accountHome()
    queue(home, event(1, NOW))
    const deliver = answering('accepted')

    for (const who of [null, { ...identity, token: '' }]) {
      expect(await outbox(deliver, who as UsageIdentity).outbox.drain()).toEqual({ sent: 0, dropped: 0, kept: 0 })
    }

    const failing = new CronUsageOutbox({
      root,
      identity: async () => {
        throw new Error('keycloak down')
      },
      deliver
    })

    expect(await failing.drain()).toEqual({ sent: 0, dropped: 0, kept: 0 })
    expect(deliver).not.toHaveBeenCalled()
    expect(waiting(home)).toEqual([`${uuid(1)}.json`])
  })

  it("leaves another account's runs for when that person signs in", async () => {
    const theirs = accountHome('someone-else')
    accountHome()
    queue(theirs, event(1, NOW))
    const deliver = answering('accepted')

    await outbox(deliver).outbox.drain()

    expect(deliver).not.toHaveBeenCalled()
    expect(waiting(theirs)).toEqual([`${uuid(1)}.json`])
  })

  it('runs one pass at a time: a second call joins it instead of sending the same files again', async () => {
    const home = accountHome()
    queue(home, event(1, NOW))
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => (release = resolve))

    const deliver = vi.fn(async (_who: UsageIdentity, _events: UsageEventFacts[]): Promise<UsageDelivery> => {
      await gate

      return 'accepted'
    })

    const { outbox: box } = outbox(deliver)
    const first = box.drain()
    const second = box.drain()
    release()

    expect(await first).toBe(await second)
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(await box.drain()).toEqual({ sent: 0, dropped: 0, kept: 0 }) // a later pass runs anew
  })

  it('reaches the console as the release that sends it, with the run’s own id, and is counted once when sent twice', async () => {
    const home = accountHome()
    queue(home, event(1, NOW, { outcome: 'failure', error_code: 'app_shutdown' }))
    const bodies: any[] = []
    const seen = new Set<string>()
    let accepted = 0

    const server = createServer((req, res) => {
      let body = ''
      req.on('data', chunk => (body += chunk))
      req.on('end', () => {
        const parsed = JSON.parse(body)
        bodies.push({ headers: req.headers, body: parsed })

        for (const item of parsed.events) {
          if (!seen.has(item.event_id)) {
            seen.add(item.event_id)
            accepted++
          }
        }

        res.writeHead(202, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ accepted, duplicates: 0 }))
      })
    })

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))

    try {
      const { port } = server.address() as { port: number }

      const reporter = new UsageReporter({
        identity: async () => null,
        version: '1.1.4',
        os: 'macOS',
        sleep: async () => {}
      })

      const local = { ...identity, issuer: `http://127.0.0.1:${port}/auth/realms/agent-hub` }

      const box = new CronUsageOutbox({
        root,
        identity: async () => local,
        deliver: (who, events) => reporter.deliver(who, events),
        now: () => NOW
      })

      // A crash between the console's answer and the delete leaves the file: the next pass sends it again.
      const copy = readFileSync(path.join(home, OUTBOX_DIR, `${uuid(1)}.json`), 'utf8')
      expect(await box.drain()).toMatchObject({ sent: 1 })
      writeFileSync(path.join(home, OUTBOX_DIR, `${uuid(1)}.json`), copy)
      expect(await box.drain()).toMatchObject({ sent: 1 })
    } finally {
      await new Promise(resolve => server.close(resolve))
    }

    expect(accepted).toBe(1)
    expect(bodies).toHaveLength(2)
    expect(bodies[0].headers.authorization).toBe('Bearer synthetic-access')
    expect(bodies[0].headers['x-sso-request']).toBe('1')
    expect(bodies[0].body).toEqual({
      events: [
        {
          product: 'agentx-workmate',
          event_id: uuid(1),
          occurred_at: new Date(NOW - 60_000).toISOString(),
          feature: 'cron.run',
          outcome: 'failure',
          duration_ms: 1001,
          error_code: 'app_shutdown',
          version: '1.1.4',
          os: 'macOS',
          browser: 'Native'
        }
      ]
    })
  })
})
