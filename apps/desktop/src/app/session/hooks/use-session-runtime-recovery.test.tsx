import { useStore } from '@nanostores/react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as HermesModule from '@/hermes'
import { type ChatMessage, textPart } from '@/lib/chat-messages'
import { createClientSessionState } from '@/lib/chat-runtime'
import {
  $activeSessionId,
  setActiveSessionId,
  setAwaitingResponse,
  setBusy,
  setMessages,
  setSessions
} from '@/store/session'
import { $sessionStates, $sessionTiles, clearAllSessionStates, patchSessionTile } from '@/store/session-states'
import type { RpcEvent, SessionInfo } from '@/types/hermes'

import type { ClientSessionState } from '../../types'

import { _submitInFlight } from './use-prompt-actions/utils'
import { useSessionRuntimeRecovery } from './use-session-runtime-recovery'
import { useSessionStateCache } from './use-session-state-cache'

vi.mock('@/hermes', async importActual => ({
  ...(await importActual<typeof HermesModule>()),
  getSessionMessages: vi.fn(async () => ({ messages: [], session_id: '' }))
}))

const { getSessionMessages } = await import('@/hermes')

type Gateway = ReturnType<typeof vi.fn>

interface Api {
  cache: ReturnType<typeof useSessionStateCache>
  recovery: ReturnType<typeof useSessionRuntimeRecovery>
}

let api: Api | null = null

function Harness({ replay, requestGateway }: { replay: (event: RpcEvent) => void; requestGateway: Gateway }) {
  const activeSessionId = useStore($activeSessionId)
  const busyRef = useRef(false)

  const cache = useSessionStateCache({
    activeSessionId,
    busyRef,
    selectedStoredSessionId: null,
    setAwaitingResponse,
    setBusy,
    setMessages
  })

  const recovery = useSessionRuntimeRecovery({
    rehomeRuntime: cache.rehomeRuntime,
    replayGatewayEvent: replay,
    requestGateway: requestGateway as never,
    runtimeIdByStoredSessionIdRef: cache.runtimeIdByStoredSessionIdRef,
    sessionStateByRuntimeIdRef: cache.sessionStateByRuntimeIdRef,
    updateSessionState: cache.updateSessionState
  })

  useEffect(() => {
    api = { cache, recovery }
  })

  return null
}

async function mount(requestGateway: Gateway, replay: (event: RpcEvent) => void = vi.fn()) {
  render(<Harness replay={replay} requestGateway={requestGateway} />)
  await waitFor(() => expect(api).not.toBeNull())

  return api!
}

const row = (id: string, over: Partial<SessionInfo> = {}): SessionInfo =>
  ({
    ended_at: null,
    id,
    input_tokens: 0,
    is_active: false,
    last_active: 0,
    message_count: 2,
    model: null,
    output_tokens: 0,
    preview: null,
    profile: 'default',
    source: null,
    started_at: 0,
    title: null,
    ...over
  }) as SessionInfo

const user = (id: string, text: string): ChatMessage => ({ id, parts: [textPart(text)], role: 'user' })

const assistant = (id: string, text: string, pending = false): ChatMessage => ({
  id,
  parts: [textPart(text)],
  pending,
  role: 'assistant'
})

const texts = (state: ClientSessionState | undefined) =>
  (state?.messages ?? []).map(m => `${m.role}:${m.parts.map(p => ('text' in p ? p.text : p.type)).join('')}`)

/** Seed the cache the way a bound tile's runtime looks after it streamed. */
function seedRuntime(
  cache: Api['cache'],
  runtimeId: string,
  storedSessionId: string,
  patch: Partial<ClientSessionState>
) {
  act(() => {
    cache.updateSessionState(runtimeId, state => ({ ...state, ...patch }), storedSessionId)
  })
}

const persisted = (rows: Array<[string, string]>, sessionId = 'stored-1') => ({
  messages: rows.map(([role, content], index) => ({ content, role, timestamp: index + 1 })),
  session_id: sessionId
})

beforeEach(() => {
  api = null
  setSessions([row('stored-1')])
  setActiveSessionId(null)
  clearAllSessionStates()
  $sessionTiles.set([])
  vi.mocked(getSessionMessages).mockReset()
  vi.mocked(getSessionMessages).mockResolvedValue({ messages: [], session_id: '' } as never)
})

afterEach(() => {
  cleanup()
  setSessions([])
  setActiveSessionId(null)
  clearAllSessionStates()
  $sessionTiles.set([])
})

