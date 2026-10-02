import { useStore } from '@nanostores/react'

import { BrandMark } from '@/components/brand-mark'
import { Button } from '@/components/ui/button'
import { DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { ErrorIcon } from '@/components/ui/error-state'
import { Loader } from '@/components/ui/loader'
import { Progress } from '@/components/ui/progress'
import type { AppUpdateActiveWork, AppUpdateRelease, AppUpdateState } from '@/global'
import { type Translations, useI18n } from '@/i18n'
import { formatByteSize } from '@/lib/format'
import { AlertCircle, AlertTriangle, ExternalLink } from '@/lib/icons'
import { IS_MAC } from '@/lib/keybinds/combo'
import { fmtDate } from '@/lib/time'
import {
  $appUpdate,
  $appUpdateActiveWork,
  cancelAppUpdateDownload,
  checkAppUpdate,
  deferAppUpdate,
  dismissActiveWorkPrompt,
  downloadAppUpdate,
  downloadProblemKey,
  installAppUpdate
} from '@/store/app-update'

/** The notes for the UI language: its own, its language's, English, Vietnamese. */
function notesFor(notes: Record<string, string[]>, locale: string): string[] {
  return notes[locale] ?? notes[locale.split('-')[0]] ?? notes.en ?? notes.vi ?? []
}

function openDownloadPage(url: string) {
  void window.agentxDesktop?.openExternal?.(url)
}

/** What went wrong, in words, and main's own reason for whoever has to dig in. */
function problemFor(state: AppUpdateState, u: Translations['appUpdate']): null | { detail: string; text: string } {
  if (state.installError) {
    return { detail: state.installError.message, text: u.installFailed }
  }

  if (state.downloadError) {
    return { detail: state.downloadError.message, text: u.downloadFailed[downloadProblemKey(state.downloadError.kind)] }
  }

  return null
}

/** The updates dialog's body for this app's own update; see store/app-update.ts. */
export function AppUpdateContent({ onClose }: { onClose: () => void }) {
  const state = useStore($appUpdate)
  const activeWork = useStore($appUpdateActiveWork)
  const { t } = useI18n()
  const u = t.appUpdate

  if (!state || (state.checking && !state.release && state.phase !== 'up-to-date')) {
    return (
      <Centered icon={<Loader className="size-12" label={u.checking} type="lemniscate-bloom" />} title={u.checking} />
    )
  }

  if (activeWork && state.phase === 'ready') {
    return <ActiveWorkPrompt activeWork={activeWork} />
  }

  switch (state.phase) {
    case 'installing':
      return (
        <Centered
          body={u.installingBody}
          icon={<Loader className="size-12" label={u.installingTitle} type="lemniscate-bloom" />}
          title={u.installingTitle}
        />
      )

    case 'downloading':
      return <Downloading onHide={onClose} state={state} />

    case 'ready':

    case 'available':
      return state.release ? (
        <ReleaseView
          onLater={() => {
            deferAppUpdate()
            onClose()
          }}
          release={state.release}
          state={state}
        />
      ) : null

    case 'up-to-date':
      return (
        <Centered
          body={u.upToDateBody(state.currentVersion)}
          footer={<CheckAgain checking={state.checking} />}
          icon={<BrandMark className="size-12" />}
          title={u.upToDateTitle}
        />
      )

    default:
      return state.checkError ? (
        <Centered
          action={
            <Button disabled={state.checking} onClick={() => void checkAppUpdate()} size="sm">
              {u.tryAgain}
            </Button>
          }
          body={u.checkFailedBody}
          icon={<ErrorIcon />}
          title={u.checkFailedTitle}
        />
      ) : (
        <Centered
          action={
            <Button onClick={() => void checkAppUpdate()} size="sm">
              {u.checkNow}
            </Button>
          }
          icon={<BrandMark className="size-12" />}
          title={u.notCheckedTitle}
        />
      )
  }
}

function ReleaseView({
  onLater,
  release,
  state
}: {
  onLater: () => void
  release: AppUpdateRelease
  state: AppUpdateState
}) {
  const { locale, t } = useI18n()
  const u = t.appUpdate
  const ready = state.phase === 'ready'
  const notes = notesFor(release.notes, locale)
  const problem = problemFor(state, u)

  return (
    <div className="grid gap-5 px-6 pb-6 pt-7 pr-8">
      <div className="flex flex-col items-center gap-3 text-center">
        <BrandMark className="size-16" />
        <DialogTitle className="text-center text-xl">
          {ready ? u.readyTitle(release.version) : u.availableTitle(release.version)}
        </DialogTitle>
        <DialogDescription className="text-center text-xs text-muted-foreground">
          {u.releasedOn(fmtDate.format(Date.parse(release.publishedAt)))}
        </DialogDescription>
      </div>

      <div>
        <p className="text-2xs font-medium uppercase tracking-label text-(--ui-text-tertiary)">{u.whatsNew}</p>
        <ul className="mt-1.5 grid gap-1.5 text-xs text-foreground">
          {notes.map(note => (
            <li className="flex items-start gap-2" key={note}>
              <span aria-hidden className="mt-1.5 inline-block size-1 shrink-0 rounded-full bg-primary" />
              <span className="leading-snug">{note}</span>
            </li>
          ))}
        </ul>
      </div>

      {state.blocked ? (
        <div className="grid gap-3">
          <p className="text-center text-xs leading-5 text-muted-foreground">{u.blocked[state.blocked]}</p>
          <Button className="font-semibold" onClick={() => openDownloadPage(state.downloadPageUrl)} size="lg">
            <ExternalLink className="size-3.5" />
            {u.openDownloadPage}
          </Button>
        </div>
      ) : (
        <div className="grid gap-2">
          {ready && (
            <p className="text-center text-xs leading-5 text-muted-foreground">
              {IS_MAC ? u.readyBodyMac : u.readyBodyWindows} {u.readyAgentNote}
            </p>
          )}
          {problem && (
            <div className="grid gap-1 text-center" role="alert">
              <p className="text-xs leading-5 text-destructive">
                <AlertCircle className="mr-1 inline size-3.5 align-[-0.15em]" />
                {problem.text}
              </p>
              <p className="select-text break-words text-2xs leading-4 text-muted-foreground">{problem.detail}</p>
            </div>
          )}
          {ready ? (
            <Button className="font-semibold" onClick={() => void installAppUpdate()} size="lg">
              {u.restartToUpdate}
            </Button>
          ) : (
            <Button className="font-semibold" onClick={() => void downloadAppUpdate()} size="lg">
              {problem ? u.retryDownload : u.download(formatByteSize(release.bytes))}
            </Button>
          )}
          {state.installError && (
            <Button
              className="font-medium"
              onClick={() => openDownloadPage(state.downloadPageUrl)}
              type="button"
              variant="text"
            >
              <ExternalLink className="size-3.5" />
              {u.openDownloadPage}
            </Button>
          )}
          <Button className="font-medium" onClick={onLater} type="button" variant="text">
            {u.later}
          </Button>
        </div>
      )}
    </div>
  )
}

function Downloading({ onHide, state }: { onHide: () => void; state: AppUpdateState }) {
  const { t } = useI18n()
  const u = t.appUpdate
  const received = state.progress?.receivedBytes ?? 0
  const total = state.progress?.totalBytes ?? state.release?.bytes ?? 0
  const fraction = total > 0 ? Math.min(1, received / total) : 0

  return (
    <div className="grid gap-5 px-6 pb-6 pt-7 pr-8">
      <div className="flex flex-col items-center gap-3 text-center">
        <BrandMark className="size-16" />
        <DialogTitle className="text-center text-xl">{u.downloadingTitle(state.release?.version ?? '')}</DialogTitle>
        <DialogDescription className="text-center text-sm">{u.downloadInBackground}</DialogDescription>
      </div>

      <div className="grid gap-1.5">
        <Progress aria-label={u.downloadingTitle(state.release?.version ?? '')} size="lg" value={fraction} />
        <p className="text-center text-xs tabular-nums text-muted-foreground">
          {u.downloadProgress(formatByteSize(received, '0 B'), formatByteSize(total))} · {Math.round(fraction * 100)}%
        </p>
      </div>

      <div className="grid gap-2">
        <Button className="font-semibold" onClick={onHide} size="lg" variant="secondary">
          {u.hide}
        </Button>
        <Button className="font-medium" onClick={() => void cancelAppUpdateDownload()} type="button" variant="text">
          {u.cancelDownload}
        </Button>
      </div>
    </div>
  )
}

function ActiveWorkPrompt({ activeWork }: { activeWork: AppUpdateActiveWork }) {
  const { t } = useI18n()
  const u = t.appUpdate

  return (
    <div className="grid gap-5 px-6 pb-6 pt-7 pr-8">
      <div className="flex flex-col items-center gap-3 text-center">
        <AlertTriangle className="size-8 text-(--ui-yellow)" />
        <DialogTitle className="text-center text-xl">{u.activeWorkTitle}</DialogTitle>
        <DialogDescription className="text-center text-sm">{u.activeWorkBody(activeWork.count)}</DialogDescription>
      </div>

      {activeWork.titles.length > 0 && (
        <ul className="grid gap-1 text-xs text-foreground">
          {activeWork.titles.slice(0, 5).map(title => (
            <li className="truncate" key={title}>
              • {title}
            </li>
          ))}
        </ul>
      )}

      <div className="grid gap-2">
        <Button className="font-semibold" onClick={() => void installAppUpdate({ confirmActiveWork: true })} size="lg">
          {u.updateAnyway}
        </Button>
        <Button className="font-medium" onClick={dismissActiveWorkPrompt} type="button" variant="text">
          {u.keepWorking}
        </Button>
      </div>
    </div>
  )
}

function CheckAgain({ checking }: { checking: boolean }) {
  const { t } = useI18n()

  return (
    <Button disabled={checking} onClick={() => void checkAppUpdate()} size="sm" variant="text">
      {checking ? t.appUpdate.checking : t.appUpdate.checkNow}
    </Button>
  )
}

function Centered({
  action,
  body,
  footer,
  icon,
  title
}: {
  action?: React.ReactNode
  body?: string
  footer?: React.ReactNode
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
      {footer && <div className="flex justify-center">{footer}</div>}
    </div>
  )
}
