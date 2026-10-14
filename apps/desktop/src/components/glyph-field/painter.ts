import { onThemeRepaint } from '@/hooks/use-theme-epoch'
import {
  cellGlyph,
  cellInk,
  type CellPaint,
  cellPaint,
  composeField,
  type FieldComposition,
  GLYPH_CELL_HEIGHT,
  GLYPH_CELL_WIDTH,
  GLYPH_FONT_SIZE,
  GLYPH_SET,
  layoutGlyphGrid,
  RIPPLE_FLASH_WINDOW_MS,
  rippleFlash,
  ripplePointArrival,
  rippleReach,
  rippleTrace,
  TRACE_FADE_MS,
  TRACE_LEVEL,
  traceDecay
} from '@/lib/glyph-field'

type Rgb = readonly [number, number, number]

interface Palette {
  readonly accent: Rgb
  readonly ink: Rgb
  readonly strength: number
}

interface Ripple {
  /** `performance.now()` at the click. */
  readonly born: number
  readonly reach: number
  readonly seed: number
  /** Where it started, in the host's CSS px. */
  readonly x: number
  readonly y: number
  /** For every cell, ms after `born` when the edge reaches it (Infinity: never). */
  arrivals: Float32Array
  /** The latest of those arrivals: once its flash is out, the ring is only trace. */
  lastArrival: number
}

/** Colour steps from the ink to the accent, baked into the atlas. */
const TINT_STEPS = 24

/**
 * Characters fainter than this are not drawn. High enough that the trace on
 * open paper — a few percent, and most of the cells — costs nothing, low
 * enough that a fading stroke never visibly pops out.
 */
const MIN_ALPHA = 0.015

/**
 * The canvas is allocated in steps of this many CSS px, so a sash drag or a
 * window resize inside the step doesn't reallocate it on every frame.
 */
const ALLOCATION_STEP = 128

const MAX_DPR = 3

/** At most this many rings at once; another click retires the oldest into the trace. */
const MAX_RIPPLES = 6

/** A double-click (or a trackpad's bounce) makes one ring, not two on top of each other. */
const RIPPLE_COOLDOWN_MS = 90

/** Samples of the trace's exponential fade handed to the compositor. */
const FADE_KEYFRAMES = 12

/** Long enough for the host's fade-out (`--dur-long-exit`) to finish first. */
const RELEASE_AFTER_MS = 400

/** The idle warm-up runs by then even if the renderer never goes idle. */
const WARMUP_TIMEOUT_MS = 2000

const FONT_STACK = '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace'

/** The per-mode strength (styles.css), if the stylesheet hasn't said. */
const DEFAULT_STRENGTH = 0.85

/**
 * One drawing per app launch: every empty chat in a session brings out the
 * same strokes (several surfaces never disagree), and a relaunch draws new ones.
 */
const LAUNCH_SEED = Math.floor(Math.random() * 0x7fffffff)
let launchComposition: FieldComposition | null = null

function composition(): FieldComposition {
  launchComposition ??= composeField(LAUNCH_SEED)

  return launchComposition
}

let colorProbe: CanvasRenderingContext2D | null | undefined

/**
 * Theme tokens arrive as `color-mix()`/oklch, which getComputedStyle hands back
 * as `color(srgb …)` — rasterising through a 1×1 canvas is the one reading that
 * is right for every syntax the engine accepts.
 */
function resolveRgb(color: string): Rgb | null {
  if (colorProbe === undefined) {
    const probe = document.createElement('canvas')
    probe.width = 1
    probe.height = 1
    colorProbe = probe.getContext('2d', { willReadFrequently: true })
  }

  if (!colorProbe) {
    return null
  }

  colorProbe.clearRect(0, 0, 1, 1)
  colorProbe.fillStyle = '#000'
  colorProbe.fillStyle = color
  colorProbe.fillRect(0, 0, 1, 1)
  const [r, g, b] = colorProbe.getImageData(0, 0, 1, 1).data

  return [r, g, b]
}

