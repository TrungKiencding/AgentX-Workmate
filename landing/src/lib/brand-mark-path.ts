/**
 * The AgentX mark as line art — copied verbatim from
 * `apps/desktop/src/lib/brand-mark-path.ts`.
 *
 * `landing/` is a standalone Vite app outside the repo's npm workspace, so it
 * cannot import across package boundaries. If the artwork ever changes, the
 * desktop file is the original; re-copy this one from it rather than re-fitting
 * the numbers here, or the two logos drift apart.
 *
 * ---- original header ----
 *
 * The AgentX mark as LINE ART: the centreline of the shipped ring logo, drawn
 * as geometry instead of traced. The ring is a rounded triangle whose right
 * leg forks — the loop turns in along a wide fillet while the tail carries
 * straight on, rounds the bottom-right corner and tucks back under the loop.
 * Fitting that to the medial axis of `assets/brand/mark-1024.png` (the raster
 * every icon is generated from) gives three sharp vertices, four fillet radii
 * and the tail's tip, all in a 100x100 box; `buildMark()` turns those into two
 * paths of straight runs and circular arcs. The earlier skeleton trace put a
 * kink on every corner and a wobble along the tail, which a hairline at 24px
 * shows as a shaky hand. Re-fit the numbers if the artwork changes.
 *
 * One source for every place the mark is drawn as a stroke — the chat
 * watermark, the `BrandGlyph` at the head of a reply, the `EmptyFigure`
 * illustrations — so the three can never drift into three slightly different
 * logos.
 */
type Point = readonly [number, number]

const APEX: Point = [49.9, -9.6]
const HEEL: Point = [-6.6, 107.1]
const ELBOW: Point = [86, 63.9]
/** Where the tail ends, just under the loop's base — and the heading it arrives on. */
const TAIL_TIP: Point = [55, 89]
const TAIL_RETURN: Point = [0.984, 0.178]
const RADIUS = { apex: 12, elbow: 28, heel: 11.5, tail: 11.5 } as const

/** The box the mark is drawn in — pass as the `viewBox` of any SVG that draws it. */
export const BRAND_MARK_VIEWBOX = '0 0 100 100'

function towards(from: Point, to: Point): Point {
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  const length = Math.hypot(dx, dy)

  return [dx / length, dy / length]
}

function along(from: Point, direction: Point, distance: number): Point {
  return [from[0] + direction[0] * distance, from[1] + direction[1] * distance]
}

/** Where `from + s·direction` meets `through + t·heading`. */
function intersect(from: Point, direction: Point, through: Point, heading: Point): Point {
  const det = direction[0] * -heading[1] - direction[1] * -heading[0]
  const s = ((through[0] - from[0]) * -heading[1] - (through[1] - from[1]) * -heading[0]) / det

  return along(from, direction, s)
}

/** Where a fillet of `radius` at `corner` (between the rays toward `a` and `b`) touches each ray. */
function fillet(corner: Point, a: Point, b: Point, radius: number): readonly [Point, Point] {
  const u = towards(corner, a)
  const v = towards(corner, b)
  const half = Math.acos(u[0] * v[0] + u[1] * v[1]) / 2
  const reach = radius / Math.tan(half)

  return [along(corner, u, reach), along(corner, v, reach)]
}

const point = ([x, y]: Point) => `${x.toFixed(2)} ${y.toFixed(2)}`
const arc = (radius: number, to: Point) => `A${radius} ${radius} 0 0 1 ${point(to)}`

/** The mark as two SVG path strings — the closed loop and the open tail. */
export function buildMark(): readonly [loop: string, tail: string] {
  const [apexLeft, apexRight] = fillet(APEX, HEEL, ELBOW, RADIUS.apex)
  const [fork, elbowBase] = fillet(ELBOW, APEX, HEEL, RADIUS.elbow)
  const [heelBase, heelLeft] = fillet(HEEL, ELBOW, APEX, RADIUS.heel)

  const loop = [
    `M${point(apexRight)}`,
    `L${point(fork)}`,
    arc(RADIUS.elbow, elbowBase),
    `L${point(heelBase)}`,
    arc(RADIUS.heel, heelLeft),
    `L${point(apexLeft)}`,
    `${arc(RADIUS.apex, apexRight)}Z`
  ].join(' ')

  // The tail leaves the loop at the fork, keeps the right leg's line to where
  // it meets the return line through the tip, and rounds that corner.
  const corner = intersect(APEX, towards(APEX, ELBOW), TAIL_TIP, TAIL_RETURN)
  const [cornerDown, cornerBack] = fillet(corner, APEX, TAIL_TIP, RADIUS.tail)

  const tail = [`M${point(fork)}`, `L${point(cornerDown)}`, arc(RADIUS.tail, cornerBack), `L${point(TAIL_TIP)}`].join(
    ' '
  )

  return [loop, tail]
}

/** The two paths, built once. */
export const BRAND_MARK_PATHS = buildMark()
