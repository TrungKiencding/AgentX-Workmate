import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { $backdrop } from '@/store/backdrop'

import { ChatWatermark } from './chat-watermark'

// The brand backdrop is drawing, not copy, and its whole job is to stay a
// whisper: these pin the two decisions that went wrong once — wordmarks set as
// filled light type rather than outlined heavy type, and a mark built from
// clean geometry rather than a noisy trace — plus the id scoping that keeps
// several mounted chat surfaces from sharing one SVG pattern.

afterEach(() => {
  cleanup()
  $backdrop.set(true)
})

function renderWatermark() {
  return render(<ChatWatermark />).container
}

describe('ChatWatermark', () => {
  it('renders nothing when the backdrop setting is off', () => {
    $backdrop.set(false)

    expect(renderWatermark().querySelector('[data-slot="chat-watermark"]')).toBeNull()
  })

  it('sets the wordmarks as filled light type, never as outlines', () => {
    const words = Array.from(renderWatermark().querySelectorAll('text'))

    expect(words.map(word => word.textContent)).toEqual(['AgentX', 'Workmate', 'AgentX', 'Workmate'])

    for (const word of words) {
      expect(word.getAttribute('fill')).toBe('currentColor')
      expect(word.getAttribute('stroke')).toBe('none')
      expect(Number(word.getAttribute('font-weight'))).toBeLessThanOrEqual(300)
      expect(Number(word.getAttribute('fill-opacity'))).toBeLessThan(1)
    }

    // No two wordmarks at the same size — equal twins are what reads as a grid.
    const sizes = words.map(word => word.getAttribute('font-size'))

    expect(new Set(sizes).size).toBe(sizes.length)
  })

  it('draws the mark from straight runs and circular arcs, with the tail forking off the loop', () => {
    const paths = Array.from(renderWatermark().querySelectorAll('path')).map(path => path.getAttribute('d') ?? '')
    const [loop, tail] = paths

    expect(paths.length).toBeGreaterThan(0)
    expect(paths.length % 2).toBe(0)

    for (const d of paths) {
      // Only M/L/A/Z — a Bézier anywhere means a trace crept back in.
      expect(d).toMatch(/^M[\d. -]+(?: [LA][\d. -]+)+Z?$/)
      expect(d).not.toMatch(/[CSQT]/)
    }

    expect(loop.endsWith('Z')).toBe(true)
    expect(tail.endsWith('Z')).toBe(false)

    const forkOfLoop = loop.match(/ L([\d.-]+ [\d.-]+)/)?.[1]
    const startOfTail = tail.match(/^M([\d.-]+ [\d.-]+)/)?.[1]

    expect(startOfTail).toBe(forkOfLoop)

    // Every mark stays inside its 100x100 box, with breathing room for the stroke.
    for (const d of paths) {
      const coords = d.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? []

      expect(coords.length).toBeGreaterThan(0)
      expect(Math.min(...coords)).toBeGreaterThanOrEqual(0)
      expect(Math.max(...coords)).toBeLessThanOrEqual(100)
    }
  })

  it('gives every mounted surface its own pattern id', () => {
    const container = render(
      <>
        <ChatWatermark />
        <ChatWatermark />
      </>
    ).container

    const patterns = Array.from(container.querySelectorAll('pattern')).map(pattern => pattern.id)
    const fills = Array.from(container.querySelectorAll('rect')).map(rect => rect.getAttribute('fill'))

    expect(patterns).toHaveLength(2)
    expect(new Set(patterns).size).toBe(2)
    expect(fills).toEqual(patterns.map(id => `url(#${id})`))
  })
})
