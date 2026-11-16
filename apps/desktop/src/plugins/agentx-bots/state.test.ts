import { host, type PluginStorage, queryClient } from '@agentx/plugin-sdk'
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'

import {
  $botMeta,
  $groupChats,
  $recentlyDeleted,
  $seenActivity,
  bindStorage,
  deleteBot,
  emptyRoom,
  markSeen,
  markSeenAt,
  mergeServerMeta,
  noteRoster,
  PLUGIN_ID,
  resetBotState,
  saveBotMeta,
  settleDeleted,
  unreadBots,
  withoutDeleted
} from './state'
import { bot } from './test-utils'

function memoryStorage(initial: Record<string, unknown> = {}): PluginStorage & { data: Record<string, unknown> } {
  const data = { ...initial }

  return {
    data,
    get: <T>(key: string, fallback: T) => (key in data ? (data[key] as T) : fallback),
    remove: key => void delete data[key],
    set: (key, value) => void (data[key] = value)
  }
}

let request: MockInstance

beforeEach(() => {
  resetBotState()
  request = vi.spyOn(host, 'requestPrimary')
  vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('bindStorage', () => {
  it('hydrates meta, seen watermarks and rooms (runtime fields reset)', () => {
    bindStorage(
      memoryStorage({
        'bot-meta': { writer: { title: 'Biên tập' } },
        'seen-activity': { writer: 42 },
        'group-chats': { team: { log: [], watermarks: { writer: 1 }, sessions: {}, running: true, epoch: 9 } }
      })
    )

    expect($botMeta.get().writer.title).toBe('Biên tập')
    expect($seenActivity.get()).toEqual({ writer: 42 })
    expect($groupChats.get().team).toMatchObject({ running: false, epoch: 0, watermarks: { writer: 1 } })
  })

  it('ignores corrupt stored values', () => {
    bindStorage(memoryStorage({ 'bot-meta': ['nope'], 'group-chats': { team: { log: 'x' } } }))

    expect($botMeta.get()).toEqual({})
    expect($groupChats.get()).toEqual({})
  })
})

describe('saveBotMeta', () => {
  it('reports persisted when the gateway applied ui_meta, never sending the picture', async () => {
    const storage = memoryStorage()
    bindStorage(storage)
    request.mockResolvedValue({ applied: { ui_meta: true } })

    await expect(saveBotMeta('writer', { title: 'Biên tập', image: 'data:image/png;base64,AAA' })).resolves.toBe(
      'persisted'
    )

    const configure = request.mock.calls.find(([method]) => method === 'profiles.configure')!
    expect(configure[1]).toEqual({ name: 'writer', ui_meta: { [PLUGIN_ID]: { title: 'Biên tập' } } })
    expect(request.mock.calls.some(([method]) => method === 'profiles.set_asset')).toBe(true)
    expect((storage.data['bot-meta'] as Record<string, unknown>).writer).toMatchObject({ title: 'Biên tập' })
  })

  it('distinguishes an explicit refusal from an older gateway', async () => {
    request.mockResolvedValueOnce({ applied: { ui_meta: false } })
    await expect(saveBotMeta('writer', { title: 'x' })).resolves.toBe('failed')

    request.mockRejectedValueOnce(new Error('unknown method'))
    await expect(saveBotMeta('writer', { title: 'y' })).resolves.toBe('unsupported')
  })

  it('does not re-upload an unchanged picture', async () => {
    $botMeta.set({ writer: { image: 'data:same' } })
    request.mockResolvedValue({ applied: { ui_meta: true } })

    await saveBotMeta('writer', { image: 'data:same', title: 't' })

    expect(request.mock.calls.some(([method]) => method === 'profiles.set_asset')).toBe(false)
  })
})

describe('mergeServerMeta', () => {
  it('server wins, but the local picture survives and a dropped chat pin is dropped', () => {
    $botMeta.set({ writer: { title: 'old', image: 'data:pic', chat: 'stale' } })

    mergeServerMeta([bot('writer', { ui_meta: { [PLUGIN_ID]: { title: 'new', color: '#fff' } } })])

    expect($botMeta.get().writer).toEqual({ title: 'new', color: '#fff', image: 'data:pic' })
  })

  it('leaves bots without server meta alone', () => {
    $botMeta.set({ writer: { title: 'local' } })
    mergeServerMeta([bot('writer')])

    expect($botMeta.get().writer.title).toBe('local')
  })
})

describe('unread', () => {
  const active = (name: string, last: number) => bot(name, { last_session: { id: 's', last_active: last } })

  it('a first sighting is seeded as seen, later activity is unread until opened', () => {
    bindStorage(memoryStorage())
    noteRoster([active('writer', 100)])

    expect(unreadBots([active('writer', 100)], $seenActivity.get()).size).toBe(0)
    expect(unreadBots([active('writer', 150)], $seenActivity.get())).toEqual(new Set(['writer']))

    markSeen(active('writer', 150))
    expect(unreadBots([active('writer', 150)], $seenActivity.get()).size).toBe(0)
  })

  it('marking a moment as seen clears activity up to it', () => {
    bindStorage(memoryStorage({ 'seen-activity': { writer: 10 } }))
    markSeenAt('writer', 200)

    expect(unreadBots([active('writer', 150)], $seenActivity.get()).size).toBe(0)
    expect(unreadBots([active('writer', 250)], $seenActivity.get())).toEqual(new Set(['writer']))
  })

  it('a bot never seen is not unread', () => {
    expect(unreadBots([active('new', 500)], {}).size).toBe(0)
  })
})

describe('deleteBot', () => {
  it('refuses the main assistant', async () => {
    await expect(deleteBot('default')).rejects.toThrow()
  })

  it('deletes through the host and forgets local state', async () => {
    const remove = vi.spyOn(host, 'deleteProfile').mockResolvedValue(undefined)
    $botMeta.set({ writer: { title: 'x' }, other: {} })
    $seenActivity.set({ writer: 1 })

    await deleteBot('writer')

    expect(remove).toHaveBeenCalledWith('writer')
    expect($botMeta.get()).toEqual({ other: {} })
    expect($seenActivity.get()).toEqual({})
  })

  it('leaves every room and hides the assistant until a fresh roster drops it', async () => {
    vi.spyOn(host, 'deleteProfile').mockResolvedValue(undefined)
    $groupChats.set({
      Marketing: {
        ...emptyRoom(),
        log: [{ from: { kind: 'member', name: 'writer' }, text: 'Bản nháp', at: 1 }],
        sessions: { writer: 's-w', other: 's-o' },
        watermarks: { writer: 1, other: 0 }
      }
    })

    await deleteBot('writer')

    const room = $groupChats.get().Marketing
    expect(room.sessions).toEqual({ other: 's-o' })
    expect(room.watermarks).toEqual({ other: 0 })
    expect(room.log).toHaveLength(1) // what it said stays

    // A roster fetched before the delete still names it: hidden.
    const stale = [bot('default'), bot('writer')]
    settleDeleted(stale)
    expect(withoutDeleted(stale, $recentlyDeleted.get()).map(row => row.name)).toEqual(['default'])

    // A fresh roster without it: nothing left to hide, and a profile that
    // really comes back later is shown again.
    settleDeleted([bot('default')])
    expect($recentlyDeleted.get().size).toBe(0)
    expect(withoutDeleted(stale, $recentlyDeleted.get())).toHaveLength(2)
  })
})
