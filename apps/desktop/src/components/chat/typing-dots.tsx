import { cn } from '@/lib/utils'

/**
 * The reply-is-coming indicator: three small dots that rise and brighten in a
 * gentle wave, the way a message app shows the other side typing. Paints in
 * currentColor; the wave pauses with the ambient-motion gate (`live`) and
 * under reduced motion, resting as three even dots.
 */
export function TypingDots({ className, live = true }: { className?: string; live?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-flex h-4 shrink-0 items-center gap-[3px]', className)}
      data-live={live ? '' : undefined}
      data-slot="typing-dots"
    >
      <span className="typing-dot" />
      <span className="typing-dot" />
      <span className="typing-dot" />
    </span>
  )
}
