import type * as React from 'react'

import type { IconComponent } from '@/lib/icons'
import { cn } from '@/lib/utils'

export interface SegmentedControlOption<T extends string> {
  id: T
  label: string
  icon?: IconComponent
}

interface SegmentedControlProps<T extends string> extends Omit<React.ComponentProps<'div'>, 'onChange'> {
  options: readonly SegmentedControlOption<T>[]
  value: T
  onChange: (id: T) => void
  className?: string
  /** Dims the whole track and blocks selection (e.g. gated behind a prerequisite). */
  disabled?: boolean
  /**
   * `sm` (default) — 28px track, 12px labels: the in-form choice.
   * `md` — 32px track, 13px labels: a view switch inside one page tab (the
   * store's Kỹ năng · MCP), which has to read as a switch at a glance without
   * becoming a second page-tab row.
   */
  size?: 'md' | 'sm'
}

const SIZES = {
  sm: { option: 'h-6 gap-1 px-2.5 text-xs', icon: 'size-3' },
  md: { option: 'h-7 gap-1.5 px-3 text-sm', icon: 'size-3.5' }
} as const

/**
 * Grouped one-row toggle used for small mutually-exclusive choices
 * (color mode, tool-call display, usage period, etc.). Flat by design —
 * no per-option borders, just a tinted track with a raised active pill.
 */
export function SegmentedControl<T extends string>({
  className,
  disabled = false,
  onChange,
  options,
  size = 'sm',
  value,
  ...props
}: SegmentedControlProps<T>) {
  const metrics = SIZES[size]

  return (
    <div
      className={cn(
        // Options sit inside the 2px track pad — `sm` lands on --control-h-sm
        // (28px), matching buttons/inputs on the row; `md` on --control-h-md.
        'inline-grid w-fit auto-cols-fr grid-flow-col gap-0.5 rounded-(--radius-control) bg-(--ui-bg-tertiary) p-0.5',
        disabled && 'opacity-50',
        className
      )}
      role="group"
      {...props}
    >
      {options.map(({ id, label, icon: Icon }) => {
        const active = value === id

        return (
          <button
            aria-pressed={active}
            className={cn(
              'flex items-center justify-center rounded-[calc(var(--radius-control)-0.125rem)] font-medium transition-colors disabled:cursor-default',
              metrics.option,
              active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            )}
            data-active={active}
            disabled={disabled}
            key={id}
            onClick={() => onChange(id)}
            type="button"
          >
            {Icon && <Icon className={metrics.icon} />}
            {label}
          </button>
        )
      })}
    </div>
  )
}
