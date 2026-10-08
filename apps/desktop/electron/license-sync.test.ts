import assert from 'node:assert/strict'

import { test } from 'vitest'

import { createLicenseSync, LICENSE_REFRESH_INTERVAL_MS, type LicenseView, licenseViewFrom } from './license-sync'

const ACTIVE = {
  access: 'full',
  enforced: true,
  last_day: '2027-05-31',
  notice: null,
  plan: { name: 'Pilot 2026', slug: 'pilot-2026' },
  server_time: '2027-01-31T09:00:00+07:00',
  state: 'active'
}

const EXPIRED = { ...ACTIVE, access: 'read_only', notice: 'read_only', state: 'expired' }

function harness(answers: Array<(refresh: boolean) => unknown>) {
  let clock = 1_000_000
  const asked: boolean[] = []
  const broadcasts: LicenseView[] = []
  const logs: string[] = []

  const sync = createLicenseSync({
    broadcast: view => void broadcasts.push(view),
    fetch: async refresh => {
      asked.push(refresh)
      const answer = answers.shift()

      if (!answer) {
        throw new Error('no more answers')
      }

      return answer(refresh)
    },
    log: line => void logs.push(line),
    now: () => clock
  })

  return {
    advance: (ms: number) => {
      clock += ms
    },
    asked,
    broadcasts,
    logs,
    sync
  }
}

const backend =
  (license: unknown, status = 'cached') =>
  () => ({ account: 'kien', detail: '', license, status })

test('a refresh asks the keys service and tells every window what it said', async () => {
  const h = harness([backend(ACTIVE, 'ok')])

  const view = await h.sync.refresh('launch')

  assert.deepEqual(h.asked, [true])
  assert.equal(view.status, 'ok')
  assert.deepEqual(view.license, ACTIVE)
  assert.equal(h.broadcasts.length, 1)
  assert.equal(h.broadcasts[0].account, 'kien')
})

test('the same answer again is not news', async () => {
  const h = harness([backend(ACTIVE, 'ok'), backend({ ...ACTIVE, server_time: '2027-01-31T09:30:00+07:00' })])

  await h.sync.refresh('launch')
  const again = await h.sync.read()

  // A newer server_time alone changes nothing a window shows.
  assert.equal(again.status, 'cached')
  assert.equal(h.broadcasts.length, 1)
})

test('a changed license is broadcast', async () => {
  const h = harness([backend(ACTIVE, 'ok'), backend(EXPIRED)])

  await h.sync.refresh('launch')
  await h.sync.read()

  assert.equal(h.broadcasts.length, 2)
  assert.equal(h.broadcasts[1].license?.state, 'expired')
})

test('an unreachable backend never erases what is known', async () => {
  const h = harness([
    backend(EXPIRED, 'ok'),
    () => ({ current: '', detail: 'The local backend is not running.', status: 'offline' }),
    () => {
      throw new Error('ECONNREFUSED')
    }
  ])

  await h.sync.refresh('launch')
  const restarting = await h.sync.read()
  const failing = await h.sync.read()

  // The read-only banner stays up while the backend restarts.
  assert.equal(restarting.status, 'unavailable')
  assert.equal(restarting.license?.state, 'expired')
  assert.equal(restarting.detail, 'The local backend is not running.')
  assert.equal(failing.license?.state, 'expired')
  assert.equal(h.broadcasts.length, 1)
})

test('a service that predates licensing clears the license', async () => {
  const h = harness([backend(EXPIRED, 'ok'), backend(null, 'unsupported')])

  await h.sync.refresh('launch')
  const view = await h.sync.refresh('requested')

  assert.equal(view.license, null)
  assert.equal(h.broadcasts.length, 2)
  assert.equal(h.broadcasts[1].license, null)
})

test('each beat re-reads the record, and asks the service once the last refresh is old enough', async () => {
  const h = harness([backend(ACTIVE, 'ok'), backend(ACTIVE), backend(ACTIVE, 'ok')])

  // Not before the first refresh: there is nobody signed in to ask about.
  assert.equal(h.sync.tick('interval'), null)

  await h.sync.refresh('launch')
  h.advance(LICENSE_REFRESH_INTERVAL_MS - 1)
  await h.sync.tick('interval')

  h.advance(1)
  await h.sync.tick('focus')

  // refresh, read (the record), refresh (half an hour on).
  assert.deepEqual(h.asked, [true, false, true])
})

