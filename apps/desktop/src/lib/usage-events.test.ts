import { expect, it } from 'vitest'

import { usageSignal } from './usage-events'
it('observes terminal state and drops all transcript content', () => {
  expect(usageSignal({ type: 'message.delta', session_id: 's', payload: { text: 'private' } })).toBeNull()
  expect(
    usageSignal({
      type: 'message.complete',
      session_id: 's',
      profile: 'p',
      payload: { status: 'error', text: 'private', error: 'secret' }
    })
  ).toEqual({ key: 's', profile: 'p', phase: 'finish', failed: true, cancelled: false })
  expect(usageSignal({ type: 'message.complete', payload: { status: 'error' } })).toBeNull()

  for (const status of ['cancelled', 'interrupted']) {
    expect(usageSignal({ type: 'message.complete', session_id: 's', payload: { status } })?.cancelled).toBe(true)
  }
})
