import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createClientSessionState } from '@/lib/chat-runtime'
import {
  $attentionSessionIds,
  $sessionStates,
  $stalledSessionIds,
  $workingSessionIds,
  clearAllSessionStates,
  publishSessionState,
  SESSION_WATCHDOG_TIMEOUT_MS
} from '@/store/session-states'

import { rehydrateLiveSessionStatuses } from './use-background-sync'

describe('rehydrateLiveSessionStatuses', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    clearAllSessionStates()
  })

  it('restores running sessions after reconnect without opening them', () => {
    const now = 1_800_000_000_000

    rehydrateLiveSessionStatuses(
      {
        sessions: [
          {
            id: 'runtime-overnight',
            last_active: (now - SESSION_WATCHDOG_TIMEOUT_MS - 1_000) / 1000,
            session_key: 'overnight-exam-learning',
            status: 'working'
          },
          {
            id: 'runtime-cleanup',
            last_active: now / 1000,
            session_key: 'temporary-file-cleanup',
            status: 'working'
          }
        ]
      },
      now
    )

    expect($workingSessionIds.get()).toEqual(['overnight-exam-learning', 'temporary-file-cleanup'])
    expect($stalledSessionIds.get()).toEqual(['overnight-exam-learning'])
    expect($attentionSessionIds.get()).toEqual([])
  })

  it('restores a waiting turn as working and needing attention', () => {
    rehydrateLiveSessionStatuses({
      sessions: [{ id: 'runtime-needs-user', session_key: 'needs-user', status: 'waiting' }]
    })

    expect($workingSessionIds.get()).toEqual(['needs-user'])
    expect($attentionSessionIds.get()).toEqual(['needs-user'])
    expect($stalledSessionIds.get()).toEqual([])
  })

  it('keeps a submit-seeded busy alive while the agent build is "starting"', () => {
    // A fresh chat's first message: submit seeded busy+awaitingResponse and
    // prompt.submit queued the message behind the deferred agent build. The
    // live snapshot reports that session as "starting" (not "working") for
    // the whole build — the 1.5s poll used to write busy:false over the seed,
    // blanking the transcript's waiting indicator mid-build.
    publishSessionState('runtime-building', {
      ...createClientSessionState('building-session'),
      awaitingResponse: true,
      busy: true,
      messages: [{ id: 'u1', parts: [{ text: 'hi', type: 'text' as const }], role: 'user' as const }],
      turnStartedAt: 12345
    })

    rehydrateLiveSessionStatuses({
      sessions: [{ id: 'runtime-building', session_key: 'building-session', status: 'starting' }]
    })

    const state = $sessionStates.get()['runtime-building']

    expect(state.busy).toBe(true)
    expect(state.awaitingResponse).toBe(true)
    expect(state.turnStartedAt).toBe(12345)
  })

  it('does not arm busy for a "starting" session with no queued submit', () => {
    // Open-chat pre-warm: the build runs but nothing was sent — stays idle.
    publishSessionState('runtime-prewarm', {
      ...createClientSessionState('prewarm-session'),
      awaitingResponse: false,
      busy: false
    })

    rehydrateLiveSessionStatuses({
      sessions: [{ id: 'runtime-prewarm', session_key: 'prewarm-session', status: 'starting' }]
    })

    expect($sessionStates.get()['runtime-prewarm'].busy).toBe(false)
    expect($workingSessionIds.get()).toEqual([])
  })

  it('ignores idle, starting, and malformed live-session rows', () => {
    rehydrateLiveSessionStatuses({
      sessions: [
        { id: 'runtime-idle', session_key: 'idle-session', status: 'idle' },
        { id: 'runtime-starting', session_key: 'starting-session', status: 'starting' },
        { id: 'runtime-malformed', status: 'working' }
      ]
    })

    expect($workingSessionIds.get()).toEqual([])
    expect($attentionSessionIds.get()).toEqual([])
    expect($stalledSessionIds.get()).toEqual([])
  })
})
