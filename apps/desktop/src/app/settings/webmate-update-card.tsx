import { useStore } from '@nanostores/react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { DisclosureRow } from '@/components/ui/disclosure-row'
import { type Translations, useI18n } from '@/i18n'
import { CheckCircle2, Loader2, RefreshCw } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { $webmateStatus, $webmateUpdate, applyWebmateUpdate, checkWebmateUpdate } from '@/store/webmate'

function relativeTime(iso: string | null | undefined, a: Translations['settings']['about']) {
  if (!iso) {
    return a.never
  }

  const diff = Date.now() - Date.parse(iso)

  if (!Number.isFinite(diff) || diff < 60_000) {
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

/**
 * The WebMate update card — the same shape as the app's own update card on
 * the About page, so "there is a new WebMate" reads like "there is a new
 * Workmate". Shown under Settings → Trình duyệt and Settings → Giới thiệu.
 */
export function WebmateUpdateCard() {
  const { locale, t } = useI18n()
  const copy = t.webmate.update
  const a = t.settings.about
  const status = useStore($webmateStatus)
  const update = useStore($webmateUpdate)
  const [notesOpen, setNotesOpen] = useState(false)

  const check = update.check
  const summary = status?.update ?? null
  const feedVersion = check?.feed?.version ?? summary?.feedVersion ?? null
  const installed = status?.installedVersion ?? check?.installedVersion ?? null
  const running = status?.extensionVersion ?? null
  const pending = check?.pendingVersion ?? summary?.pendingVersion ?? null
  const available = check?.available ?? summary?.available ?? false
  const blocked = check?.blockedByMinWorkmate ?? summary?.blockedByMinWorkmate ?? false
  const mandatory = check?.belowMinProtocol ?? summary?.belowMinProtocol ?? false
  const failed = (check?.failedVersions ?? summary?.failedVersions ?? []).includes(feedVersion ?? '')
  const checkedAt = check?.checkedAt ?? summary?.checkedAt ?? null
  const checkError = check ? !check.ok : summary ? !summary.ok : false
  const notes = check?.feed?.notes ?? summary?.notes ?? {}
  const note = notes[locale] ?? notes.en ?? notes.vi ?? null

  let line: string
  let tone: 'idle' | 'available' | 'error' | 'mandatory' = 'idle'

  if (update.applying && update.progress) {
    line = copy.stages[update.progress.stage]
    tone = 'available'
  } else if (mandatory && feedVersion) {
    line = copy.mandatoryBody
    tone = 'mandatory'
  } else if (pending) {
    line = copy.pending(pending)
    tone = 'available'
  } else if (blocked) {
    line = copy.blocked
    tone = 'error'
  } else if (failed && feedVersion) {
    line = copy.failed(feedVersion)
    tone = 'error'
  } else if (available && feedVersion) {
    line = copy.available(feedVersion)
    tone = 'available'
  } else if (checkError) {
    line = copy.checkError
    tone = 'error'
  } else if (checkedAt) {
    line = copy.upToDate
  } else {
    line = copy.neverChecked
  }

  const canInstall = Boolean(feedVersion) && (available || mandatory) && !update.applying && !blocked

  return (
    <div
      className={cn(
        'rounded-xl border px-4 py-3 text-sm',
        tone === 'available' && 'border-primary/30 bg-primary/5 text-foreground',
        tone === 'mandatory' && 'border-(--ui-yellow)/40 bg-(--ui-yellow)/10 text-foreground',
        tone === 'error' && 'border-destructive/35 bg-destructive/5 text-destructive',
        tone === 'idle' && 'border-border/70 bg-muted/20 text-foreground'
      )}
      data-slot="webmate-update-card"
    >
      <div className="flex items-start gap-2">
        {update.applying ? (
          <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-primary" />
        ) : tone === 'available' || tone === 'mandatory' ? (
          <Codicon className="mt-0.5 size-4 shrink-0 text-primary" name="cloud-download" size="1rem" />
        ) : tone === 'error' ? null : (
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
        )}
        <div className="min-w-0">
          <p className="font-medium">{line}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {installed ? t.webmate.settings.version(installed) : t.webmate.settings.states.notInstalled}
            {running && running !== installed ? ` · ${t.webmate.settings.running(running)}` : ''}
            {' · '}
            {copy.lastChecked(relativeTime(checkedAt, a))}
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-4">
        <Button
          disabled={update.checking || update.applying}
          onClick={() => void checkWebmateUpdate()}
          size="sm"
          variant="textStrong"
        >
          {update.checking ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
          {update.checking ? copy.checking : copy.checkNow}
        </Button>

        {canInstall ? (
          <Button onClick={() => void applyWebmateUpdate()} size="sm">
            {copy.install}
          </Button>
        ) : null}

        {update.applying ? <span className="text-xs text-muted-foreground">{copy.installing}</span> : null}
      </div>

      {canInstall && status?.prefs.mode === 'window' ? (
        <p className="mt-2 text-xs text-muted-foreground">{t.webmate.window.updateRelaunch}</p>
      ) : null}

      {note && feedVersion && (available || mandatory) ? (
        <div className="mt-3">
          <DisclosureRow onToggle={() => setNotesOpen(open => !open)} open={notesOpen}>
            {copy.notes}
          </DisclosureRow>
          {notesOpen ? (
            <p className="mt-2 whitespace-pre-line text-xs leading-5 text-muted-foreground">{note}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
