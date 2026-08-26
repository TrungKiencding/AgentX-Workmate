import type { ReactNode } from 'react'

import { DisclosureRow } from '@/components/chat/disclosure-row'

/**
 * Transcript scaffolding: the quiet lines around the reply that say what the
 * agent did rather than what it said — a thinking header, a settled tool run,
 * the live activity ticker.
 *
 * They all render through here so they cannot drift apart. They used to each
 * pick their own grey — a thinking header painted `--ui-text-secondary`, a tool
 * summary `--ui-text-tertiary`, both under the same opacity — which read as two
 * different kinds of line for what is one kind of thing.
 *
 * The resting fade is the other half and lives in CSS, on the *block* that
 * holds the row rather than on the row: mark it `data-conversation-scaffold`.
 * A surface that skips the mark reads a shade brighter than its neighbours.
 */
export const SCAFFOLD_LABEL_CLASS =
  'text-[length:var(--conversation-caption-font-size)] font-medium leading-(--conversation-line-height) text-(--conversation-scaffold-text)'

/** Durations, counts and diff stats trailing a scaffold label. Sits at the
 *  type ramp's floor (11px) — a step behind the label it trails, never below
 *  what the ramp allows. */
export const SCAFFOLD_META_CLASS = 'shrink-0 text-2xs tabular-nums text-(--conversation-scaffold-meta)'

/**
 * One scaffold line. `children` is the label and whatever trails it in flow
 * (meta, diff counts); `trailing` overlays the right edge for a live timer.
 */
export function ScaffoldRow({
  children,
  onToggle,
  open = false,
  trailing
}: {
  children: ReactNode
  onToggle?: () => void
  open?: boolean
  trailing?: ReactNode
}) {
  return (
    <DisclosureRow onToggle={onToggle} open={open} trailing={trailing}>
      <span className="flex min-w-0 items-center gap-1.5">{children}</span>
    </DisclosureRow>
  )
}
