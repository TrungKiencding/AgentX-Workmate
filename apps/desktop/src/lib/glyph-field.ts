/**
 * The empty chat's ground. At rest it is blank paper. A click lets ink into it:
 * a ring spreads from the pointer, and every small monospaced character it
 * reaches flashes in the accent and settles into a grey trace — brightest
 * where the ring crosses the long, wind-swept strokes of a hidden drawing,
 * faintest on the open paper between them. The trace lingers and builds up,
 * so a few clicks bring the drawing out of the paper; left alone, it all fades
 * back to white.
 *
 * This module is the model and nothing else. The drawing, the grid, the ring
 * and the choice of character are pure functions of a seed, a point and a
 * time, so tests can pin them without a renderer; `components/glyph-field`
 * only paints what it is told.
 */

// ── Randomness ──────────────────────────────────────────────────────────────

/** The murmur3 finaliser: avalanches every input bit across the word. */
function mix32(value: number): number {
  let h = value | 0
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)

  return h ^ (h >>> 16)
}

/**
 * Three integers to a uniform number in [0, 1). Stateless on purpose: a cell
 * asks for "its" random number by coordinates, in any order, on any frame,
 * and always gets the same answer — no PRNG stream to keep in step.
 */
export function hash3(a: number, b: number, c: number): number {
  let h = mix32(Math.imul(a | 0, 0x9e3779b1) ^ 0x2545f491)
  h = mix32(h ^ Math.imul(b | 0, 0x85ebca77))
  h = mix32(h ^ Math.imul(c | 0, 0xc2b2ae3d))

  return (h >>> 0) / 4294967296
}

export const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value)

export function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / (edge1 - edge0))

  return t * t * (3 - 2 * t)
}

// ── Noise ───────────────────────────────────────────────────────────────────

/** Unit gradients for the lattice — 64 headings is plenty to hide the grid. */
const GRADIENT_COUNT = 64

const GRADIENTS = Float32Array.from({ length: GRADIENT_COUNT * 2 }, (_, index) => {
  const angle = (Math.floor(index / 2) / GRADIENT_COUNT) * Math.PI * 2

  return index % 2 === 0 ? Math.cos(angle) : Math.sin(angle)
})

/** Quintic fade: zero first and second derivatives at the lattice, so no creases. */
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)

function cornerDot(ix: number, iy: number, seed: number, dx: number, dy: number): number {
  const slot = Math.floor(hash3(ix, iy, seed) * GRADIENT_COUNT) * 2

  return GRADIENTS[slot] * dx + GRADIENTS[slot + 1] * dy
}

/** 2D gradient noise, roughly in [-0.7, 0.7], smooth everywhere. */
export function gradientNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy
  const u = fade(fx)
  const v = fade(fy)
  const n00 = cornerDot(ix, iy, seed, fx, fy)
  const n10 = cornerDot(ix + 1, iy, seed, fx - 1, fy)
  const n01 = cornerDot(ix, iy + 1, seed, fx, fy - 1)
  const n11 = cornerDot(ix + 1, iy + 1, seed, fx - 1, fy - 1)
  const top = n00 + (n10 - n00) * u
  const bottom = n01 + (n11 - n01) * u

  return top + (bottom - top) * v
}

/** Fractal sum of octaves, normalised back to a single octave's range. */
export function fbm(x: number, y: number, seed: number, octaves: number): number {
  let sum = 0
  let amplitude = 1
  let frequency = 1
  let total = 0

  for (let octave = 0; octave < octaves; octave += 1) {
    sum += amplitude * gradientNoise(x * frequency, y * frequency, seed + octave * 7919)
    total += amplitude
    amplitude *= 0.5
    frequency *= 2.03
  }

  return sum / total
}

// ── The picture ─────────────────────────────────────────────────────────────

/**
 * One drawing, fixed by its seed. The strokes are anisotropic noise — long
 * along a heading, narrow across it — bent by a domain warp so they sweep
 * instead of running ruler-straight, then thresholded against a ranking taken
 * once over a reference sheet. Ranking (not a fixed cut-off) is what keeps
 * every seed covering the same share of the page; taking it over a fixed
 * reference (not the live canvas) is what keeps a stroke from brightening or
 * fading while the window is being resized.
 */
