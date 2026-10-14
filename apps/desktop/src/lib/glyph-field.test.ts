import { describe, expect, it } from 'vitest'

import {
  cellGlyph,
  cellInk,
  cellPaint,
  composeField,
  FIELD_COVERAGE,
  fieldInk,
  GLYPH_CELL_HEIGHT,
  GLYPH_CELL_WIDTH,
  GLYPH_SET,
  glyphIndex,
  gradientNoise,
  hash3,
  layoutGlyphGrid,
  RIPPLE_FLASH_WINDOW_MS,
  RIPPLE_PAPER_INK,
  RIPPLE_SPREAD_MS,
  RIPPLE_SWELL_MS,
  RIPPLE_WOBBLE,
  rippleArrival,
  rippleFlash,
  rippleFront,
  ripplePointArrival,
  rippleReach,
  rippleTrace,
  rippleWobble,
  TRACE_DEPOSIT,
  TRACE_LEVEL,
  TRACE_SETTLE_MS,
  traceDecay
} from './glyph-field'

const SEEDS = [1, 42, 2024, 987_654_321]

describe('hash3', () => {
  it('is stable, in [0, 1), and spreads evenly', () => {
    expect(hash3(3, 5, 7)).toBe(hash3(3, 5, 7))
    expect(hash3(3, 5, 7)).not.toBe(hash3(5, 3, 7))

    let sum = 0
    const samples = 20_000

    for (let i = 0; i < samples; i += 1) {
      const value = hash3(i, i * 7, 11)

      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
      sum += value
    }

    expect(sum / samples).toBeCloseTo(0.5, 1)
  })
})

describe('gradientNoise', () => {
  it('is bounded and continuous — a nudge moves it a little, never a jump', () => {
    for (let i = 0; i < 2_000; i += 1) {
      const x = i * 0.137
      const y = i * 0.071
      const here = gradientNoise(x, y, 9)

      expect(Math.abs(here)).toBeLessThan(1)
      expect(Math.abs(gradientNoise(x + 0.001, y, 9) - here)).toBeLessThan(0.01)
      expect(Math.abs(gradientNoise(x, y + 0.001, 9) - here)).toBeLessThan(0.01)
    }
  })
})

describe('the drawing', () => {
  it('is fixed by its seed, and a new seed draws a new one', () => {
    const a = composeField(42)
    const b = composeField(42)
    const c = composeField(43)

    expect(fieldInk(a, 300, 200)).toBe(fieldInk(b, 300, 200))

    const differs = Array.from({ length: 50 }, (_, i) => fieldInk(a, i * 37, i * 23) !== fieldInk(c, i * 37, i * 23))

    expect(differs.some(Boolean)).toBe(true)
  })

  it('sweeps its strokes up to the right, and ranks its tones into a feathered edge', () => {
    for (const seed of SEEDS) {
      const field = composeField(seed)

      // Canvas y points down: rising to the right is a negative sine.
      expect(field.sin).toBeLessThan(0)
      expect(field.cos).toBeGreaterThan(0)
      expect(field.full).toBeGreaterThan(field.floor)
    }
  })

  it('covers the same share of the page whatever the seed', () => {
    for (const seed of SEEDS) {
      const field = composeField(seed)
      let inked = 0
      let total = 0

      // Offset from the ranking's own lattice, so this is a fresh sample.
      for (let y = 7; y < 1000; y += 23) {
        for (let x = 11; x < 1600; x += 23) {
          const ink = fieldInk(field, x, y)

          expect(ink).toBeGreaterThanOrEqual(0)
          expect(ink).toBeLessThanOrEqual(1)
          inked += ink > 0 ? 1 : 0
          total += 1
        }
      }

      expect(Math.abs(inked / total - FIELD_COVERAGE)).toBeLessThan(0.06)
    }
  })

  it('leaves most of the page as open paper', () => {
    const field = composeField(7)
    let open = 0

    for (let i = 0; i < 4_000; i += 1) {
      open += fieldInk(field, (i * 97) % 1600, (i * 61) % 1000) === 0 ? 1 : 0
    }

    expect(open / 4_000).toBeGreaterThan(0.5)
  })
})

