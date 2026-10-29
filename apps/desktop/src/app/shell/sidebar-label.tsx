import type * as React from 'react'

import { cn } from '@/lib/utils'

interface SidebarPanelLabelProps extends React.ComponentProps<'span'> {
  dotClassName?: string
}

export function SidebarPanelLabel({ children, className, dotClassName, ...props }: SidebarPanelLabelProps) {
  return (
    <span
      className={cn(
        // Group title (spec §5.2): text-meta in secondary ink, its own casing,
        // no tracking — a label, not a headline.
        'flex min-w-0 items-center gap-2 pl-3 text-sm text-(--text-secondary)',
        className
      )}
      {...props}
    >
      {dotClassName ? (
        <span aria-hidden="true" className={cn('inline-block size-1.5 shrink-0 rounded-full', dotClassName)} />
      ) : null}
      <span className="min-w-0 truncate leading-none">{children}</span>
    </span>
  )
}
