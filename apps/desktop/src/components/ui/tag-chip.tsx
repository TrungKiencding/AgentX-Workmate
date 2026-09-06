import type * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * The quiet metadata tag the store surfaces share: a category on a skill
 * detail, "Desktop / Trình duyệt" on a store card, a transport on a catalog
 * entry. A full pill on the tertiary fill at 12px, sentence case as written —
 * it labels, it never signals state (state is `StatusPill`'s job, with a dot).
 */
export function TagChip({ children, className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      className={cn(
        'inline-flex w-fit shrink-0 items-center gap-1 rounded-full bg-(--ui-bg-tertiary) px-2 py-0.5 text-xs text-(--ui-text-secondary)',
        className
      )}
      data-slot="tag-chip"
      {...props}
    >
      {children}
    </span>
  )
}
