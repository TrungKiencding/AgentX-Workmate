/**
 * AgentX WebMate in the renderer: what the desktop knows about the browser
 * extension (pushed by the main process from `<webmate>/`), what the backend
 * knows (the MCP server registration and its enabled flag), the browser scan,
 * the guided install, updates, and the "Workmate wants to use your browser"
 * card. apps/desktop/WEBMATE-INTEGRATION-PLAN.md §5.
 *
 * The main process owns every file; this store never touches the disk. The
 * backend owns `mcp_servers.webmate.enabled`; switching it goes through the
 * same REST call the MCP tab uses, followed by `reload.mcp` so the running
 * gateway starts (or stops) the bridge server right away.
 */

import { atom } from 'nanostores'

import type {
  DesktopWebmateApplyOutcome,
  DesktopWebmateBrowser,
  DesktopWebmateBrowserProfile,
  DesktopWebmateConnection,
  DesktopWebmateOpenGuideResult,
  DesktopWebmateOpenWindowResult,
  DesktopWebmatePrefs,
  DesktopWebmateSignInOutcome,
  DesktopWebmateStatus,
  DesktopWebmateUpdateCheck,
  DesktopWebmateUpdateProgress,
  DesktopWebmateWindowStatus
} from '@/global'
import { getMcpCatalog, getWebmateStatus, installMcpCatalogEntry, setMcpServerEnabled, setSkillEnabled } from '@/hermes'
import { translateNow } from '@/i18n'
import { $gateway } from '@/store/gateway'
import { dismissNotification, notify } from '@/store/notifications'
import type { WebmateBackendStatus } from '@/types/hermes'

export const WEBMATE_SERVER_NAME = 'webmate'
export const WEBMATE_SKILL_NAME = 'webmate'

export const WEBMATE_CODES = [
  'WEBMATE_DISABLED',
  'WEBMATE_NOT_INSTALLED',
  'WEBMATE_NOT_CONNECTED',
  'WEBMATE_OUTDATED',
  'WEBMATE_NOT_SIGNED_IN',
  'WEBMATE_PORT_IN_USE'
] as const

export type WebmateCode = (typeof WEBMATE_CODES)[number]

export type WebmateReadiness =
  | 'off'
  | 'notInstalled'
  | 'installedClosed'
  | 'installedDisabled'
  | 'installedNotConnected'
  | 'outdated'
  | 'notSignedIn'
  | 'ready'

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export const $webmateStatus = atom<DesktopWebmateStatus | null>(null)
export const $webmateBackend = atom<WebmateBackendStatus | null>(null)
export const $webmateBrowsers = atom<DesktopWebmateBrowser[] | null>(null)
export const $webmateScanning = atom<boolean>(false)

export interface WebmateGuideState {
  /** 'browser' = the guided install into the person's browser; 'window' = the Workmate browser window (phase 3). */
  kind: 'browser' | 'window'
  browserId: string
  browserName: string
  profileDir: string | null
  profileName: string | null
  startedAt: number
  /** The command Workmate ran to open the extensions page, for the "reopen" affordance. */
  /** A window for the profile opened. */
  opened: boolean
  /** That window reached the extensions page; false means "type the address into the new window". */
  navigated: boolean
  openError: string | null
  folderOpened: boolean
  copied: boolean
  /** `reload.mcp` (or the catalog install) failed: the bridge server may not be listening. */
  serverError: string | null
  preparing: boolean
}

export const $webmateGuide = atom<WebmateGuideState | null>(null)

export interface WebmateUpdateState {
  check: DesktopWebmateUpdateCheck | null
  checking: boolean
  applying: boolean
  progress: DesktopWebmateUpdateProgress | null
  lastOutcome: DesktopWebmateApplyOutcome | null
}

export const $webmateUpdate = atom<WebmateUpdateState>({
  check: null,
  checking: false,
  applying: false,
  progress: null,
  lastOutcome: null
})

export interface WebmatePromptState {
  code: WebmateCode
  at: number
}

