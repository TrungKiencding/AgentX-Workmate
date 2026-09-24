import { QueryClient } from '@tanstack/react-query'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ClientSessionState } from '@/app/types'
import { textPart } from '@/lib/chat-messages'
import { createClientSessionState } from '@/lib/chat-runtime'
import type { RpcEvent } from '@/types/hermes'

import { useMessageStream } from './index'

// A window that (re)attached to a turn already running — a switch back, a
// reconnect, a tab re-binding — never received what was emitted before the
// attach: the prompt row, early tool calls, anything streamed while nobody was
// listening. Streaming the rest of the reply is not proof it saw the whole
// turn, so when that turn settles it re-reads the stored history.

const SID = 'rt-1'
const STORED = 'stored-1'

let handleEvent: ((event: RpcEvent) => void) | null = null
let states: Map<string, ClientSessionState>
let hydrate: ReturnType<typeof vi.fn>

function Harness({ seed }: { seed: Partial<ClientSessionState> }) {
  const activeSessionIdRef = useRef<string | null>(SID)

  const sessionStateByRuntimeIdRef = useRef(
    new Map<string, ClientSessionState>([[SID, { ...createClientSessionState(STORED), ...seed }]])
  )

  const queryClientRef = useRef(new QueryClient())

  const stream = useMessageStream({
    activeSessionIdRef,
    hydrateFromStoredSession: hydrate as never,
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

async function mount(seed: Partial<ClientSessionState>) {
  render(<Harness seed={seed} />)
  await waitFor(() => expect(handleEvent).not.toBeNull())
}

const liveTurn: Partial<ClientSessionState> = {
  awaitingResponse: false,
  busy: true,
  messages: [{ id: 'assistant-stream-rt-1', parts: [textPart('partial')], pending: true, role: 'assistant' }],
  sawAssistantPayload: true,
  streamId: 'assistant-stream-rt-1'
}

const complete = () =>
  act(() => handleEvent!({ payload: { text: 'partial and the rest' }, session_id: SID, type: 'message.complete' }))

beforeEach(() => {
  handleEvent = null
  hydrate = vi.fn(async () => undefined)
})

afterEach(() => {
  cleanup()
})

describe('settling a turn this window adopted mid-flight', () => {
  it('hydrates from stored history when the adopted turn completes', async () => {
    await mount({ ...liveTurn, adoptedRunningTurn: true })

    await complete()

    expect(hydrate).toHaveBeenCalledWith(3, STORED, SID)
    expect(states.get(SID)?.adoptedRunningTurn).toBe(false)
  })

  it('skips the re-read for a turn this window streamed from its start', async () => {
    await mount({ ...liveTurn, adoptedRunningTurn: false })

    await complete()

    expect(hydrate).not.toHaveBeenCalled()
  })

  it('a running:false settle clears the adoption so the next turn is not re-read for nothing', async () => {
    await mount({ ...liveTurn, adoptedRunningTurn: true })

    act(() => handleEvent!({ payload: { running: false }, session_id: SID, type: 'session.info' }))

    expect(states.get(SID)).toMatchObject({ adoptedRunningTurn: false, busy: false })
  })
})