export interface FieldComposition {
  readonly seed: number
  /** The strokes' heading, as a unit vector. */
  readonly cos: number
  readonly sin: number
  /** Feature size in CSS px along a stroke and across it. */
  readonly along: number
  readonly across: number
  /** How hard the domain warp bends the strokes, in feature units. */
  readonly warp: number
  /** Tones at or below `floor` carry no ink; at `full` and above, all of it. */
  readonly floor: number
  readonly full: number
}

/** Share of the sheet a stroke touches at all — the rest is open paper. */
export const FIELD_COVERAGE = 0.38

/** Share of the ranking over which a stroke's edge feathers in. */
const FIELD_FEATHER = 0.18

/** The reference sheet the ranking is taken over, in CSS px, and its sampling step. */
const REFERENCE_WIDTH = 1600
const REFERENCE_HEIGHT = 1000
const REFERENCE_STEP = 20

/** Raw tone of a composition at a point, before ranking — higher is inkier. */
function rawTone(geometry: Omit<FieldComposition, 'floor' | 'full'>, x: number, y: number): number {
  const { across, along, cos, seed, sin, warp } = geometry
  const u = (x * cos + y * sin) / along
  const v = (y * cos - x * sin) / across
  const bendU = fbm(u * 0.5 + 11.3, v * 0.5 - 4.7, seed + 101, 2)
  const bendV = fbm(u * 0.5 - 7.1, v * 0.5 + 9.2, seed + 202, 2)

  return fbm(u + bendU * warp, v + bendV * warp * 1.4, seed, 3)
}

function quantile(sorted: Float32Array, q: number): number {
  const index = clamp01(q) * (sorted.length - 1)
  const low = Math.floor(index)
  const high = Math.min(sorted.length - 1, low + 1)

  return sorted[low] + (sorted[high] - sorted[low]) * (index - low)
}

export function composeField(seed: number): FieldComposition {
  const pick = (salt: number) => hash3(seed, salt, 0x51ed)
  // Strokes rise to the right, the way a hand sweeps a brush: 22–42° above the
  // horizontal. Canvas y points down, so "above" is a negative angle. They are
  // long (a stroke outruns a window's width) and only gently bent — a hard
  // warp curls them into clouds, and clouds read as noise, not as a drawing.
  const angle = -((22 + pick(1) * 20) * Math.PI) / 180

  const geometry = {
    across: 190 + pick(3) * 60,
    along: 820 + pick(2) * 260,
    cos: Math.cos(angle),
    seed,
    sin: Math.sin(angle),
    warp: 0.35 + pick(4) * 0.25
  }

  const columns = REFERENCE_WIDTH / REFERENCE_STEP
  const rows = REFERENCE_HEIGHT / REFERENCE_STEP
  const tones = new Float32Array(columns * rows)

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      tones[row * columns + column] = rawTone(geometry, column * REFERENCE_STEP, row * REFERENCE_STEP)
    }
  }

  tones.sort()

  return {
    ...geometry,
    floor: quantile(tones, 1 - FIELD_COVERAGE),
    full: quantile(tones, 1 - FIELD_COVERAGE + FIELD_FEATHER)
  }
}

/**
 * The picture's ink at a point (CSS px), 0…1: the stroke itself, broken up by
 * a grain finer than a stroke and coarser than a character so a stroke reads
 * as dry-brushed rather than filled.
 */
export function fieldInk(composition: FieldComposition, x: number, y: number): number {
  const stroke = smoothstep(composition.floor, composition.full, rawTone(composition, x, y))

  if (stroke <= 0) {
    return 0
  }

  const grain = 0.5 + gradientNoise(x / 30, y / 14, composition.seed + 303)

  return stroke * (0.45 + 0.55 * clamp01(grain))
}

// ── The grid ────────────────────────────────────────────────────────────────

/**
 * The type: 10px JetBrains Mono on a 7.2 × 15 cell. The advance is the face's
 * 6px plus 1.2px of tracking — letter-spaced text is what makes a sheet of
 * characters read as texture instead of as a paragraph — and the line is half
 * again the size so rows stay separate stripes at a glance.
 */
