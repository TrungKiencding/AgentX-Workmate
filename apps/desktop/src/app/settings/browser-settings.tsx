import { useStore } from '@nanostores/react'
import { type ReactNode, useEffect, useState } from 'react'

import { WebmateGuideSteps } from '@/components/onboarding/browser-step'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { StatusPill, type StatusPillTone } from '@/components/ui/status-pill'
import {
  StoreCard,
  StoreCardDescription,
  StoreCardFooter,
  StoreCardGlyph,
  StoreCardGrid,
  StoreCardHeader,
  StoreCardMeta
} from '@/components/ui/store-card'
import { TagChip } from '@/components/ui/tag-chip'
import type { DesktopWebmateBrowser, DesktopWebmateBrowserProfile } from '@/global'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { AppWindow, Copy, FolderOpen, Globe, Loader2, RefreshCw } from '@/lib/icons'
import { cn } from '@/lib/utils'
import {
  $webmateBackend,
  $webmateBrowsers,
  $webmateGuide,
  $webmateScanning,
  $webmateStatus,
  $webmateUpdate,
  applyWebmateUpdate,
  clearWebmateGuide,
  closeWebmateWindow,
  copyWebmatePath,
  hasChromiumBrowser,
  openWebmateWindow,
  refreshWebmateBackend,
  refreshWebmateStatus,
  resetWebmateToken,
  revealWebmateFolder,
  scanWebmateBrowsers,
  setWebmateEnabled,
  setWebmateMode,
  setWebmatePrefs,
  startWebmateGuide,
  webmateEnabled,
  type WebmateReadiness,
  webmateReadiness
} from '@/store/webmate'

import { CONTROL_TEXT } from './constants'
import { ListRow, SectionHeading, SettingsContent, SettingsSection, ToggleRow } from './primitives'
import { WebmateUpdateCard } from './webmate-update-card'

const CAPTION = 'text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)'

function Caption({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn(CAPTION, className)}>{children}</p>
}

const TONE: Record<WebmateReadiness, StatusPillTone> = {
  off: 'muted',
  notInstalled: 'muted',
  installedClosed: 'muted',
  installedDisabled: 'warn',
  installedNotConnected: 'warn',
  outdated: 'warn',
  notSignedIn: 'warn',
  ready: 'good'
}

/**
 * Settings → Trình duyệt: the WebMate switch, one card per browser profile
 * with its state and the one action that state calls for, the guided install
 * inline, the update card, and the two preferences.
 */
