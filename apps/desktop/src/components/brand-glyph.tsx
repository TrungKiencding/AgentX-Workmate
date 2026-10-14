import type * as React from 'react'

import { BRAND_MARK_PATHS, BRAND_MARK_ROUTE, BRAND_MARK_VIEWBOX } from '@/lib/brand-mark-path'
import { cn } from '@/lib/utils'

/**
 * The mark as a 20px line-art glyph — the shared geometry of
 * `lib/brand-mark-path.ts`, drawn once, in `currentColor`, with a stroke that
 * does not scale. It says "AgentX is speaking" at the head of a
 * reply and anchors the `EmptyFigure` illustrations; it is not a button and
 * carries no colour of its own. For the brand *plate* (a filled tile for hero
 * and About moments) use `BrandMark` instead.
 *
 * `tracing` is the same mark waiting for a reply: it writes itself along its
 * one-stroke route over a faint copy of itself (the pen's timing lives with
 * the `brand-glyph-pen` keyframes in `styles.css`). Off, it is the plain mark,
 * so a paused wait rests as exactly the glyph that will head the reply.
 */
// `md` (20px) heads a reply and anchors the empty figures; `sm` (14px) is the
// thinking row's mark when a stall brings it back under the prose — the same
// drawing, one rung smaller.
const GLYPH_SIZE = { md: { className: 'size-5', px: 20 }, sm: { className: 'size-3.5', px: 14 } } as const

const STROKE_PX = 1.5

// The loop crosses its own box by design (the fillets extend a hair past
// 0/100); a touch of inset keeps the stroke inside the cell.
const INSET_SCALE = 0.88

interface BrandGlyphProps extends React.ComponentProps<'svg'> {
  size?: keyof typeof GLYPH_SIZE
  tracing?: boolean
}

export function BrandGlyph({ className, size = 'md', tracing = false, ...props }: BrandGlyphProps) {
  return (
    <svg
      aria-hidden="true"
      className={cn(GLYPH_SIZE[size].className, 'shrink-0', className)}
      data-slot="brand-glyph"
      data-tracing={tracing ? '' : undefined}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={tracing ? (STROKE_PX * 100) / (GLYPH_SIZE[size].px * INSET_SCALE) : STROKE_PX}
      viewBox={BRAND_MARK_VIEWBOX}
      {...props}
    >
      <g transform={`translate(6 6) scale(${INSET_SCALE})`}>
        {tracing ? (
          // A dash is measured along the path in the path's own units, which a
          // non-scaling stroke would put in screen pixels — so while tracing,
          // the hairline is the same 1.5px expressed in the mark's units.
          <>
            <g data-slot="brand-glyph-ghost">
              {BRAND_MARK_PATHS.map(d => (
                <path d={d} key={d} />
              ))}
            </g>
            <path d={BRAND_MARK_ROUTE} data-slot="brand-glyph-ink" pathLength={1} />
          </>
        ) : (
          BRAND_MARK_PATHS.map(d => <path d={d} key={d} vectorEffect="non-scaling-stroke" />)
        )}
      </g>
    </svg>
  )
}
