import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * The one status pill: a dot and a word, in a soft tint of the tone colour.
 *
 * Every tone paints from the semantic tokens (`--ui-green / -yellow / -red`,
 * `--ui-info` for "in progress", the tertiary ink for a resting state), so a
 * pill follows the skin instead of shipping a Tailwind ramp that never moves
 * with the theme. The fill is a soft tint of the tone (`--status-pill-tint`);
 * the label is the tone pulled toward the page ink (`--status-pill-ink`) so it
 * clears 4.5:1 on that tint on every preset — `check-theme-contrast.mjs`
 * measures exactly this pair — while the dot keeps the pure hue. The dot is
 * always there: a status is a glyph *and* a colour, never a hue alone.
 *
 * `sm` (24px, 12px text) sits beside a row title; `md` (28px, 13px) rides the
 * small control height so it lines up with a `size="sm"` button on the same
 * line. The label is the child; keep it to a word or two.
 */
export type StatusPillTone = 'bad' | 'good' | 'info' | 'muted' | 'warn'

const TONE_COLOR: Record<StatusPillTone, string> = {
  bad: 'var(--ui-red)',
  good: 'var(--ui-green)',
  info: 'var(--ui-info)',
  muted: 'var(--ui-text-tertiary)',
  warn: 'var(--ui-yellow)'
}

const statusPillVariants = cva(
  'inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full font-medium leading-none whitespace-nowrap text-[color-mix(in_srgb,var(--status-pill-color)_var(--status-pill-ink),var(--dt-foreground))] [background:color-mix(in_srgb,var(--status-pill-color)_var(--status-pill-tint),transparent)]',
  {
    variants: {
      size: {
        sm: 'h-(--status-pill-h-sm) px-2 text-xs',
        md: 'h-(--status-pill-h-md) px-2.5 text-sm'
      }
    },
    defaultVariants: { size: 'sm' }
  }
)

export interface StatusPillProps extends React.ComponentProps<'span'>, VariantProps<typeof statusPillVariants> {
  tone: StatusPillTone
}

export function StatusPill({ children, className, size, style, tone, ...props }: StatusPillProps) {
  return (
    <span
      className={cn(statusPillVariants({ size }), className)}
      data-slot="status-pill"
      data-tone={tone}
      style={{ '--status-pill-color': TONE_COLOR[tone], ...style } as React.CSSProperties}
      {...props}
    >
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-(--status-pill-color)" />
      {children}
    </span>
  )
}

export { statusPillVariants }
