import { afterEach, describe, expect, it } from 'vitest'

import {
  $agentStartingSessions,
  clearAllAgentStarting,
  sessionAgentStarting,
  setSessionAgentStarting
} from './agent-starting'

afterEach(() => {
  clearAllAgentStarting()
})

describe('agent starting store', () => {
  it('tracks the flag per session', () => {
    setSessionAgentStarting('a', true)

    expect(sessionAgentStarting('a').get()).toBe(true)
    expect(sessionAgentStarting('b').get()).toBe(false)

    setSessionAgentStarting('a', false)

    expect(sessionAgentStarting('a').get()).toBe(false)
  })

  it('setting an already-set flag does not churn the atom', () => {
    setSessionAgentStarting('a', true)
    const before = $agentStartingSessions.get()

    setSessionAgentStarting('a', true)

    expect($agentStartingSessions.get()).toBe(before)
  })

  it('clearing an unset flag does not churn the atom', () => {
    const before = $agentStartingSessions.get()

    setSessionAgentStarting('a', false)

    expect($agentStartingSessions.get()).toBe(before)
  })

  it('clearAllAgentStarting drops every session', () => {
    setSessionAgentStarting('a', true)
    setSessionAgentStarting('b', true)

    clearAllAgentStarting()

    expect($agentStartingSessions.get()).toEqual({})
  })
})
