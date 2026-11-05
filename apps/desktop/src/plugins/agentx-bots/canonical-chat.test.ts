import { host } from '@agentx/plugin-sdk'
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'

import { createCanonicalChat, openCanonicalChat, resetCanonicalChats } from './canonical-chat'
import { $botMeta, resetBotState } from './state'

type Handler = (params: Record<string, unknown>) => unknown

let handlers: Record<string, Handler>
let calls: string[]
let openSession: MockInstance
let activate: MockInstance

beforeEach(() => {
  resetBotState()
  resetCanonicalChats()
  calls = []
  handlers = {
    'profiles.configure': () => ({ applied: { ui_meta: true } }),
    'session.create': () => ({ session_id: 'rt-1', stored_session_id: 'stored-1' }),
    'prompt.submit': () => ({ ok: true })
  }
  vi.spyOn(host, 'request').mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
    calls.push(method)
    const handler = handlers[method]

    if (!handler) {
      throw new Error(`unexpected ${method}`)
    }

    return handler(params) as never
  })
  activate = vi.spyOn(host, 'activateProfile').mockImplementation(async () => {
    calls.push('activate')
  })
  openSession = vi.spyOn(host, 'openSession').mockImplementation(async () => {
    calls.push('open')
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createCanonicalChat', () => {
  it('switches to the bot backend first, then creates, opens and kicks off', async () => {
    await expect(createCanonicalChat('writer', 'Chào bạn!')).resolves.toBe('stored-1')

    expect(activate).toHaveBeenCalledWith('writer')
    expect(calls.filter(call => call !== 'profiles.configure')).toEqual([
      'activate',
      'session.create',
      'open',
      'prompt.submit'
    ])
    expect($botMeta.get().writer.chat).toBe('stored-1')
  })

  it('creates the chat with the protocol title', async () => {
    const create = vi.fn(() => ({ session_id: 'rt', stored_session_id: 's' }))
    handlers['session.create'] = create

    await createCanonicalChat('writer', 'hi')

    expect(create).toHaveBeenCalledWith({ profile: 'writer', title: 'Bot Chat' })
  })

  it('is single-flight per bot', async () => {
    const [a, b] = [createCanonicalChat('writer', 'hi'), createCanonicalChat('writer', 'hi')]

    expect(a).toBe(b)
    await a
    expect(calls.filter(call => call === 'session.create')).toHaveLength(1)
  })

  it('clears the pin when the kickoff fails', async () => {
    handlers['prompt.submit'] = () => {
      throw new Error('boom')
    }

    await expect(createCanonicalChat('writer', 'hi')).rejects.toThrow('boom')
    expect($botMeta.get().writer.chat).toBeNull()
  })
})

describe('openCanonicalChat', () => {
  it('opens the pinned chat when it still exists', async () => {
    $botMeta.set({ writer: { chat: 'pinned' } })
    handlers['session.list'] = () => ({ sessions: [{ id: 'other' }, { id: 'pinned' }] })

    await expect(openCanonicalChat('writer', 'hi')).resolves.toBe('pinned')
    expect(openSession).toHaveBeenCalledWith('pinned', { profile: 'writer' })
    expect(calls).not.toContain('session.create')
  })

  it('adopts an existing Bot Chat, never an unrelated recent session', async () => {
    handlers['session.list'] = () => ({
      sessions: [
        { id: 'recent', title: 'Kế hoạch' },
        { id: 'bc', title: 'Bot Chat' }
      ]
    })

    await expect(openCanonicalChat('writer', 'hi')).resolves.toBe('bc')
    expect($botMeta.get().writer.chat).toBe('bc')
  })

  it('creates the chat when the bot has none', async () => {
    handlers['session.list'] = () => ({ sessions: [{ id: 'recent', title: 'Kế hoạch' }] })

    await expect(openCanonicalChat('writer', 'hi')).resolves.toBe('stored-1')
  })

  it('re-points a vanished pin at the newest Bot Chat', async () => {
    $botMeta.set({ writer: { chat: 'gone' } })
    handlers['session.list'] = () => ({ sessions: [{ id: 'bc2', title: 'Bot Chat' }] })

    await expect(openCanonicalChat('writer', 'hi')).resolves.toBe('bc2')
  })

  it('recreates when the pinned chat cannot be opened', async () => {
    $botMeta.set({ writer: { chat: 'pinned' } })
    handlers['session.list'] = () => ({ sessions: [{ id: 'pinned' }] })
    openSession.mockRejectedValueOnce(new Error('resume refused'))

    await expect(openCanonicalChat('writer', 'hi')).resolves.toBe('stored-1')
  })
})
