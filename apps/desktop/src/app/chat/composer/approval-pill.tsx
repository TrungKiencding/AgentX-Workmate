import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { useGatewayRequest } from '@/app/gateway/hooks/use-gateway-request'
import { ApprovalModeOptions } from '@/app/shell/approval-mode-menu'
import { composerUndersideControl } from '@/components/chat/composer-dock'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { releaseTypingFocus } from '@/components/ui/keyboard-first'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { ShieldCheck, ZapFilled } from '@/lib/icons'
import { cn } from '@/lib/utils'
import {
  $approvalModes,
  type ApprovalMode,
  setApprovalModeForProfile,
  syncApprovalModeForProfile
} from '@/store/approval-mode'
import { notifyError } from '@/store/notifications'
import { $activeGatewayProfile } from '@/store/profile'
import { $gatewayState } from '@/store/session'

// May shrink: in a narrow pane the label gives way before the model's name.
const TRIGGER = cn(composerUndersideControl, 'min-w-0 max-w-56 shrink')

/**
 * How much AgentX asks before it acts, in the strip under the composer.
 *
 * The three modes (ask every time / decide on its own when safe / never ask)
 * have existed for a while, but the only control for them was a status-bar
 * item — and the status bar is off by default — or a raw `manual / smart /
 * off` select in Settings. People who wanted AgentX to keep working while
 * they were away from the machine could not find it (pilot feedback
 * 2026-11-10). It sits beside the model because it is the same kind of fact:
 * how this assistant runs, right now.
 *
 * "Never ask" is confirmed before it is switched on: it removes the one check
 * between a prompt and a shell command.
 */
export function ApprovalPill({ disabled = false }: { disabled?: boolean }) {
  const { t } = useI18n()
  const copy = t.shell.approvalMode
  const { requestGateway } = useGatewayRequest()
  const profile = useStore($activeGatewayProfile)
  const gatewayState = useStore($gatewayState)
  const modes = useStore($approvalModes)
  const mode = modes[profile.trim() || 'default'] ?? 'smart'
  const [open, setOpen] = useState(false)
  const [confirmingOff, setConfirmingOff] = useState(false)

  useEffect(() => {
    if (gatewayState !== 'open') {
      return
    }

    void syncApprovalModeForProfile(requestGateway, profile).catch(() => undefined)
  }, [gatewayState, profile, requestGateway])

  const apply = (next: ApprovalMode) => setApprovalModeForProfile(requestGateway, profile, next).then(() => undefined)

  const select = (next: ApprovalMode) => {
    setOpen(false)

    if (next === mode) {
      return
    }

    if (next === 'off') {
      setConfirmingOff(true)

      return
    }

    void apply(next).catch(error => notifyError(error, copy.changeFailed))
  }

  const labels: Record<ApprovalMode, string> = { manual: copy.manual, off: copy.off, smart: copy.smart }
  const title = copy.ariaLabel(labels[mode])

  return (
    <>
      <DropdownMenu
        onOpenChange={next => {
          setOpen(next)

          if (!next) {
            // Radix returns focus to this button; let typing reach the composer.
            releaseTypingFocus()
          }
        }}
        open={open}
      >
        <Tip label={title} side="top">
          <DropdownMenuTrigger asChild>
            <Button
              aria-label={title}
              className={TRIGGER}
              data-approval-mode={mode}
              disabled={disabled || gatewayState !== 'open'}
              type="button"
              variant="ghost"
            >
              {mode === 'off' ? (
                <ZapFilled className="size-3.5 shrink-0 text-(--ui-accent)" />
              ) : (
                <ShieldCheck className="size-3.5 shrink-0 opacity-70" />
              )}
              <span className="min-w-0 truncate">{labels[mode]}</span>
            </Button>
          </DropdownMenuTrigger>
        </Tip>
        <DropdownMenuContent align="end" className="w-72 p-1" side="top" sideOffset={8}>
          <ApprovalModeOptions mode={mode} onSelect={select} />
        </DropdownMenuContent>
      </DropdownMenu>

      <ConfirmDialog
        confirmLabel={copy.confirmOffAction}
        description={copy.confirmOffBody}
        destructive
        dismissOnConfirm
        onClose={() => setConfirmingOff(false)}
        onConfirm={() => apply('off')}
        open={confirmingOff}
        title={copy.confirmOffTitle}
      />
    </>
  )
}