/** The "Workmate wants to use your browser" card; null when hidden. */
export const $webmatePrompt = atom<WebmatePromptState | null>(null)

let promptShownThisSession = false

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const CODE_PATTERN = /\bWEBMATE_(DISABLED|NOT_INSTALLED|NOT_CONNECTED|OUTDATED|NOT_SIGNED_IN|PORT_IN_USE)\b/

export function isWebmateCode(value: unknown): value is WebmateCode {
  return typeof value === 'string' && (WEBMATE_CODES as readonly string[]).includes(value)
}

/**
 * The WEBMATE_* code a `tool.complete` payload carries, or null. The MCP
 * server puts the code at the head of the error text and in
 * `structuredContent.code`; the backend wraps an MCP error as `{ error }`, so
 * both the parsed object and the raw string forms are checked. Only tools of
 * the webmate server count — a chat message quoting a code is not a failure.
 */
export function webmateCodeFromToolPayload(payload: unknown): WebmateCode | null {
  if (!payload || typeof payload !== 'object') {
    return null
  }

  const record = payload as Record<string, unknown>
  const name = typeof record.name === 'string' ? record.name : ''

  if (!/webmate/i.test(name)) {
    return null
  }

  const result = record.result

  const candidates: unknown[] = [
    result,
    result && typeof result === 'object' ? (result as Record<string, unknown>).error : undefined,
    result && typeof result === 'object' ? (result as Record<string, unknown>).result : undefined,
    result && typeof result === 'object' ? (result as Record<string, unknown>).structuredContent : undefined,
    record.result_text,
    record.error
  ]

  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const match = CODE_PATTERN.exec(candidate)

      if (match) {
        return `WEBMATE_${match[1]}` as WebmateCode
      }
    } else if (candidate && typeof candidate === 'object') {
      const code = (candidate as Record<string, unknown>).code

      if (isWebmateCode(code)) {
        return code
      }
    }
  }

  return null
}

/** The browser id a bridge `browser` label ("Chrome 152", "Microsoft Edge 152") refers to. */
export function browserIdFromBridgeLabel(label: string | null | undefined): DesktopWebmateBrowser['id'] | null {
  const value = String(label || '').toLowerCase()

  if (!value) {
    return null
  }

  if (value.includes('edge')) {
    return 'edge'
  }

  if (value.includes('brave')) {
    return 'brave'
  }

  if (value.includes('vivaldi')) {
    return 'vivaldi'
  }

  if (value.includes('opera')) {
    return 'opera'
  }

  if (value.includes('arc')) {
    return 'arc'
  }

  if (value.includes('chromium')) {
    return 'chromium'
  }

  if (value.includes('chrome')) {
    return 'chrome'
  }

  return null
}

export interface ReadinessInput {
  status: DesktopWebmateStatus | null
  backend: WebmateBackendStatus | null
  browser?: DesktopWebmateBrowser | null
  profile?: DesktopWebmateBrowserProfile | null
}

/**
 * The attached extensions a status describes: the server's list when it has
 * one (1.2.0: several browsers at once), else the single connection the
 * older fields describe. Empty when nothing is attached.
 */
export function webmateConnections(status: DesktopWebmateStatus | null): DesktopWebmateConnection[] {
  if (!status?.connected) {
    return []
  }

  if (status.connections?.length) {
    return status.connections
  }

  return [
    {
      instanceId: status.instanceId ?? '',
      browser: status.browser,
      extensionVersion: status.extensionVersion,
      installType: status.installType,
      signedIn: status.signedIn,
      protocolVersion: status.protocolVersion,
      lastHelloAt: null,
      paired: true,
      active: true
    }
  ]
}

/** The attached extensions that run in this browser (by the bridge's label), active one first. */
export function connectionsForBrowser(
  status: DesktopWebmateStatus | null,
  browserId: DesktopWebmateBrowser['id']
): DesktopWebmateConnection[] {
  return webmateConnections(status)
    .filter(connection => {
      const id = browserIdFromBridgeLabel(connection.browser)

      return id === null || id === browserId
    })
    .sort((a, b) => Number(b.active) - Number(a.active))
}

