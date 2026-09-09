import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Loader } from '@/components/ui/loader'
import { RowButton } from '@/components/ui/row-button'
import { StatusPill } from '@/components/ui/status-pill'
import { TagChip } from '@/components/ui/tag-chip'
import type { DesktopWebmateBrowser, DesktopWebmateBrowserProfile } from '@/global'
import { useI18n } from '@/i18n'
import { AppWindow, Check, ChevronLeft, ChevronRight, Copy, ExternalLink, FolderOpen } from '@/lib/icons'
import { cn } from '@/lib/utils'
import {
  $webmateBrowsers,
  $webmateGuide,
  $webmateScanning,
  $webmateStatus,
  clearWebmateGuide,
  copyWebmatePath,
  reopenWebmateGuide,
  revealWebmateFolder,
  scanWebmateBrowsers,
  startWebmateGuide
} from '@/store/webmate'

import { webmateGuideImage } from './webmate-guide-images'

/** The address to type when the window opened but could not be steered to the page. */
function extensionsUrlFor(browserId: string): string {
  return browserId === 'edge'
    ? 'edge://extensions'
    : browserId === 'brave'
      ? 'brave://extensions'
      : 'chrome://extensions'
}

/** After this long without a hello, show the usual reasons and the way out. */
const SLOW_AFTER_MS = 120_000
const TICK_MS = 5_000

export type BrowserStepChoice = 'connected' | 'later' | 'never'

/**
 * The "Kết nối trình duyệt" onboarding step. Two screens: pick a browser
 * (and profile), then the three steps with a live "waiting → connected" line
 * driven by the status the main process pushes. No "I'm done" button: the
 * extension's hello is what flips the screen.
 */
export function BrowserStepPanel({
  leaving,
  onFinish
}: {
  leaving: boolean
  onFinish: (choice: BrowserStepChoice) => void
}) {
  const { t } = useI18n()
  const copy = t.webmate.onboarding
  const browsers = useStore($webmateBrowsers)
  const scanning = useStore($webmateScanning)
  const guide = useStore($webmateGuide)

  useEffect(() => {
    if (browsers === null) {
      void scanWebmateBrowsers()
    }
  }, [browsers])

  return (
    <div className={cn('grid gap-4 transition duration-[360ms] ease-out', leaving ? 'opacity-0' : 'opacity-100')}>
      <div>
        <h3 className="font-serif-display text-2xl text-(--ui-text-primary)">{copy.title}</h3>
        <p className="mt-1.5 text-sm leading-6 text-(--ui-text-tertiary)">{copy.intro}</p>
      </div>

      {guide ? (
        <WebmateGuideSteps onFinish={onFinish} />
      ) : (
        <BrowserPicker browsers={browsers} onFinish={onFinish} scanning={scanning} />
      )}
    </div>
  )
}

