import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'

import { ActionStatus } from '@/components/ui/action-status'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useI18n } from '@/i18n'
import { AlertTriangle } from '@/lib/icons'

interface ConfirmDialogProps {
  open: boolean
  onClose: () => void
  // Does the work. Throw to surface an inline error and keep the dialog open.
  onConfirm: () => Promise<void> | void
  title: ReactNode
  description?: ReactNode
  confirmLabel?: string
  busyLabel?: string
  doneLabel?: string
  cancelLabel?: string
  destructive?: boolean
  /** Close as soon as onConfirm resolves — for optimistic actions that finish in the background. */
  dismissOnConfirm?: boolean
}

// Shared confirmation dialog: Enter confirms from the dialog background.
// Focused controls own their keys, including Cancel and the rotation checkbox.
// Esc/Cancel/backdrop dismiss. Owns the pending → done → close beat and inline
// error, so callers pass only an async onConfirm that does the work.
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel,
  busyLabel,
  doneLabel,
  cancelLabel,
  destructive = false,
  dismissOnConfirm = false
}: ConfirmDialogProps) {
  const { t } = useI18n()
  const [status, setStatus] = useState<'done' | 'idle' | 'saving'>('idle')
  const [error, setError] = useState<null | string>(null)
  const closeTimer = useRef<number | null>(null)
  const pending = useRef<AbortController | null>(null)
  const busy = status === 'saving' || status === 'done'
  const resolvedConfirmLabel = confirmLabel ?? t.common.confirm
  const resolvedBusyLabel = busyLabel ?? t.common.loading
  const resolvedDoneLabel = doneLabel ?? t.common.done
  const resolvedCancelLabel = cancelLabel ?? t.common.cancel

  useEffect(() => {
    if (open) {
      setStatus('idle')
      setError(null)
    }

    return () => {
      pending.current?.abort()

      if (closeTimer.current !== null) {
        window.clearTimeout(closeTimer.current)
      }
    }
  }, [open])

  async function run() {
    if (busy || (pending.current && !pending.current.signal.aborted)) {
      return
    }

    setError(null)
    const request = new AbortController()

    pending.current = request

    if (dismissOnConfirm) {
      try {
        await onConfirm()

        if (!request.signal.aborted) {
          onClose()
        }
      } catch (err) {
        if (!request.signal.aborted) {
          setError(err instanceof Error ? err.message : t.errors.genericFailure)
        }
      } finally {
        if (pending.current === request) {
          pending.current = null
        }
      }

      return
    }

    setStatus('saving')

    try {
      await onConfirm()

      if (request.signal.aborted) {
        return
      }

      setStatus('done')
      closeTimer.current = window.setTimeout(onClose, 600)
    } catch (err) {
      if (!request.signal.aborted) {
        setStatus('idle')
        setError(err instanceof Error ? err.message : t.errors.genericFailure)
      }
    } finally {
      if (pending.current === request) {
        pending.current = null
      }
    }
  }

  return (
    <Dialog onOpenChange={value => !value && !busy && onClose()} open={open}>
      <DialogContent
        className="max-w-md"
        onKeyDown={event => {
          const target = event.target as HTMLElement

          if (
            target.closest(
              'button, input, textarea, select, a, [role="checkbox"], [role="switch"], [contenteditable="true"]'
            )
          ) {
            return
          }

          if (event.key === 'Enter' && !busy) {
            event.preventDefault()
            void run()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <DialogFooter>
          <Button disabled={busy} onClick={onClose} type="button" variant="ghost">
            {resolvedCancelLabel}
          </Button>
          <Button disabled={busy} onClick={() => void run()} variant={destructive ? 'destructive' : 'default'}>
            <ActionStatus
              busy={resolvedBusyLabel}
              done={resolvedDoneLabel}
              idle={resolvedConfirmLabel}
              state={status}
            />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
