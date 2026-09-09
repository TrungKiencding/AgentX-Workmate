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
  $webmateSigningIn,
  $webmateStatus,
  clearWebmateGuide,
  closeWebmateWindow,
  copyWebmatePath,
  hasChromiumBrowser,
  openWebmateWindow,
  reopenWebmateGuide,
  revealWebmateFolder,
  scanWebmateBrowsers,
  signInWebmate,
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
/** After a hello, how long the silent sign-in gets before the step offers the button instead. */
const SSO_GRACE_MS = 25_000

/**
 * The line under "Đã kết nối": signed in (nothing to do), being signed in by
 * Workmate (the silent hint runs in the main process right after the hello),
 * or — once that had its chance — a button for the interactive sign-in.
 */
export function SignInLine({ connectedAt }: { connectedAt: number | null }) {
  const { t } = useI18n()
  const copy = t.webmate.sso
  const status = useStore($webmateStatus)
  const signingIn = useStore($webmateSigningIn)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 2_000)

    return () => window.clearInterval(timer)
  }, [])

  const signedIn = status?.signedIn ?? null

  if (signedIn === true) {
    return (
      <p className="text-xs text-muted-foreground" data-slot="webmate-sso-line">
        {copy.onboardingSignedIn}
      </p>
    )
  }

  if (signedIn !== false) {
    return null
  }

  const waiting = (status?.prefs.ssoAutoSignIn ?? true) && connectedAt !== null && now - connectedAt < SSO_GRACE_MS

  if (waiting || signingIn) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground" data-slot="webmate-sso-line">
        <Loader className="size-5" type="lemniscate-bloom" />
        {signingIn ? copy.signingIn : copy.onboardingWaiting}
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-2" data-slot="webmate-sso-line">
      <p className="text-xs text-muted-foreground">{copy.onboardingManual}</p>
      <Button onClick={() => void signInWebmate()} size="xs" variant="outline">
        {copy.signIn}
      </Button>
    </div>
  )
}

/** The moment `connected` first became true in this component's life, for the sign-in grace. */
function useConnectedAt(connected: boolean): number | null {
  const [connectedAt, setConnectedAt] = useState<number | null>(null)

  useEffect(() => {
    if (connected && connectedAt === null) {
      setConnectedAt(Date.now())
    }
  }, [connected, connectedAt])

  return connectedAt
}

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

      <WindowDoor browsers={browsers} />

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

/** The third door: Workmate's own browser window. Active when a Chromium-based browser exists. */
function WindowDoor({ browsers }: { browsers: DesktopWebmateBrowser[] | null }) {
  const { t } = useI18n()
  const copy = t.webmate.window
  const available = hasChromiumBrowser(browsers)

  return (
    <div className="grid gap-1">
      <RowButton
        className={cn(
          'group flex w-full items-center justify-between gap-3 rounded-(--radius-card) border border-dashed border-(--ui-stroke-tertiary) px-3 py-2.5 text-left transition-colors',
          available === false ? 'opacity-60' : 'hover:bg-(--ui-control-hover-background)'
        )}
        disabled={available === false}
        onClick={() => void openWebmateWindow()}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <AppWindow className="size-4.5 shrink-0 text-(--ui-text-tertiary)" />
          <div className="min-w-0">
            <span className="text-[length:var(--conversation-text-font-size)] font-semibold">{copy.title}</span>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{copy.description}</p>
          </div>
        </div>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground transition group-hover:text-foreground" />
      </RowButton>
      {available === false ? <p className="px-3 text-xs text-muted-foreground">{copy.noChromium}</p> : null}
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

  const connected = Boolean(status?.connected && status.installType === 'workmate')
  const connectedAt = useConnectedAt(connected)

  if (!guide) {
    return null
  }

  const slow = !connected && !guide.preparing && now - guide.startedAt > SLOW_AFTER_MS

  if (guide.kind === 'window') {
    return (
      <WindowSteps
        connected={connected}
        connectedAt={connectedAt}
        guide={guide}
        onFinish={onFinish}
        slow={slow}
        surface={surface}
      />
    )
  }

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
            <SignInLine connectedAt={connectedAt} />
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
                  <Button onClick={() => void openWebmateWindow(guide.browserId)} size="xs" variant="outline">
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

/**
 * The window variant of the steps: nothing to drag. Workmate is opening (or
 * has opened) its own browser window with the extension inside; the line
 * below flips to connected on the extension's hello, exactly as for the
 * guided install. The person is told to sign in to their sites again there.
 */
function WindowSteps({
  connected,
  connectedAt,
  guide,
  onFinish,
  slow,
  surface
}: {
  connected: boolean
  connectedAt: number | null
  guide: { browserName: string; preparing: boolean; openError: string | null; serverError: string | null }
  onFinish: (choice: BrowserStepChoice) => void
  slow: boolean
  surface: 'onboarding' | 'settings'
}) {
  const { t } = useI18n()
  const copy = t.webmate.window
  const onboarding = t.webmate.onboarding
  const status = useStore($webmateStatus)
  const windowState = status?.window ?? null

  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-sm font-semibold">{copy.title}</h4>
        <Button
          className="font-medium"
          disabled={connected}
          onClick={() => {
            void closeWebmateWindow()
            clearWebmateGuide()
          }}
          size="xs"
          type="button"
          variant="text"
        >
          <ChevronLeft className="size-3" />
          {onboarding.back}
        </Button>
      </div>

      <p className="text-sm leading-6 text-(--ui-text-secondary)">{copy.signInNote}</p>
      {guide.serverError ? <p className="text-xs text-destructive">{onboarding.serverError}</p> : null}
      {guide.openError && !guide.preparing ? (
        <p className="text-xs text-destructive">{copy.failed(guide.openError)}</p>
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
                {onboarding.connected(status?.browser ?? guide.browserName)}
              </StatusPill>
            </div>
            <p className="text-xs text-muted-foreground">{onboarding.connectedHint}</p>
            <SignInLine connectedAt={connectedAt} />
          </div>
        ) : (
          <div className="grid gap-2">
            <div className="flex items-center gap-2.5 text-sm text-muted-foreground">
              <Loader className="size-6" type="lemniscate-bloom" />
              {guide.preparing || windowState?.phase === 'starting'
                ? copy.opening
                : guide.openError
                  ? copy.failed(guide.openError)
                  : onboarding.waiting}
            </div>
            {windowState?.browserName ? (
              <p className="text-xs text-muted-foreground">{copy.using(windowState.browserName)}</p>
            ) : null}
            {slow ? <p className="text-xs text-(--ui-text-secondary)">{onboarding.slowTitle}</p> : null}
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
            {onboarding.never}
          </Button>
          {connected ? (
            <Button onClick={() => onFinish('connected')} size="lg">
              {onboarding.start}
            </Button>
          ) : (
            <Button onClick={() => onFinish('later')} size="sm" variant="outline">
              {onboarding.later}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