describe('attachSessionRuntime — a tile re-attaching after a reconnect', () => {
  it('re-attaches a cached runtime in place instead of handing the stale binding back', async () => {
    const requestGateway = vi.fn(async (method: string) =>
      method === 'session.activate'
        ? ({
            messages: [],
            messages_omitted: true,
            running: false,
            session_id: 'rt-1',
            session_key: 'stored-1'
          } as never)
        : ({} as never)
    )

    const { cache, recovery } = await mount(requestGateway)
    seedRuntime(cache, 'rt-1', 'stored-1', { messages: [user('u1', 'hi'), assistant('a1', 'hello')] })

    await act(async () => {
      await expect(recovery.attachSessionRuntime('stored-1')).resolves.toBe('rt-1')
    })

    // session.activate is what re-points the runtime's events at this socket.
    expect(requestGateway).toHaveBeenCalledWith('session.activate', {
      cols: 96,
      omit_messages: true,
      session_id: 'rt-1'
    })
    expect(requestGateway).not.toHaveBeenCalledWith('session.resume', expect.anything())
  })

  it('settles a turn that finished while nobody was attached, from the stored transcript', async () => {
    vi.mocked(getSessionMessages).mockResolvedValue(
      persisted([
        ['user', 'hi'],
        ['assistant', 'hello'],
        ['user', 'long task'],
        ['assistant', 'the final answer']
      ]) as never
    )

    const requestGateway = vi.fn(async () => ({
      messages: [],
      messages_omitted: true,
      running: false,
      session_id: 'rt-1',
      session_key: 'stored-1'
    }))

    const { cache, recovery } = await mount(requestGateway)
    seedRuntime(cache, 'rt-1', 'stored-1', {
      awaitingResponse: true,
      busy: true,
      messages: [user('u1', 'hi'), assistant('a1', 'hello'), user('user-opt', 'long task'), assistant('s1', '', true)],
      streamId: 's1',
      turnStartedAt: 1
    })

    await act(async () => {
      await recovery.attachSessionRuntime('stored-1')
    })

    const state = cache.sessionStateByRuntimeIdRef.current.get('rt-1')
    expect(texts(state)).toEqual(['user:hi', 'assistant:hello', 'user:long task', 'assistant:the final answer'])
    expect(state).toMatchObject({ awaitingResponse: false, busy: false, needsInput: false, streamId: null })
    expect($sessionStates.get()['rt-1']?.busy).toBe(false)
  })

  it('leaves a send still staging its attachments to its own submit', async () => {
    // The reconnect re-attach answers between image.attach and prompt.submit:
    // the backend has no turn yet, but the one on screen is real.
    const requestGateway = vi.fn(async () => ({
      messages: [],
      messages_omitted: true,
      running: false,
      session_id: 'rt-1',
      session_key: 'stored-1'
    }))

    const { cache, recovery } = await mount(requestGateway)
    seedRuntime(cache, 'rt-1', 'stored-1', {
      awaitingResponse: true,
      busy: true,
      messages: [user('u1', 'hi'), assistant('a1', 'hello'), user('user-opt', 'Kho lạnh')],
      turnStartedAt: 7
    })

    _submitInFlight.add('stored-1')

    try {
      await act(async () => {
        await recovery.attachSessionRuntime('stored-1')
      })
    } finally {
      _submitInFlight.delete('stored-1')
    }

    const state = cache.sessionStateByRuntimeIdRef.current.get('rt-1')
    expect(state).toMatchObject({ awaitingResponse: true, busy: true, turnStartedAt: 7 })
    expect(texts(state).at(-1)).toBe('user:Kho lạnh')
  })

  it('keeps the whole conversation when the re-attached turn is still running', async () => {
    vi.mocked(getSessionMessages).mockResolvedValue(
      persisted([
        ['user', 'hi'],
        ['assistant', 'hello'],
        ['user', 'long task']
      ]) as never
    )

    const requestGateway = vi.fn(async () => ({
      inflight: { assistant: 'partial answer', streaming: true, user: 'long task' },
      messages: [],
      messages_omitted: true,
      running: true,
      session_id: 'rt-1',
      session_key: 'stored-1'
    }))

    const { cache, recovery } = await mount(requestGateway)
    seedRuntime(cache, 'rt-1', 'stored-1', {
      busy: true,
      messages: [user('u1', 'hi'), assistant('a1', 'hello'), user('user-opt', 'long task')]
    })

    await act(async () => {
      await recovery.attachSessionRuntime('stored-1')
    })

    const state = cache.sessionStateByRuntimeIdRef.current.get('rt-1')!

    // The omitted transcript is not an empty one: history stays, the live
    // turn is grafted on, and later deltas extend that projected row.
    expect(texts(state)).toEqual(['user:hi', 'assistant:hello', 'user:long task', 'assistant:partial answer'])
    expect(state.busy).toBe(true)
    expect(state.adoptedRunningTurn).toBe(true)
    expect(state.awaitingResponse).toBe(false)
    expect(state.streamId).toBe(state.messages.at(-1)!.id)
  })

  it('rebinds a runtime the backend reaped and moves the conversation — and the tile — onto it', async () => {
    const requestGateway = vi.fn(async (method: string) => {
      if (method === 'session.activate') {
        throw new Error('session not found')
      }

      return { messages: [], messages_omitted: true, running: false, session_id: 'rt-2', session_key: 'stored-1' }
    })

    const { cache, recovery } = await mount(requestGateway)
    seedRuntime(cache, 'rt-1', 'stored-1', { messages: [user('u1', 'hi'), assistant('a1', 'hello')], model: 'm-1' })
    act(() => {
      $sessionTiles.set([{ storedSessionId: 'stored-1' }])
      patchSessionTile('stored-1', { runtimeId: 'rt-1' })
    })

    await act(async () => {
      await expect(recovery.attachSessionRuntime('stored-1')).resolves.toBe('rt-2')
    })

    expect(requestGateway).toHaveBeenCalledWith('session.resume', {
      cols: 96,
      omit_messages: true,
      profile: 'default',
      session_id: 'stored-1'
    })
    expect(cache.sessionStateByRuntimeIdRef.current.has('rt-1')).toBe(false)
    expect($sessionStates.get()['rt-1']).toBeUndefined()
    expect(texts(cache.sessionStateByRuntimeIdRef.current.get('rt-2'))).toEqual(['user:hi', 'assistant:hello'])
    expect(cache.runtimeIdByStoredSessionIdRef.current.get('stored-1')).toBe('rt-2')
    expect($sessionTiles.get()[0]?.runtimeId).toBe('rt-2')
  })

  it('binds a cold tile with its owning profile and paints the runtime facts it reports', async () => {
    setSessions([row('stored-x', { profile: 'ai-engineer' })])
    vi.mocked(getSessionMessages).mockResolvedValue(
      persisted(
        [
          ['user', 'q'],
          ['assistant', 'a']
        ],
        'stored-x'
      ) as never
    )

    const requestGateway = vi.fn(async () => ({
      info: { model: 'MiniMax-M3', provider: 'litellm' },
      messages: [],
      messages_omitted: true,
      running: false,
      session_id: 'rt-x',
      session_key: 'stored-x'
    }))

    const { cache, recovery } = await mount(requestGateway)

    await act(async () => {
      await expect(recovery.attachSessionRuntime('stored-x')).resolves.toBe('rt-x')
    })

    // A resume or read without the profile forks the chat into the launch
    // profile's DB (#67603).
    expect(getSessionMessages).toHaveBeenCalledWith('stored-x', 'ai-engineer')
    expect(requestGateway).toHaveBeenCalledWith('session.resume', {
      cols: 96,
      omit_messages: true,
      profile: 'ai-engineer',
      session_id: 'stored-x'
    })

    const state = cache.sessionStateByRuntimeIdRef.current.get('rt-x')
    expect(texts(state)).toEqual(['user:q', 'assistant:a'])
    // No model → the pill shows a spinner until some later session.info.
    expect(state?.model).toBe('MiniMax-M3')
  })

  it('replays the question a re-attached session is blocked on, marked as a replay', async () => {
    const replay = vi.fn()

    const requestGateway = vi.fn(async () => ({
      messages: [],
      messages_omitted: true,
      pending_prompts: [
        { event: 'clarify.request', payload: { choices: ['a', 'b'], question: 'Pick?', request_id: 'r1' } }
      ],
      running: true,
      session_id: 'rt-1',
      session_key: 'stored-1'
    }))

    const { cache, recovery } = await mount(requestGateway, replay)
    seedRuntime(cache, 'rt-1', 'stored-1', { busy: true, messages: [user('u1', 'go')] })

    await act(async () => {
      await recovery.attachSessionRuntime('stored-1')
    })

    expect(replay).toHaveBeenCalledWith({
      payload: { choices: ['a', 'b'], question: 'Pick?', replayed: true, request_id: 'r1' },
      session_id: 'rt-1',
      type: 'clarify.request'
    })
    expect(cache.sessionStateByRuntimeIdRef.current.get('rt-1')?.needsInput).toBe(true)
  })

  it('surfaces a transient activation failure instead of guessing the runtime is gone', async () => {
    const requestGateway = vi.fn(async (method: string) => {
      if (method === 'session.activate') {
        throw new Error('request timed out after 30s: session.activate')
      }

      return {}
    })

    const { cache, recovery } = await mount(requestGateway)
    seedRuntime(cache, 'rt-1', 'stored-1', { messages: [user('u1', 'hi')] })

    await expect(recovery.attachSessionRuntime('stored-1')).rejects.toThrow('timed out')
    expect(requestGateway).not.toHaveBeenCalledWith('session.resume', expect.anything())
    expect(cache.sessionStateByRuntimeIdRef.current.has('rt-1')).toBe(true)
  })

  it('keeps the cached binding on a backend that predates session.activate', async () => {
    const requestGateway = vi.fn(async (method: string) => {
      if (method === 'session.activate') {
        throw new Error('method not found')
      }

      return {}
    })

    const { cache, recovery } = await mount(requestGateway)
    seedRuntime(cache, 'rt-1', 'stored-1', { messages: [user('u1', 'hi')] })

    await expect(recovery.attachSessionRuntime('stored-1')).resolves.toBe('rt-1')
    expect(requestGateway).not.toHaveBeenCalledWith('session.resume', expect.anything())
  })
})

