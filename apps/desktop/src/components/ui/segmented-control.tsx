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
   * `sm` (default) — 28px track: the in-form choice.
   * `md` — 32px track with 28px segments (spec §5.4): a view switch inside one page tab (the
   * store's Kỹ năng · MCP), which has to read as a switch at a glance without
   * becoming a second page-tab row.
   */
  size?: 'md' | 'sm'
}

const SIZES = {
  sm: { option: 'h-6 gap-1.5 px-2.5 text-sm', icon: 'size-3.5' },
  md: { option: 'h-7 min-w-8 gap-1.5 px-2.5 text-sm', icon: 'size-4' }
} as const

/**
 * Segmented control (spec §5.4) for 2–4 mutually-exclusive choices (colour
 * mode, tool-call display, usage period…); five or more belong in a dropdown.
 * A --bg-subtle track with a 2px pad; the active segment is the page colour
 * edged by --border-default (dark: --bg-selected, no edge).
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
        'inline-grid w-fit auto-cols-fr grid-flow-col gap-0.5 rounded-(--radius-control) bg-(--bg-subtle) p-0.5',
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
              'flex items-center justify-center rounded-sm transition-colors duration-(--dur-micro) disabled:cursor-default',
              metrics.option,
              active
                ? 'bg-(--bg-app) text-(--text-primary) shadow-sm dark:bg-(--bg-selected) dark:shadow-none'
                : 'text-(--text-secondary) hover:text-(--text-primary)'
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