/** The attached browsers nobody is signed in to — the ones "Đăng nhập WebMate" would act on. */
export function connectionsNotSignedIn(status: DesktopWebmateStatus | null): DesktopWebmateConnection[] {
  return webmateConnections(status).filter(connection => connection.signedIn === false)
}

/** Is the MCP server switched on? Unknown (backend unreachable) counts as on so the UI never shows a false "off". */
export function webmateEnabled(backend: WebmateBackendStatus | null): boolean {
  return backend?.server ? backend.server.registered && backend.server.enabled : true
}

/**
 * One word for the state of WebMate — overall (no browser given) or for one
 * browser profile. Mirrors the table in §5.3 of the plan.
 */
export function webmateReadiness({ status, backend, browser, profile }: ReadinessInput): WebmateReadiness {
  if (!webmateEnabled(backend)) {
    return 'off'
  }

  const connected = Boolean(status?.connected)
  const connectedBrowserId = browserIdFromBridgeLabel(status?.browser)
  const minProtocol = status?.update?.minProtocol ?? null

  // Which attached extension(s) this card is about: the ones in this browser,
  // else (no browser given) every attached one.
  const mine = browser ? connectionsForBrowser(status, browser.id) : webmateConnections(status)

  if (browser && profile) {
    if (!profile.webmate.installed) {
      return 'notInstalled'
    }

    const thisOne = connected && (mine.length > 0 || connectedBrowserId === null || connectedBrowserId === browser.id)

    if (!thisOne) {
      if (profile.webmate.disabled) {
        return 'installedDisabled'
      }

      return browser.running === false ? 'installedClosed' : 'installedNotConnected'
    }
  } else {
    if (!status?.installedVersion) {
      return 'notInstalled'
    }

    if (!connected) {
      return 'installedNotConnected'
    }
  }

  const protocol = mine.length ? Math.max(...mine.map(c => c.protocolVersion ?? 0)) : (status?.protocolVersion ?? null)

  if (status?.update?.belowMinProtocol || (minProtocol !== null && protocol !== null && protocol < minProtocol)) {
    return 'outdated'
  }

  // Several copies can run in one browser (the person's profile and the
  // Workmate window): one signed in is enough for that browser to be usable.
  const signedIn = mine.length
    ? mine.some(c => c.signedIn === true) || !mine.some(c => c.signedIn === false)
    : status?.signedIn !== false

  if (!signedIn) {
    return 'notSignedIn'
  }

  return 'ready'
}

// ---------------------------------------------------------------------------
// Bridge access
// ---------------------------------------------------------------------------

const bridge = () => window.agentxDesktop?.webmate

const errMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function isWebmateAvailable(): boolean {
  return typeof window !== 'undefined' && Boolean(bridge()?.status)
}

export async function refreshWebmateStatus(): Promise<DesktopWebmateStatus | null> {
  const api = bridge()

  if (!api?.status) {
    return null
  }

  try {
    const status = await api.status()

    $webmateStatus.set(status)

    return status
  } catch {
    return $webmateStatus.get()
  }
}

export async function refreshWebmateBackend(): Promise<WebmateBackendStatus | null> {
  if (typeof window === 'undefined' || !window.agentxDesktop?.api) {
    return null
  }

  try {
    const backend = await getWebmateStatus()

    $webmateBackend.set(backend)

    return backend
  } catch {
    return $webmateBackend.get()
  }
}

export async function scanWebmateBrowsers(force = false): Promise<DesktopWebmateBrowser[]> {
  const api = bridge()

  if (!api?.scan) {
    return []
  }

  $webmateScanning.set(true)

  try {
    const browsers = await api.scan({ force })

    $webmateBrowsers.set(browsers)

    return browsers
  } catch {
    return $webmateBrowsers.get() ?? []
  } finally {
    $webmateScanning.set(false)
  }
}

