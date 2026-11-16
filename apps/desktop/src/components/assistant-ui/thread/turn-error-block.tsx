import { ActionBarPrimitive, useAuiState } from '@assistant-ui/react'
import { type FC, useId, useMemo, useState } from 'react'

import { TooltipIconButton } from '@/components/assistant-ui/tooltip-icon-button'
import { DetailPanel } from '@/components/detail-panel'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { AlertTriangle, ChevronRight, RefreshCw, XIcon } from '@/lib/icons'
import { describeTurnError, turnErrorDetails } from '@/lib/turn-error'
import { cn } from '@/lib/utils'

/**
 * A failed turn, said plainly (lib/turn-error.ts): what happened, what to do,
 * "Try again" only where sending it again can help, and the raw text with its
 * code folded under "Error details" for whoever has to diagnose it. Renders
 * inside MessagePrimitive.Error, so only on a message that failed.
 */
export const TurnErrorBlock: FC<{
  /** Offer "Try again" — the thread's own regenerate — when the failure allows it. */
  canRetry: boolean
  onDismiss?: () => void
}> = ({ canRetry, onDismiss }) => {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const detailsId = useId()

  const errorText = useAuiState(s =>
    s.message.status?.type === 'incomplete' && typeof s.message.status.error === 'string' ? s.message.status.error : ''
  )

  const errorCode = useAuiState(s => {
    const code = s.message.metadata?.custom?.errorCode

    return typeof code === 'string' ? code : undefined
  })

  // A thread that cannot regenerate (no reload handler) offers no retry.
  const canReload = useAuiState(s => s.thread.capabilities.reload)
  const view = useMemo(() => describeTurnError({ code: errorCode, text: errorText }, t), [errorCode, errorText, t])
  const copy = t.turnError

  return (
    <div
      className="mt-1.5 flex items-start gap-2 text-[length:var(--conversation-caption-font-size)] leading-5"
      data-error-code={view.code}
      data-slot="aui_turn-error"
      role="alert"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-(--conversation-error-text)" />
      <div className="min-w-0 flex-1">
        <p className="m-0 font-medium text-(--text-primary)">{view.title}</p>
        <p className="m-0 text-(--text-secondary)">{view.hint}</p>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          {canRetry && canReload && view.retry && (
            <ActionBarPrimitive.Reload asChild>
              <Button onClick={() => triggerHaptic('submit')} size="inline" type="button" variant="textStrong">
                <RefreshCw className="size-3.5" />
                {copy.retry}
              </Button>
            </ActionBarPrimitive.Reload>
          )}
          <Button
            aria-controls={detailsId}
            aria-expanded={open}
            onClick={() => setOpen(value => !value)}
            size="inline"
            type="button"
            variant="text"
          >
            <ChevronRight className={cn('size-3.5 transition-transform duration-(--dur-micro)', open && 'rotate-90')} />
            {copy.details}
          </Button>
        </div>
        {open && (
          <DetailPanel
            copyFailedLabel={copy.copyDetailsFailed}
            copyLabel={copy.copyDetails}
            detail={turnErrorDetails(view, errorText, copy)}
            id={detailsId}
          />
        )}
      </div>
      {onDismiss && (
        <TooltipIconButton
          className="-my-0.5 shrink-0 text-(--text-tertiary) hover:text-(--text-primary)"
          onClick={onDismiss}
          side="top"
          tooltip={t.assistant.thread.dismissError}
        >
          <XIcon className="size-3.5" />
        </TooltipIconButton>
      )}
    </div>
  )
}
