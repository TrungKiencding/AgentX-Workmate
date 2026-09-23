import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ClientSessionState } from '@/app/types'
import { createClientSessionState } from '@/lib/chat-runtime'
import { $selectedStoredSessionId, $unreadFinishedSessionIds } from '@/store/session'
import { $sessionStates, $workingSessionIds, clearAllSessionStates, publishSessionState } from '@/store/session-states'

import { _submitInFlight } from '../../session/hooks/use-prompt-actions/utils'

import {
  type LiveSessionStateCommit,
  rehydrateLiveSessionStatuses,
  resetLiveRuntimeTracking
} from './use-background-sync'

/**
 * `session.active_list` is an async snapshot racing the live event stream, and
 * the renderer keeps each session twice — the wiring cache the panes render
 * from, and the `$sessionStates` mirror the sidebar reads. These pin that the
 * poll never overrules newer events and never lets the two copies disagree.
 */
describe('rehydrateLiveSessionStatuses — snapshot ordering and the cache', () => {
  beforeEach(() => {
    $selectedStoredSessionId.set(null)
    $unreadFinishedSessionIds.set([])
    resetLiveRuntimeTracking()
    clearAllSessionStates()
  })

  afterEach(() => {
    clearAllSessionStates()
    resetLiveRuntimeTracking()
    $unreadFinishedSessionIds.set([])
  })

  const running = (): ClientSessionState => ({ ...createClientSessionState('stored-a'), busy: true, turnStartedAt: 1 })

  it('an idle snapshot taken before a turn started cannot end that turn', () => {
    const stateAtRequest = $sessionStates.get()
    // message.start landed while the request was in flight.
    publishSessionState('rt-a', running())

    rehydrateLiveSessionStatuses(
      { sessions: [{ id: 'rt-a', session_key: 'stored-a', status: 'idle' }] },
      Date.now(),
      'default',
      stateAtRequest
    )

    expect($sessionStates.get()['rt-a']?.busy).toBe(true)
  })

  it('a working snapshot taken before a turn finished cannot revive it', () => {
    publishSessionState('rt-a', running())
    const stateAtRequest = $sessionStates.get()
    publishSessionState('rt-a', { ...running(), busy: false, turnStartedAt: null })

    rehydrateLiveSessionStatuses(
      { sessions: [{ id: 'rt-a', session_key: 'stored-a', status: 'working' }] },
      Date.now(),
      'default',
      stateAtRequest
    )

    expect($workingSessionIds.get()).not.toContain('stored-a')
  })

  it('a runtime missing from a stale snapshot is judged by the next poll, not reaped', () => {
    rehydrateLiveSessionStatuses({ sessions: [{ id: 'rt-a', session_key: 'stored-a', status: 'working' }] })
    const stateAtRequest = $sessionStates.get()
    publishSessionState('rt-a', { ...$sessionStates.get()['rt-a']!, turnStartedAt: 99 })

    rehydrateLiveSessionStatuses({ sessions: [] }, Date.now(), 'default', stateAtRequest)
    expect($sessionStates.get()['rt-a']?.busy).toBe(true)

    // Kept as a candidate: the next snapshot that also omits it settles it.
    rehydrateLiveSessionStatuses({ sessions: [] })
    expect($sessionStates.get()['rt-a']?.busy).toBe(false)
  })

  it('writes through the supplied commit (the app routes cached runtimes through its cache)', () => {
    const writes: Array<[string, ClientSessionState]> = []

    const commit: LiveSessionStateCommit = (runtimeId, update, storedSessionId) =>
      writes.push([runtimeId, update(createClientSessionState(storedSessionId))])

    rehydrateLiveSessionStatuses(
      { sessions: [{ id: 'rt-a', session_key: 'stored-a', status: 'waiting' }] },
      Date.now(),
      'default',
      $sessionStates.get(),
      commit
    )

    expect(writes).toEqual([
      ['rt-a', expect.objectContaining({ busy: true, needsInput: true, storedSessionId: 'stored-a' })]
    ])
    // Nothing reached the mirror behind the commit's back.
    expect($sessionStates.get()['rt-a']).toBeUndefined()
  })

  it('settles the bubble of a turn whose runtime vanished before its completion reached us', () => {
    publishSessionState('rt-a', {
      ...running(),
      awaitingResponse: false,
      messages: [
        { id: 'u1', parts: [{ text: 'go', type: 'text' }], role: 'user' },
        { id: 's1', parts: [{ text: 'partial answer', type: 'text' }], pending: true, role: 'assistant' },
        { id: 's2', parts: [], pending: true, role: 'assistant' }
      ],
      streamId: 's1'
    })
    rehydrateLiveSessionStatuses({ sessions: [{ id: 'rt-a', session_key: 'stored-a', status: 'working' }] })

    rehydrateLiveSessionStatuses({ sessions: [] })

    const state = $sessionStates.get()['rt-a']!
    // Kept text is un-pended (no endless "thinking"), the empty placeholder
    // goes, and the turn flags clear.
    expect(state.messages.map(m => [m.id, m.pending ?? false])).toEqual([
      ['u1', false],
      ['s1', false]
    ])
    expect(state).toMatchObject({ awaitingResponse: false, busy: false, streamId: null, turnStartedAt: null })
  })

  it('also settles a turn that was only awaiting its first token', () => {
    publishSessionState('rt-a', { ...createClientSessionState('stored-a'), awaitingResponse: true })
    rehydrateLiveSessionStatuses({ sessions: [{ id: 'rt-a', session_key: 'stored-a', status: 'starting' }] })

    rehydrateLiveSessionStatuses({ sessions: [] })

    expect($sessionStates.get()['rt-a']?.awaitingResponse).toBe(false)
  })

  describe('while a send is still on its way to the backend', () => {
    // Four images uploading before prompt.submit: the backend truthfully has
    // no turn, and the submit settles the one on screen either way.
    const sending = (): ClientSessionState => ({ ...running(), awaitingResponse: true })

    afterEach(() => {
      _submitInFlight.clear()
    })

    it('an idle row does not blank its thinking indicator', () => {
      publishSessionState('rt-a', sending())
      _submitInFlight.add('stored-a')

      rehydrateLiveSessionStatuses({ sessions: [{ id: 'rt-a', session_key: 'stored-a', status: 'idle' }] })

      expect($sessionStates.get()['rt-a']).toMatchObject({ awaitingResponse: true, busy: true })
    })

    it('a runtime missing from the snapshot is not settled under it', () => {
      publishSessionState('rt-a', sending())
      rehydrateLiveSessionStatuses({ sessions: [{ id: 'rt-a', session_key: 'stored-a', status: 'working' }] })
      _submitInFlight.add('stored-a')

      rehydrateLiveSessionStatuses({ sessions: [] })
      expect($sessionStates.get()['rt-a']).toMatchObject({ awaitingResponse: true, busy: true })

      // Once the send has landed the next snapshot judges it as usual.
      _submitInFlight.delete('stored-a')
      rehydrateLiveSessionStatuses({ sessions: [] })
      expect($sessionStates.get()['rt-a']?.busy).toBe(false)
    })
  })
})