describe('recoverSessionRuntime — a send whose runtime is already gone', () => {
  it('carries the conversation and the turn being sent onto the live runtime', async () => {
    vi.mocked(getSessionMessages).mockResolvedValue(
      persisted([
        ['user', 'hi'],
        ['assistant', 'hello'],
        ['user', 'second question'],
        ['assistant', 'an answer this window never saw']
      ]) as never
    )

    const requestGateway = vi.fn(async () => ({
      messages: [],
      messages_omitted: true,
      running: false,
      session_id: 'rt-2',
      session_key: 'stored-1'
    }))

    const { cache, recovery } = await mount(requestGateway)
    seedRuntime(cache, 'rt-1', 'stored-1', {
      awaitingResponse: true,
      busy: true,
      messages: [user('u1', 'hi'), assistant('a1', 'hello'), user('user-123-abc', 'Kho lạnh')],
      turnStartedAt: 42
    })
    act(() => setActiveSessionId('rt-1'))

    let recovered: null | string = null

    await act(async () => {
      recovered = await recovery.recoverSessionRuntime('stored-1', 'rt-1')
    })

    expect(recovered).toBe('rt-2')
    expect(requestGateway).toHaveBeenCalledWith('session.resume', {
      omit_messages: true,
      profile: 'default',
      session_id: 'stored-1',
      source: 'desktop'
    })

    const state = cache.sessionStateByRuntimeIdRef.current.get('rt-2')!

    // The stored turns it missed come back, the prompt being sent stays last,
    // and the turn state is the caller's: nothing here settles it.
    expect(texts(state)).toEqual([
      'user:hi',
      'assistant:hello',
      'user:second question',
      'assistant:an answer this window never saw',
      'user:Kho lạnh'
    ])
    expect(state).toMatchObject({ awaitingResponse: true, busy: true, turnStartedAt: 42 })
    expect(cache.sessionStateByRuntimeIdRef.current.has('rt-1')).toBe(false)
    // The main chat follows the conversation onto the live runtime.
    expect($activeSessionId.get()).toBe('rt-2')
    expect(cache.activeSessionIdRef.current).toBe('rt-2')
  })

  it('never carries another conversation that happened to hold the stale id', async () => {
    const requestGateway = vi.fn(async () => ({
      messages: [],
      messages_omitted: true,
      running: false,
      session_id: 'rt-2',
      session_key: 'stored-1'
    }))

    setSessions([row('stored-1'), row('stored-other')])

    const { cache, recovery } = await mount(requestGateway)
    seedRuntime(cache, 'rt-1', 'stored-other', { messages: [user('u9', 'someone else')] })

    await act(async () => {
      await recovery.recoverSessionRuntime('stored-1', 'rt-1')
    })

    expect(texts(cache.sessionStateByRuntimeIdRef.current.get('rt-1'))).toEqual(['user:someone else'])
    expect(texts(cache.sessionStateByRuntimeIdRef.current.get('rt-2'))).toEqual([])
  })

  it('reports no runtime when the resume yields none', async () => {
    const requestGateway = vi.fn(async () => ({}))
    const { recovery } = await mount(requestGateway)

    await expect(recovery.recoverSessionRuntime('stored-1', null)).resolves.toBeNull()
  })

  it('a stale runtime without cached state still leaves the live one bound to the stored id', async () => {
    const requestGateway = vi.fn(async () => ({ messages: [], session_id: 'rt-2', session_key: 'stored-1' }))
    const { cache, recovery } = await mount(requestGateway)

    await act(async () => {
      await recovery.recoverSessionRuntime('stored-1', 'rt-unknown')
    })

    expect(cache.getRuntimeIdForStoredSession('stored-1')).toBe('rt-2')
    expect(createClientSessionState('stored-1').messages).toEqual([])
  })
})
