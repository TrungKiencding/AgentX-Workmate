import type * as React from 'react'

import { BRAND_MARK_PATHS, BRAND_MARK_VIEWBOX } from '@/lib/brand-mark-path'
import { cn } from '@/lib/utils'

/**
 * The mark as a 20px line-art glyph — the same geometry the chat watermark
 * tiles (`lib/brand-mark-path.ts`), drawn once, in `currentColor`, with a
 * stroke that does not scale. It says "AgentX is speaking" at the head of a
 * reply and anchors the `EmptyFigure` illustrations; it is not a button and
 * carries no colour of its own. For the brand *plate* (a filled tile for hero
 * and About moments) use `BrandMark` instead.
 */
// `md` (20px) heads a reply and anchors the empty figures; `sm` (14px) is the
// thinking row's mark beside the timer — the same drawing, one rung smaller.
const GLYPH_SIZE = { md: 'size-5', sm: 'size-3.5' } as const

interface BrandGlyphProps extends React.ComponentProps<'svg'> {
  size?: keyof typeof GLYPH_SIZE
}

export function BrandGlyph({ className, size = 'md', ...props }: BrandGlyphProps) {
  return (
    <svg
      aria-hidden="true"
      className={cn(GLYPH_SIZE[size], 'shrink-0', className)}
      data-slot="brand-glyph"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.5}
      viewBox={BRAND_MARK_VIEWBOX}
      {...props}
    >
      {/* The loop crosses its own box by design (the fillets extend a hair past
          0/100); a touch of inset keeps the stroke inside the 20px cell. */}
      <g transform="translate(6 6) scale(0.88)">
        {BRAND_MARK_PATHS.map(d => (
          <path d={d} key={d} vectorEffect="non-scaling-stroke" />
        ))}
      </g>
    </svg>
  )
}
