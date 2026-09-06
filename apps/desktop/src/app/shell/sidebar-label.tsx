import type * as React from 'react'

import { cn } from '@/lib/utils'

interface SidebarPanelLabelProps extends React.ComponentProps<'span'> {
  dotClassName?: string
}

export function SidebarPanelLabel({ children, className, dotClassName, ...props }: SidebarPanelLabelProps) {
  return (
    <span
      className={cn(
        // A label, not a headline, and a sentence, not a stamp: 12px semibold
        // in the recessive tertiary ink, its own casing, no tracking. Visible
        // enough to group the rows beneath it, quiet enough that the rows stay
        // the thing you read — and readable by someone who has never seen a
        // tracked-out uppercase caption in a code editor.
        'flex min-w-0 items-center gap-2 pl-2 text-xs font-semibold text-(--ui-text-tertiary)',
        className
      )}
      {...props}
    >
      <span aria-hidden="true" className={cn('dither inline-block size-2 shrink-0 rounded-[1px]', dotClassName)} />
      <span className="min-w-0 truncate leading-none">{children}</span>
    </span>
  )
}
