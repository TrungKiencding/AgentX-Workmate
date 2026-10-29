import { cn } from '@/lib/utils'

/**
 * The composer surface and everything docked to it paint ONE shared
 * `--composer-fill` var. The composer's state ladder (rest / scrolled) lives
 * in styles.css on `[data-slot='composer-root']`; anything painted outside that
 * root — the status stack above it — gets the opaque `:root` value instead.
 */
export const composerFill = 'bg-(--composer-fill)'

/** Surface transition for the composer and the cards docked to it. Flat by
 *  design (spec §1): no backdrop blur — the fill is opaque. */
export const composerSurfaceGlass = 'transition-[background-color] duration-(--dur-micro) ease-out'

const composerDockEdge = (edge: 'bottom' | 'top') =>
  cn('border border-(--border-default)', edge === 'top' ? 'rounded-t-xl border-b-0' : 'rounded-b-xl border-t-0')

/** Glassy docked card — the status stack / queue above the composer. It sits
 *  outside `composer-root`, so its `--composer-fill` is the opaque `:root`
 *  value: the card stays solid while the thread scrolls under it, and live
 *  status never has the transcript showing through it. */
export const composerDockCard = (edge: 'bottom' | 'top' = 'top') =>
  cn(composerDockEdge(edge), composerFill, composerSurfaceGlass)

/** Floating composer panel skin — the `/`·`@`·`?` completion drawer and the
 *  attach (`+`) menu. The level-1 popover surface (spec §5.11): --bg-raised
 *  under shadow-md, 12px corners, meta-size type. Uses an explicit fill (not
 *  `--composer-fill`) so it renders identically whether mounted inside the
 *  composer or portaled out of it. Visual skin only — consumers add their own
 *  size/position/padding. */
export const composerPanelCard = 'rounded-lg bg-(--bg-raised) text-sm shadow-md'

/**
 * A quiet control floating over composer content — the micro-action pills above
 * the surface, the Open affordance on a hovered link inside it. Full radius,
 * hairline border, the composer's own fill behind a blur so the text underneath
 * never shows through. Sized against the composer's control height so a pill
 * lines up with the chrome it floats above.
 *
 * Skin and size only; the call site owns position, width caps, and disabled
 * state.
 */
export const composerFloatingPill = cn(
  'inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-2.5',
  'border border-(--border-default) bg-(--bg-app)',
  'text-sm font-normal text-(--text-secondary) transition-colors duration-(--dur-micro)',
  'hover:bg-(--bg-hover) hover:text-(--text-primary)'
)

/**
 * Shared grid for the chrome-free floating strips that bracket the composer —
 * the micro-action pills above the surface and the `composer.underside` slot
 * below it.
 *
 * Both are in-flow children of the composer DOCK, siblings of the composer
 * itself rather than children of it. That's deliberate: the pop-out drag
 * region is `absolute inset-0` inside the composer, so anything rendered in
 * there is inside the grab area by construction. Living outside makes that
 * impossible instead of something the gesture has to exclude.
 *
 * One parent and one constant means the two strips share a left edge without
 * anyone matching numbers across files. Vertical spacing stays at the call
 * site; the horizontal inset matches the composer's 5px grab margin so the
 * strips line up with the surface rather than the margin's outer edge.
 */
export const composerFloatingStrip = 'flex flex-wrap items-center gap-1.5'