test('a boundary the backend crossed by itself shows on the next beat', async () => {
  // The grace period ended between two refreshes: the backend re-evaluated
  // its record, and the beat's read carries the new state.
  const h = harness([backend({ ...ACTIVE, notice: 'grace', state: 'grace' }, 'ok'), backend(EXPIRED)])

  await h.sync.refresh('launch')
  h.advance(30_000)
  await h.sync.tick('interval')

  assert.equal(h.broadcasts.at(-1)?.license?.state, 'expired')
})

test('a read that raced a refresh cannot put back what the refresh replaced', async () => {
  let answerRead: (value: unknown) => void = () => undefined
  let answerRefresh: (value: unknown) => void = () => undefined

  const h = harness([
    () => backend(ACTIVE, 'ok')(),
    () =>
      new Promise(resolve => {
        answerRead = resolve
      }),
    () =>
      new Promise(resolve => {
        answerRefresh = resolve
      })
  ])

  await h.sync.refresh('launch')
  const read = h.sync.read()
  const refresh = h.sync.refresh('requested')

  answerRefresh({ account: 'kien', detail: '', license: EXPIRED, status: 'ok' })
  await refresh
  // The record the read saw predates the refresh's answer.
  answerRead({ account: 'kien', detail: '', license: ACTIVE, status: 'cached' })
  await read

  assert.equal(h.sync.current().license?.state, 'expired')
})

test('concurrent refreshes share one request', async () => {
  let release: (value: unknown) => void = () => undefined

  const h = harness([
    () =>
      new Promise(resolve => {
        release = resolve
      })
  ])

  const first = h.sync.refresh('launch')
  const second = h.sync.refresh('requested')
  release({ account: 'kien', detail: '', license: ACTIVE, status: 'ok' })

  assert.equal(await first, await second)
  assert.deepEqual(h.asked, [true])
})

test('a refresh the service could not answer is logged with its reason', async () => {
  const h = harness([backend(EXPIRED, 'offline')])

  await h.sync.refresh('interval')

  assert.deepEqual(h.logs, ['[license] interval: offline'])
})

test('a window that cannot be told does not break the answer', async () => {
  const logs: string[] = []

  const sync = createLicenseSync({
    broadcast: () => {
      throw new Error('Object has been destroyed')
    },
    fetch: async () => ({ account: 'kien', detail: '', license: EXPIRED, status: 'ok' }),
    log: line => void logs.push(line)
  })

  const view = await sync.refresh('launch')

  assert.equal(view.license?.state, 'expired')
  assert.deepEqual(logs, ['[license] could not tell the windows: Object has been destroyed'])
})

test('signing out forgets the license and stops the cadence', async () => {
  const h = harness([backend(EXPIRED, 'ok')])

  await h.sync.refresh('launch')
  h.sync.forget()
  h.advance(LICENSE_REFRESH_INTERVAL_MS)

  // The next person must not inherit the last one's read-only banner — and a
  // window must tell this from "the backend could not be asked".
  assert.equal(h.sync.current().license, null)
  assert.equal(h.broadcasts.at(-1)?.license, null)
  assert.equal(h.broadcasts.at(-1)?.status, 'signed_out')
  assert.equal(h.sync.tick('interval'), null)
})

test('an answer asked for before a sign-out never lands after it', async () => {
  let answerOld: (value: unknown) => void = () => undefined

  const h = harness([
    () =>
      new Promise(resolve => {
        answerOld = resolve
      }),
    backend(ACTIVE, 'ok')
  ])

  const old = h.sync.refresh('launch')
  h.sync.forget()
  // The next person signs in: their refresh is a request of its own.
  const next = await h.sync.refresh('provisioned')

  answerOld({ account: 'previous', detail: '', license: EXPIRED, status: 'ok' })
  await old

  assert.equal(next.license?.state, 'active')
  assert.equal(h.sync.current().account, 'kien')
  assert.equal(h.sync.current().license?.state, 'active')
  assert.deepEqual(h.asked, [true, true])
})

test('only a license-shaped object counts as a license', () => {
  assert.equal(licenseViewFrom(null), null)
  assert.equal(licenseViewFrom({ status: 'offline' }), null)
  assert.equal(licenseViewFrom('<html>'), null)
  assert.equal(licenseViewFrom({ license: { state: 'active' } })?.license, null)
  assert.deepEqual(licenseViewFrom({ license: null }), { account: null, detail: '', license: null, status: 'cached' })
})