export const GLYPH_FONT_SIZE = 10
export const GLYPH_CELL_WIDTH = 7.2
export const GLYPH_CELL_HEIGHT = 15

export interface GlyphGrid {
  readonly columns: number
  readonly rows: number
}

/**
 * Cells covering a width × height sheet, anchored at its top-left corner. The
 * anchor matters: a cell keeps its coordinates (and so its character and its
 * ink) while the sheet grows or shrinks, so a resize never reshuffles the
 * picture under the user.
 */
export function layoutGlyphGrid(width: number, height: number): GlyphGrid {
  return {
    columns: Math.max(0, Math.ceil(width / GLYPH_CELL_WIDTH)),
    rows: Math.max(0, Math.ceil(height / GLYPH_CELL_HEIGHT))
  }
}

/** Every character a cell can show. Index into this with `glyphIndex`. */
export const GLYPH_SET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** How a uniform number splits between digits, lower case and capitals. */
const DIGIT_SHARE = 0.52
const LOWER_SHARE = 0.3

/**
 * A uniform number to a character: about half digits — the sheet should read
 * as numbers first — then lower case, with capitals as the punctuation.
 */
export function glyphIndex(u: number): number {
  const t = clamp01(u)

  if (t < DIGIT_SHARE) {
    return Math.min(9, Math.floor((t / DIGIT_SHARE) * 10))
  }

  if (t < DIGIT_SHARE + LOWER_SHARE) {
    return 10 + Math.min(25, Math.floor(((t - DIGIT_SHARE) / LOWER_SHARE) * 26))
  }

  const upperShare = 1 - DIGIT_SHARE - LOWER_SHARE

  return 36 + Math.min(25, Math.floor(((t - DIGIT_SHARE - LOWER_SHARE) / upperShare) * 26))
}

/**
 * A cell's ink: the picture at the cell's centre, with a little per-character
 * jitter so neighbours never print at exactly the same weight.
 */
export function cellInk(composition: FieldComposition, column: number, row: number): number {
  const ink = fieldInk(composition, (column + 0.5) * GLYPH_CELL_WIDTH, (row + 0.5) * GLYPH_CELL_HEIGHT)

  return ink === 0 ? 0 : ink * (0.72 + 0.28 * hash3(column, row, composition.seed ^ 0x1d))
}

/** A cell's character before any ring has rewritten it. */
export function cellGlyph(seed: number, column: number, row: number): number {
  return glyphIndex(hash3(column, row, seed))
}

// ── The ring ────────────────────────────────────────────────────────────────

/** How long the leading edge takes to reach the farthest corner of the sheet. */
export const RIPPLE_SPREAD_MS = 2400

/** How long a character takes to swell to full once the edge reaches it. */
export const RIPPLE_SWELL_MS = 80

/**
 * The flash's time constant. The accent goes quickly, which is what keeps the
 * ring a ring rather than a filled disc: the lit band behind the edge is as
 * wide as the edge travels in a few of these.
 */
export const RIPPLE_FLASH_MS = 420

/** Past this, a character's flash is under 0.3% — nothing left to paint. */
export const RIPPLE_FLASH_WINDOW_MS = RIPPLE_SWELL_MS + RIPPLE_FLASH_MS * 6

/** How long the grey trace takes to settle in, as the flash goes out. */
export const TRACE_SETTLE_MS = 450

/** The trace's time constant: it lingers long enough for a few clicks to build on each other. */
export const TRACE_FADE_MS = 3200

/** How much trace one ring leaves on a character, out of a ceiling of 1. */
export const TRACE_DEPOSIT = 0.45

/** How bright a full trace prints, as a share of a full flash. */
export const TRACE_LEVEL = 0.4

/** The most the edge's wobble pushes it in or out, as a fraction of the radius. */
export const RIPPLE_WOBBLE = 0.034

/** How far a ring has to travel from (x, y) to reach every corner of a width × height sheet. */
export function rippleReach(x: number, y: number, width: number, height: number): number {
  return Math.hypot(Math.max(x, width - x), Math.max(y, height - y)) * (1 + RIPPLE_WOBBLE) + GLYPH_CELL_WIDTH
}