describe('the grid', () => {
  it('covers the sheet in whole cells from the top-left corner', () => {
    expect(layoutGlyphGrid(0, 0)).toEqual({ columns: 0, rows: 0 })
    expect(layoutGlyphGrid(GLYPH_CELL_WIDTH * 10, GLYPH_CELL_HEIGHT * 4)).toEqual({ columns: 10, rows: 4 })
    expect(layoutGlyphGrid(GLYPH_CELL_WIDTH * 10 + 1, GLYPH_CELL_HEIGHT * 4 + 1)).toEqual({ columns: 11, rows: 5 })
  })

  it('reads as numbers first, then lower case, with capitals as punctuation', () => {
    const counts = { digit: 0, lower: 0, upper: 0 }
    const samples = 30_000

    for (let i = 0; i < samples; i += 1) {
      const glyph = GLYPH_SET[glyphIndex(hash3(i, 1, 2))]

      if (/[0-9]/.test(glyph)) {
        counts.digit += 1
      } else if (/[a-z]/.test(glyph)) {
        counts.lower += 1
      } else {
        counts.upper += 1
      }
    }

    expect(counts.digit / samples).toBeCloseTo(0.52, 1)
    expect(counts.lower / samples).toBeCloseTo(0.3, 1)
    expect(counts.upper / samples).toBeCloseTo(0.18, 1)
  })

  it('never indexes past the set, even at the ends of the range', () => {
    for (const u of [-1, 0, 0.51999, 0.52, 0.81999, 0.82, 0.99999, 1, 2]) {
      const index = glyphIndex(u)

      expect(index).toBeGreaterThanOrEqual(0)
      expect(index).toBeLessThan(GLYPH_SET.length)
    }
  })

  it('gives every cell its own stable character and ink', () => {
    const field = composeField(5)

    expect(cellGlyph(5, 3, 4)).toBe(cellGlyph(5, 3, 4))
    expect(cellInk(field, 3, 4)).toBe(cellInk(field, 3, 4))

    for (let row = 0; row < 40; row += 1) {
      for (let column = 0; column < 80; column += 1) {
        const ink = cellInk(field, column, row)

        expect(ink).toBeGreaterThanOrEqual(0)
        expect(ink).toBeLessThanOrEqual(1)
      }
    }
  })
})

describe('the ring', () => {
  it('leaves the click at once and slows as it spreads, reaching its full reach on time', () => {
    const reach = 900

    expect(rippleFront(reach, 0)).toBe(0)
    expect(rippleFront(reach, RIPPLE_SPREAD_MS)).toBe(reach)
    expect(rippleFront(reach, RIPPLE_SPREAD_MS * 2)).toBe(reach)

    let previous = 0
    let previousStep = Number.POSITIVE_INFINITY

    for (let age = 100; age <= RIPPLE_SPREAD_MS; age += 100) {
      const front = rippleFront(reach, age)
      const step = front - previous

      expect(step).toBeGreaterThan(0)
      expect(step).toBeLessThan(previousStep)
      previous = front
      previousStep = step
    }
  })

  it('times its arrival as the exact inverse of its front', () => {
    const reach = 1200

    for (const age of [10, 250, 900, 1800, 2399]) {
      expect(rippleArrival(reach, rippleFront(reach, age))).toBeCloseTo(age, 6)
    }

    expect(rippleArrival(reach, reach)).toBe(Number.POSITIVE_INFINITY)
    expect(rippleArrival(reach, reach * 2)).toBe(Number.POSITIVE_INFINITY)
  })

  it('reaches every corner of the sheet, wherever the click lands', () => {
    const [width, height] = [1100, 760]

    for (const [x, y] of [
      [0, 0],
      [550, 380],
      [1100, 760],
      [20, 700]
    ]) {
      const reach = rippleReach(x, y, width, height)

      for (const [cx, cy] of [
        [0, 0],
        [width, 0],
        [0, height],
        [width, height]
      ]) {
        expect(Number.isFinite(ripplePointArrival(77, x, y, reach, cx, cy))).toBe(true)
      }
    }
  })

  it('wobbles its edge by a few percent, never more', () => {
    for (let i = 0; i < 720; i += 1) {
      expect(Math.abs(rippleWobble(31, (i / 720) * Math.PI * 2))).toBeLessThanOrEqual(RIPPLE_WOBBLE + 1e-12)
    }

    // And not a compass circle: the edge does move.
    const headings = Array.from({ length: 12 }, (_, i) => rippleWobble(31, (i / 12) * Math.PI * 2))

    expect(Math.max(...headings) - Math.min(...headings)).toBeGreaterThan(RIPPLE_WOBBLE / 4)
  })
})

