import assert from 'node:assert/strict'

import { describe, test } from 'vitest'

import {
  AgentxKeyGate,
  type AgentxKeyGateState,
  classifyAccountKey,
  failureFromProvision,
  OPEN_KEY_GATE
} from './agentx-key-gate'

const ACCOUNT = { displayName: 'Lê Trung Kiên', email: 'kien@astralx.com.vn' }

// What the deployed keys service answered for the bug report: the SSO console
// grants models the proxy does not serve.
const REFUSED_424 = {
  code: 'no_grantable_models',
  detail:
    'the second brain could not issue a key: the second brain returned HTTP 424: None of the models chosen in the SSO console is served by the model proxy right now.',
  license: null,
  ok: false,
  status: 'error'
}

const ISSUED = { ok: true, status: 'provisioned', detail: 'minted', models: ['MiniMax/MiniMax-M3'] }
const PRESENT = { ok: true, status: 'reused', detail: 'a LiteLLM key is configured for this account.' }
const MISSING = { ok: false, status: 'missing', detail: 'this account has no LiteLLM key yet.' }

function harness() {
  const published: AgentxKeyGateState[] = []
  const logs: string[] = []
  const gate = new AgentxKeyGate({ log: message => logs.push(message), publish: state => published.push(state) })

  return { gate, logs, published }
}

/** Resolve after the pending microtasks/timers so a held promise can settle (or not). */
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

describe('classifyAccountKey', () => {
  test('reads the key standing from the backend’s account block', () => {
    assert.equal(classifyAccountKey(PRESENT), 'has-key')
    assert.equal(classifyAccountKey(ISSUED), 'has-key')
    assert.equal(classifyAccountKey({ status: 'rotated', ok: true }), 'has-key')
    assert.equal(classifyAccountKey(MISSING), 'missing')
    assert.equal(classifyAccountKey({ status: 'disabled' }), 'not-required')
    assert.equal(classifyAccountKey({ status: 'unconfigured' }), 'not-required')
    assert.equal(classifyAccountKey(null), 'unknown')
    assert.equal(classifyAccountKey({}), 'unknown')
    assert.equal(classifyAccountKey({ status: 'offline', ok: false }), 'unknown')
  })
})

describe('failureFromProvision', () => {
  test('keeps what support needs and names a missing answer', () => {
    assert.deepEqual(failureFromProvision(REFUSED_424), {
      code: 'no_grantable_models',
      detail: REFUSED_424.detail,
      license: null,
      status: 'error'
    })
    assert.deepEqual(failureFromProvision(null), { code: '', detail: '', license: null, status: 'no-answer' })
  })
})

