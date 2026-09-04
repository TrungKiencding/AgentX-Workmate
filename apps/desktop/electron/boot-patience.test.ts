import assert from 'node:assert/strict'

import { test } from 'vitest'

import { createBootPatience, isBackendWarmupError } from './boot-patience'

function fakeClock(start = 0) {
  let time = start

  return {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms
    },
    advance: (ms: number) => {
      time += ms
    }
  }
}

const timeout = () => new Error('Timed out connecting to AgentX backend after 8000ms')

test('a first answer that times out is retried and the second answer wins', async () => {
  const clock = fakeClock()
  const retries: string[] = []

  const patience = createBootPatience({
    budgetMs: 60_000,
    delayMs: 1_000,
    now: clock.now,
    sleep: clock.sleep,
    onRetry: retry => retries.push(`${retry.label}#${retry.attempt}`)
  })

  let calls = 0

  const value = await patience.run('/api/status', async () => {
    calls += 1

    if (calls === 1) {
      throw timeout()
    }

    return { ok: true }
  })

  assert.deepEqual(value, { ok: true })
  assert.equal(calls, 2)
  assert.deepEqual(retries, ['/api/status#1'])
  assert.equal(patience.retries, 1)
})

test('anything that is not a warm-up failure propagates on the first attempt', async () => {
  const clock = fakeClock()
  const patience = createBootPatience({ now: clock.now, sleep: clock.sleep })
  let calls = 0

  await assert.rejects(
    patience.run('ws ticket', async () => {
      calls += 1
      throw new Error('401: session rejected')
    }),
    /401/
  )

  assert.equal(calls, 1)
  assert.equal(patience.retries, 0)
})

test('the budget is shared across every step of one boot', async () => {
  const clock = fakeClock()
  const patience = createBootPatience({ budgetMs: 5_000, delayMs: 2_000, now: clock.now, sleep: clock.sleep })

  // Step one burns 4s of the 5s budget (two retries), then succeeds.
  let first = 0
  await patience.run('status', async () => {
    first += 1

    if (first < 3) {
      throw timeout()
    }

    return 'ok'
  })
  assert.equal(first, 3)

  // Step two only has 1s left: one more retry (capped to what is left), then
  // the timeout is the caller's problem again.
  let second = 0
  await assert.rejects(
    patience.run('providers', async () => {
      second += 1
      throw timeout()
    }),
    /Timed out connecting/
  )
  assert.equal(second, 2)
  assert.equal(clock.now(), 5_000)
})

test('an exhausted budget rethrows the last error untouched', async () => {
  const clock = fakeClock()
  const patience = createBootPatience({ budgetMs: 0, now: clock.now, sleep: clock.sleep })
  const original = timeout()

  await assert.rejects(
    patience.run('status', async () => {
      throw original
    }),
    error => error === original
  )
})

test('warm-up detection covers the shapes a starting backend produces', () => {
  assert.equal(isBackendWarmupError(timeout()), true)
  assert.equal(isBackendWarmupError(new Error('connect ETIMEDOUT 127.0.0.1:50603')), true)
  assert.equal(isBackendWarmupError(new Error('socket hang up')), true)
  assert.equal(isBackendWarmupError(new Error('403: forbidden')), false)
  assert.equal(isBackendWarmupError(null), false)
})