function mixRgb(a: Rgb, b: Rgb, amount: number): string {
  const channel = (index: number) => Math.round(a[index] + (b[index] - a[index]) * amount)

  return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`
}

function samePalette(a: Palette | null, b: Palette): boolean {
  return (
    a !== null &&
    a.strength === b.strength &&
    a.ink.every((channel, index) => channel === b.ink[index]) &&
    a.accent.every((channel, index) => channel === b.accent[index])
  )
}

const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

/**
 * Paints the glyph field onto one canvas. Imperative on purpose: a ring
 * repaints thousands of characters on every frame for a few seconds, which is
 * canvas work, not React work.
 *
 * It costs nothing at rest — no bitmap until the first click, no animation
 * frame once the rings are out. Each ring is per-frame canvas work only while
 * it is flashing; what it leaves is a trace that fades at one rate everywhere,
 * so the last frame is painted once and its fade runs on the compositor.
 */
export class GlyphFieldPainter {
  private host: HTMLElement | null = null
  private canvas: HTMLCanvasElement | null = null
  private context: CanvasRenderingContext2D | null = null
  private atlas: HTMLCanvasElement | null = null
  private atlasCell = { height: 0, width: 0 }
  private palette: Palette | null = null
  private paletteStale = true
  private active = false
  private allocated = false
  private allocation = { height: 0, width: 0 }
  private dpr = 1
  private size = { height: 0, width: 0 }
  private columns = 0
  private rows = 0
  private inks = new Float32Array(0)
  private glyphs = new Uint8Array(0)
  /** What retired rings left on each cell, as it stood at `residueAt`. */
  private residue = new Float32Array(0)
  private residueAt = 0
  /** The brightest printed trace (trace × ink) on the sheet as of the last frame. */
  private maxTrace = 0
  private ripples: Ripple[] = []
  private frame = 0
  private warmup = 0
  private fade: Animation | null = null
  private releaseTimer: ReturnType<typeof setTimeout> | undefined
  private dprQuery: MediaQueryList | null = null
  private readonly paint: CellPaint = { alpha: 0, tint: 0 }

  /**
   * Bind to the host (which clips the sheet and listens for clicks through
   * its chat surface) and the canvas. Returns the matching detach.
   */
  attach(host: HTMLElement, canvas: HTMLCanvasElement): () => void {
    const context = canvas.getContext('2d')

    if (!context) {
      return () => {}
    }

    this.host = host
    this.canvas = canvas
    this.context = context
    // A fresh <canvas> is 300×150: blank paper holds no bitmap at all.
    this.release()

    // Clicks land on whatever sits over the sheet — the greeting, a card, the
    // composer — so the ring listens on the whole chat surface, not the canvas.
    const surface = host.closest<HTMLElement>('[data-chat-surface]') ?? host.parentElement
    surface?.addEventListener('pointerdown', this.onPointerDown, { passive: true })

    const offTheme = onThemeRepaint(this.onThemeRepaint)
    this.watchDpr()

    // Canvas text doesn't reflow when a webfont arrives: re-bake the atlas
    // once the bundled face is ready, in case the first one used a fallback.
    let attached = true
    void document.fonts?.load(`${GLYPH_FONT_SIZE}px ${FONT_STACK}`).then(
      () => {
        if (attached) {
          this.atlas = null
        }
      },
      () => {}
    )

    // Re-attached to a sheet that is already armed (StrictMode runs effects
    // twice): the detach cancelled its warm-up, so ask again.
    this.warmUp()

    return () => {
      attached = false
      surface?.removeEventListener('pointerdown', this.onPointerDown)
      offTheme()
      this.dprQuery?.removeEventListener('change', this.onDprChange)
      this.dprQuery = null
      this.coolDown()
      this.clear()
      clearTimeout(this.releaseTimer)
      this.release()
      this.host = null
      this.canvas = null
      this.context = null
    }
  }

  /** Arm the sheet for clicks, or wipe it and free the bitmap once the host's fade is over. */
  setActive(active: boolean) {
    if (this.active === active) {
      return
    }

    this.active = active
    clearTimeout(this.releaseTimer)

    if (active) {
      // Back before the release: carry on from the frame that was left up.
      this.fade?.play()

      if (this.ripples.length > 0) {
        this.schedule()
      }

      this.warmUp()

      return
    }

    // The host fades the last frame out; the next empty chat starts on blank paper.
    this.coolDown()
    this.stop()
    this.fade?.pause()
    this.releaseTimer = setTimeout(() => {
      this.clear()
      this.release()
    }, RELEASE_AFTER_MS)
  }

  /** The host's size in CSS px. */
  resize(width: number, height: number) {
    this.size = { height, width }

    // Blank paper needs no bitmap — only the drawing, ready for the first
    // click. A running ring repaints on its next frame.
    if (!this.allocated) {
      this.warmUp()
    } else if (this.ensureCanvas() === 'reset') {
      this.repaintStill()
    }
  }

  /** Start a ring at (x, y) in the host's CSS px. */
  ripple(x: number, y: number, now = performance.now()) {
    if (!this.active || this.ensureCanvas() === 'unavailable') {
      return
    }

    const last = this.ripples.at(-1)

    if (last && now - last.born < RIPPLE_COOLDOWN_MS) {
      return
    }

    // The compositor has been fading the last frame: take the sheet back.
    if (this.fade) {
      this.fade.cancel()
      this.fade = null
      this.draw(now)
    }

    if (this.ripples.length >= MAX_RIPPLES) {
      this.retire([this.ripples[0]], now)
    }

    const ripple: Ripple = {
      arrivals: new Float32Array(0),
      born: now,
      lastArrival: 0,
      reach: rippleReach(x, y, this.size.width, this.size.height),
      seed: Math.floor(Math.random() * 0x7fffffff),
      x,
      y
    }

    this.measure(ripple)
    this.ripples.push(ripple)
    this.schedule()
  }

  /**
   * Lay out the drawing for the host's size in idle time, so the first click
   * only has to allocate and paint — not work out ten thousand cells while
   * its ring is meant to be leaving the pointer.
   */
  private warmUp() {
    if (this.warmup || !this.active || typeof requestIdleCallback !== 'function') {
      return
    }

    this.warmup = requestIdleCallback(
      () => {
        this.warmup = 0
        const { height, width } = this.size

        if (this.active && width > 0 && height > 0) {
          this.reflow(
            layoutGlyphGrid(
              Math.ceil(width / ALLOCATION_STEP) * ALLOCATION_STEP,
              Math.ceil(height / ALLOCATION_STEP) * ALLOCATION_STEP
            )
          )
        }
      },
      { timeout: WARMUP_TIMEOUT_MS }
    )
  }

  private coolDown() {
    if (this.warmup) {
      cancelIdleCallback(this.warmup)
      this.warmup = 0
    }
  }

  private onPointerDown = (event: PointerEvent) => {
    if (!this.host || !this.active || event.button !== 0 || prefersReducedMotion()) {
      return
    }

    const box = this.host.getBoundingClientRect()
    const x = event.clientX - box.left
    const y = event.clientY - box.top

    if (x < 0 || y < 0 || x > box.width || y > box.height) {
      return
    }

    this.ripple(x, y)
  }

  /**
   * The root's class/style attributes change for more than themes — a sash
   * drag rewrites `--workspace-left` on every frame — so a running ring just
   * re-reads the palette on its next frame, and a still frame is repainted
   * only when the colours really moved.
   */
  private onThemeRepaint = () => {
    this.paletteStale = true

    if (this.fade) {
      const palette = this.readPalette()

      if (palette && !samePalette(this.palette, palette)) {
        this.repaintStill()
      }
    }
  }

  private onDprChange = () => {
    this.watchDpr()

    if (this.allocated && this.ensureCanvas() === 'reset') {
      this.repaintStill()
    }
  }

  /** A `resolution` query for the current ratio fires once the window lands on a different screen. */
  private watchDpr() {
    this.dprQuery?.removeEventListener('change', this.onDprChange)
    this.dprQuery = window.matchMedia?.(`(resolution: ${window.devicePixelRatio || 1}dppx)`) ?? null
    this.dprQuery?.addEventListener('change', this.onDprChange)
  }

  /**
   * Make sure the bitmap covers the host at the current pixel ratio. 'reset'
   * when it had to be (re)allocated — the sheet is blank until repainted.
   */
  private ensureCanvas(): 'ready' | 'reset' | 'unavailable' {
    const canvas = this.canvas
    const { height, width } = this.size

    if (!canvas || width <= 0 || height <= 0) {
      return 'unavailable'
    }

    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1)
    const allocationWidth = Math.ceil(width / ALLOCATION_STEP) * ALLOCATION_STEP
    const allocationHeight = Math.ceil(height / ALLOCATION_STEP) * ALLOCATION_STEP

    // Grow at once; shrink only once the sheet is two steps too big, so a
    // window wobbling around a step boundary doesn't reallocate on every frame.
    const fits =
      this.allocated &&
      dpr === this.dpr &&
      allocationWidth <= this.allocation.width &&
      allocationHeight <= this.allocation.height &&
      this.allocation.width - allocationWidth < ALLOCATION_STEP * 2 &&
      this.allocation.height - allocationHeight < ALLOCATION_STEP * 2

    if (fits) {
      return 'ready'
    }

    if (dpr !== this.dpr) {
      this.atlas = null
    }

    this.dpr = dpr
    this.allocation = { height: allocationHeight, width: allocationWidth }
    canvas.width = Math.round(allocationWidth * dpr)
    canvas.height = Math.round(allocationHeight * dpr)
    canvas.style.width = `${allocationWidth}px`
    canvas.style.height = `${allocationHeight}px`
    this.allocated = true
    this.reflow(layoutGlyphGrid(allocationWidth, allocationHeight))

    return 'reset'
  }

  /**
   * Fit the per-cell arrays to a new grid. Cells that survive keep their ink,
   * character and trace — the grid is anchored top-left, so a cell's
   * coordinates never move — and only new cells are computed. Live rings are
   * re-measured against the new grid.
   */
  private reflow({ columns, rows }: { columns: number; rows: number }) {
    if (columns === this.columns && rows === this.rows) {
      return
    }

    const field = composition()
    const inks = new Float32Array(columns * rows)
    const glyphs = new Uint8Array(columns * rows)
    const residue = new Float32Array(columns * rows)

    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const index = row * columns + column

        if (column < this.columns && row < this.rows) {
          const previous = row * this.columns + column
          inks[index] = this.inks[previous]
          glyphs[index] = this.glyphs[previous]
          residue[index] = this.residue[previous]
        } else {
          inks[index] = cellInk(field, column, row)
          glyphs[index] = cellGlyph(field.seed, column, row)
        }
      }
    }

    this.columns = columns
    this.rows = rows
    this.inks = inks
    this.glyphs = glyphs
    this.residue = residue

    for (const ripple of this.ripples) {
      this.measure(ripple)
    }
  }

  /**
   * When the ring's edge reaches each cell — the only per-cell geometry a
   * ring costs, done once, so a frame is subtractions and exps.
   */
  private measure(ripple: Ripple) {
    const arrivals = new Float32Array(this.columns * this.rows)
    let lastArrival = 0

    for (let row = 0; row < this.rows; row += 1) {
      const y = (row + 0.5) * GLYPH_CELL_HEIGHT

      for (let column = 0; column < this.columns; column += 1) {
        const x = (column + 0.5) * GLYPH_CELL_WIDTH
        const arrival = ripplePointArrival(ripple.seed, ripple.x, ripple.y, ripple.reach, x, y)
        arrivals[row * this.columns + column] = arrival

        if (arrival !== Number.POSITIVE_INFINITY && arrival > lastArrival) {
          lastArrival = arrival
        }
      }
    }

    ripple.arrivals = arrivals
    ripple.lastArrival = lastArrival
  }

  /**
   * Fold rings whose flash is over into the residue. From here on all a ring
   * is, is trace fading at the shared rate, so it no longer needs its own
   * per-cell arrivals.
   */
  private retire(rings: readonly Ripple[], now: number) {
    if (rings.length === 0) {
      return
    }

    const decay = traceDecay(now - this.residueAt)
    const residue = this.residue

    for (let index = 0; index < residue.length; index += 1) {
      let trace = residue[index] * decay

      for (const ring of rings) {
        trace += rippleTrace(now - ring.born - ring.arrivals[index])
      }

      residue[index] = trace > 1 ? 1 : trace
    }

    this.residueAt = now
    this.ripples = this.ripples.filter(ring => !rings.includes(ring))
  }

  /** Read the ink, the accent and the strength off the host and the canvas. */
  private readPalette(): Palette | null {
    if (!this.host || !this.canvas) {
      return null
    }

    const hostStyle = getComputedStyle(this.host)
    const ink = resolveRgb(hostStyle.color)
    const accent = resolveRgb(getComputedStyle(this.canvas).color)
    const strength = Number.parseFloat(hostStyle.getPropertyValue('--ui-glyph-field-strength'))

    if (!ink || !accent) {
      return null
    }

    return { accent, ink, strength: Number.isFinite(strength) ? strength : DEFAULT_STRENGTH }
  }

  /**
   * Bake every character in every tint step into one sprite sheet at device
   * resolution, so a frame is nothing but `drawImage` from a single source.
   */
  private bakeAtlas(palette: Palette): HTMLCanvasElement | null {
    const width = Math.ceil(GLYPH_CELL_WIDTH * this.dpr)
    const height = Math.ceil(GLYPH_CELL_HEIGHT * this.dpr)
    const atlas = document.createElement('canvas')
    atlas.width = width * GLYPH_SET.length
    atlas.height = height * TINT_STEPS
    const context = atlas.getContext('2d')

    if (!context) {
      return null
    }

    context.font = `400 ${GLYPH_FONT_SIZE * this.dpr}px ${FONT_STACK}`
    context.textAlign = 'center'
    context.textBaseline = 'middle'

    for (let step = 0; step < TINT_STEPS; step += 1) {
      context.fillStyle = mixRgb(palette.ink, palette.accent, step / (TINT_STEPS - 1))

      for (let glyph = 0; glyph < GLYPH_SET.length; glyph += 1) {
        context.fillText(GLYPH_SET[glyph], glyph * width + width / 2, step * height + height / 2)
      }
    }

    this.atlasCell = { height, width }

    return atlas
  }

  private schedule() {
    if (!this.frame && this.active) {
      this.frame = requestAnimationFrame(this.onFrame)
    }
  }

  private stop() {
    if (this.frame) {
      cancelAnimationFrame(this.frame)
      this.frame = 0
    }
  }

  private onFrame = (now: number) => {
    this.frame = 0

    if (this.draw(now)) {
      this.schedule()
    } else {
      this.handOff()
    }
  }

  /**
   * The rings are out and only trace is left, fading at one rate everywhere:
   * the frame just painted is the whole future, scaled. Hand that scaling to
   * the compositor as an opacity animation — sampled from the same
   * exponential the model fades by — and stop painting.
   */
  private handOff() {
    const canvas = this.canvas
    const strength = this.palette?.strength ?? DEFAULT_STRENGTH
    const brightest = strength * TRACE_LEVEL * this.maxTrace

    if (!canvas || !this.allocated || brightest <= MIN_ALPHA) {
      this.clear()

      return
    }

    const duration = TRACE_FADE_MS * Math.log(brightest / MIN_ALPHA)
    const tail = traceDecay(duration)

    const keyframes = Array.from({ length: FADE_KEYFRAMES + 1 }, (_, step) => {
      const offset = step / FADE_KEYFRAMES

      return { offset, opacity: (traceDecay(duration * offset) - tail) / (1 - tail) }
    })

    this.fade = canvas.animate(keyframes, { duration, easing: 'linear', fill: 'forwards' })

    // Faded out: back to blank paper, and nothing held for it.
    this.fade.onfinish = () => {
      this.clear()
      this.release()
    }
  }

  /** Repaint the still frame a fade is showing (after a reset or a new palette), and fade from there. */
  private repaintStill() {
    if (!this.fade) {
      return
    }

    this.fade.cancel()
    this.fade = null
    this.draw(performance.now())
    this.handOff()
  }

  /** Paint one frame at `now`. True while a ring is still flashing. */
  private draw(now: number): boolean {
    const canvas = this.canvas
    const context = this.context

    if (!canvas || !context || !this.allocated) {
      return false
    }

    if (this.paletteStale) {
      const palette = this.readPalette()
      this.paletteStale = false

      if (palette && !samePalette(this.palette, palette)) {
        this.palette = palette
        this.atlas = null
      }
    }

    const palette = this.palette

    if (palette) {
      this.atlas ??= this.bakeAtlas(palette)
    }

    this.retire(
      this.ripples.filter(ring => now - ring.born >= ring.lastArrival + RIPPLE_FLASH_WINDOW_MS),
      now
    )

    context.setTransform(1, 0, 0, 1, 0, 0)
    context.globalAlpha = 1
    context.clearRect(0, 0, canvas.width, canvas.height)

    const atlas = this.atlas

    if (!palette || !atlas) {
      return this.ripples.length > 0
    }

    const { glyphs, inks, residue, ripples } = this
    const { height: cellHeight, width: cellWidth } = this.atlasCell
    const decay = traceDecay(now - this.residueAt)
    const dpr = this.dpr
    let alpha = 1
    let maxTrace = 0

    for (let row = 0; row < this.rows; row += 1) {
      const top = Math.round(row * GLYPH_CELL_HEIGHT * dpr)

      for (let column = 0; column < this.columns; column += 1) {
        const index = row * this.columns + column
        let trace = residue[index] * decay
        // Flashes overlap as light does: each covers part of what the others
        // left dark, so two together are brighter than one but never past full.
        let dark = 1

        for (const ring of ripples) {
          const since = now - ring.born - ring.arrivals[index]

          if (since <= 0) {
            continue
          }

          if (since < RIPPLE_FLASH_WINDOW_MS) {
            dark *= 1 - rippleFlash(since)
          }

          trace += rippleTrace(since)
        }

        if (trace > 1) {
          trace = 1
        }

        // What the fade has to outlast: the brightest trace that prints.
        if (trace * inks[index] > maxTrace) {
          maxTrace = trace * inks[index]
        }

        // Nothing flashing, and no stroke here to hold a trace: blank paper.
        if (dark === 1 && (trace === 0 || inks[index] === 0)) {
          continue
        }

        const paint = cellPaint(inks[index], 1 - dark, trace, palette.strength, this.paint)

        if (paint.alpha < MIN_ALPHA) {
          continue
        }

        if (paint.alpha !== alpha) {
          alpha = paint.alpha
          context.globalAlpha = alpha
        }

        context.drawImage(
          atlas,
          glyphs[index] * cellWidth,
          Math.round(paint.tint * (TINT_STEPS - 1)) * cellHeight,
          cellWidth,
          cellHeight,
          Math.round(column * GLYPH_CELL_WIDTH * dpr),
          top,
          cellWidth,
          cellHeight
        )
      }
    }

    this.maxTrace = maxTrace

    return this.ripples.length > 0
  }

  /** Back to blank paper: no rings, no trace, no fade. */
  private clear() {
    this.stop()
    this.fade?.cancel()
    this.fade = null
    this.ripples = []
    this.residue.fill(0)
    this.maxTrace = 0
    this.context?.clearRect(0, 0, this.canvas?.width ?? 0, this.canvas?.height ?? 0)
  }

  /** Drop the bitmap and the atlas; the per-cell drawing stays for the next showing. */
  private release() {
    if (this.canvas) {
      this.canvas.width = 0
      this.canvas.height = 0
    }

    this.allocated = false
    this.allocation = { height: 0, width: 0 }
    this.atlas = null
  }
}
