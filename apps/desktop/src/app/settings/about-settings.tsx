import { useStore } from '@nanostores/react'
import { useEffect } from 'react'

import { BrandMark } from '@/components/brand-mark'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import type { AppUpdateState } from '@/global'
import { type Translations, useI18n } from '@/i18n'
import { formatByteSize } from '@/lib/format'
import { CheckCircle2, ExternalLink, Loader2, RefreshCw } from '@/lib/icons'
import { cn } from '@/lib/utils'
import {
  $appUpdate,
  cancelAppUpdateDownload,
  checkAppUpdate,
  downloadAppUpdate,
  downloadProblemKey,
  installAppUpdate
} from '@/store/app-update'
import { openUpdateOverlay } from '@/store/update-overlay'
import { $desktopVersion, refreshDesktopVersion } from '@/store/updates'

import { ListRow, SectionHeading, SettingsContent } from './primitives'
import { UninstallSection } from './uninstall-section'
import { WebmateUpdateCard } from './webmate-update-card'

function relativeTime(ms: null | number | undefined, a: Translations['settings']['about']) {
  if (!ms) {
    return a.never
  }

  const diff = Date.now() - ms

  if (diff < 60_000) {
    return a.justNow
  }

  if (diff < 3_600_000) {
    return a.minAgo(Math.round(diff / 60_000))
  }

  if (diff < 86_400_000) {
    return a.hoursAgo(Math.round(diff / 3_600_000))
  }

  return a.daysAgo(Math.round(diff / 86_400_000))
}

type Tone = 'available' | 'error' | 'idle'

/** The one-line summary of this app's update state, and how loudly to say it. */
export function appUpdateStatusLine(state: AppUpdateState | null, t: Translations): { line: string; tone: Tone } {
  const a = t.settings.about
  const u = t.appUpdate
  const next = state?.release?.version ?? ''

  if (state?.installError) {
    return { line: u.installFailed, tone: 'error' }
  }

  switch (state?.phase) {
    case 'available':
      return state.downloadError
        ? { line: u.downloadFailed[downloadProblemKey(state.downloadError.kind)], tone: 'error' }
        : { line: u.statusAvailable(next), tone: 'available' }
    case 'downloading': {
      const total = state.progress?.totalBytes ?? 0
      const percent = total > 0 ? Math.floor(((state.progress?.receivedBytes ?? 0) / total) * 100) : 0

      return { line: u.statusDownloading(percent), tone: 'available' }
    }

    case 'ready':
      return { line: u.statusReady(next), tone: 'available' }

    case 'installing':
      return { line: u.statusInstalling, tone: 'available' }

    case 'up-to-date':
      return { line: a.onLatest, tone: 'idle' }

    default:
      if (state?.checking) {
        return { line: u.checking, tone: 'idle' }
      }

      return state?.checkError ? { line: a.cantReach, tone: 'error' } : { line: a.tapCheck, tone: 'idle' }
  }
}

export function AboutSettings() {
  const { t } = useI18n()
  const a = t.settings.about
  const u = t.appUpdate
  const version = useStore($desktopVersion)
  const state = useStore($appUpdate)

  // The version atom is loaded once at app boot; re-read it on mount so opening
  // About always reflects the running build and the agent beside it.
  useEffect(() => {
    void refreshDesktopVersion()
  }, [])

  const phase = state?.phase
  const busy = Boolean(state?.checking) || phase === 'downloading' || phase === 'installing'
  const { line, tone } = appUpdateStatusLine(state, t)
  const agentLags = Boolean(version?.agentVersion && version.agentVersion !== version.appVersion)

  const install = async () => {
    const outcome = await installAppUpdate()

    // Asking about the agent's work, or saying why it failed, is the dialog's job.
    if (outcome && !outcome.started) {
      openUpdateOverlay('client')
    }
  }

  return (
    <SettingsContent>
      <div className="flex flex-col items-center gap-3 pt-6 pb-2 text-center">
        <BrandMark className="size-16" />
        <div>
          <h2 className="text-lg font-semibold tracking-tight">{a.heading}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {version?.appVersion ? a.version(version.appVersion) : a.versionUnavailable}
            {agentLags && version ? ` · ${a.agentVersion(version.agentVersion)}` : ''}
          </p>
        </div>
      </div>

      <div className="mx-auto mt-4 w-full max-w-2xl">
        <SectionHeading icon={RefreshCw} title={a.updates} />

        <div
          className={cn(
            'rounded-xl border px-4 py-3 text-sm',
            tone === 'available' && 'border-primary/30 bg-primary/5 text-foreground',
            tone === 'error' && 'border-destructive/35 bg-destructive/5 text-destructive',
            tone === 'idle' && 'border-border/70 bg-muted/20 text-foreground'
          )}
        >
          <div className="flex items-start gap-2">
            {tone === 'available' ? (
              <Codicon className="mt-0.5 size-4 shrink-0 text-primary" name="cloud-download" size="1rem" />
            ) : tone === 'error' ? null : (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            )}
            <div className="min-w-0">
              <p className="font-medium">{line}</p>
              {state?.blocked && phase !== 'up-to-date' && (
                <p className="mt-1 text-xs text-muted-foreground">{u.blocked[state.blocked]}</p>
              )}
              <p className="mt-1 text-xs text-muted-foreground">{a.lastChecked(relativeTime(state?.checkedAt, a))}</p>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-4">
            <Button disabled={busy} onClick={() => void checkAppUpdate()} size="sm" variant="textStrong">
              {state?.checking ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
              {state?.checking ? a.checking : a.checkNow}
            </Button>

            {phase === 'available' && !state?.blocked && (
              <Button onClick={() => void downloadAppUpdate()} size="sm">
                {u.download(formatByteSize(state?.release?.bytes))}
              </Button>
            )}

            {phase === 'downloading' && (
              <Button onClick={() => void cancelAppUpdateDownload()} size="sm" variant="textStrong">
                {u.cancelDownload}
              </Button>
            )}

            {phase === 'ready' && (
              <Button onClick={() => void install()} size="sm">
                {u.restartToUpdate}
              </Button>
            )}

            {(phase === 'available' || phase === 'ready') && (
              <Button onClick={() => openUpdateOverlay('client')} size="sm" variant="textStrong">
                {a.seeWhatsNew}
              </Button>
            )}

            {state?.downloadPageUrl && (
              <Button asChild className="ml-auto" size="sm" variant="text">
                <a
                  href={state.downloadPageUrl}
                  onClick={event => {
                    event.preventDefault()
                    void window.agentxDesktop?.openExternal?.(state.downloadPageUrl)
                  }}
                  rel="noreferrer"
                  target="_blank"
                >
                  <ExternalLink className="size-3" />
                  {a.downloadPage}
                </a>
              </Button>
            )}
          </div>
        </div>

        <ListRow description={a.automaticUpdatesDesc} title={a.automaticUpdates} />

        {/* The browser extension updates on its own feed; it reads like the app's card above. */}
        <SectionHeading icon={RefreshCw} title={t.webmate.update.heading} />
        <WebmateUpdateCard />

        <UninstallSection />
      </div>
    </SettingsContent>
  )
}
