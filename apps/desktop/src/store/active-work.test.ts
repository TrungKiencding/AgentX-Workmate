import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ClientSessionState } from '@/app/types'

import { $sessions } from './session'
import { clearAllSessionStates, publishSessionState } from './session-states'

const desktopWindow = window as unknown as { agentxDesktop?: Window['agentxDesktop'] }
const setActiveWork = vi.fn()

const busy = (storedSessionId: string, isBusy: boolean) =>
  ({ busy: isBusy, needsInput: false, storedSessionId }) as ClientSessionState

const session = (id: string, title: null | string) => ({ id, title }) as (typeof $sessions.value)[number]

beforeAll(async () => {
  desktopWindow.agentxDesktop = { setActiveWork } as unknown as Window['agentxDesktop']
  // Subscribes at import time, so the bridge has to exist first.
  await import('./active-work')
})

beforeEach(() => {
  clearAllSessionStates()
  $sessions.set([])
  setActiveWork.mockClear()
})

describe('active work bridge', () => {
  it('reports a busy session by title', () => {
    $sessions.set([session('s1', 'Fix login'), session('s2', 'Idle chat')])
    publishSessionState('runtime-1', busy('s1', true))

    expect(setActiveWork).toHaveBeenLastCalledWith(expect.objectContaining({ count: 1, titles: ['Fix login'] }))
  })

  it('counts an untitled busy session without inventing a title', () => {
    $sessions.set([session('s1', null)])
    publishSessionState('runtime-1', busy('s1', true))

    expect(setActiveWork).toHaveBeenLastCalledWith(expect.objectContaining({ count: 1, titles: [] }))
  })

  it('drops back to nothing when the turn ends', () => {
    $sessions.set([session('s1', 'Fix login')])
    publishSessionState('runtime-1', busy('s1', true))
    publishSessionState('runtime-1', busy('s1', false))

    expect(setActiveWork).toHaveBeenLastCalledWith({ count: 0, titles: [] })
  })

  it('does not re-send an unchanged summary', () => {
    $sessions.set([session('s1', 'Fix login')])
    publishSessionState('runtime-1', busy('s1', true))
    setActiveWork.mockClear()

    $sessions.set([session('s1', 'Fix login'), session('s2', 'Something else')])

    expect(setActiveWork).not.toHaveBeenCalled()
  })
})

// The main process shows the "still working — quit anyway?" dialog and has no
// translations of its own (pilot 2026-11: the dialog was English in a
// Vietnamese app, and absent altogether when the window was closed).
describe('active work bridge: the confirmation speaks the app language', () => {
  it('sends the words with a running turn, and nothing extra when idle', async () => {
    const { setRuntimeI18nLocale } = await import('@/i18n/runtime')

    setRuntimeI18nLocale('vi')
    $sessions.set([session('s1', 'Bản tin tài chính')])
    publishSessionState('runtime-1', busy('s1', true))

    const sent = setActiveWork.mock.lastCall?.[0]

    expect(sent.copy.stay).toBe('Tiếp tục chạy')
    expect(sent.copy.quit).toBe('Vẫn thoát')
    expect(sent.copy.messageMany).toContain('{count}')

    publishSessionState('runtime-1', busy('s1', false))
    expect(setActiveWork).toHaveBeenLastCalledWith({ count: 0, titles: [] })
  })

  it('re-sends the words when the language changes mid-turn', async () => {
    const { setRuntimeI18nLocale } = await import('@/i18n/runtime')

    setRuntimeI18nLocale('vi')
    $sessions.set([session('s1', 'Fix login')])
    publishSessionState('runtime-1', busy('s1', true))
    setRuntimeI18nLocale('en')

    expect(setActiveWork.mock.lastCall?.[0].copy.stay).toBe('Keep Running')
  })
})
