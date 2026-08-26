import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

// Canonical centered empty state. Three beats, always in this order: the NAME of
// what is missing (14px medium), WHY it is missing (13px muted), and one action
// that fixes it. Pass `action` a single Button — the caller owns the verb.
//
// The default for "no results / nothing here yet" page bodies. For richer
// master-detail lists that want a leading icon, use PanelEmpty (overlays/panel),
// which renders the same three beats; the file-tree's inline uppercase error
// state is its own deliberately-distinct treatment.
export function EmptyState({
  action,
  title,
  description,
  className
}: {
  /** One action that resolves the emptiness — a Button, labelled with a verb. */
  action?: ReactNode
  title: string
  description?: string
  className?: string
}) {
  return (
    <div className={cn('grid min-h-48 place-items-center text-center', className)}>
      <div className="flex flex-col items-center gap-2">
        <div className="text-base font-medium text-foreground">{title}</div>
        {description && <div className="max-w-sm text-sm text-(--ui-text-tertiary)">{description}</div>}
        {action && <div className="mt-2">{action}</div>}
      </div>
    </div>
  )
}
