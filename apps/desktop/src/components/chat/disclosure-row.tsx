import type { ReactNode } from 'react'

import { DisclosureCaret } from '@/components/ui/disclosure-caret'
import { cn } from '@/lib/utils'

// Shared header row for any collapsible block (thinking, tool group, single
// tool). Each parent supplies its own outer wrapper (with the data-slot CSS
// uses to escape the message padding) and its own expanded body.
//
// Affordance:
//   - No leading chevron; a caret appears to the RIGHT of the text on hover
//     (and stays visible when the row is open).
//   - The hover background is a tight content-shaped pill — sized to the
//     title text, NOT the full row — and reaches just past the chevron with
//     `-mx-1.5 px-1.5` so it reads as a soft hit-target rather than a slab
//     stretching to the message edge.
//   - `trailing` is the far-right, non-interactive slot (a duration timer). It
//     lays out *in flow*, not as an overlay: an overlay reserved no room, so a
//     long title ran underneath the timer ("…webmate 34s" printed on top of the
//     label). In flow, the title column shrinks and truncates first and the
//     timer keeps its width. It is `pointer-events-none` so it can never steal
//     a click from the caret. Interactive controls go in `action`, which sits
//     in the same right-hand group so it never covers the caret's hit-target,
//     no matter how long the title is.
export function DisclosureRow({
  action,
  children,
  onToggle,
  open,
  trailing
}: {
  action?: ReactNode
  children: ReactNode
  onToggle?: () => void
  open: boolean
  trailing?: ReactNode
}) {
  return (
    <div className="group/disclosure-row flex w-full max-w-full min-w-0 text-(--ui-text-tertiary)">
      <button
        aria-expanded={onToggle ? open : undefined}
        className={cn(
          // max-w-fit so the click target hugs the title text width — no
          // background fill, just the cursor + the affordance caret.
          'flex min-w-0 max-w-fit items-start gap-1.5 text-left transition-colors',
          onToggle ? 'hover:text-foreground focus-visible:text-foreground focus-visible:outline-none' : 'cursor-default'
        )}
        disabled={!onToggle}
        onClick={onToggle}
        type="button"
      >
        <span className="flex min-w-0 flex-col gap-0.5">{children}</span>
        {onToggle && (
          // Wrapper height matches the title row's actual line-height so the
          // caret centres with the title, not the whole subtitle stack.
          <span
            className={cn(
              'flex h-(--conversation-line-height) shrink-0 items-center justify-center transition-opacity duration-(--dur-short-exit)',
              open
                ? 'opacity-80'
                : 'opacity-(--disclosure-caret-rest) group-hover/disclosure-row:opacity-80 group-focus-within/disclosure-row:opacity-80'
            )}
          >
            <DisclosureCaret open={open} />
          </span>
        )}
      </button>
      {(trailing || action) && (
        <span className="ml-auto flex h-(--conversation-line-height) shrink-0 items-center gap-1.5 self-start pl-2">
          {trailing && <span className="pointer-events-none flex items-center pr-1">{trailing}</span>}
          {action}
        </span>
      )}
    </div>
  )
}
