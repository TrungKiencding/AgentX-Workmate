import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * The one status badge (spec §5.14): a 6px dot in the signal colour and a word
 * in secondary ink — never a coloured fill. The dot carries the hue, the word
 * carries the meaning, so a status never rests on colour alone.
 *
 * Every tone paints its dot from the semantic tokens (`--ui-green / -yellow /
 * -red`, `--ui-info` for "in progress", the tertiary ink for a resting state),
 * so it follows the skin instead of shipping a Tailwind ramp.
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
  'inline-flex w-fit shrink-0 items-center gap-1.5 leading-none whitespace-nowrap text-(--text-secondary)',
  {
    variants: {
      size: {
        sm: 'h-(--status-pill-h-sm) text-xs',
        md: 'h-(--status-pill-h-md) text-sm'
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
