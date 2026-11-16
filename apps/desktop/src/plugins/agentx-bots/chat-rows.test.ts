import { describe, expect, it } from 'vitest'

import { chatRows, conversationRows, routineRunRows } from './bot-detail'
import type { ProfileSession } from './types'

const row = (over: Partial<ProfileSession> & { id: string }): ProfileSession => ({ title: '', ...over })

const MAIN = row({ id: 'main', title: 'Bot Chat', last_active: 10 })
const SIDE = row({ id: 'side', title: 'Ý tưởng tiêu đề', last_active: 20 })
const RUN = row({ id: 'cron_j1_1', source: 'cron', started_at: 30, title: 'Bản tin · 2026-11-10 21:00' })
const OLD_RUN = row({ id: 'cron_j1_0', source: 'cron', started_at: 5, title: 'Bản tin · 2026-11-09 21:00' })
const ROOM = row({ id: 'room', source: 'bot-room', title: 'Group: Sales' })

describe('conversation rows', () => {
  it('are the chats a person holds: no group-room plumbing, no scheduled runs', () => {
    expect(conversationRows([ROOM, RUN, SIDE, MAIN]).map(r => r.id)).toEqual(['side', 'main'])
  })

  it('lists scheduled runs apart, newest first', () => {
    expect(routineRunRows([OLD_RUN, SIDE, RUN, MAIN]).map(r => r.id)).toEqual(['cron_j1_1', 'cron_j1_0'])
  })
})

describe('chatRows', () => {
  it('leads an assistant with its pinned main conversation', () => {
    const { main, others, showMain } = chatRows([SIDE, MAIN], { pinned: 'main', primary: false })

    expect(showMain).toBe(true)
    expect(main?.id).toBe('main')
    expect(others.map(r => r.id)).toEqual(['side'])
  })

  // The reported case: only a scheduled run exists.
  it('offers the main conversation before it exists', () => {
    expect(chatRows([RUN], { pinned: null, primary: false })).toEqual({ main: null, others: [], showMain: true })
    expect(chatRows([], { pinned: null, primary: false }).showMain).toBe(true)
  })

  it('adopts an unpinned "Bot Chat" as the main conversation', () => {
    expect(chatRows([SIDE, MAIN], { pinned: null, primary: false }).main?.id).toBe('main')
  })

  it('follows the newest "Bot Chat" when the pin points at a session that is gone', () => {
    const { main, others } = chatRows([SIDE, MAIN], { pinned: 'deleted', primary: false })

    expect(main?.id).toBe('main')
    expect(others.map(r => r.id)).toEqual(['side'])
  })

  it('never takes a scheduled run for the main conversation', () => {
    const run = row({ id: 'cron_x', source: 'cron', title: 'Bot Chat' })

    expect(chatRows([run], { pinned: 'cron_x', primary: false }).main).toBeNull()
  })

  it('gives the main assistant plain recent chats and no main row', () => {
    expect(chatRows([SIDE, MAIN, RUN], { pinned: null, primary: true })).toEqual({
      main: null,
      others: [SIDE, MAIN],
      showMain: false
    })
  })
})