/**
 * The leading edge's radius `age` ms after the click: quick off the mark and
 * easing out, the way ink slows as the paper takes it up.
 */
export function rippleFront(reach: number, age: number): number {
  const t = clamp01(age / RIPPLE_SPREAD_MS)

  return reach * (1 - (1 - t) * (1 - t))
}

/** The inverse: how many ms after the click the edge reaches `distance` — never, past the reach. */
export function rippleArrival(reach: number, distance: number): number {
  return distance >= reach ? Number.POSITIVE_INFINITY : RIPPLE_SPREAD_MS * (1 - Math.sqrt(1 - distance / reach))
}

/**
 * The edge is not a compass circle — ink never is. Three slow harmonics push
 * it in and out by up to RIPPLE_WOBBLE of the radius, a different shape for
 * every ring.
 */
export function rippleWobble(seed: number, heading: number): number {
  const phase = (k: number) => hash3(seed, k, 0x77) * Math.PI * 2

  const wave =
    Math.sin(3 * heading + phase(1)) + 0.5 * Math.sin(5 * heading + phase(2)) + 0.25 * Math.sin(9 * heading + phase(3))

  return (wave / 1.75) * RIPPLE_WOBBLE
}

/**
 * When a ring started at (x, y) reaches the point (px, py): the arrival at
 * the distance along this heading, with the edge's wobble taken out.
 */
export function ripplePointArrival(seed: number, x: number, y: number, reach: number, px: number, py: number): number {
  const dx = px - x
  const dy = py - y

  return rippleArrival(reach, Math.sqrt(dx * dx + dy * dy) / (1 + rippleWobble(seed, Math.atan2(dy, dx))))
}

/**
 * A character's flash `since` ms after the edge reached it: a quick swell, then
 * a fast exponential fade. Continuous in time on purpose — every frame moves
 * every character a little, never a step.
 */
export function rippleFlash(since: number): number {
  if (since <= 0 || since >= RIPPLE_FLASH_WINDOW_MS) {
    return 0
  }

  return since < RIPPLE_SWELL_MS
    ? smoothstep(0, RIPPLE_SWELL_MS, since)
    : Math.exp(-(since - RIPPLE_SWELL_MS) / RIPPLE_FLASH_MS)
}

/** The trace one ring leaves on a character `since` ms after its edge got there. */
export function rippleTrace(since: number): number {
  return since <= 0 ? 0 : TRACE_DEPOSIT * smoothstep(0, TRACE_SETTLE_MS, since) * Math.exp(-since / TRACE_FADE_MS)
}

/**
 * How much of a trace is left after `elapsed` ms. Every trace fades at the
 * same rate, so a whole sheet of them fades as one — which is what lets the
 * painter hand the tail of the fade to the compositor.
 */
export function traceDecay(elapsed: number): number {
  return Math.exp(-Math.max(0, elapsed) / TRACE_FADE_MS)
}

// ── Paint ───────────────────────────────────────────────────────────────────

/**
 * Even open paper flashes a little as the ring passes, so a ring always reads
 * as a whole circle; the strokes of the drawing take the rest. Only strokes
 * keep a trace — open paper goes straight back to white.
 */
export const RIPPLE_PAPER_INK = 0.12

export interface CellPaint {
  /** Opacity of the character. */
  alpha: number
  /** 0 = the ink, 1 = the accent. */
  tint: number
}

/**
 * A cell's paint from its ink (the drawing), its flash, its trace (0…1, the
 * sum of what every ring left, capped) and the per-mode strength. Flash and
 * trace overlap as light does — each covers part of what the other left dark
 * — and the colour is the flash's share of the light. Writes into `out` so
 * the paint loop allocates nothing per cell.
 */
export function cellPaint(
  ink: number,
  flash: number,
  trace: number,
  strength: number,
  out: CellPaint = { alpha: 0, tint: 0 }
): CellPaint {
  const flashLight = (RIPPLE_PAPER_INK + (1 - RIPPLE_PAPER_INK) * ink) * flash
  const traceLight = ink * TRACE_LEVEL * trace
  const light = flashLight + traceLight - flashLight * traceLight

  out.alpha = strength * light
  out.tint = light > 0 ? flashLight / (flashLight + traceLight) : 0

  return out
}
