import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { BrandMark } from '@/components/brand-mark'
import { Button } from '@/components/ui/button'
import { writeClipboardText } from '@/components/ui/copy-button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  preventCloseButtonAutoFocus
} from '@/components/ui/dialog'
import { ErrorIcon, ErrorState } from '@/components/ui/error-state'
import { Loader } from '@/components/ui/loader'
import { Progress } from '@/components/ui/progress'
import type { BackendUpdateStatus } from '@/global'
import { useI18n } from '@/i18n'
import { buildCommitChangelog } from '@/lib/commit-changelog'
import { AlertCircle, Check, Copy, Terminal } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { $appUpdate, checkAppUpdate, dismissActiveWorkPrompt } from '@/store/app-update'
import { $updateOverlayOpen, $updateOverlayTarget, closeUpdateOverlay } from '@/store/update-overlay'
import {
  $backendUpdateApply,
  $backendUpdateChecking,
  $backendUpdateStatus,
  applyBackendUpdate,
  type BackendUpdateApplyState,
  checkBackendUpdates,
  resetBackendUpdateApplyState
} from '@/store/updates'

import { AppUpdateContent } from './app-update-content'

/**
 * The updates dialog: this app's own update ('client'), or in remote mode the
 * connected backend's ('backend'). Opening it checks the target unless it is
 * already somewhere in an update.
 */
export function UpdatesOverlay() {
  const open = useStore($updateOverlayOpen)
  const target = useStore($updateOverlayTarget)
  const appUpdate = useStore($appUpdate)
  const backendApply = useStore($backendUpdateApply)

  useEffect(() => {
    if (!open) {
      return
    }

    if (target === 'backend') {
      void checkBackendUpdates()

      return
    }

    const phase = $appUpdate.get()?.phase

    if (!phase || phase === 'idle' || phase === 'up-to-date') {
      void checkAppUpdate()
    }
  }, [open, target])

  // The app is quitting for its installer, or a backend update is mid-flight:
  // neither may be dismissed half-way.
  const locked =
    target === 'backend' ? backendApply.applying || backendApply.stage === 'restart' : appUpdate?.phase === 'installing'

  const handleClose = (next: boolean) => {
    if (next || locked) {
      return
    }

    closeUpdateOverlay()
    dismissActiveWorkPrompt()

    if (target === 'backend' && ['error', 'manual', 'restart'].includes(backendApply.stage)) {
      resetBackendUpdateApplyState()
    }
  }

  return (
    <Dialog onOpenChange={handleClose} open={open}>
      {/* This dialog has no inputs, so Radix's default autofocus would land on
          the close button and trigger its tooltip immediately on open. */}
      <DialogContent
        className="max-w-sm overflow-hidden p-0 gap-0"
        onOpenAutoFocus={preventCloseButtonAutoFocus}
        showCloseButton={!locked}
      >
        {target === 'client' ? (
          <AppUpdateContent onClose={() => handleClose(false)} />
        ) : (
          <BackendUpdateContent onClose={() => handleClose(false)} />
        )}
      </DialogContent>
    </Dialog>
  )
}

function BackendUpdateContent({ onClose }: { onClose: () => void }) {
  const status = useStore($backendUpdateStatus)
  const checking = useStore($backendUpdateChecking)
  const apply = useStore($backendUpdateApply)

  if (apply.stage === 'manual') {
    return <ManualView command={apply.command} message={apply.message} onDone={onClose} />
  }

  if (apply.applying || apply.stage === 'restart') {
    return <ApplyingView apply={apply} />
  }

  if (apply.stage === 'error') {
    return <ErrorView message={apply.message} onDismiss={onClose} onRetry={() => void applyBackendUpdate()} />
  }

  return <IdleView checking={checking} onLater={onClose} status={status} />
}

