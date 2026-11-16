import { act, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useScrollbarReveal } from './use-scrollbar-reveal'

function Scroller() {
  const ref = useRef<HTMLDivElement>(null)
  useScrollbarReveal(ref, 500)

  return (
    <div data-testid="scroller" ref={ref} tabIndex={0}>
      <p data-testid="content">text</p>
    </div>
  )
}

describe('useScrollbarReveal', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const mount = () => {
    const view = render(<Scroller />)

    return { el: view.getByTestId('scroller'), content: view.getByTestId('content'), view }
  }

  it('shows the thumb while the person scrolls and hides it once idle', () => {
    const { el } = mount()
    expect(el.hasAttribute('data-scrolling')).toBe(false)

    act(() => void el.dispatchEvent(new WheelEvent('wheel', { deltaY: 40 })))
    expect(el.hasAttribute('data-scrolling')).toBe(true)

    act(() => vi.advanceTimersByTime(400))
    act(() => void el.dispatchEvent(new WheelEvent('wheel', { deltaY: 40 })))
    act(() => vi.advanceTimersByTime(400))
    // Still within the window opened by the second wheel.
    expect(el.hasAttribute('data-scrolling')).toBe(true)

    act(() => vi.advanceTimersByTime(200))
    expect(el.hasAttribute('data-scrolling')).toBe(false)
  })

  it('leaves the thumb hidden when the app scrolls on its own', () => {
    const { el } = mount()

    act(() => void el.dispatchEvent(new Event('scroll')))
    expect(el.hasAttribute('data-scrolling')).toBe(false)
  })

  it('reveals for scrolling keys only', () => {
    const { el } = mount()

    act(() => void el.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true })))
    expect(el.hasAttribute('data-scrolling')).toBe(false)

    act(() => void el.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true })))
    expect(el.hasAttribute('data-scrolling')).toBe(true)
  })

  it('keeps the thumb while its bar is dragged, not while content is pressed', () => {
    const { el, content } = mount()

    act(() => void content.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
    expect(el.hasAttribute('data-scrolling')).toBe(false)

    act(() => void el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
    act(() => vi.advanceTimersByTime(2000))
    expect(el.hasAttribute('data-scrolling')).toBe(true)

    act(() => void window.dispatchEvent(new PointerEvent('pointerup')))
    act(() => vi.advanceTimersByTime(600))
    expect(el.hasAttribute('data-scrolling')).toBe(false)
  })

  it('ends a drag whose release the page never heard', () => {
    const { el } = mount()

    act(() => void el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
    act(() => void window.dispatchEvent(new PointerEvent('pointermove', { buttons: 1 })))
    act(() => vi.advanceTimersByTime(2000))
    expect(el.hasAttribute('data-scrolling')).toBe(true)

    act(() => void window.dispatchEvent(new PointerEvent('pointermove', { buttons: 0 })))
    act(() => vi.advanceTimersByTime(600))
    expect(el.hasAttribute('data-scrolling')).toBe(false)
  })

  it('shows the thumb when the pointer reaches for the bar', () => {
    const { el } = mount()
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: 400 })
    el.getBoundingClientRect = () => ({ left: 0, right: 600, top: 0, bottom: 400, width: 600, height: 400, x: 0, y: 0, toJSON: () => ({}) })

    act(() => void el.dispatchEvent(new PointerEvent('pointermove', { clientX: 300, bubbles: true })))
    expect(el.hasAttribute('data-scrolling')).toBe(false)

    act(() => void el.dispatchEvent(new PointerEvent('pointermove', { clientX: 594, bubbles: true })))
    expect(el.hasAttribute('data-scrolling')).toBe(true)
  })

  it('cleans up on unmount', () => {
    const { el, view } = mount()

    act(() => void el.dispatchEvent(new WheelEvent('wheel', { deltaY: 40 })))
    view.unmount()
    expect(el.hasAttribute('data-scrolling')).toBe(false)
  })
})
