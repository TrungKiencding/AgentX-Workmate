import { type RefObject, useEffect } from 'react'

/** How long the thumb stays after the last scroll input. */
export const SCROLLBAR_REVEAL_IDLE_MS = 900

/** How close to the scroller's trailing edge the pointer must come to call up
 *  the thumb — the bar's own width plus a little slack. */
export const SCROLLBAR_REVEAL_EDGE_PX = 14

const SCROLL_KEYS = new Set(['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '])

/**
 * Show a scroller's thumb only while the person scrolls it.
 *
 * Marks the element `data-scrolling` on scroll *input* — wheel or trackpad,
 * touch, a scrolling key, a press on the scrollbar itself — or when the
 * pointer comes to the bar's edge to grab it, and clears the
 * mark once input has been idle for `idleMs`. The stylesheet hides the thumb
 * without the mark. Scrolls the app makes on its own (following a streaming
 * reply, jumping to the latest message) are not input, so they leave the bar
 * hidden: it means "you are moving this", not "this moved".
 *
 * The mark is written straight to the element: toggling it many times a
 * second must not re-render the transcript.
 */
export function useScrollbarReveal(ref: RefObject<HTMLElement | null>, idleMs = SCROLLBAR_REVEAL_IDLE_MS): void {
  useEffect(() => {
    const el = ref.current

    if (!el) {
      return
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    let dragging = false
    // Read once: a pointermove handler must not force style on every event.
    const rtl = getComputedStyle(el).direction === 'rtl'

    const hide = () => {
      timer = undefined

      if (!dragging) {
        el.removeAttribute('data-scrolling')
      }
    }

    const reveal = () => {
      el.setAttribute('data-scrolling', '')
      clearTimeout(timer)
      timer = setTimeout(hide, idleMs)
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (SCROLL_KEYS.has(event.key) && !event.defaultPrevented) {
        reveal()
      }
    }

    // A press that lands on the element itself, not on its content, is a
    // press on its scrollbar: keep the thumb while it is dragged.
    const onPointerDown = (event: PointerEvent) => {
      if (event.target === el) {
        dragging = true
        reveal()
      }
    }

    const onPointerUp = () => {
      if (dragging) {
        dragging = false
        reveal()
      }
    }

    // Reaching for the bar shows it: a hidden thumb cannot be aimed at.
    const onEdgeMove = (event: PointerEvent) => {
      const rect = el.getBoundingClientRect()
      const edge = rtl ? event.clientX - rect.left : rect.right - event.clientX

      if (edge >= 0 && edge <= SCROLLBAR_REVEAL_EDGE_PX && el.scrollHeight > el.clientHeight) {
        reveal()
      }
    }

    // A release the page never heard (let go outside the window, a native
    // drag that swallowed it) must not pin the thumb: any move with no button
    // held ends the drag.
    const onPointerMove = (event: PointerEvent) => {
      if (dragging && event.buttons === 0) {
        onPointerUp()
      }
    }

    el.addEventListener('wheel', reveal, { passive: true })
    el.addEventListener('touchmove', reveal, { passive: true })
    el.addEventListener('keydown', onKeyDown)
    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('pointermove', onEdgeMove, { passive: true })
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
    window.addEventListener('pointermove', onPointerMove, { passive: true })
    window.addEventListener('blur', onPointerUp)

    return () => {
      clearTimeout(timer)
      el.removeAttribute('data-scrolling')
      el.removeEventListener('wheel', reveal)
      el.removeEventListener('touchmove', reveal)
      el.removeEventListener('keydown', onKeyDown)
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('pointermove', onEdgeMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('blur', onPointerUp)
    }
  }, [idleMs, ref])
}