function BrowserPicker({
  browsers,
  onFinish,
  scanning
}: {
  browsers: DesktopWebmateBrowser[] | null
  onFinish: (choice: BrowserStepChoice) => void
  scanning: boolean
}) {
  const { t } = useI18n()
  const copy = t.webmate.onboarding
  const supported = (browsers ?? []).filter(b => b.supported)
  const unsupported = (browsers ?? []).filter(b => !b.supported)

  return (
    <div className="grid gap-3">
      <p className="text-sm font-semibold">{copy.pickBrowser}</p>

      {browsers === null || (scanning && supported.length === 0) ? (
        <div className="flex items-center gap-2.5 py-1 text-sm text-muted-foreground" role="status">
          <Loader className="size-7" type="lemniscate-bloom" />
          {copy.scanning}
        </div>
      ) : supported.length === 0 ? (
        <p className="rounded-(--radius-card) border border-(--ui-stroke-tertiary) bg-(--ui-bg-quinary) px-3 py-2.5 text-sm text-muted-foreground">
          {copy.noBrowsers}
        </p>
      ) : (
        <div className="grid max-h-[46dvh] gap-1.5 overflow-y-auto p-0.5">
          {supported.map(browser =>
            browser.profiles.length > 1 ? (
              browser.profiles.map(profile => (
                <BrowserRow browser={browser} key={`${browser.id}:${profile.dir}`} profile={profile} />
              ))
            ) : (
              <BrowserRow browser={browser} key={browser.id} profile={browser.profiles[0] ?? null} />
            )
          )}
          {unsupported.map(browser => (
            <div
              className="flex w-full items-center justify-between gap-3 rounded-(--radius-control) px-3 py-2.5 text-left opacity-60"
              key={browser.id}
            >
              <span className="text-[length:var(--conversation-text-font-size)] font-semibold">{browser.name}</span>
              <TagChip>
                {browser.unsupportedReason === 'safari' ? copy.unsupported.safari : copy.unsupported.firefox}
              </TagChip>
            </div>
          ))}
        </div>
      )}

      {/* Phase 3 lights this up; until then it is there so the choice reads as three doors. */}
      <div
        aria-disabled
        className="flex w-full items-center justify-between gap-3 rounded-(--radius-card) border border-dashed border-(--ui-stroke-tertiary) px-3 py-2.5 text-left opacity-60"
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <AppWindow className="size-4.5 shrink-0 text-(--ui-text-tertiary)" />
          <div className="min-w-0">
            <span className="text-[length:var(--conversation-text-font-size)] font-semibold">
              {copy.workmateWindow.title}
            </span>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{copy.workmateWindow.description}</p>
          </div>
        </div>
        <TagChip>{copy.workmateWindow.comingSoon}</TagChip>
      </div>

      <div className="flex items-center justify-between gap-3 pt-1">
        <Button className="font-medium" onClick={() => onFinish('never')} size="xs" type="button" variant="text">
          {copy.never}
        </Button>
        <Button onClick={() => onFinish('later')} size="sm" variant="outline">
          {copy.later}
        </Button>
      </div>
    </div>
  )
}

function BrowserRow({
  browser,
  profile
}: {
  browser: DesktopWebmateBrowser
  profile: DesktopWebmateBrowserProfile | null
}) {
  const { t } = useI18n()
  const copy = t.webmate.onboarding
  const installed = Boolean(profile?.webmate.installed)
  const disabled = Boolean(profile?.webmate.disabled)
  const elsewhere = Boolean(profile?.webmate.elsewhere && !installed)
  const showProfile = browser.profiles.length > 1 && profile

  return (
    <RowButton
      className="group flex w-full items-center justify-between gap-3 rounded-(--radius-control) px-3 py-2.5 text-left transition-colors hover:bg-(--ui-control-hover-background)"
      onClick={() => void startWebmateGuide(browser, profile)}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[length:var(--conversation-text-font-size)] font-semibold">
            {browser.name}
            {showProfile ? <span className="font-normal text-muted-foreground"> · {profile.displayName}</span> : null}
          </span>
          {browser.isDefault ? <TagChip>{copy.defaultBadge}</TagChip> : null}
          {installed ? (
            <StatusPill tone={disabled ? 'warn' : 'good'}>
              {disabled ? copy.disabledBadge : copy.installedBadge}
            </StatusPill>
          ) : elsewhere ? (
            <TagChip>{copy.elsewhereBadge}</TagChip>
          ) : null}
        </div>
        {browser.version ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{browser.version}</p> : null}
      </div>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground transition group-hover:text-foreground" />
    </RowButton>
  )
}

/**
 * The three steps with the live connection line. Onboarding shows it with
 * later / never / start; Settings → Trình duyệt embeds it with a single close.
 */
