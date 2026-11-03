import { QueryClient } from '@tanstack/react-query'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ClientSessionState } from '@/app/types'
import { chatMessageText } from '@/lib/chat-messages'
import { createClientSessionState } from '@/lib/chat-runtime'
import { dispatchNativeNotification } from '@/store/native-notifications'
import { $notifications, clearNotifications } from '@/store/notifications'
import type { RpcEvent } from '@/types/hermes'

import { useMessageStream } from './index'

vi.mock('@/store/native-notifications', () => ({ dispatchNativeNotification: vi.fn() }))

const SID = 'session-1'

let handleEvent: ((event: RpcEvent) => void) | null = null
let sessionStates: Map<string, ClientSessionState>

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
      sessionStates.set(sessionId, next)

      return next
    }
  })

  useEffect(() => {
    handleEvent = stream.handleGatewayEvent
  }, [stream.handleGatewayEvent])

  return null
}

async function mountStream() {
  sessionStates = new Map()
  render(<Harness />)
  await waitFor(() => expect(handleEvent).not.toBeNull())
}

const start = () => act(() => handleEvent!({ payload: {}, session_id: SID, type: 'message.start' }))
const delta = (text: string) => act(() => handleEvent!({ payload: { text }, session_id: SID, type: 'message.delta' }))

const completeWithError = (payload: Record<string, unknown>) =>
  act(() => handleEvent!({ payload: { status: 'error', ...payload }, session_id: SID, type: 'message.complete' }))

function getState(): ClientSessionState {
  return sessionStates.get(SID) ?? createClientSessionState()
}

function lastAssistant() {
  return [...getState().messages].reverse().find(m => m.role === 'assistant' && !m.hidden)
}

describe('terminal error message.complete frames', () => {
  beforeEach(() => {
    handleEvent = null
    vi.mocked(dispatchNativeNotification).mockClear()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('marks the bubble failed from the structured error field, not the text heuristic', async () => {
    await mountStream()
    await start()
    await delta('…')

    // "Error: <detail>" does not match the legacy completionErrorText regexes.
    await completeWithError({ text: 'Error: invalid model slug', error: 'invalid model slug', recoverable: true })

    const bubble = lastAssistant()
    expect(bubble?.error).toBe('invalid model slug')
    expect(getState().busy).toBe(false)
    expect(getState().awaitingResponse).toBe(false)
  })

  it('keeps streamed partial text visible on a partial failure', async () => {
    await mountStream()
    await start()
    await delta('half an ans')

    await completeWithError({
      text: 'half an ans',
      error: 'connection reset mid-stream',
      partial: true,
      recoverable: true
    })

    const bubble = lastAssistant()
    expect(bubble?.error).toBe('connection reset mid-stream')
    expect(chatMessageText(bubble!)).toBe('half an ans')
    expect(bubble?.pending).toBe(false)
  })

  it('falls back to the frame text when no error field is present', async () => {
    await mountStream()
    await start()
    await delta('…')

    await completeWithError({ text: 'Error: something broke' })

    const bubble = lastAssistant()
    expect(bubble?.error).toBe('Error: something broke')
  })

  it("keeps the gateway's failure code on the bubble, beside the raw text", async () => {
    await mountStream()
    await start()

    const raw = 'API call failed after 3 retries: HTTP 429: {"error":{"message":"Rate limit reached"}}'
    await completeWithError({
      text: `Error: ${raw}`,
      error: raw,
      failure_code: 'rate_limited',
      failure_reason: 'rate_limit'
    })

    expect(lastAssistant()).toMatchObject({ error: raw, errorCode: 'rate_limited' })
  })

  it('tells an overloaded provider apart by the classified reason', async () => {
    await mountStream()
    await start()

    await completeWithError({
      error: 'HTTP 500: upstream',
      failure_code: 'upstream_error',
      failure_reason: 'overloaded'
    })

    expect(lastAssistant()?.errorCode).toBe('overloaded')
  })

  it('reads the text when the frame carries only the fallback code, or none (an older backend)', async () => {
    await mountStream()
    await start()
    await completeWithError({
      error: 'Context length exceeded: max compression attempts (3) reached.',
      failure_code: 'operation_failed'
    })
    expect(lastAssistant()?.errorCode).toBe('context_too_long')

    await start()
    await completeWithError({ error: 'Connection error.' })
    expect(lastAssistant()?.errorCode).toBe('network_error')
  })

  it('still fails the bubble when the frame carries no text at all', async () => {
    await mountStream()
    await start()

    await completeWithError({ failure_code: 'compute_host_error' })

    expect(lastAssistant()).toMatchObject({ error: 'compute_host_error', errorCode: 'compute_host_error' })
  })

  it('says offline when the device had no network', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    await mountStream()
    await start()

    await completeWithError({ error: 'Connection error.', failure_code: 'network_error' })

    expect(lastAssistant()?.errorCode).toBe('offline')
  })

  it('notifies a failed turn as one, in plain words', async () => {
    await mountStream()
    await start()

    await completeWithError({ error: 'HTTP 429: slow down', failure_code: 'rate_limited' })

    expect(dispatchNativeNotification).toHaveBeenCalledWith({
      body: 'Too many requests right now',
      kind: 'turnError',
      sessionId: SID,
      title: 'Turn failed'
    })
  })

  it('still notifies a healthy turn as done', async () => {
    await mountStream()
    await start()

    await act(() =>
      handleEvent!({ payload: { status: 'complete', text: 'All done.' }, session_id: SID, type: 'message.complete' })
    )

    expect(dispatchNativeNotification).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'All done.', kind: 'turnDone' })
    )
  })
})

describe('bare error events', () => {
  beforeEach(() => {
    handleEvent = null
    clearNotifications()
    vi.mocked(dispatchNativeNotification).mockClear()
  })

  afterEach(() => {
    cleanup()
    clearNotifications()
    vi.restoreAllMocks()
  })

  const raise = (message: unknown) =>
    act(() => handleEvent!({ payload: { message } as never, session_id: SID, type: 'error' }))

  it('fails the bubble, toasts in plain words and keeps the raw text folded', async () => {
    await mountStream()
    await start()

    const raw = "Could not switch model: Error code: 404 - {'error': {'message': 'The model `x` does not exist'}}"
    await raise(raw)

    expect(lastAssistant()).toMatchObject({ error: raw, errorCode: 'model_unavailable' })

    const toasts = $notifications.get()
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toMatchObject({
      id: `gateway-error:${raw}`,
      kind: 'error',
      title: "This model isn't available right now",
      message: 'It may have been removed or paused. Pick another model and try again.',
      detail: `Error code: model_unavailable\n${raw}`
    })
    expect(dispatchNativeNotification).toHaveBeenCalledWith({
      body: "This model isn't available right now",
      kind: 'turnError',
      sessionId: SID,
      title: 'Turn failed'
    })
  })

  it('collapses the same error from several turns into one toast', async () => {
    await mountStream()
    await start()
    await raise('Connection error.')
    await start()
    await raise('Connection error.')

    expect($notifications.get()).toHaveLength(1)
  })

  it('never shows an English placeholder when the event carries no message', async () => {
    await mountStream()
    await start()

    await raise(undefined)

    expect(lastAssistant()).toMatchObject({ error: 'operation_failed', errorCode: 'operation_failed' })
    expect($notifications.get()[0]).toMatchObject({
      title: 'Something went wrong',
      detail: 'Error code: operation_failed'
    })
  })
})
