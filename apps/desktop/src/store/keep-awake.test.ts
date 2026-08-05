import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { storedBoolean } from '@/lib/storage'

import { $keepAwake, setKeepAwake } from './keep-awake'

const KEY = 'agentx.desktop.keepAwake.v1'
const desktopWindow = window as unknown as { agentxDesktop?: Window['agentxDesktop'] }
const initialAgentxDesktop = desktopWindow.agentxDesktop
const setKeepAwakeBridge = vi.fn()

beforeEach(() => {
  desktopWindow.agentxDesktop = { setKeepAwake: setKeepAwakeBridge } as unknown as Window['agentxDesktop']
  setKeepAwake(false)
  setKeepAwakeBridge.mockClear()
})

afterEach(() => {
  desktopWindow.agentxDesktop = initialAgentxDesktop
})

describe('keep-awake store', () => {
  it('persists the pref and mirrors it to the main process', () => {
    setKeepAwake(true)
    expect($keepAwake.get()).toBe(true)
    expect(storedBoolean(KEY, false)).toBe(true)
    expect(setKeepAwakeBridge).toHaveBeenLastCalledWith(true)

    setKeepAwake(false)
    expect(storedBoolean(KEY, true)).toBe(false)
    expect(setKeepAwakeBridge).toHaveBeenLastCalledWith(false)
  })
})
