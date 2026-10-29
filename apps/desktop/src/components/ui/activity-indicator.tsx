import { cn } from '@/lib/utils'

const SPOKES = 12

/**
 * The platform's indeterminate activity indicator: twelve rounded spokes whose
 * opacity falls off around the dial, the dial turning in twelve discrete steps
 * (`steps()`, not a smooth spin — the system indicator's own rhythm). Paints in
 * currentColor; reduced motion holds it still (the falloff alone still reads
 * as "working").
 */
export function ActivityIndicator({ className, label }: { className?: string; label?: string }) {
  return (
    <svg
      aria-hidden={label ? undefined : true}
      aria-label={label}
      className={cn('size-5 shrink-0 animate-[activity-spin_1s_steps(12)_infinite] motion-reduce:animate-none', className)}
      data-slot="activity-indicator"
      role={label ? 'img' : undefined}
      viewBox="0 0 24 24"
    >
      {Array.from({ length: SPOKES }, (_, index) => (
        <line
          key={index}
          opacity={0.15 + (0.85 * (index + 1)) / SPOKES}
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth={2}
          transform={`rotate(${index * (360 / SPOKES)} 12 12)`}
          x1={12}
          x2={12}
          y1={2.5}
          y2={7}
        />
      ))}
    </svg>
  )
}
