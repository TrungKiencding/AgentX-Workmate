import { QueryClient } from '@tanstack/react-query'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ClientSessionState } from '@/app/types'
import { createClientSessionState } from '@/lib/chat-runtime'
import { $clarifyRequests, clearClarifyRequest } from '@/store/clarify'
import { dispatchNativeNotification } from '@/store/native-notifications'
import { clearAllPrompts } from '@/store/prompts'
import type { RpcEvent } from '@/types/hermes'

import { useMessageStream } from './index'

vi.mock('@/store/native-notifications', () => ({ dispatchNativeNotification: vi.fn() }))

// A question the session is blocked on comes back through the normal event
// path when a window (re)attaches to it. It must render like a live one — the
// user has to be able to answer it — but it was already announced once, so it
// must not raise a second OS notification.

const SID = 'rt-1'
let handleEvent: ((event: RpcEvent) => void) | null = null
let states: Map<string, ClientSessionState>

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
      const next = updater(sessionStateByRuntimeIdRef.current.get(sessionId) ?? createClientSessionState())
      sessionStateByRuntimeIdRef.current.set(sessionId, next)

      return next
    }
  })

  useEffect(() => {
    handleEvent = stream.handleGatewayEvent
    states = sessionStateByRuntimeIdRef.current
  }, [stream.handleGatewayEvent])

  return null
}

async function mount() {
  render(<Harness />)
  await waitFor(() => expect(handleEvent).not.toBeNull())
}

const send = (type: string, payload: Record<string, unknown>) =>
  act(() => handleEvent!({ payload, session_id: SID, type }))

beforeEach(() => {
  handleEvent = null
  vi.mocked(dispatchNativeNotification).mockClear()
})

afterEach(() => {
  cleanup()
  clearClarifyRequest()
  clearAllPrompts()
})

describe('replayed blocking prompts', () => {
  it('a replayed clarify renders and blocks like a live one, without a second OS notification', async () => {
    await mount()

    send('clarify.request', { choices: ['a', 'b'], question: 'Pick one?', replayed: true, request_id: 'r1' })

    expect($clarifyRequests.get()[SID]).toMatchObject({ question: 'Pick one?', requestId: 'r1' })
    expect(states.get(SID)?.needsInput).toBe(true)
    expect(dispatchNativeNotification).not.toHaveBeenCalled()
  })

  it('a live clarify still notifies', async () => {
    await mount()

    send('clarify.request', { choices: ['a'], question: 'Pick one?', request_id: 'r2' })

    expect(dispatchNativeNotification).toHaveBeenCalledTimes(1)
  })

  it('replayed sudo and secret prompts stay quiet too', async () => {
    await mount()

    send('sudo.request', { replayed: true, request_id: 's1' })
    send('secret.request', { env_var: 'API_KEY', prompt: 'Key?', replayed: true, request_id: 's2' })

    expect(states.get(SID)?.needsInput).toBe(true)
    expect(dispatchNativeNotification).not.toHaveBeenCalled()
  })
})
