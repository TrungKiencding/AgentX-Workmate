import { useStore } from '@nanostores/react'
import { useRef } from 'react'

import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { ArrowDown } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { $approvalRequest } from '@/store/prompts'
import { $threadJumpButtonVisible, requestScrollToBottom } from '@/store/thread-scroll'

/**
 * Floating "jump to bottom" control. Sits centered just above the composer,
 * clearing the out-of-flow status stack via the same measured-height CSS vars
 * the thread's bottom clearance uses (`--composer-measured-height`, which
 * covers the whole dock), so it never overlaps the queue / subagent
 * / background cards. Visible only while the user has scrolled meaningfully
 * away from the bottom; clicking re-arms sticky-bottom and pins the viewport.
 *
 * When the turn is BLOCKED on an approval, this same control morphs into an
 * "Approval needed" pill — the only response surface is the inline Run/Reject
 * bar on the parked tool row, which is always the bottom-most content, so the
 * existing scroll-to-bottom action lands the user right on it. One control, no
 * collision, no second scroll path (native scrollIntoView would scroll
 * overflow:hidden ancestors that can't scroll back and wreck the layout).
 *
 * Enter/exit motion lives in styles.css under `.thread-jump-button` — a
 * directional scale (contract in from 1.1, contract out to 0.9) keyed off
 * `data-state`. `idle` (never-shown) stays silent so it can't flash on mount;
 * `in`/`out` only swap once it has actually appeared.
 */
export function ScrollToBottomButton() {
  const { t } = useI18n()
  const visible = useStore($threadJumpButtonVisible)
  const request = useStore($approvalRequest)
  // Scrolled away while an approval is pending → the inline Run/Reject bar is
  // below the fold. Relabel so the user knows the session needs them, not just
  // that there's more to read.
  const approval = visible && Boolean(request)
  const hasShownRef = useRef(false)

  if (visible) {
    hasShownRef.current = true
  }

  const state = visible ? 'in' : hasShownRef.current ? 'out' : 'idle'
  const label = approval ? t.assistant.approval.jumpToApproval : t.assistant.thread.scrollToBottom
  // The pill names where it goes (spec §6.5 "↓ Mới nhất"); the approval case
  // names why the session needs you instead.
  const text = approval ? label : t.assistant.thread.jumpToLatest

  return (
    <button
      aria-hidden={!visible}
      aria-label={label}
      className={cn(
        // A level-1 pill (spec §6.5), centred 12px above the composer.
        'thread-jump-button absolute left-1/2 z-20 grid h-8 grid-flow-col place-items-center gap-1.5 rounded-full bg-(--bg-raised) px-3 text-sm shadow-md transition-colors duration-(--dur-micro)',
        approval
          ? 'text-(--accent) hover:text-(--accent-hover)'
          : 'text-(--text-secondary) hover:text-(--text-primary)',
        !visible && 'pointer-events-none'
      )}
      data-state={state}
      onClick={() => {
        triggerHaptic('selection')
        requestScrollToBottom()
      }}
      style={{
        bottom: 'calc(var(--composer-measured-height) + 0.75rem)'
      }}
      tabIndex={visible ? 0 : -1}
      type="button"
    >
      <ArrowDown className="size-4" />
      <span>{text}</span>
    </button>
  )
}
