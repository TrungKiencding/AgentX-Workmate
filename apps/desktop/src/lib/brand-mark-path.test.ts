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

type Point = readonly [number, number]

type Segment =
  { center: Point; from: Point; kind: 'arc'; radius: number; to: Point } | { from: Point; kind: 'line'; to: Point }

const same = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9

/** The path's runs and arcs — absolute M/L/A/Z only, which is all the mark uses. */
function segmentsOf(d: string): Segment[] {
  const tokens = d.match(/[MLAZ]|-?\d+(?:\.\d+)?/g) ?? []
  const segments: Segment[] = []
  let start: Point = [0, 0]
  let at: Point = [0, 0]

  for (let i = 0; i < tokens.length;) {
    const command = tokens[i++]
    const take = () => Number(tokens[i++])

    if (command === 'M') {
      start = at = [take(), take()]
    } else if (command === 'L') {
      const to: Point = [take(), take()]
      segments.push({ from: at, kind: 'line', to })
      at = to
    } else if (command === 'A') {
      const [rx, ry, rotation, largeArc, sweep] = [take(), take(), take(), take(), take()]
      const to: Point = [take(), take()]

      // Every fillet is a circular, minor, clockwise arc.
      expect([rx, rotation, largeArc, sweep]).toEqual([ry, 0, 0, 1])
      segments.push({ center: arcCenter(at, to, rx), from: at, kind: 'arc', radius: rx, to })
      at = to
    } else if (command === 'Z') {
      if (!same(at, start)) {
        segments.push({ from: at, kind: 'line', to: start })
      }

      at = start
    } else {
      throw new Error(`unexpected path command ${command}`)
    }
  }

  return segments
}

/** Centre of a minor clockwise arc of `radius` from `from` to `to` (SVG 2 §B.2.4, rx = ry, no rotation). */
function arcCenter(from: Point, to: Point, radius: number): Point {
  const hx = (from[0] - to[0]) / 2
  const hy = (from[1] - to[1]) / 2
  const k = Math.sqrt(Math.max(0, (radius ** 2 - hx ** 2 - hy ** 2) / (hx ** 2 + hy ** 2)))

  return [k * hy + (from[0] + to[0]) / 2, -k * hx + (from[1] + to[1]) / 2]
}

const angleAt = (center: Point, p: Point) => Math.atan2(p[1] - center[1], p[0] - center[0])

function lengthOf(segment: Segment): number {
  if (segment.kind === 'line') {
    return Math.hypot(segment.to[0] - segment.from[0], segment.to[1] - segment.from[1])
  }

  const turn = angleAt(segment.center, segment.to) - angleAt(segment.center, segment.from)

  return segment.radius * (((turn % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI))
}

/** The direction of travel where a segment begins (`end` false) or ends (`end` true). */
function heading(segment: Segment, end: boolean): Point {
  if (segment.kind === 'line') {
    const length = lengthOf(segment)

    return [(segment.to[0] - segment.from[0]) / length, (segment.to[1] - segment.from[1]) / length]
  }

  // Clockwise on screen is increasing angle with y pointing down.
  const angle = angleAt(segment.center, end ? segment.to : segment.from)

  return [-Math.sin(angle), Math.cos(angle)]
}

const totalLength = (d: string) => segmentsOf(d).reduce((sum, segment) => sum + lengthOf(segment), 0)

const vertices = (d: string) => new Set(segmentsOf(d).flatMap(s => [s.from.join(' '), s.to.join(' ')]))
