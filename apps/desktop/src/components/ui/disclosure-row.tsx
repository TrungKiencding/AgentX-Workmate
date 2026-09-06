import type { ReactNode } from 'react'

import { ChevronRight } from '@/lib/icons'
import { cn } from '@/lib/utils'

/**
 * The page-chrome disclosure: one sentence-case 13px row that folds a quieter
 * section away — "Chi tiết kỹ thuật", "Nâng cao (3)", "Xem thêm 8 nền tảng".
 * A Tabler caret (page chrome never draws Codicon) rotates in place; only the
 * caret's transform animates, and the label is a sentence, never a tracked-out
 * stamp. Content visibility is the caller's: render children under it when
 * `open`. The transcript's own disclosure caret (`DisclosureCaret`) stays the
 * tool-row treatment — this one is for pages.
 */
export function DisclosureRow({
  children,
  className,
  onToggle,
  open
}: {
  children: ReactNode
  className?: string
  onToggle: () => void
  open: boolean
}) {
  return (
    <button
      aria-expanded={open}
      className={cn(
        'flex w-full cursor-pointer items-center gap-1.5 py-1 text-left text-sm font-medium text-(--ui-text-secondary) transition-colors duration-(--dur-micro) hover:text-foreground',
        className
      )}
      onClick={onToggle}
      type="button"
    >
      <ChevronRight
        aria-hidden
        className={cn('size-3.5 shrink-0 transition-transform duration-(--dur-short-exit)', open && 'rotate-90')}
      />
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  )
}