describe('a lit character', () => {
  it('flashes: dark before the edge, full at the end of the swell, gone after its window', () => {
    expect(rippleFlash(-5)).toBe(0)
    expect(rippleFlash(0)).toBe(0)
    expect(rippleFlash(RIPPLE_SWELL_MS / 2)).toBeGreaterThan(0)
    expect(rippleFlash(RIPPLE_SWELL_MS)).toBeCloseTo(1, 6)
    expect(rippleFlash(RIPPLE_FLASH_WINDOW_MS)).toBe(0)
    expect(rippleFlash(RIPPLE_FLASH_WINDOW_MS - 1)).toBeLessThan(0.005)
  })

  it('moves a little every frame — never a step', () => {
    for (let since = 0; since < RIPPLE_FLASH_WINDOW_MS - 8; since += 2) {
      expect(Math.abs(rippleFlash(since + 2) - rippleFlash(since))).toBeLessThan(0.06)
      expect(Math.abs(rippleTrace(since + 2) - rippleTrace(since))).toBeLessThan(0.01)
    }
  })

  it('settles into a trace that never outweighs the deposit', () => {
    expect(rippleTrace(0)).toBe(0)
    expect(rippleTrace(TRACE_SETTLE_MS / 2)).toBeGreaterThan(0)

    for (let since = 0; since < 20_000; since += 250) {
      expect(rippleTrace(since)).toBeLessThanOrEqual(TRACE_DEPOSIT)
    }
  })

  it('fades its trace at one rate everywhere — what lets the compositor take the tail', () => {
    expect(traceDecay(0)).toBe(1)
    expect(traceDecay(-100)).toBe(1)
    expect(traceDecay(700 + 1300)).toBeCloseTo(traceDecay(700) * traceDecay(1300), 12)

    // Once settled, a ring's trace is its earlier self, scaled by the shared decay.
    const since = TRACE_SETTLE_MS + 200

    expect(rippleTrace(since + 1500)).toBeCloseTo(rippleTrace(since) * traceDecay(1500), 12)
  })
})

describe('cellPaint', () => {
  const strength = 0.85

  it('leaves blank paper blank', () => {
    expect(cellPaint(0, 0, 0, strength).alpha).toBe(0)
    expect(cellPaint(1, 0, 0, strength).alpha).toBe(0)
  })

  it('lets open paper flash faintly but keep no trace', () => {
    expect(cellPaint(0, 1, 0, strength).alpha).toBeCloseTo(strength * RIPPLE_PAPER_INK, 12)
    expect(cellPaint(0, 0, 1, strength).alpha).toBe(0)
  })

  it('colours the flash in the accent and the trace in the ink', () => {
    expect(cellPaint(1, 1, 0, strength).tint).toBe(1)
    expect(cellPaint(1, 0, 1, strength).tint).toBe(0)

    const both = cellPaint(1, 0.5, 0.5, strength).tint

    expect(both).toBeGreaterThan(0)
    expect(both).toBeLessThan(1)
  })

  it('prints a full trace at its level, and never past full strength', () => {
    expect(cellPaint(1, 0, 1, strength).alpha).toBeCloseTo(strength * TRACE_LEVEL, 12)

    for (const ink of [0, 0.3, 1]) {
      for (const flash of [0, 0.5, 1]) {
        for (const trace of [0, 0.5, 1]) {
          expect(cellPaint(ink, flash, trace, strength).alpha).toBeLessThanOrEqual(strength + 1e-12)
        }
      }
    }
  })

  it('writes into the cell it is given instead of allocating', () => {
    const out = { alpha: -1, tint: -1 }

    expect(cellPaint(1, 1, 0, strength, out)).toBe(out)
    expect(out.alpha).toBeCloseTo(strength, 12)
  })
})
