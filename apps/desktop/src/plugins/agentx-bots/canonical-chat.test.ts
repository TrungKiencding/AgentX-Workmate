import { host } from '@agentx/plugin-sdk'
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'

import { createCanonicalChat, openCanonicalChat, resetCanonicalChats, resolveCanonicalChat } from './canonical-chat'
import { $botMeta, resetBotState } from './state'

type Handler = (params: Record<string, unknown>) => unknown

let handlers: Record<string, Handler>
let calls: Array<[string, Record<string, unknown>]>
let openSession: MockInstance

beforeEach(() => {
  resetBotState()
  resetCanonicalChats()
  calls = []
  handlers = {
    'profiles.configure': () => ({ applied: { ui_meta: true } }),
    'session.create': () => ({ stored_session_id: 'stored-1', persisted: true }),
    'session.list': () => ({ sessions: [] })
  }
  vi.spyOn(host, 'requestPrimary').mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
    calls.push([method, params])
    const handler = handlers[method]

    if (!handler) {
      throw new Error(`unexpected ${method}`)
    }

    return handler(params) as never
  })
  vi.spyOn(host, 'request').mockRejectedValue(new Error('must not follow the live profile'))
  vi.spyOn(host, 'activateProfile').mockRejectedValue(new Error('must not switch profiles to create'))
  openSession = vi.spyOn(host, 'openSession').mockResolvedValue(undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

const methods = () => calls.map(([method]) => method).filter(method => method !== 'profiles.configure')

describe('createCanonicalChat', () => {
  it('persists an EMPTY titled conversation on the window backend and pins it — nothing is sent', async () => {
    await expect(createCanonicalChat('writer')).resolves.toBe('stored-1')

    expect(calls.find(([method]) => method === 'session.create')?.[1]).toEqual({
      profile: 'writer',
      title: 'Bot Chat',
      persist_only: true,
      strict_profile: true
    })
    expect(methods()).not.toContain('prompt.submit')
    expect($botMeta.get().writer?.chat).toBe('stored-1')
  })

  it('is single-flight per assistant', async () => {
    const [a, b] = await Promise.all([createCanonicalChat('writer'), createCanonicalChat('writer')])

    expect(a).toBe('stored-1')
    expect(b).toBe('stored-1')
    expect(methods().filter(method => method === 'session.create')).toHaveLength(1)
  })
})

describe('resolveCanonicalChat', () => {
  it('keeps a pin whose session still exists', async () => {
    $botMeta.set({ writer: { chat: 'pinned' } })
    handlers['session.list'] = () => ({ sessions: [{ id: 'other' }, { id: 'pinned' }] })

    await expect(resolveCanonicalChat('writer')).resolves.toBe('pinned')
    expect(methods()).toEqual(['session.list'])
    expect(calls[0][1]).toEqual({
      profile: 'writer',
      limit: 200,
      strict_profile: true,
      // scheduled runs never crowd the main conversation out of the window
      exclude_sources: ['cron']
    })
  })

  it('adopts an existing Bot Chat on first open', async () => {
    handlers['session.list'] = () => ({
      sessions: [
        { id: 'x', title: 'Ý tưởng' },
        { id: 'bc', title: 'Bot Chat' }
      ]
    })

    await expect(resolveCanonicalChat('writer')).resolves.toBe('bc')
    expect($botMeta.get().writer?.chat).toBe('bc')
    expect(methods()).not.toContain('session.create')
  })

  it('re-points a stale pin at the newest Bot Chat, else creates one', async () => {
    $botMeta.set({ writer: { chat: 'gone' } })

    await expect(resolveCanonicalChat('writer')).resolves.toBe('stored-1')
    expect(methods()).toContain('session.create')
    expect($botMeta.get().writer?.chat).toBe('stored-1')
  })

  it('trusts the pin when the list fails (no duplicate conversation)', async () => {
    $botMeta.set({ writer: { chat: 'pinned' } })

    handlers['session.list'] = () => {
      throw new Error('offline')
    }

    await expect(resolveCanonicalChat('writer')).resolves.toBe('pinned')
    expect(methods()).not.toContain('session.create')
  })
})

describe('openCanonicalChat', () => {
  it('opens the conversation on the assistant (the only profile move)', async () => {
    $botMeta.set({ writer: { chat: 'pinned' } })
    handlers['session.list'] = () => ({ sessions: [{ id: 'pinned' }] })

    await expect(openCanonicalChat('writer')).resolves.toBe('pinned')
    expect(openSession).toHaveBeenCalledWith('pinned', { profile: 'writer' })
  })

  it('starts over once when the row vanished between list and open', async () => {
    $botMeta.set({ writer: { chat: 'pinned' } })
    handlers['session.list'] = () => ({ sessions: [{ id: 'pinned' }] })
    openSession.mockRejectedValueOnce(new Error('session not found'))

    await expect(openCanonicalChat('writer')).resolves.toBe('stored-1')
    expect(openSession).toHaveBeenLastCalledWith('stored-1', { profile: 'writer' })
  })
})
