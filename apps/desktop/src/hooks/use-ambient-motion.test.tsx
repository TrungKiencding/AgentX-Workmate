import { act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PaneVisibleContext } from '@/components/pane-shell/pane-visibility'

import { useAmbientMotion } from './use-ambient-motion'

interface WindowStatePayload {
  isMinimized?: boolean
  isVisible?: boolean
}

let windowStateCallback: ((payload: WindowStatePayload) => void) | undefined
let reducedMotion: { matches: boolean; listeners: Set<() => void> }
let visibility: DocumentVisibilityState

function setReducedMotion(matches: boolean) {
  reducedMotion.matches = matches

  for (const listener of reducedMotion.listeners) {
    listener()
  }
}

function setVisibility(next: DocumentVisibilityState) {
  visibility = next
  window.document.dispatchEvent(new Event('visibilitychange'))
}

const inPane =
  (visible: boolean) =>
  ({ children }: { children: ReactNode }) => (
    <PaneVisibleContext.Provider value={visible}>{children}</PaneVisibleContext.Provider>
  )

describe('useAmbientMotion', () => {
  let offWindowState: ReturnType<typeof vi.fn>

  beforeEach(() => {
    reducedMotion = { listeners: new Set(), matches: false }
    visibility = 'visible'
    vi.spyOn(window.document, 'visibilityState', 'get').mockImplementation(() => visibility)
    vi.spyOn(window.document, 'hasFocus').mockReturnValue(true)
    vi.stubGlobal(
      'matchMedia',
      vi.fn((media: string) => ({
        addEventListener: (_: string, listener: () => void) => reducedMotion.listeners.add(listener),
        get matches() {
          return media === '(prefers-reduced-motion: reduce)' && reducedMotion.matches
        },
        media,
        removeEventListener: (_: string, listener: () => void) => reducedMotion.listeners.delete(listener)
      }))
    )
    offWindowState = vi.fn()
    window.agentxDesktop = {
      onWindowStateChanged: vi.fn(callback => {
        windowStateCallback = callback

        return offWindowState
      })
    } as unknown as typeof window.agentxDesktop
  })

  afterEach(() => {
    cleanup()
    windowStateCallback = undefined
    delete (window as unknown as { agentxDesktop?: unknown }).agentxDesktop
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('runs while the transcript is on screen', () => {
    const { result } = renderHook(() => useAmbientMotion())

    expect(result.current).toBe(true)
  })

  it('stays still under reduced motion, and follows the setting when it changes', () => {
    reducedMotion.matches = true
    const { result } = renderHook(() => useAmbientMotion())

    expect(result.current).toBe(false)

    act(() => setReducedMotion(false))
    expect(result.current).toBe(true)

    act(() => setReducedMotion(true))
    expect(result.current).toBe(false)
  })

  it('stays still in a hidden kept-alive tab', () => {
    const { result } = renderHook(() => useAmbientMotion(), { wrapper: inPane(false) })

    expect(result.current).toBe(false)
  })

  it('sleeps while the window is minimized or hidden, and wakes when it is back', () => {
    const { result } = renderHook(() => useAmbientMotion())

    act(() => windowStateCallback?.({ isMinimized: true, isVisible: false }))
    expect(result.current).toBe(false)

    act(() => windowStateCallback?.({ isMinimized: false, isVisible: true }))
    expect(result.current).toBe(true)

    act(() => setVisibility('hidden'))
    expect(result.current).toBe(false)

    act(() => setVisibility('visible'))
    expect(result.current).toBe(true)
  })

  it('starts asleep when the document is already hidden', () => {
    visibility = 'hidden'
    const { result } = renderHook(() => useAmbientMotion())

    expect(result.current).toBe(false)
  })

  it('starts asleep when the window is in the background', () => {
    vi.mocked(window.document.hasFocus).mockReturnValue(false)
    const { result } = renderHook(() => useAmbientMotion())

    expect(result.current).toBe(false)
  })

  // A loop nobody is looking at still costs a frame every vsync.
  it('rests while the window is in the background, and resumes on focus', () => {
    const { result } = renderHook(() => useAmbientMotion())

    act(() => {
      vi.mocked(window.document.hasFocus).mockReturnValue(false)
      window.dispatchEvent(new Event('blur'))
    })
    expect(result.current).toBe(false)

    act(() => {
      vi.mocked(window.document.hasFocus).mockReturnValue(true)
      window.dispatchEvent(new Event('focus'))
    })
    expect(result.current).toBe(true)
  })

  it('lets go of every listener on unmount', () => {
    const { unmount } = renderHook(() => useAmbientMotion())

    expect(reducedMotion.listeners.size).toBe(1)

    unmount()

    expect(offWindowState).toHaveBeenCalledTimes(1)
    expect(reducedMotion.listeners.size).toBe(0)
  })
})