function IdleView({
  checking,
  onLater,
  status
}: {
  checking: boolean
  onLater: () => void
  status: BackendUpdateStatus | null
}) {
  const { t } = useI18n()
  const u = t.updates

  if (!status && checking) {
    return (
      <CenteredStatus
        icon={<Loader className="size-12" label={u.checking} type="lemniscate-bloom" />}
        title={u.checking}
      />
    )
  }

  if (!status || status.error) {
    return (
      <CenteredStatus
        action={
          <Button disabled={checking} onClick={() => void checkBackendUpdates()} size="sm">
            {u.tryAgain}
          </Button>
        }
        body={u.connectionRetry}
        icon={<ErrorIcon />}
        title={u.checkFailedTitle}
      />
    )
  }

  if (!status.supported) {
    return (
      <CenteredStatus
        body={status.message ?? u.unsupportedMessage}
        icon={<AlertCircle className="size-6 text-muted-foreground" />}
        title={u.notAvailableTitle}
      />
    )
  }

  const behind = status.behind ?? 0

  if (!status.updateAvailable && behind <= 0) {
    return <CenteredStatus body={u.latestBodyBackend} icon={<BrandMark className="size-12" />} title={u.allSetTitle} />
  }

  const commits = status.commits ?? []
  const groups = buildCommitChangelog(commits)
  const shownItems = groups.reduce((sum, group) => sum + group.items.length, 0)
  const remaining = Math.max(0, behind - shownItems)

  return (
    <div className="grid gap-5 px-6 pb-6 pt-7 pr-8">
      <div className="flex flex-col items-center gap-3 text-center">
        <BrandMark className="size-16" />

        <DialogTitle className="text-center text-xl">{u.availableTitleBackend}</DialogTitle>
        <DialogDescription className="text-center text-sm">
          {commits.length > 0 ? u.availableBodyBackend : u.availableBodyNoChangelog}
        </DialogDescription>
      </div>

      {commits.length > 0 && (
        <div className="grid gap-3">
          {groups.length === 0 ? (
            <p className="text-xs text-foreground">{u.changelogFallback}</p>
          ) : (
            groups.map(group => (
              <div key={group.id}>
                <p className="text-2xs font-medium uppercase tracking-label text-(--ui-text-tertiary)">
                  {u.changelogGroups[group.id]}
                </p>
                <ul className="mt-1.5 grid gap-1.5 text-xs text-foreground">
                  {group.items.map(item => (
                    <li className="flex items-start gap-2" key={item}>
                      <span aria-hidden className="mt-1.5 inline-block size-1 shrink-0 rounded-full bg-primary" />
                      <span className="leading-snug">{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>
      )}

      <div className="grid gap-2">
        <Button className="font-semibold" onClick={() => void applyBackendUpdate()} size="lg">
          {u.updateNow}
        </Button>
        <Button className="font-medium" onClick={onLater} type="button" variant="text">
          {u.maybeLater}
        </Button>
      </div>

      {remaining > 0 && <p className="text-center text-xs text-muted-foreground">{u.moreChanges(remaining)}</p>}
    </div>
  )
}

function ManualView({ command, message, onDone }: { command: null | string; message?: string; onDone: () => void }) {
  const { t } = useI18n()
  const u = t.updates
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    if (!command) {
      return
    }

    void writeClipboardText(command).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    })
  }

  return (
    <div className="grid gap-5 px-6 pb-6 pt-7 pr-8">
      <div className="flex flex-col items-center gap-3 text-center">
        <Terminal className="size-8 text-primary" />

        <DialogTitle className="text-center text-xl">{u.manualTitle}</DialogTitle>
        <DialogDescription className="text-center text-sm">{message || u.manualBody}</DialogDescription>
      </div>

      {command && (
        <button
          className={cn(
            'group flex w-full items-center justify-between gap-3 rounded-md border px-4 py-3 text-left transition-colors',
            copied ? 'border-primary/50' : 'border-(--stroke-nous) hover:border-(--ui-stroke-secondary)'
          )}
          onClick={handleCopy}
          type="button"
        >
          <code className="min-w-0 flex-1 truncate select-all font-mono text-sm text-foreground">
            <span className="select-none text-muted-foreground">$ </span>
            {command}
          </code>
          <span
            className={cn(
              'flex shrink-0 items-center gap-1 text-xs font-medium transition-colors',
              copied ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground'
            )}
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            {copied ? u.copied : u.copy}
          </span>
        </button>
      )}

      <Button className="font-semibold" onClick={onDone} size="lg" variant="secondary">
        {u.done}
      </Button>
    </div>
  )
}

function ApplyingView({ apply }: { apply: BackendUpdateApplyState }) {
  const { t } = useI18n()
  const u = t.updates
  const label = u.stages[apply.stage] ?? u.stages.idle
  const currentMessage = apply.message.trim()
  const recentLog = apply.log.slice(-4)

  return (
    <div className="grid gap-5 px-6 pb-6 pt-7">
      <div className="flex flex-col items-center gap-3 text-center">
        <Loader className="size-16" label={label} type="lemniscate-bloom" />

        <DialogTitle className="text-center text-xl">{label}</DialogTitle>
        <DialogDescription className="text-center text-sm">{u.applyingBodyBackend}</DialogDescription>

        {currentMessage ? (
          <p className="max-w-lg break-words text-center text-xs leading-5 text-muted-foreground">{currentMessage}</p>
        ) : null}
      </div>

      <Progress aria-label={label} indeterminate size="lg" />

      {recentLog.length > 1 ? (
        <div className="max-h-24 overflow-hidden rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-left font-mono text-2xs leading-4 text-muted-foreground">
          {recentLog.map((entry, index) => (
            <div className="truncate" key={`${entry.at}-${index}`}>
              {entry.message}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function ErrorView({ message, onDismiss, onRetry }: { message: string; onDismiss: () => void; onRetry: () => void }) {
  const { t } = useI18n()
  const u = t.updates

  return (
    <ErrorState
      className="px-6 pb-6 pt-7 pr-8"
      description={
        <DialogDescription className="max-w-prose text-center text-sm leading-5 text-muted-foreground">
          {message || u.errorBody}
        </DialogDescription>
      }
      title={<DialogTitle className="text-center text-xl font-semibold tracking-tight">{u.errorTitle}</DialogTitle>}
    >
      <Button className="font-semibold" onClick={onRetry} size="lg">
        {u.tryAgain}
      </Button>
      <Button onClick={onDismiss} variant="text">
        {u.notNow}
      </Button>
    </ErrorState>
  )
}

function CenteredStatus({
  action,
  body,
  icon,
  title
}: {
  action?: React.ReactNode
  body?: string
  icon: React.ReactNode
  title: string
}) {
  return (
    <div className="grid gap-4 px-6 pb-6 pt-8 pr-8">
      <div className="flex flex-col items-center gap-3 text-center">
        {icon}

        <DialogTitle className="text-center text-lg">{title}</DialogTitle>
        {body && <DialogDescription className="text-center text-sm">{body}</DialogDescription>}
      </div>

      {action && <div className="flex justify-center">{action}</div>}
    </div>
  )
}