export function BrowserSettings() {
  const { t } = useI18n()
  const copy = t.webmate.settings
  const status = useStore($webmateStatus)
  const backend = useStore($webmateBackend)
  const browsers = useStore($webmateBrowsers)
  const scanning = useStore($webmateScanning)
  const guide = useStore($webmateGuide)
  const [toggling, setToggling] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    void refreshWebmateStatus()
    void refreshWebmateBackend()

    if ($webmateBrowsers.get() === null) {
      void scanWebmateBrowsers()
    }
  }, [])

  const enabled = webmateEnabled(backend)
  const overall = webmateReadiness({ status, backend })
  const windowState = status?.window ?? null
  const supported = (browsers ?? []).filter(b => b.supported)
  const prefs = status?.prefs

  const toggle = async (on: boolean) => {
    setToggling(true)

    try {
      await setWebmateEnabled(on)
    } finally {
      setToggling(false)
    }
  }

  const copyPath = async () => {
    if (await copyWebmatePath()) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    }
  }

  return (
    <SettingsContent>
      <SectionHeading
        aside={
          <StatusPill size="md" tone={TONE[overall]}>
            {copy.states[overall]}
          </StatusPill>
        }
        icon={AppWindow}
        title={copy.title}
      />
      <Caption className="mb-2 leading-(--conversation-caption-line-height)">{copy.intro}</Caption>

      <ToggleRow
        checked={enabled}
        description={copy.enableDesc}
        disabled={toggling}
        label={copy.enable}
        onChange={on => void toggle(on)}
      />

      <ListRow
        action={
          <Select
            onValueChange={value => {
              triggerHaptic('selection')
              void setWebmateMode(value === 'window' ? 'window' : 'browser')
            }}
            value={prefs?.mode === 'window' ? 'window' : 'browser'}
          >
            <SelectTrigger className={cn('min-w-56', CONTROL_TEXT)}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="browser">{t.webmate.window.modeBrowser}</SelectItem>
              <SelectItem value="window">{t.webmate.window.modeWindow}</SelectItem>
            </SelectContent>
          </Select>
        }
        description={t.webmate.window.modeDesc}
        title={t.webmate.window.modeLabel}
      />

      <ListRow
        action={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <StatusPill tone={windowState?.open ? 'good' : 'muted'}>
              {windowState?.open ? t.webmate.window.stateOpen : t.webmate.window.stateClosed}
            </StatusPill>
            {windowState?.open ? (
              <Button onClick={() => void closeWebmateWindow()} size="sm" variant="outline">
                {t.webmate.window.close}
              </Button>
            ) : (
              <Button
                disabled={hasChromiumBrowser(browsers) === false || windowState?.phase === 'starting'}
                onClick={() => void openWebmateWindow()}
                size="sm"
                variant="outline"
              >
                <AppWindow className="size-3.5" />
                {windowState?.phase === 'starting' ? t.webmate.window.opening : t.webmate.window.open}
              </Button>
            )}
          </div>
        }
        description={t.webmate.window.signInNote}
        hint={
          hasChromiumBrowser(browsers) === false
            ? t.webmate.window.noChromium
            : windowState?.open && windowState.browserName
              ? t.webmate.window.using(windowState.browserName)
              : (windowState?.error ?? undefined)
        }
        title={t.webmate.window.title}
      />

      <SettingsSection
        aside={
          <Button disabled={scanning} onClick={() => void scanWebmateBrowsers(true)} size="sm" variant="text">
            {scanning ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
            {copy.rescan}
          </Button>
        }
        icon={Globe}
        title={copy.browsersHeading}
      >
        {browsers === null ? (
          <Caption>{t.webmate.onboarding.scanning}</Caption>
        ) : supported.length === 0 ? (
          <Caption>{t.webmate.onboarding.noBrowsers}</Caption>
        ) : (
          <StoreCardGrid>
            {supported.flatMap(browser =>
              (browser.profiles.length ? browser.profiles : [null]).map(profile => (
                <BrowserCard
                  browser={browser}
                  enabled={enabled}
                  key={`${browser.id}:${profile?.dir ?? ''}`}
                  profile={profile}
                  readiness={webmateReadiness({ status, backend, browser, profile: profile ?? emptyProfile })}
                />
              ))
            )}
          </StoreCardGrid>
        )}

        {guide ? (
          <div className="mt-3 rounded-(--radius-card) border border-(--ui-stroke-tertiary) bg-(--ui-bg-quinary) p-4">
            <WebmateGuideSteps onFinish={() => clearWebmateGuide()} surface="settings" />
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection icon={FolderOpen} title={copy.folderTitle}>
        <ListRow
          action={
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button onClick={() => void copyPath()} size="sm" variant="outline">
                <Copy className="size-3.5" />
                {copied ? t.webmate.onboarding.pathCopied : t.webmate.onboarding.copyPath}
              </Button>
              <Button onClick={() => void revealWebmateFolder()} size="sm" variant="outline">
                <FolderOpen className="size-3.5" />
                {t.webmate.onboarding.showFolder}
              </Button>
            </div>
          }
          description={copy.folderDesc}
          hint={status?.paths.installDir}
          title={status?.installedVersion ? copy.version(status.installedVersion) : copy.states.notInstalled}
        />
      </SettingsSection>

      <SettingsSection icon={RefreshCw} title={t.webmate.update.heading}>
        <WebmateUpdateCard />
        <ToggleRow
          checked={prefs?.autoUpdate ?? true}
          description={copy.autoUpdateDesc}
          label={copy.autoUpdate}
          onChange={on => void setWebmatePrefs({ autoUpdate: on })}
        />
      </SettingsSection>

      <ListRow
        action={
          <Select
            onValueChange={value => {
              triggerHaptic('selection')
              void setWebmatePrefs({ askWhenNotReady: value === 'ask' })
            }}
            value={prefs?.askWhenNotReady === false ? 'dontAsk' : 'ask'}
          >
            <SelectTrigger className={cn('min-w-44', CONTROL_TEXT)}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ask">{copy.askMe}</SelectItem>
              <SelectItem value="dontAsk">{copy.dontAsk}</SelectItem>
            </SelectContent>
          </Select>
        }
        title={copy.askWhenNotReady}
      />

      <ListRow
        action={
          <Button onClick={() => void resetWebmateToken()} size="sm" variant="outline">
            {copy.resetToken}
          </Button>
        }
        description={copy.resetTokenDesc}
        title={copy.resetToken}
      />
    </SettingsContent>
  )
}

const emptyProfile: DesktopWebmateBrowserProfile = {
  dir: '',
  displayName: '',
  lastActive: null,
  isLastUsed: false,
  webmate: { installed: false, path: null, disabled: false, disableReasons: [], elsewhere: false }
}

function BrowserCard({
  browser,
  enabled,
  profile,
  readiness
}: {
  browser: DesktopWebmateBrowser
  enabled: boolean
  profile: DesktopWebmateBrowserProfile | null
  readiness: WebmateReadiness
}) {
  const { t } = useI18n()
  const copy = t.webmate.settings
  const update = useStore($webmateUpdate)
  const title = browser.profiles.length > 1 && profile ? `${browser.name} · ${profile.displayName}` : browser.name
  const elsewhere = profile?.webmate.elsewhere && !profile.webmate.installed ? profile.webmate.path : null

  let action: ReactNode = null

  if (enabled) {
    if (readiness === 'notInstalled') {
      action = (
        <Button onClick={() => void startWebmateGuide(browser, profile)} size="sm">
          {t.webmate.onboarding.install}
        </Button>
      )
    } else if (
      readiness === 'installedClosed' ||
      readiness === 'installedNotConnected' ||
      readiness === 'installedDisabled'
    ) {
      action = (
        <Button onClick={() => void startWebmateGuide(browser, profile)} size="sm" variant="outline">
          {copy.reconnect}
        </Button>
      )
    } else if (readiness === 'outdated') {
      action = (
        <Button disabled={update.applying} onClick={() => void applyWebmateUpdate()} size="sm">
          {t.webmate.update.install}
        </Button>
      )
    }
  }

  return (
    <StoreCard>
      <StoreCardHeader
        dimmed={!enabled}
        glyph={
          <StoreCardGlyph>
            <AppWindow />
          </StoreCardGlyph>
        }
        meta={browser.isDefault ? <TagChip>{t.webmate.onboarding.defaultBadge}</TagChip> : undefined}
        title={title}
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusPill tone={TONE[readiness]}>{copy.states[readiness]}</StatusPill>
      </div>
      <StoreCardDescription>{elsewhere ? copy.elsewhere(elsewhere) : copy.hints[readiness]}</StoreCardDescription>
      <StoreCardFooter end={action}>
        {browser.version ? <StoreCardMeta>{browser.version}</StoreCardMeta> : null}
      </StoreCardFooter>
    </StoreCard>
  )
}