describe('AgentxKeyGate.hold', () => {
  test('an install that provisions no keys never holds the boot', async () => {
    const { gate } = harness()

    await gate.hold({
      account: ACCOUNT,
      provision: async () => assert.fail('nothing to provision'),
      readKey: async () => ({ status: 'unconfigured' })
    })

    assert.deepEqual(gate.state, OPEN_KEY_GATE)
  })

  test('an account that already holds its key goes straight through', async () => {
    const { gate } = harness()

    await gate.hold({
      account: ACCOUNT,
      provision: async () => assert.fail('a present key is not re-provisioned here'),
      readKey: async () => PRESENT
    })

    assert.equal(gate.state.phase, 'open')
    assert.equal(gate.state.required, true)
  })

  test('an unreadable key status does not lock the person out', async () => {
    const { gate, logs } = harness()

    await gate.hold({ account: ACCOUNT, provision: async () => null, readKey: async () => null })

    assert.equal(gate.state.phase, 'open')
    assert.ok(logs.some(line => line.includes('could not read the account key status')))
  })

  test('a refused key holds the boot until a retry brings the key in', async () => {
    const { gate, published } = harness()
    let key: unknown = MISSING
    let answer: unknown = REFUSED_424
    let provisions = 0
    let released = false

    const held = gate
      .hold({
        account: ACCOUNT,
        lastAttempt: REFUSED_424,
        provision: async () => {
          provisions++

          if (answer === ISSUED) {
            key = PRESENT
          }

          return answer
        },
        readKey: async () => key
      })
      .then(() => {
        released = true
      })

    await settle()
    // Sign-in's own attempt already failed: no second request before the person asks.
    assert.equal(provisions, 0)
    assert.equal(released, false)
    assert.equal(gate.state.phase, 'blocked')
    assert.equal(gate.state.failure?.code, 'no_grantable_models')
    assert.deepEqual(gate.state.account, ACCOUNT)

    // Still refused: the gate stays shut with the newest reason.
    answer = { ok: false, status: 'offline', detail: 'the second brain is unreachable', code: '' }
    assert.equal((await gate.retry()).phase, 'blocked')
    assert.equal(gate.state.failure?.status, 'offline')
    assert.equal(gate.state.attempts, 2)
    assert.equal(released, false)

    // The administrator fixed the SSO console.
    answer = ISSUED
    const opened = await gate.retry()
    await held

    assert.equal(released, true)
    assert.equal(opened.phase, 'open')
    assert.equal(opened.required, true)
    assert.equal(opened.attempts, 3)
    assert.equal(provisions, 2)
    assert.ok(
      published.some(state => state.phase === 'provisioning'),
      'the person sees the request go out'
    )
  })

  test('with no earlier answer it asks once itself, and opens when that works', async () => {
    const { gate } = harness()
    let key: unknown = MISSING
    let provisions = 0

    await gate.hold({
      account: ACCOUNT,
      provision: async () => {
        provisions++
        key = PRESENT

        return ISSUED
      },
      readKey: async () => key
    })

    assert.equal(provisions, 1)
    assert.equal(gate.state.phase, 'open')
    assert.equal(gate.state.required, true)
  })

  test('a key reported issued but not on this machine still counts as missing', async () => {
    const { gate } = harness()

    void gate.hold({ account: ACCOUNT, provision: async () => ISSUED, readKey: async () => MISSING }).catch(() => {})
    await settle()

    assert.equal(gate.state.phase, 'blocked')
    assert.equal(gate.state.failure?.status, 'error')
    assert.match(gate.state.failure?.detail || '', /did not keep it/)
  })

  test('a provisioning call that throws reads as no answer', async () => {
    const { gate } = harness()

    void gate
      .hold({
        account: ACCOUNT,
        provision: async () => {
          throw new Error('socket hang up')
        },
        readKey: async () => MISSING
      })
      .catch(() => {})
    await settle()

    assert.equal(gate.state.phase, 'blocked')
    assert.equal(gate.state.failure?.status, 'no-answer')
  })

  test('the boot going away releases the hold instead of leaving it hanging', async () => {
    const { gate } = harness()
    const controller = new AbortController()

    const held = gate.hold({
      account: ACCOUNT,
      lastAttempt: REFUSED_424,
      provision: async () => REFUSED_424,
      readKey: async () => MISSING,
      signal: controller.signal
    })

    await settle()
    controller.abort(new Error('AgentX backend exited'))

    await assert.rejects(held, /backend exited/)
    assert.equal(gate.state.phase, 'open')
    assert.equal(gate.state.required, true, 'the account still needs a key; only the hold is gone')
  })

  test('an already-aborted boot is never held', async () => {
    const { gate } = harness()
    const controller = new AbortController()

    controller.abort(new Error('superseded'))

    await assert.rejects(
      gate.hold({
        account: ACCOUNT,
        lastAttempt: REFUSED_424,
        provision: async () => REFUSED_424,
        readKey: async () => MISSING,
        signal: controller.signal
      }),
      /superseded/
    )
  })

  test('a second hold supersedes the first', async () => {
    const { gate } = harness()

    const first = gate.hold({
      account: ACCOUNT,
      lastAttempt: REFUSED_424,
      provision: async () => REFUSED_424,
      readKey: async () => MISSING
    })

    await settle()
    void gate.hold({ account: ACCOUNT, provision: async () => ISSUED, readKey: async () => PRESENT })

    await assert.rejects(first, /newer boot/)
  })
})

describe('AgentxKeyGate.retry', () => {
  test('does nothing unless a hold is waiting', async () => {
    const { gate } = harness()

    assert.deepEqual(await gate.retry(), OPEN_KEY_GATE)
  })

  test('a double click sends one request', async () => {
    const { gate } = harness()
    let provisions = 0

    let finish: (value: unknown) => void = () => {}

    void gate
      .hold({
        account: ACCOUNT,
        lastAttempt: REFUSED_424,
        provision: () => {
          provisions++

          return new Promise(resolve => {
            finish = resolve
          })
        },
        readKey: async () => MISSING
      })
      .catch(() => {})
    await settle()

    const one = gate.retry()
    const two = gate.retry()

    finish(REFUSED_424)
    await Promise.all([one, two])

    assert.equal(provisions, 1)
    assert.equal(gate.state.phase, 'blocked')
  })
})

describe('AgentxKeyGate.forget', () => {
  test('signing out leaves no account and nothing required', async () => {
    const { gate } = harness()

    await gate.hold({ account: ACCOUNT, provision: async () => ISSUED, readKey: async () => PRESENT })
    gate.forget()

    assert.deepEqual(gate.state, OPEN_KEY_GATE)
  })
})
