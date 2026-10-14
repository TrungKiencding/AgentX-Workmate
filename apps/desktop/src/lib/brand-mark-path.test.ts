import { describe, expect, it } from 'vitest'

import { BRAND_MARK_PATHS } from './brand-mark-path'

// The mark is drawn as a hairline in three places (the reply's BrandGlyph, the
// thinking row, the EmptyFigures), so its geometry is pinned here, once: built
// from clean geometry rather than a noisy trace.
describe('BRAND_MARK_PATHS', () => {
  it('draws the mark from straight runs and circular arcs, with the tail forking off the loop', () => {
    const [loop, tail] = BRAND_MARK_PATHS

    for (const d of BRAND_MARK_PATHS) {
      // Only M/L/A/Z — a Bézier anywhere means a trace crept back in.
      expect(d).toMatch(/^M[\d. -]+(?: [LA][\d. -]+)+Z?$/)
      expect(d).not.toMatch(/[CSQT]/)
    }

    expect(loop.endsWith('Z')).toBe(true)
    expect(tail.endsWith('Z')).toBe(false)

    const forkOfLoop = loop.match(/ L([\d.-]+ [\d.-]+)/)?.[1]
    const startOfTail = tail.match(/^M([\d.-]+ [\d.-]+)/)?.[1]

    expect(startOfTail).toBe(forkOfLoop)
  })

  it('keeps every point inside the 100x100 box, with breathing room for the stroke', () => {
    for (const d of BRAND_MARK_PATHS) {
      const coords = d.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? []

      expect(coords.length).toBeGreaterThan(0)
      expect(Math.min(...coords)).toBeGreaterThanOrEqual(0)
      expect(Math.max(...coords)).toBeLessThanOrEqual(100)
    }
  })
})
