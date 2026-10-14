import { expect, it } from 'vitest'

import { usageSignal } from './usage-events'
it('observes terminal state and drops all transcript content', () => {
  expect(usageSignal({ type: 'message.delta', session_id: 's', payload: { text: 'private' } })).toBeNull()
  expect(
    usageSignal({
      type: 'message.complete',
      session_id: 's',
      profile: 'p',
      payload: { status: 'error', text: 'private', error: 'secret', failure_code: 'rate_limited' }
    })
  ).toEqual({ key: 's', profile: 'p', phase: 'finish', failed: true, cancelled: false, code: 'rate_limited' })
  expect(usageSignal({ type: 'message.complete', payload: { status: 'error' } })).toBeNull()

  for (const status of ['cancelled', 'interrupted']) {
    expect(usageSignal({ type: 'message.complete', session_id: 's', payload: { status } })?.cancelled).toBe(true)
  }
})

it('counts a turn that ended without its answer as failed, though without an error', () => {
  expect(
    usageSignal({
      type: 'message.complete',
      session_id: 's',
      payload: { status: 'complete', failure_code: 'max_steps' }
    })
  ).toEqual({ key: 's', phase: 'finish', failed: true, cancelled: false, code: 'max_steps' })
  expect(usageSignal({ type: 'message.complete', session_id: 's', payload: { status: 'complete' } })).toEqual({
    key: 's',
    phase: 'finish',
    failed: false,
    cancelled: false
  })
  // An error frame without a code (from an older backend) still counts as failed.
  expect(usageSignal({ type: 'message.complete', session_id: 's', payload: { status: 'error' } })?.failed).toBe(true)
  // A stopped turn is never a failure, whatever came with it.
  expect(
    usageSignal({ type: 'message.complete', session_id: 's', payload: { status: 'interrupted', failure_code: 'x' } })
  ).toEqual({ key: 's', phase: 'finish', failed: false, cancelled: true })
})

it('does not end a turn at an error event: the turn goes on after a warning', () => {
  expect(
    usageSignal({ type: 'error', session_id: 's', payload: { message: 'model switch needs confirming' } })
  ).toBeNull()
})
