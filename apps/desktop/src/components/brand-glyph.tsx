import type * as React from 'react'

import { BRAND_MARK_PATHS, BRAND_MARK_VIEWBOX } from '@/lib/brand-mark-path'
import { cn } from '@/lib/utils'

/**
 * The mark as a 20px line-art glyph — the shared geometry of
 * `lib/brand-mark-path.ts`, drawn once, in `currentColor`, with a stroke that
 * does not scale. It says "AgentX is speaking" at the head of a
 * reply and anchors the `EmptyFigure` illustrations; it is not a button and
 * carries no colour of its own. For the brand *plate* (a filled tile for hero
 * and About moments) use `BrandMark` instead.
 */
// `md` (20px) anchors the empty figures and the connect screen; `sm` (14px)
// is the same drawing one rung smaller.
const GLYPH_SIZE = { md: { className: 'size-5', px: 20 }, sm: { className: 'size-3.5', px: 14 } } as const

const STROKE_PX = 1.5

// The loop crosses its own box by design (the fillets extend a hair past
// 0/100); a touch of inset keeps the stroke inside the cell.
const INSET_SCALE = 0.88

interface BrandGlyphProps extends React.ComponentProps<'svg'> {
  size?: keyof typeof GLYPH_SIZE
}

export function BrandGlyph({ className, size = 'md', ...props }: BrandGlyphProps) {
  return (
    <svg
      aria-hidden="true"
      className={cn(GLYPH_SIZE[size].className, 'shrink-0', className)}
      data-slot="brand-glyph"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={STROKE_PX}
      viewBox={BRAND_MARK_VIEWBOX}
      {...props}
    >
      <g transform={`translate(6 6) scale(${INSET_SCALE})`}>
        {BRAND_MARK_PATHS.map(d => (
          <path d={d} key={d} vectorEffect="non-scaling-stroke" />
        ))}
      </g>
    </svg>
  )
}
