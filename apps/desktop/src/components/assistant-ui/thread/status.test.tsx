import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { __resetElapsedTimerRegistryForTests } from '@/components/chat/activity-timer'
import { I18nProvider } from '@/i18n'
import { $activeSessionId, $turnStartedAt } from '@/store/session'

import { ResponseLoadingIndicator } from './status'

function renderIndicator() {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      <ResponseLoadingIndicator />
    </I18nProvider>
  )
}

describe('ResponseLoadingIndicator timer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    __resetElapsedTimerRegistryForTests()
  })

  afterEach(() => {
    cleanup()
    $activeSessionId.set(null)
    $turnStartedAt.set(null)
    __resetElapsedTimerRegistryForTests()
    vi.useRealTimers()
  })

  it('preserves each running session timer while switching between sessions', () => {
    $activeSessionId.set('session-a')
    $turnStartedAt.set(Date.now())
    const sessionA = renderIndicator()

    act(() => vi.advanceTimersByTime(5_000))
    expect(screen.getAllByText((_, node) => node?.textContent === '5s').length).toBeGreaterThan(0)
    sessionA.unmount()

    $activeSessionId.set('session-b')
    $turnStartedAt.set(Date.now())
    const sessionB = renderIndicator()

    act(() => vi.advanceTimersByTime(3_000))
    expect(screen.getAllByText((_, node) => node?.textContent === '3s').length).toBeGreaterThan(0)
    sessionB.unmount()

    $activeSessionId.set('session-a')
    $turnStartedAt.set(new Date('2026-01-01T00:00:00.000Z').getTime())
    renderIndicator()

    expect(screen.getAllByText((_, node) => node?.textContent === '8s').length).toBeGreaterThan(0)
  })
})

// The status line sits between tool rows and thinking headers, which the
// transcript rests at a fade. Without the mark it reads a shade brighter than
// both — the one line in the column claiming emphasis it hasn't earned.
describe('status line', () => {
  afterEach(cleanup)

  it('is marked as transcript scaffolding', () => {
    $activeSessionId.set('session-a')
    $turnStartedAt.set(Date.now())
    const { container } = renderIndicator()

    expect(container.querySelector('[role="status"]')?.hasAttribute('data-conversation-scaffold')).toBe(true)
  })
})

// The wait is the reply's own mark writing itself, its name shimmering on the
// same lap — and both rest, as the plain mark and plain text, when the motion
// would be unwelcome or unseen.
describe('thinking row motion', () => {
  const parts = (container: HTMLElement) => ({
    glyph: container.querySelector('[data-slot="aui_response-loading"] [data-slot="brand-glyph"]'),
    label: container.querySelector('[data-slot="aui_response-loading"] [data-slot="aui_status-label"]')
  })

  // The window has to be focused for the row to move (jsdom reports it isn't).
  beforeEach(() => {
    vi.spyOn(window.document, 'hasFocus').mockReturnValue(true)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('writes the mark at the head and shimmers the label while on screen', () => {
    const { glyph, label } = parts(renderIndicator().container)

    expect(glyph?.hasAttribute('data-tracing')).toBe(true)
    expect(glyph?.getAttribute('class')).toContain('size-5')
    expect(label?.textContent).toBe('Thinking')
    expect(label?.classList.contains('shimmer')).toBe(true)
  })

  it('rests under reduced motion', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((media: string) => ({
        addEventListener: vi.fn(),
        matches: media === '(prefers-reduced-motion: reduce)',
        media,
        removeEventListener: vi.fn()
      }))
    )

    const { glyph, label } = parts(renderIndicator().container)

    expect(glyph?.hasAttribute('data-tracing')).toBe(false)
    expect(label?.textContent).toBe('Thinking')
    expect(label?.classList.contains('shimmer')).toBe(false)
  })

  it('rests while the window is hidden', () => {
    vi.spyOn(window.document, 'visibilityState', 'get').mockReturnValue('hidden')

    const { glyph, label } = parts(renderIndicator().container)

    expect(glyph?.hasAttribute('data-tracing')).toBe(false)
    expect(label?.classList.contains('shimmer')).toBe(false)
  })

  it('rests while the window is in the background', () => {
    vi.mocked(window.document.hasFocus).mockReturnValue(false)

    const { glyph, label } = parts(renderIndicator().container)

    expect(glyph?.hasAttribute('data-tracing')).toBe(false)
    expect(label?.classList.contains('shimmer')).toBe(false)
  })
})
