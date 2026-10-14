import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GlyphFieldPainter } from './painter'

// The sheet is canvas work, which jsdom doesn't do: a recording 2D context, a
// hand-cranked animation frame and a stand-in for the Web Animations API let
// these pin what the painter does and — as much — what it doesn't do at rest.

interface FakeContext {
  draws: number[]
  clearRect: ReturnType<typeof vi.fn>
  drawImage: (...args: unknown[]) => void
  fillRect: ReturnType<typeof vi.fn>
  fillText: ReturnType<typeof vi.fn>
  getImageData: () => { data: Uint8ClampedArray }
  globalAlpha: number
  setTransform: ReturnType<typeof vi.fn>
}

function fakeContext(): FakeContext {
  const context: FakeContext = {
    clearRect: vi.fn(),
    draws: [],
    drawImage: () => context.draws.push(context.globalAlpha),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    getImageData: () => ({ data: new Uint8ClampedArray([64, 63, 83, 255]) }),
    globalAlpha: 1,
    setTransform: vi.fn()
  }

  return context
}

interface FakeAnimation {
  cancel: ReturnType<typeof vi.fn>
  keyframes: { offset: number; opacity: number }[]
  onfinish: (() => void) | null
  options: KeyframeAnimationOptions
  pause: ReturnType<typeof vi.fn>
  play: ReturnType<typeof vi.fn>
}

function installRaf() {
  let nextId = 1
  const frames = new Map<number, FrameRequestCallback>()

  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    value: (callback: FrameRequestCallback) => {
      frames.set(nextId, callback)

      return nextId++
    }
  })

  Object.defineProperty(window, 'cancelAnimationFrame', {
    configurable: true,
    value: (id: number) => frames.delete(id)
  })

  return {
    pending: () => frames.size,
    /** Run frames every `step` ms from `from` until the painter stops asking (or `limit`). */
    runUntilIdle(from: number, step = 16, limit = 20_000) {
      let now = from

      while (frames.size > 0 && now - from < limit) {
        const [id, callback] = frames.entries().next().value as [number, FrameRequestCallback]
        frames.delete(id)
        callback(now)
        now += step
      }

      return now
    },
    runNext(now: number) {
      const [id, callback] = frames.entries().next().value as [number, FrameRequestCallback]
      frames.delete(id)
      callback(now)
    }
  }
}

let reducedMotion = false
let contexts: Map<HTMLCanvasElement, FakeContext>
let animations: FakeAnimation[]
let clock = 0

function mountSheet(width = 800, height = 600) {
  const surface = document.createElement('div')
  surface.setAttribute('data-chat-surface', '')
  const host = document.createElement('div')
  const canvas = document.createElement('canvas')
  host.append(canvas)
  surface.append(host)
  document.body.append(surface)

  vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({
    bottom: 50 + height,
    height,
    left: 100,
    right: 100 + width,
    top: 50,
    width,
    x: 100,
    y: 50,
    toJSON: () => ({})
  } as DOMRect)

  const painter = new GlyphFieldPainter()
  const detach = painter.attach(host, canvas)
  painter.resize(width, height)

  return { canvas, detach, host, painter, surface }
}

function press(target: Element, clientX: number, clientY: number, button = 0) {
  target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button, clientX, clientY }))
}

beforeEach(() => {
  vi.useFakeTimers()
  reducedMotion = false
  contexts = new Map()
  animations = []
  clock = 1_000
  vi.spyOn(performance, 'now').mockImplementation(() => clock)

  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    if (!contexts.has(this)) {
      contexts.set(this, fakeContext())
    }

    return contexts.get(this) as unknown as CanvasRenderingContext2D
  } as unknown as typeof HTMLCanvasElement.prototype.getContext)

  Object.defineProperty(HTMLElement.prototype, 'animate', {
    configurable: true,
    value(keyframes: FakeAnimation['keyframes'], options: KeyframeAnimationOptions) {
      const animation: FakeAnimation = {
        cancel: vi.fn(),
        keyframes,
        onfinish: null,
        options,
        pause: vi.fn(),
        play: vi.fn()
      }

      animations.push(animation)

      return animation
    }
  })

  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      addEventListener: vi.fn(),
      matches: query.includes('reduced-motion') ? reducedMotion : false,
      removeEventListener: vi.fn()
    })
  })
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete (HTMLElement.prototype as Partial<HTMLElement>).animate
  delete (window as Partial<Window>).matchMedia
})

