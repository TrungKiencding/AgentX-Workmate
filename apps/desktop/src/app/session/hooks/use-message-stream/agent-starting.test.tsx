/**
 * The gateway's `agent-build-slow` keyed notice is transcript state on the
 * desktop, not a toast — plus the message.start timer-origin contract: a
 * submit-stamped turnStartedAt must survive the backend's turn start so the
 * waiting indicator's timer counts from the SEND through a slow agent build.
 */
import { QueryClient } from '@tanstack/react-query'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ClientSessionState } from '@/app/types'
import { createClientSessionState } from '@/lib/chat-runtime'
import { $agentStartingSessions, clearAllAgentStarting, sessionAgentStarting } from '@/store/agent-starting'
import { $notifications } from '@/store/notifications'
import type { RpcEvent } from '@/types/hermes'

import { useMessageStream } from './index'

const SID = 'session-1'
let handleEvent: ((event: RpcEvent) => void) | null = null
let latestState: ClientSessionState | null = null
let seedState: ((state: Partial<ClientSessionState>) => void) | null = null

function Harness() {
  const activeSessionIdRef = useRef<string | null>(SID)
  const sessionStateByRuntimeIdRef = useRef(new Map<string, ClientSessionState>())
  const queryClientRef = useRef(new QueryClient())

  const stream = useMessageStream({
    activeSessionIdRef,
    hydrateFromStoredSession: vi.fn(async () => undefined),
    queryClient: queryClientRef.current,
    refreshHermesConfig: vi.fn(async () => undefined),
    refreshSessions: vi.fn(async () => undefined),
    sessionStateByRuntimeIdRef,
    updateSessionState: (sessionId, updater) => {
      const current = sessionStateByRuntimeIdRef.current.get(sessionId) ?? createClientSessionState()
      const next = updater(current)
      sessionStateByRuntimeIdRef.current.set(sessionId, next)
      latestState = next

      return next
    }
  })

  useEffect(() => {
    handleEvent = stream.handleGatewayEvent

    seedState = state => {
      const current = sessionStateByRuntimeIdRef.current.get(SID) ?? createClientSessionState()
      sessionStateByRuntimeIdRef.current.set(SID, { ...current, ...state })
    }
  }, [stream.handleGatewayEvent])

  return null
}

async function mountStream() {
  render(<Harness />)
  await waitFor(() => expect(handleEvent).not.toBeNull())
}

function emit(type: RpcEvent['type'], payload: RpcEvent['payload'] = {}) {
  act(() => handleEvent!({ payload, session_id: SID, type }))
}

beforeEach(() => {
  handleEvent = null
  latestState = null
  seedState = null
})

afterEach(() => {
  cleanup()
  clearAllAgentStarting()
  $notifications.set([])
  vi.restoreAllMocks()
})

describe('agent-build-slow notice handling', () => {
  it('sets the per-session starting flag instead of toasting', async () => {
    await mountStream()

    emit('notification.show', {
      key: 'agent-build-slow',
      kind: 'agent',
      level: 'info',
      text: 'Still starting the agent…',
      ttl_ms: null
    })

    expect(sessionAgentStarting(SID).get()).toBe(true)
    expect($notifications.get()).toEqual([])
  })

  it('clears the flag on the matching notification.clear', async () => {
    await mountStream()

    emit('notification.show', { key: 'agent-build-slow', kind: 'agent', level: 'info', text: 'x' })
    emit('notification.clear', { key: 'agent-build-slow' })

    expect(sessionAgentStarting(SID).get()).toBe(false)
  })

  it('an unrelated notification.clear leaves the flag alone', async () => {
    await mountStream()

    emit('notification.show', { key: 'agent-build-slow', kind: 'agent', level: 'info', text: 'x' })
    emit('notification.clear', { key: 'credits.restored' })

    expect(sessionAgentStarting(SID).get()).toBe(true)
  })

  it('message.start retires the flag even without a notification.clear', async () => {
    await mountStream()

    emit('notification.show', { key: 'agent-build-slow', kind: 'agent', level: 'info', text: 'x' })
    emit('message.start')

    expect(sessionAgentStarting(SID).get()).toBe(false)
  })

  it('a turn error retires the flag', async () => {
    await mountStream()

    emit('notification.show', { key: 'agent-build-slow', kind: 'agent', level: 'info', text: 'x' })
    emit('error', { message: 'model exploded' })

    expect(sessionAgentStarting(SID).get()).toBe(false)
  })

  it('other notices still toast', async () => {
    await mountStream()

    emit('notification.show', { key: 'credits.75', kind: 'ttl', level: 'warn', text: '⚠ 75% used' })

    expect($agentStartingSessions.get()).toEqual({})
    expect($notifications.get()).toHaveLength(1)
  })
})

describe('message.start timer origin', () => {
  it('keeps a submit-stamped turnStartedAt while the turn was awaited', async () => {
    await mountStream()

    seedState!({ awaitingResponse: true, busy: true, turnStartedAt: 12345 })
    emit('message.start')

    expect(latestState?.turnStartedAt).toBe(12345)
  })

  it('stamps a fresh origin for backend-initiated turns', async () => {
    await mountStream()

    const before = Date.now()
    emit('message.start')

    expect(latestState?.turnStartedAt).toBeGreaterThanOrEqual(before)
  })
})
