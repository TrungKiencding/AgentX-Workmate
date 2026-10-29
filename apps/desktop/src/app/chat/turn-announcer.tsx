import { useState } from 'react'

import { useI18n } from '@/i18n'

/**
 * Screen-reader announcement for a finished turn (Quiet Tool spec §10): the
 * transcript itself is never a live region — reading every streamed token
 * aloud is noise — so this one polite status line speaks once when the
 * foreground turn ends, and clears when the next one starts so the same words
 * are announced again next time.
 */
export function TurnDoneAnnouncer({ busy }: { busy: boolean }) {
  const { t } = useI18n()
  const [previousBusy, setPreviousBusy] = useState(busy)
  const [message, setMessage] = useState('')

  // Derived during render (no effect): React re-renders with the new state
  // before committing, so the announcement lands in the same frame.
  if (busy !== previousBusy) {
    setPreviousBusy(busy)
    setMessage(busy ? '' : t.assistant.thread.turnDone)
  }

  return (
    <div aria-live="polite" className="sr-only" data-slot="turn-done-announcer" role="status">
      {message}
    </div>
  )
}