export function WebmateGuideSteps({
  onFinish,
  surface = 'onboarding'
}: {
  onFinish: (choice: BrowserStepChoice) => void
  surface?: 'onboarding' | 'settings'
}) {
  const { locale, t } = useI18n()
  const copy = t.webmate.onboarding
  const guide = useStore($webmateGuide)
  const status = useStore($webmateStatus)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS)

    return () => window.clearInterval(timer)
  }, [])

  if (!guide) {
    return null
  }

  const connected = Boolean(status?.connected && status.installType === 'workmate')
  const slow = !connected && !guide.preparing && now - guide.startedAt > SLOW_AFTER_MS
  const image = webmateGuideImage(guide.browserId, locale)
  // Edge words and places the same two controls differently.
  const steps = guide.browserId === 'edge' ? copy.stepsEdge : copy.steps
  const installDir = status?.paths.installDir ?? ''

  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-sm font-semibold">{copy.stepsTitle(guide.browserName)}</h4>
        <Button
          className="font-medium"
          disabled={connected}
          onClick={() => clearWebmateGuide()}
          size="xs"
          type="button"
          variant="text"
        >
          <ChevronLeft className="size-3" />
          {copy.back}
        </Button>
      </div>

      {guide.serverError ? <p className="text-xs text-destructive">{copy.serverError}</p> : null}
      {guide.openError && !guide.preparing ? (
        <p className="text-xs text-destructive">{copy.openFailed(guide.browserName)}</p>
      ) : guide.opened && !guide.navigated && !guide.preparing ? (
        <p className="text-xs text-(--ui-text-secondary)">{copy.typeAddress(extensionsUrlFor(guide.browserId))}</p>
      ) : null}

      <div className={cn('grid gap-4', image ? 'sm:grid-cols-[minmax(0,1fr)_16rem]' : '')}>
        <ol className="grid list-decimal gap-2.5 pl-5 text-sm leading-6 text-(--ui-text-secondary)">
          <li>{steps.devMode}</li>
          <li>{steps.drag}</li>
          <li>{copy.steps.done}</li>
        </ol>
        {image ? (
          <img
            alt=""
            className="w-full self-start rounded-(--radius-card) border border-(--ui-stroke-tertiary) shadow-xs"
            src={image}
          />
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => void reopenWebmateGuide()} size="sm" variant="outline">
          <ExternalLink className="size-3.5" />
          {copy.reopenPage}
        </Button>
        <Button onClick={() => void revealWebmateFolder()} size="sm" variant="outline">
          <FolderOpen className="size-3.5" />
          {copy.showFolder}
        </Button>
        <Button onClick={() => void copyWebmatePath()} size="sm" variant="outline">
          {guide.copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {guide.copied ? copy.pathCopied : copy.copyPath}
        </Button>
      </div>
      {installDir ? (
        <code className="truncate rounded-md border border-(--stroke-nous) px-3 py-1.5 font-mono text-xs text-muted-foreground">
          {installDir}
        </code>
      ) : null}

      <div
        className={cn(
          'rounded-(--radius-card) border px-4 py-3',
          connected ? 'border-(--ui-green)/40 bg-(--ui-green)/10' : 'border-(--ui-stroke-tertiary) bg-(--ui-bg-quinary)'
        )}
        role="status"
      >
        {connected ? (
          <div className="grid gap-1">
            <div className="flex items-center gap-2">
              <StatusPill size="md" tone="good">
                {copy.connected(status?.browser ?? guide.browserName)}
              </StatusPill>
            </div>
            <p className="text-xs text-muted-foreground">{copy.connectedHint}</p>
          </div>
        ) : (
          <div className="grid gap-2">
            <div className="flex items-center gap-2.5 text-sm text-muted-foreground">
              <Loader className="size-6" type="lemniscate-bloom" />
              {guide.preparing ? copy.serverStarting : copy.waiting}
            </div>
            {slow ? (
              <div className="grid gap-1.5 text-xs text-(--ui-text-secondary)">
                <p>{copy.slowTitle}</p>
                <ul className="list-disc pl-5">
                  {copy.slowReasons.map(reason => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
                <div>
                  <Button disabled size="xs" title={copy.workmateWindow.comingSoon} variant="outline">
                    <AppWindow className="size-3" />
                    {copy.useWindow}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {surface === 'settings' ? (
        <div className="flex items-center justify-end gap-3 pt-1">
          <Button
            onClick={() => onFinish(connected ? 'connected' : 'later')}
            size="sm"
            variant={connected ? 'default' : 'outline'}
          >
            {connected ? t.common.done : t.common.close}
          </Button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3 pt-1">
          <Button className="font-medium" onClick={() => onFinish('never')} size="xs" type="button" variant="text">
            {copy.never}
          </Button>
          {connected ? (
            <Button onClick={() => onFinish('connected')} size="lg">
              {copy.start}
            </Button>
          ) : (
            <Button onClick={() => onFinish('later')} size="sm" variant="outline">
              {copy.later}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
