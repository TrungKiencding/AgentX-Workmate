import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $backdrop } from '@/store/backdrop'

import { GlyphField } from './index'

// The canvas work is pinned in painter.test.ts; this is the React shell — the
// setting it obeys and the state it hands the stylesheet for the fade. Without
// a 2D context (jsdom's, and a renderer that can't make one) the sheet simply
// stays blank: the shell must still mount and unmount cleanly around it.

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  $backdrop.set(true)
})

describe('GlyphField', () => {
  it('renders nothing when the backdrop setting is off', () => {
    $backdrop.set(false)

    const { container } = render(<GlyphField active />)

    expect(container.querySelector('[data-slot="glyph-field"]')).toBeNull()
  })

  it('marks its state for the fade, and stays out of the accessibility tree', () => {
    const { container, rerender } = render(<GlyphField active />)
    const host = container.querySelector<HTMLElement>('[data-slot="glyph-field"]')

    expect(host?.dataset.state).toBe('on')
    expect(host?.getAttribute('aria-hidden')).toBe('true')
    expect(host?.querySelector('canvas')).toBeTruthy()

    rerender(<GlyphField active={false} />)

    expect(host?.dataset.state).toBe('off')
  })
})