export async function loadWebmatePrefs(): Promise<DesktopWebmatePrefs | null> {
  const api = bridge()

  if (!api?.getPrefs) {
    return null
  }

  try {
    return await api.getPrefs()
  } catch {
    return null
  }
}

export async function setWebmatePrefs(
  patch: Partial<Omit<DesktopWebmatePrefs, 'schema' | 'updatedAt'>>
): Promise<DesktopWebmatePrefs | null> {
  const api = bridge()

  if (!api?.setPrefs) {
    return null
  }

  try {
    const prefs = await api.setPrefs(patch)
    const current = $webmateStatus.get()

    if (current) {
      $webmateStatus.set({ ...current, prefs })
    }

    return prefs
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Server: register, enable, start
// ---------------------------------------------------------------------------

async function reloadMcp(): Promise<void> {
  const gateway = $gateway.get()

  if (!gateway) {
    throw new Error('AgentX gateway unavailable')
  }

  // confirm: true — the reload is the point of the switch, not a surprise.
  await gateway.request('reload.mcp', { confirm: true }, 180_000)
}

/**
 * Make sure the WebMate MCP server is registered, enabled and running in the
 * gateway. Idempotent: a clean machine gets the catalog entry installed; an
 * existing one only flips `enabled`. `reload.mcp` starts the bridge listener
 * so the extension has something to connect to.
 */
export async function ensureWebmateServer(): Promise<{ ok: boolean; error: string | null }> {
  try {
    const backend = (await refreshWebmateBackend()) ?? $webmateBackend.get()
    let registered = Boolean(backend?.server?.registered)

    if (!registered) {
      const catalog = await getMcpCatalog()
      const entry = catalog.entries.find(item => item.name === WEBMATE_SERVER_NAME)

      if (!entry) {
        return { ok: false, error: 'catalog entry missing' }
      }

      if (!entry.installed) {
        await installMcpCatalogEntry(WEBMATE_SERVER_NAME)
      }

      registered = true
    }

    if (!backend?.server?.enabled) {
      await setMcpServerEnabled(WEBMATE_SERVER_NAME, true)
    }

    await reloadMcp()
    // The skill teaches the agent when to reach for the browser; without it the
    // tools exist but are never picked up on their own.
    await setSkillEnabled(WEBMATE_SKILL_NAME, true).catch(() => undefined)
    await refreshWebmateBackend()

    return { ok: true, error: null }
  } catch (error) {
    return { ok: false, error: errMessage(error) }
  }
}

/** Settings → Trình duyệt switch. */
export async function setWebmateEnabled(enabled: boolean): Promise<boolean> {
  try {
    if (enabled) {
      const ensured = await ensureWebmateServer()

      if (!ensured.ok) {
        throw new Error(ensured.error ?? 'failed')
      }
    } else {
      await setMcpServerEnabled(WEBMATE_SERVER_NAME, false)
      await reloadMcp().catch(() => undefined)
      await refreshWebmateBackend()
    }

    return true
  } catch (error) {
    notify({ kind: 'error', message: translateNow('webmate.settings.toggleFailed'), detail: errMessage(error) })

    return false
  }
}

// ---------------------------------------------------------------------------
// Guided install
// ---------------------------------------------------------------------------

/**
 * "Cài vào trình duyệt này": prepare the folder, make sure the server listens,
 * open the extensions page for that profile and show the folder. From here on
 * the status watcher does the rest — connected flips the panel.
 */
export async function startWebmateGuide(
  browser: DesktopWebmateBrowser,
  profile: DesktopWebmateBrowserProfile | null
): Promise<WebmateGuideState> {
  const api = bridge()

  const state: WebmateGuideState = {
    kind: 'browser',
    browserId: browser.id,
    browserName: browser.name,
    profileDir: profile?.dir ?? null,
    profileName: profile?.displayName ?? null,
    startedAt: Date.now(),
    opened: false,
    navigated: false,
    openError: null,
    folderOpened: false,
    copied: false,
    serverError: null,
    preparing: true
  }

  $webmateGuide.set(state)

  const server = await ensureWebmateServer()

  if (!server.ok) {
    state.serverError = server.error
  }

  let opened: DesktopWebmateOpenGuideResult | null = null

  try {
    opened = (await api?.openGuide?.({ browserId: browser.id, profileDir: profile?.dir ?? null })) ?? null
  } catch (error) {
    opened = {
      ok: false,
      windowOpened: false,
      navigated: false,
      command: null,
      error: errMessage(error),
      folderOpened: false,
      folderError: null,
      browser: null
    }
  }

  const next: WebmateGuideState = {
    ...state,
    preparing: false,
    opened: Boolean(opened?.windowOpened),
    navigated: Boolean(opened?.navigated),
    openError: opened && !opened.windowOpened ? (opened.error ?? 'open-failed') : null,
    folderOpened: Boolean(opened?.folderOpened)
  }

  $webmateGuide.set(next)
  void refreshWebmateStatus()

  return next
}

export async function reopenWebmateGuide(): Promise<void> {
  const guide = $webmateGuide.get()

  if (!guide) {
    return
  }

  const api = bridge()

  try {
    const opened = await api?.openGuide?.({ browserId: guide.browserId, profileDir: guide.profileDir })

    $webmateGuide.set({
      ...guide,
      opened: Boolean(opened?.windowOpened),
      navigated: Boolean(opened?.navigated),
      openError: opened && !opened.windowOpened ? (opened.error ?? 'open-failed') : null
    })
  } catch (error) {
    $webmateGuide.set({ ...guide, opened: false, navigated: false, openError: errMessage(error) })
  }
}

export async function revealWebmateFolder(): Promise<boolean> {
  try {
    const result = await bridge()?.revealFolder?.()

    return Boolean(result?.ok)
  } catch {
    return false
  }
}

const COPY_FLASH_MS = 1500

export async function copyWebmatePath(): Promise<boolean> {
  try {
    const result = await bridge()?.copyPath?.()
    const guide = $webmateGuide.get()

    if (result?.ok && guide) {
      $webmateGuide.set({ ...guide, copied: true })
      window.setTimeout(() => {
        const current = $webmateGuide.get()

        if (current?.copied) {
          $webmateGuide.set({ ...current, copied: false })
        }
      }, COPY_FLASH_MS)
    }

    return Boolean(result?.ok)
  } catch {
    return false
  }
}

export function clearWebmateGuide(): void {
  $webmateGuide.set(null)
}

export async function resetWebmateToken(): Promise<boolean> {
  try {
    const result = await bridge()?.resetToken?.()

    if (result?.ok) {
      notify({ kind: 'success', message: translateNow('webmate.settings.resetTokenDone') })
    }

    void refreshWebmateStatus()

    return Boolean(result?.ok)
  } catch (error) {
    notify({ kind: 'error', message: errMessage(error) })

    return false
  }
}

// ---------------------------------------------------------------------------
// Signed in together (phase 4)
// ---------------------------------------------------------------------------

export const $webmateSigningIn = atom<boolean>(false)

/**
 * "Đăng nhập WebMate bằng tài khoản này": the main process asks the attached
 * browser(s) — interactively by default (a Keycloak tab in that browser with
 * the account pre-filled), silently when `interactive` is false. The status
 * push flips the cards to "Sẵn sàng"; this only reports the outcome.
 */
export async function signInWebmate(
  request: { instanceId?: string | null; interactive?: boolean } = {}
): Promise<DesktopWebmateSignInOutcome | null> {
  const api = bridge()

  if (!api?.signIn || $webmateSigningIn.get()) {
    return null
  }

  $webmateSigningIn.set(true)

  try {
    const outcome = await api.signIn(request)
    const copy = webmateSignInOutcomeCopy(outcome)

    if (copy) {
      notify({ kind: copy.kind, message: copy.message })
    }

    void refreshWebmateStatus()

    return outcome
  } catch (error) {
    notify({ kind: 'error', message: translateNow('webmate.sso.failed', errMessage(error)) })

    return null
  } finally {
    $webmateSigningIn.set(false)
  }
}

/** The toast for a sign-in outcome; null when the status push says everything already. */
export function webmateSignInOutcomeCopy(
  outcome: DesktopWebmateSignInOutcome
): { kind: 'success' | 'info' | 'warning' | 'error'; message: string } | null {
  if (!outcome.sent) {
    return { kind: 'warning', message: translateNow('webmate.sso.notConnected') }
  }

  if (!outcome.result) {
    return { kind: 'warning', message: translateNow('webmate.sso.noAnswer') }
  }

  const results = outcome.result.results ?? []
  const signedIn = results.find(entry => entry.signedIn)

  if (signedIn) {
    return {
      kind: 'success',
      message: signedIn.email
        ? translateNow('webmate.sso.signedInAs', signedIn.email)
        : translateNow('webmate.sso.signedIn')
    }
  }

  if (results.some(entry => entry.outcome === 'login-required')) {
    return { kind: 'info', message: translateNow('webmate.sso.loginRequired') }
  }

  if (results.some(entry => entry.outcome === 'unsupported')) {
    return { kind: 'warning', message: translateNow('webmate.sso.unsupported') }
  }

  if (!outcome.ok) {
    const failed = results.find(entry => !entry.ok)

    return {
      kind: 'error',
      message: translateNow(
        'webmate.sso.failed',
        failed?.message ?? outcome.error ?? translateNow('webmate.sso.noAnswer')
      )
    }
  }

  if (!results.length) {
    return { kind: 'info', message: translateNow('webmate.sso.nothingToDo') }
  }

  return null
}

/** Settings → "Trình duyệt để đăng nhập": remembered by the main process; the guided install uses the same choice. */
export async function chooseWebmateBrowser(
  browserId: string,
  profileDir: string | null
): Promise<DesktopWebmatePrefs['browser']> {
  const api = bridge()

  if (!api?.chooseBrowser) {
    return null
  }

  try {
    const chosen = await api.chooseBrowser({ browserId, profileDir })

    void refreshWebmateStatus()

    return chosen
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// The Workmate browser window (phase 3)
// ---------------------------------------------------------------------------

/** Whether any Chromium-based browser Workmate could run was found (null = not scanned yet). */
export function hasChromiumBrowser(browsers: DesktopWebmateBrowser[] | null): boolean | null {
  if (browsers === null) {
    return null
  }

  return browsers.some(browser => browser.supported && browser.executable)
}

/**
 * "Dùng cửa sổ riêng": make sure the bridge server is up, ask the main process
 * to start the window with the extension loaded, and show the same waiting →
 * connected panel the guided install uses (kind 'window').
 */
export async function openWebmateWindow(browserId?: string | null): Promise<DesktopWebmateOpenWindowResult> {
  const api = bridge()

  if (!api?.openWindow) {
    return { ok: false, error: 'unavailable', window: closedWindow() }
  }

  const startedAt = Date.now()

  $webmateGuide.set({
    kind: 'window',
    browserId: browserId ?? '',
    browserName: '',
    profileDir: null,
    profileName: null,
    startedAt,
    opened: false,
    navigated: false,
    openError: null,
    folderOpened: false,
    copied: false,
    serverError: null,
    preparing: true
  })

  const server = await ensureWebmateServer()
  let result: DesktopWebmateOpenWindowResult

  try {
    result = await api.openWindow({ browserId: browserId ?? null })
  } catch (error) {
    result = { ok: false, error: errMessage(error), window: closedWindow() }
  }

  const current = $webmateGuide.get()

  if (current?.kind === 'window' && current.startedAt === startedAt) {
    $webmateGuide.set({
      ...current,
      preparing: false,
      browserId: result.window.browserId ?? current.browserId,
      browserName: result.window.browserName ?? '',
      opened: result.ok,
      navigated: result.ok,
      openError: result.ok ? null : (result.error ?? 'open-failed'),
      serverError: server.ok ? null : server.error
    })
  }

  void refreshWebmateStatus()

  return result
}

export async function closeWebmateWindow(): Promise<DesktopWebmateWindowStatus | null> {
  try {
    const status = (await bridge()?.closeWindow?.()) ?? null

    void refreshWebmateStatus()

    return status
  } catch {
    return null
  }
}

/** Settings → "Workmate làm việc trong trình duyệt nào". Switching away from the window closes it. */
export async function setWebmateMode(mode: 'browser' | 'window'): Promise<void> {
  await setWebmatePrefs({ mode })

  if (mode === 'browser' && $webmateStatus.get()?.window?.open) {
    await closeWebmateWindow()
  }
}

function closedWindow(): DesktopWebmateWindowStatus {
  return {
    open: false,
    phase: 'closed',
    pid: null,
    browserId: null,
    browserName: null,
    extensionId: null,
    startedAt: null,
    error: null,
    exitCode: null
  }
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

const UPDATE_TOAST_ID = 'webmate-update-available'
const MANDATORY_TOAST_ID = 'webmate-update-required'
const UPDATE_TOAST_COOLDOWN_MS = 24 * 60 * 60 * 1000

function patchUpdate(patch: Partial<WebmateUpdateState>) {
  $webmateUpdate.set({ ...$webmateUpdate.get(), ...patch })
}

function snoozeUpdateToast(): void {
  void setWebmatePrefs({ updateToastSnoozedUntil: new Date(Date.now() + UPDATE_TOAST_COOLDOWN_MS).toISOString() })
}

function isUpdateToastSnoozed(): boolean {
  const until = $webmateStatus.get()?.prefs.updateToastSnoozedUntil

  return Boolean(until && Date.parse(until) > Date.now())
}

/**
 * Toast for a newer signed release, at most once per 24 h (closing it
 * snoozes). A release the attached extension is too old for is mandatory:
 * a warning that comes back on every check until the update lands.
 */
export function maybeNotifyWebmateUpdate(check: DesktopWebmateUpdateCheck | null): void {
  if (!check || !check.feed) {
    dismissNotification(MANDATORY_TOAST_ID)

    return
  }

  if (check.belowMinProtocol && !$webmateUpdate.get().applying) {
    notify({
      action: { label: translateNow('webmate.update.toastAction'), onClick: () => void applyWebmateUpdate() },
      durationMs: 0,
      id: MANDATORY_TOAST_ID,
      kind: 'warning',
      message: translateNow('webmate.update.mandatoryBody'),
      title: translateNow('webmate.update.mandatoryTitle')
    })

    return
  }

  dismissNotification(MANDATORY_TOAST_ID)

  if (!check.available || $webmateUpdate.get().applying || isUpdateToastSnoozed()) {
    return
  }

  // Auto-update installs it without asking; the toast is for the opt-out.
  if ($webmateStatus.get()?.prefs.autoUpdate) {
    return
  }

  notify({
    action: {
      label: translateNow('webmate.update.toastAction'),
      onClick: () => {
        snoozeUpdateToast()
        void applyWebmateUpdate()
      }
    },
    durationMs: 0,
    icon: 'cloud-download',
    id: UPDATE_TOAST_ID,
    kind: 'info',
    message: translateNow('webmate.update.toastBody', check.feed.version),
    onDismiss: () => snoozeUpdateToast(),
    title: translateNow('webmate.update.toastTitle')
  })
}

export async function checkWebmateUpdate(): Promise<DesktopWebmateUpdateCheck | null> {
  const api = bridge()

  if (!api?.checkUpdate || $webmateUpdate.get().checking) {
    return $webmateUpdate.get().check
  }

  patchUpdate({ checking: true })

  try {
    const check = await api.checkUpdate()

    patchUpdate({ check })
    maybeNotifyWebmateUpdate(check)
    void refreshWebmateStatus()

    return check
  } catch {
    return $webmateUpdate.get().check
  } finally {
    patchUpdate({ checking: false })
  }
}

export async function applyWebmateUpdate(): Promise<DesktopWebmateApplyOutcome | null> {
  const api = bridge()

  if (!api?.applyUpdate || $webmateUpdate.get().applying) {
    return $webmateUpdate.get().lastOutcome
  }

  dismissNotification(UPDATE_TOAST_ID)
  patchUpdate({ applying: true, progress: null })

  try {
    const outcome = await api.applyUpdate()

    patchUpdate({ lastOutcome: outcome })

    if (outcome.ok) {
      dismissNotification(MANDATORY_TOAST_ID)
      notify({
        kind: 'success',
        message: translateNow('webmate.update.doneToast', outcome.version),
        placement: 'default'
      })
    } else if (!outcome.pending) {
      notify({
        kind: 'error',
        message: translateNow(
          'webmate.update.failedToast',
          outcome.error ?? translateNow('webmate.update.stages.error')
        )
      })
    }

    void refreshWebmateStatus()
    void checkWebmateUpdate()

    return outcome
  } catch (error) {
    notify({ kind: 'error', message: translateNow('webmate.update.failedToast', errMessage(error)) })

    return null
  } finally {
    patchUpdate({ applying: false })
  }
}

// ---------------------------------------------------------------------------
// The "Workmate wants to use your browser" card
// ---------------------------------------------------------------------------

const CARD_SNOOZE_MS = 24 * 60 * 60 * 1000

/**
 * A webmate tool just failed with a code. Show the card at most once per
 * session, never while snoozed ("Không phải bây giờ") or opted out
 * ("Đừng hỏi lại" / Settings → Không hỏi), and never for a code the card
 * cannot help with in this session (port in use is a toast, not a card).
 */
export function reportWebmateToolCode(code: WebmateCode): void {
  const prefs = $webmateStatus.get()?.prefs

  if (prefs && !prefs.askWhenNotReady) {
    return
  }

  if (prefs?.cardSnoozedUntil && Date.parse(prefs.cardSnoozedUntil) > Date.now()) {
    return
  }

  if (promptShownThisSession || $webmatePrompt.get()) {
    return
  }

  promptShownThisSession = true
  $webmatePrompt.set({ code, at: Date.now() })
}

/** Inspect a `tool.complete` payload; shows the card when it carries a WEBMATE_* code. */
export function reportWebmateToolPayload(payload: unknown): WebmateCode | null {
  const code = webmateCodeFromToolPayload(payload)

  if (code) {
    reportWebmateToolCode(code)
  }

  return code
}

export function dismissWebmatePrompt(choice: 'notNow' | 'never' | 'acted'): void {
  $webmatePrompt.set(null)

  if (choice === 'notNow') {
    void setWebmatePrefs({ cardSnoozedUntil: new Date(Date.now() + CARD_SNOOZE_MS).toISOString() })
  } else if (choice === 'never') {
    void setWebmatePrefs({ askWhenNotReady: false })
  }
}

/** Test seam. */
export function resetWebmatePromptSession(): void {
  promptShownThisSession = false
  $webmatePrompt.set(null)
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let unsubscribeStatus: (() => void) | null = null
let unsubscribeProgress: (() => void) | null = null
let started = false

/** Subscribe to the main process's status pushes and load the first snapshot. Idempotent. */
export function startWebmateWatcher(): void {
  if (started || typeof window === 'undefined') {
    return
  }

  const api = bridge()

  if (!api?.subscribe) {
    return
  }

  started = true
  unsubscribeStatus = api.subscribe(status => $webmateStatus.set(status))
  unsubscribeProgress =
    api.onUpdateProgress?.(progress => {
      patchUpdate({ progress })
    }) ?? null
  void refreshWebmateStatus()
  void refreshWebmateBackend()
}

export function stopWebmateWatcher(): void {
  unsubscribeStatus?.()
  unsubscribeProgress?.()
  unsubscribeStatus = null
  unsubscribeProgress = null
  started = false
}
