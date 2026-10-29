import { useRef } from 'react'

import type { DragKind } from '@/app/chat/hooks/use-file-drop-zone'
import { DROP_SHEET_CLASS } from '@/components/ui/drop-affordance'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

/**
 * Full-bleed affordance shown while files or a session are dragged over the chat
 * area. Always `pointer-events-none` so the drop lands on the real element
 * underneath and the drop-zone handler claims it — the overlay is purely visual.
 * The label names the outcome (attach files / link this chat); the last kind is
 * held through the fade-out so it doesn't blank.
 */
export function ChatDropOverlay({ kind }: { kind: DragKind }) {
  const { t } = useI18n()
  const lastKind = useRef<DragKind>(kind)

  if (kind) {
    lastKind.current = kind
  }

  const shown = kind ?? lastKind.current

  return (
    <div
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-0 z-40 flex items-center justify-center transition-opacity duration-(--dur-short-exit) ease-out',
        kind ? 'opacity-100' : 'opacity-0'
      )}
      data-slot="chat-drop-overlay"
    >
      <div
        className={cn(DROP_SHEET_CLASS, 'absolute inset-2 opacity-95')}
      />
      {shown && (
        <span className="relative text-base text-(--text-secondary)">
          {shown === 'session' ? t.composer.dropSession : t.composer.dropFiles}
        </span>
      )}
    </div>
  )
}
