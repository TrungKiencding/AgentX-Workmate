import * as React from 'react'

import { cn } from '@/lib/utils'

// In-pane text tab (spec §5.18): 13px secondary ink; the current tab reads in
// primary ink over a 2px underline (an inset shadow, so it costs no layout).
// The host row draws the --border-subtle divider beneath the tabs.
function TextTabMeta({ className, ...props }: React.ComponentProps<'span'>) {
  return <span className={cn('text-xs tabular-nums text-(--text-tertiary)', className)} {...props} />
}

interface TextTabProps extends React.ComponentProps<'button'> {
  active?: boolean
}

function TextTab({ active = false, children, className, type = 'button', ...props }: TextTabProps) {
  return (
    <button
      className={cn(
        'inline-flex h-9 items-center gap-1.5 bg-transparent px-0.5 text-sm text-(--text-secondary) transition-colors duration-(--dur-micro) hover:text-(--text-primary) disabled:pointer-events-none disabled:text-(--text-disabled)',
        active && 'text-(--text-primary) shadow-[inset_0_-2px_0_var(--text-primary)]',
        className
      )}
      data-active={active}
      type={type}
      {...props}
    >
      {children}
    </button>
  )
}

export { TextTab, TextTabMeta }