describe('GlyphFieldPainter', () => {
  it('is blank paper at rest: no bitmap, no animation frame', () => {
    const raf = installRaf()
    const { canvas, painter } = mountSheet()

    painter.setActive(true)

    expect(canvas.width).toBe(0)
    expect(raf.pending()).toBe(0)
  })

  it('lays the drawing out in idle time, so the first click only has to paint', () => {
    installRaf()

    const idle: IdleRequestCallback[] = []

    vi.stubGlobal('requestIdleCallback', (callback: IdleRequestCallback) => idle.push(callback))
    vi.stubGlobal('cancelIdleCallback', vi.fn())

    const { canvas, painter } = mountSheet()

    const cells = () => {
      const { columns, rows } = painter as unknown as { columns: number; rows: number }

      return columns * rows
    }

    painter.setActive(true)

    expect(idle).toHaveLength(1)
    expect(cells()).toBe(0)

    idle[0]({ didTimeout: false, timeRemaining: () => 50 })

    expect(cells()).toBeGreaterThan(0)
    // Still blank paper: the drawing is data, not a bitmap.
    expect(canvas.width).toBe(0)
  })

  it('starts a ring where a primary click lands anywhere on the chat surface', () => {
    const raf = installRaf()
    const { canvas, painter, surface } = mountSheet()

    painter.setActive(true)
    press(surface, 400, 300)

    expect(canvas.width).toBeGreaterThan(0)
    expect(raf.pending()).toBe(1)

    // A third of a second in, the ring is lit — and nothing prints past full strength.
    raf.runNext(clock + 300)
    const drawn = contexts.get(canvas)?.draws ?? []

    expect(drawn.length).toBeGreaterThan(0)
    expect(Math.max(...drawn)).toBeLessThanOrEqual(1)
    expect(Math.min(...drawn)).toBeGreaterThan(0)
  })

  it('ignores secondary buttons, presses outside the sheet, and reduced motion', () => {
    const raf = installRaf()
    const { canvas, painter, surface } = mountSheet()

    painter.setActive(true)
    press(surface, 400, 300, 2)
    press(surface, 40, 300)
    press(surface, 400, 900)
    reducedMotion = true
    press(surface, 400, 300)

    expect(raf.pending()).toBe(0)
    expect(canvas.width).toBe(0)
  })

  it('stays put on an inactive sheet', () => {
    const raf = installRaf()
    const { painter, surface } = mountSheet()

    press(surface, 400, 300)

    expect(raf.pending()).toBe(0)

    painter.setActive(true)
    painter.setActive(false)
    press(surface, 400, 300)

    expect(raf.pending()).toBe(0)
  })

  it('hands the trace to the compositor once the rings are out, then lets the bitmap go', () => {
    const raf = installRaf()
    const { canvas, painter, surface } = mountSheet()

    painter.setActive(true)
    press(surface, 300, 200)
    raf.runUntilIdle(clock + 16)

    // No more frames: what is left is one fade, sampled from 1 down to 0.
    expect(raf.pending()).toBe(0)
    expect(animations).toHaveLength(1)

    const [fade] = animations
    const opacities = fade.keyframes.map(frame => frame.opacity)

    expect(opacities[0]).toBe(1)
    expect(opacities.at(-1)).toBe(0)
    expect(opacities.every((opacity, i) => i === 0 || opacity < opacities[i - 1])).toBe(true)
    expect(fade.options.easing).toBe('linear')

    fade.onfinish?.()

    expect(fade.cancel).toHaveBeenCalled()
    expect(canvas.width).toBe(0)
  })

  it('takes the sheet back from the compositor when a click lands mid-fade', () => {
    const raf = installRaf()
    const { painter, surface } = mountSheet()

    painter.setActive(true)
    press(surface, 300, 200)
    clock = raf.runUntilIdle(clock + 16)

    const [fade] = animations

    press(surface, 500, 400)

    expect(fade.cancel).toHaveBeenCalled()
    expect(raf.pending()).toBe(1)
  })

  it('stops at once when the chat starts, and frees the bitmap after the fade-out', () => {
    const raf = installRaf()
    const { canvas, painter, surface } = mountSheet()

    painter.setActive(true)
    press(surface, 300, 200)
    raf.runNext(clock + 100)
    painter.setActive(false)

    expect(raf.pending()).toBe(0)
    // The last frame stays up while the host fades it out…
    expect(canvas.width).toBeGreaterThan(0)

    vi.advanceTimersByTime(400)

    // …then the sheet is gone.
    expect(canvas.width).toBe(0)
  })

  it('lets go of everything on detach', () => {
    const raf = installRaf()
    const { canvas, detach, painter, surface } = mountSheet()

    painter.setActive(true)
    press(surface, 300, 200)
    detach()

    expect(raf.pending()).toBe(0)
    expect(canvas.width).toBe(0)

    // Its listener went with it.
    press(surface, 300, 200)

    expect(raf.pending()).toBe(0)
  })
})
