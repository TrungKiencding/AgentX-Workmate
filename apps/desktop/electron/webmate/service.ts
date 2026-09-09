/**
 * The one object main.ts talks to for WebMate. It owns the status watcher,
 * the browser scan cache, prefs, the guided-install actions and the updater,
 * and pushes changes to every renderer window. main.ts only registers the
 * `agentx:webmate:*` IPC handlers that call into it (constraint 6).
 *
 * Side effects that belong to Electron (shell.openPath, clipboard, the window
 * list) are injected so this module stays a plain Node module with tests.
 */

import { promises as fsp } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { type BootstrapResult, bootstrapWebmate } from './bootstrap'
import {
  chooseWindowBrowser,
  type WindowLaunchOptions,
  type WindowStatus,
  WorkmateBrowserWindow
} from './browser-window'
import { type BrowserInfo, type BrowserScanIo, defaultBrowserScanIo, scanBrowsers } from './browsers'
import {
  parseLastCommand,
  sendWebmateCommand,
  waitForCommandResult,
  type WebmateCommandAction,
  type WebmateCommandPayload,
  type WebmateLastCommand
} from './commands'
import {
  type ExecCapture,
  openExtensionsPage,
  type OpenGuideResult,
  openUrlInBrowser,
  type SpawnDetached
} from './guide'
import { defaultPairingIo, ensurePairing, type PairingFile, type PairingOptions, parsePairingFile } from './pairing'
import { WEBMATE_BRIDGE_PORT, WEBMATE_MIN_SERVER_VERSION, type WebmatePaths, webmatePaths } from './paths'
import {
  prefsFile,
  readPrefs,
  type WebmateChosenBrowser,
  type WebmatePrefs,
  type WebmatePrefsPatch,
  writePrefs
} from './prefs'
import {
  parseReleaseManifest,
  type ParseReleaseOptions,
  type ReleaseManifest,
  WEBMATE_RELEASE_FEED_URL,
  WEBMATE_RELEASE_PUBLIC_KEY
} from './release-feed'
import { chooseLoginTarget, chosenBrowserFrom, planAuthHints } from './sso'
import { readWebmateStatus, type WebmateLocalStatus, WebmateStatusWatcher } from './status'
import {
  type ApplyOutcome,
  applyPendingSwap,
  type ApplyStage,
  applyWebmateUpdate,
  checkWebmateUpdate,
  readUpdateCheck,
  restorePrevious,
  type UpdateCheckFile,
  writeUpdateCheck
} from './updater'

export const WEBMATE_STATUS_CHANNEL = 'agentx:webmate:status'
export const WEBMATE_UPDATE_PROGRESS_CHANNEL = 'agentx:webmate:update:progress'

/** Largest package the updater will download (the Chrome zip is ~5 MB). */
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024

export interface WebmateServiceDeps {
  agentxHome: string
  resourcesPath: string | null
  appRoot: string
  appVersion: string
  isPackaged: boolean
  env?: NodeJS.ProcessEnv
  log?: (message: string) => void
  /** Deliver a payload to every renderer window. */
  broadcast: (channel: string, payload: unknown) => void
  /** shell.openPath: resolves '' on success, an error message otherwise. */
  openPath: (dir: string) => Promise<string>
  writeClipboard: (text: string) => void
  spawnDetached?: SpawnDetached
  /** Runs osascript / powershell for the second move of the guide. */
  execCapture?: ExecCapture
  scanIo?: BrowserScanIo
  fetchImpl?: typeof fetch
  platform?: NodeJS.Platform
  /**
   * Phase 4: the email of the AgentX account Workmate is signed in as (null
   * when signed out). It is the login_hint every `auth_hint` carries.
   */
  accountEmail?: () => string | null
  /** shell.openExternal — the fallback when no chosen browser can take a URL. */
  openExternal?: (url: string) => Promise<void>
}

export interface UpdateProgressPayload {
  stage: ApplyStage
  message: string
  version: string
  at: number
}

export interface OpenGuideRequest {
  browserId: string
  profileDir: string | null
}

export interface OpenGuideOutcome extends OpenGuideResult {
  folderOpened: boolean
  folderError: string | null
  browser: string | null
}

/** What the renderer receives: the file-based status plus the Workmate browser window's state. */
export interface WebmateServiceStatus extends WebmateLocalStatus {
  window: WindowStatus
}

export interface OpenWindowOutcome {
  ok: boolean
  error: string | null
  window: WindowStatus
}

/** The answer to "sign WebMate in with my account" (Settings, the prompt card, the onboarding step). */
export interface SignInOutcome {
  ok: boolean
  /** Whether the server was even asked (false: no browser attached). */
  sent: boolean
  commandId: string | null
  result: WebmateLastCommand | null
  error: string | null
}

export interface OpenLoginOutcome {
  /** Where the page went. */
  target: 'window' | 'browser' | 'system'
  ok: boolean
  error: string | null
}

/** How long to wait for the server's answer to a sign-in command (its own per-browser deadline is 90 s). */
const AUTH_COMMAND_WAIT_MS = 100_000

export class WebmateService {
  readonly paths: WebmatePaths
  private watcher: WebmateStatusWatcher | null = null
  private browsers: BrowserInfo[] | null = null
  private scanInFlight: Promise<BrowserInfo[]> | null = null
  private applyInFlight: Promise<ApplyOutcome> | null = null
  private checkInFlight: Promise<UpdateCheckFile> | null = null
  private bootstrapInFlight: Promise<BootstrapResult> | null = null
  private pendingSwapInFlight = false
  private readonly log: (message: string) => void
  private readonly env: NodeJS.ProcessEnv
  private readonly platform: NodeJS.Platform
  /** The Workmate browser window (phase 3): the person's Chromium binary on our own profile. */
  private readonly window: WorkmateBrowserWindow
  private windowOptions: WindowLaunchOptions | null = null
  /** Phase 4: when each attached browser was last told to sign in silently (per instance id, this session). */
  private readonly lastHintAt = new Map<string, number>()
  private hintInFlight: Promise<void> | null = null

  constructor(private readonly deps: WebmateServiceDeps) {
    this.paths = webmatePaths(deps.agentxHome)
    this.log = deps.log ?? (() => {})
    this.env = deps.env ?? process.env
    this.platform = deps.platform ?? process.platform
    this.window = new WorkmateBrowserWindow({
      log: this.log,
      onChange: () => this.broadcastStatus()
    })
  }

  // -- lifecycle ------------------------------------------------------------

  start(): void {
    if (this.watcher) {
      return
    }

    this.watcher = new WebmateStatusWatcher({
      paths: this.paths,
      onChange: status => {
        this.broadcastStatus(status)
        void this.rememberConnection(status)
        void this.applyPendingIfIdle(status)
        void this.maybeHintSignIn(status)
      }
    })
    this.watcher.start()
  }

  /** On quit: stop watching and close the Workmate browser window (Browser.close, then kill). */
  stop(): Promise<void> {
    this.watcher?.stop()
    this.watcher = null

    return this.window.close()
  }

  private decorate(status: WebmateLocalStatus): WebmateServiceStatus {
    return { ...status, window: this.window.current() }
  }

  private broadcastStatus(status?: WebmateLocalStatus): void {
    const base = status ?? (this.watcher ? this.watcher.current() : readWebmateStatus(this.paths))

    this.deps.broadcast(WEBMATE_STATUS_CHANNEL, this.decorate(base))
  }

  /** A fresh read (and a broadcast if anything changed), with the window's state attached. */
  status(): WebmateServiceStatus {
    return this.decorate(this.watcher ? this.watcher.refresh() : readWebmateStatus(this.paths))
  }

  // -- the Workmate browser window ------------------------------------------

  windowStatus(): WindowStatus {
    return this.window.current()
  }

  /**
   * Open the Workmate browser window: the remembered (or default, or first)
   * Chromium-based browser on `<webmate>/profile` with the extension folder
   * loaded over the CDP pipe. The hello follows through state.json.
   */
  async openWindow(request: { browserId?: string | null } = {}): Promise<OpenWindowOutcome> {
    await this.bootstrap()
    const browsers = await this.scan()
    const browser = chooseWindowBrowser(browsers, request.browserId ?? this.getPrefs().browser?.id ?? null)

    if (!browser) {
      return { ok: false, error: 'no-chromium-browser', window: this.window.current() }
    }

    const server = await this.ensureServerForWindow()

    if (server) {
      this.log(`[webmate] window: bridge server not confirmed (${server}); opening anyway`)
    }

    this.setPrefs({
      mode: 'window',
      browser: { id: browser.id, name: browser.name, profileDir: null, profileName: null }
    })

    const options: WindowLaunchOptions = {
      browser,
      profileDir: this.paths.profileDir,
      installDir: this.paths.installDir
    }

    try {
      await fsp.mkdir(this.paths.profileDir, { recursive: true })
      const status = await this.window.open(options)

      this.windowOptions = options

      return { ok: true, error: null, window: status }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), window: this.window.current() }
    }
  }

  /** The renderer owns registering/enabling the MCP server (REST + reload.mcp); nothing to do here yet. */
  private async ensureServerForWindow(): Promise<string | null> {
    return this.status().serverRunning ? null : 'bridge server is not listening'
  }

  async closeWindow(): Promise<WindowStatus> {
    await this.window.close()

    return this.window.current()
  }

  // -- folder + pairing (phase 1, re-exposed) --------------------------------

  bootstrap(): Promise<BootstrapResult> {
    if (!this.bootstrapInFlight) {
      this.bootstrapInFlight = bootstrapWebmate({
        agentxHome: this.deps.agentxHome,
        resourcesPath: this.deps.resourcesPath,
        appRoot: this.deps.appRoot,
        appVersion: this.deps.appVersion,
        isPackaged: this.deps.isPackaged,
        log: this.log
      }).finally(() => {
        this.bootstrapInFlight = null
        this.status()
      })
    }

    return this.bootstrapInFlight
  }

  // -- browsers + guide -----------------------------------------------------

  scan(force = false): Promise<BrowserInfo[]> {
    if (this.scanInFlight) {
      return this.scanInFlight
    }

    if (this.browsers && !force) {
      return Promise.resolve(this.browsers)
    }

    this.scanInFlight = scanBrowsers(this.paths.installDir, this.deps.scanIo ?? defaultBrowserScanIo())
      .then(result => {
        this.browsers = result

        return result
      })
      .catch(error => {
        this.log(`[webmate] browser scan failed: ${error instanceof Error ? error.message : String(error)}`)

        return this.browsers ?? []
      })
      .finally(() => {
        this.scanInFlight = null
      })

    return this.scanInFlight
  }

  /**
   * Open the chosen browser's extensions page for the chosen profile, show the
   * folder to drag, and remember the choice. The folder is prepared first so
   * the person never drags an empty directory.
   */
  async openGuide(request: OpenGuideRequest): Promise<OpenGuideOutcome> {
    await this.bootstrap()
    const browsers = await this.scan()
    const browser = browsers.find(candidate => candidate.id === request.browserId)

    if (!browser) {
      return {
        ok: false,
        windowOpened: false,
        navigated: false,
        command: null,
        error: 'browser-not-found',
        folderOpened: false,
        folderError: null,
        browser: null
      }
    }

    const profile = browser.profiles.find(candidate => candidate.dir === request.profileDir) ?? null

    this.setPrefs({
      mode: 'browser',
      browser: {
        id: browser.id,
        name: browser.name,
        profileDir: profile?.dir ?? request.profileDir,
        profileName: profile?.displayName ?? null
      }
    })

    const opened = await openExtensionsPage(
      { browser, profileDir: profile?.dir ?? request.profileDir },
      this.platform,
      {
        run: this.deps.spawnDetached,
        exec: this.deps.execCapture
      }
    )

    this.log(
      `[webmate] guide for ${browser.name}: window ${opened.windowOpened ? 'opened' : 'NOT opened'}, extensions page ${opened.navigated ? 'reached' : 'not reached'}${opened.error ? ` (${opened.error})` : ''}${opened.command ? ` — ${opened.command}` : ''}`
    )

    const folderError = await this.revealFolder()

    return { ...opened, folderOpened: folderError === null, folderError, browser: browser.name }
  }

  /** Show `<webmate>/` in Finder / Explorer so "AgentX WebMate" can be dragged. */
  async revealFolder(): Promise<string | null> {
    try {
      await fsp.mkdir(this.paths.root, { recursive: true })
      const error = await this.deps.openPath(this.paths.root)

      return error ? error : null
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  copyPath(): { ok: boolean; path: string } {
    try {
      this.deps.writeClipboard(this.paths.installDir)

      return { ok: true, path: this.paths.installDir }
    } catch {
      return { ok: false, path: this.paths.installDir }
    }
  }

  // -- prefs ----------------------------------------------------------------

  getPrefs(): WebmatePrefs {
    return readPrefs(prefsFile(this.paths, { join: (...parts) => parts.join(this.platform === 'win32' ? '\\' : '/') }))
  }

  setPrefs(patch: WebmatePrefsPatch): WebmatePrefs {
    const next = writePrefs(this.prefsPath(), patch)

    this.status()

    return next
  }

  private prefsPath(): string {
    return prefsFile(this.paths, { join: (...parts) => parts.join(this.platform === 'win32' ? '\\' : '/') })
  }

  /** The first paired hello is worth remembering: it flips the onboarding step and Settings to "connected". */
  private async rememberConnection(status: WebmateLocalStatus): Promise<void> {
    if (status.connected && status.installType === 'workmate' && !status.prefs.connectedAt) {
      this.setPrefs({ connectedAt: new Date(status.readAt).toISOString() })
    }
  }

  // -- pairing --------------------------------------------------------------

  /** "Đặt lại token": new token in pairing.json and workmate.json, then a reload so the extension re-dials with it. */
  resetToken(): { ok: boolean; reloaded: boolean } {
    const outcome = ensurePairing(this.paths, {
      port: WEBMATE_BRIDGE_PORT,
      workmateVersion: this.deps.appVersion,
      minServerVersion: WEBMATE_MIN_SERVER_VERSION,
      rotate: true
    })

    let reloaded = false

    if (this.status().connected) {
      this.sendCommand('reload')
      reloaded = true
    }

    this.log(
      `[webmate] pairing token reset (workmate.json ${outcome.workmateJsonWritten ? 'rewritten' : 'not present'})`
    )

    return { ok: outcome.pairingWritten, reloaded }
  }

  // -- sign-in (phase 4) ----------------------------------------------------

  /**
   * A browser just reported "connected · not signed in" (or a new one
   * attached): ask the server to sign it in silently with the account
   * Workmate is signed in as. Once per browser per cooldown; nothing when
   * the person switched the preference off or Workmate itself is signed out.
   */
  private async maybeHintSignIn(status: WebmateLocalStatus): Promise<void> {
    if (this.hintInFlight) {
      return
    }

    const email = this.deps.accountEmail?.() ?? null
    const decision = planAuthHints(status.connections, status.prefs, email, this.lastHintAt, Date.now())

    if (!decision.instanceIds.length || !email) {
      return
    }

    const now = Date.now()

    for (const instanceId of decision.instanceIds) {
      this.lastHintAt.set(instanceId, now)
    }

    this.hintInFlight = (async () => {
      const id = this.sendCommand('auth_hint', { loginHint: email })

      this.log(`[webmate] sign-in hint for ${decision.instanceIds.length} browser(s) as ${email} (command ${id})`)

      const result = await waitForCommandResult(id, {
        timeoutMs: AUTH_COMMAND_WAIT_MS,
        readLastCommand: () => this.readLastCommand()
      })

      this.log(`[webmate] sign-in hint ${id}: ${describeAuthResult(result)}`)
    })()
      .catch(error => {
        this.log(`[webmate] sign-in hint failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => {
        this.hintInFlight = null
      })

    await this.hintInFlight
  }

  /**
   * "Đăng nhập WebMate bằng tài khoản này": interactive by default (a tab on
   * Keycloak in the browser WebMate runs in, account pre-filled); silent when
   * asked (the hint, re-sent by hand). Waits for the server's answer.
   */
  async signInExtension(request: { instanceId?: string | null; interactive?: boolean } = {}): Promise<SignInOutcome> {
    const email = this.deps.accountEmail?.() ?? null
    const status = this.status()

    if (!status.connected) {
      return { ok: false, sent: false, commandId: null, result: null, error: 'not-connected' }
    }

    const payload: WebmateCommandPayload = {
      ...(email ? { loginHint: email } : {}),
      ...(request.instanceId ? { instanceId: request.instanceId } : {}),
      ...(request.interactive === false ? { force: true } : {})
    }

    const action: WebmateCommandAction = request.interactive === false ? 'auth_hint' : 'auth_open'
    const id = this.sendCommand(action, payload)

    this.log(`[webmate] ${action} requested (command ${id}${email ? `, ${email}` : ''})`)

    const result = await waitForCommandResult(id, {
      timeoutMs: AUTH_COMMAND_WAIT_MS,
      readLastCommand: () => this.readLastCommand()
    })

    this.log(`[webmate] ${action} ${id}: ${describeAuthResult(result)}`)
    this.status()

    if (!result) {
      return { ok: false, sent: true, commandId: id, result: null, error: 'no-answer' }
    }

    return { ok: result.ok, sent: true, commandId: id, result, error: result.ok ? null : (result.error ?? 'failed') }
  }

  /**
   * Where Workmate's own sign-in page opens (main.ts hands every Keycloak
   * URL here): the Workmate browser window when that mode is on and open, the
   * browser/profile the person chose for WebMate, else the system browser as
   * before. Landing the SSO cookie in the browser WebMate lives in is what
   * lets the silent sign-in there succeed.
   */
  async openLoginUrl(url: string): Promise<OpenLoginOutcome> {
    const prefs = this.getPrefs()
    const browsers = this.browsers ?? (await this.scan())
    const target = chooseLoginTarget(prefs, this.window.isOpen(), browsers)

    if (target.kind === 'window') {
      const opened = await this.window.openUrl(url)

      if (opened.ok) {
        this.log('[webmate] sign-in page opened in the Workmate browser window')

        return { target: 'window', ok: true, error: null }
      }

      this.log(`[webmate] sign-in page: the window refused (${opened.error}); using the system browser`)
    } else if (target.kind === 'browser') {
      const opened = await openUrlInBrowser(
        { browser: target.browser, profileDir: target.profileDir },
        url,
        this.platform,
        { run: this.deps.spawnDetached }
      )

      if (opened.ok) {
        this.log(
          `[webmate] sign-in page opened in ${target.browser.name}${target.profileDir ? ` (${target.profileDir})` : ''} — ${opened.command}`
        )

        return { target: 'browser', ok: true, error: null }
      }

      this.log(`[webmate] sign-in page: ${target.browser.name} refused (${opened.error}); using the system browser`)
    } else {
      this.log(`[webmate] sign-in page: system browser (${target.reason})`)
    }

    if (!this.deps.openExternal) {
      return { target: 'system', ok: false, error: 'no-opener' }
    }

    try {
      await this.deps.openExternal(url)

      return { target: 'system', ok: true, error: null }
    } catch (error) {
      return { target: 'system', ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Settings → "Chọn trình duyệt": remember which browser/profile Workmate signs in with and installs into. */
  async chooseBrowser(request: { browserId: string; profileDir: string | null }): Promise<WebmateChosenBrowser | null> {
    const browsers = await this.scan()
    const browser = browsers.find(candidate => candidate.id === request.browserId && candidate.supported)

    if (!browser) {
      return null
    }

    const chosen = chosenBrowserFrom(browser, request.profileDir)

    this.setPrefs({ browser: chosen, mode: 'browser' })

    return chosen
  }

  // -- commands -------------------------------------------------------------

  private sendCommand(action: WebmateCommandAction, payload?: WebmateCommandPayload): string {
    return sendWebmateCommand(this.paths, action, undefined, undefined, payload)
  }

  private readLastCommand(): WebmateLastCommand | null {
    return parseLastCommand(readWebmateStatus(this.paths).lastCommand)
  }

  // -- updates --------------------------------------------------------------

  private get devOverrides(): { feedUrl: string; publicKeyPem: string; parseOptions: ParseReleaseOptions } {
    // A development build may point the feed at a local file signed with a
    // test key to rehearse the whole update + rollback path. A packaged app
    // never reads these: the feed URL and key are compiled in.
    const dev = !this.deps.isPackaged

    return {
      feedUrl: (dev && this.env.AGENTX_WEBMATE_FEED_URL) || WEBMATE_RELEASE_FEED_URL,
      publicKeyPem:
        (dev && this.env.AGENTX_WEBMATE_FEED_PUBLIC_KEY?.replace(/\\n/g, '\n')) || WEBMATE_RELEASE_PUBLIC_KEY,
      parseOptions: { allowFileUrls: dev }
    }
  }

  private async fetchBytes(url: string): Promise<Buffer> {
    const parsed = new URL(url)

    if (parsed.protocol === 'file:') {
      if (this.deps.isPackaged) {
        throw new Error('file: URLs are not allowed in a packaged app')
      }

      return fsp.readFile(fileURLToPath(parsed))
    }

    const fetchImpl = this.deps.fetchImpl ?? fetch

    const response = await fetchImpl(url, {
      cache: 'no-store',
      redirect: 'follow',
      headers: { accept: 'application/json, application/octet-stream;q=0.9, */*;q=0.8' }
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }

    const length = Number(response.headers.get('content-length') || 0)

    if (length > MAX_PACKAGE_BYTES) {
      throw new Error(`response too large (${length} bytes)`)
    }

    const bytes = Buffer.from(await response.arrayBuffer())

    if (bytes.length > MAX_PACKAGE_BYTES) {
      throw new Error(`response too large (${bytes.length} bytes)`)
    }

    return bytes
  }

  checkUpdate(): Promise<UpdateCheckFile> {
    if (this.checkInFlight) {
      return this.checkInFlight
    }

    const { feedUrl, publicKeyPem, parseOptions } = this.devOverrides
    const status = this.status()

    this.checkInFlight = checkWebmateUpdate({
      paths: this.paths,
      appVersion: this.deps.appVersion,
      fetchText: async url => (await this.fetchBytes(url)).toString('utf8'),
      feedUrl,
      publicKeyPem,
      parseOptions,
      protocolVersion: status.protocolVersion,
      log: this.log
    })
      .then(check => {
        this.status()

        if (check.available && this.getPrefs().autoUpdate && !this.applyInFlight) {
          this.log(`[webmate] ${check.feed?.version} is available; auto-update is on`)
          void this.applyUpdate()
        }

        return check
      })
      .finally(() => {
        this.checkInFlight = null
      })

    return this.checkInFlight
  }

  /** Install the release the last check found. Guarded: one apply at a time. */
  applyUpdate(): Promise<ApplyOutcome> {
    if (this.applyInFlight) {
      return this.applyInFlight
    }

    this.applyInFlight = this.runApply().finally(() => {
      this.applyInFlight = null
      this.status()
    })

    return this.applyInFlight
  }

  private async runApply(): Promise<ApplyOutcome> {
    const check = readUpdateCheck(this.paths)
    const version = check.feed?.version ?? ''

    const failed = (error: string): ApplyOutcome => {
      this.progress('error', error, version)

      return { ok: false, version, stage: 'error', error, rolledBack: false, pending: false, live: false }
    }

    if (!check.feed) {
      return failed('no release known; check for updates first')
    }

    if (!check.available && check.pendingVersion !== check.feed.version) {
      return failed(check.blockedByMinWorkmate ? 'this release needs a newer Workmate' : 'nothing to install')
    }

    const pairing = parsePairingFile(defaultPairingIo().readText(this.paths.pairingFile))

    if (!pairing) {
      // Make one; the swapped-in folder must carry a token the server knows.
      await this.bootstrap()
    }

    const ensured = parsePairingFile(defaultPairingIo().readText(this.paths.pairingFile))

    if (!ensured) {
      return failed('pairing could not be created')
    }

    let release

    try {
      release = parseReleaseManifest(
        {
          schema: 1,
          version: check.feed.version,
          publishedAt: check.feed.publishedAt || new Date(0).toISOString(),
          chrome: check.feed.chrome,
          minWorkmate: check.feed.minWorkmate,
          minProtocol: check.feed.minProtocol,
          notes: check.feed.notes
        },
        this.devOverrides.parseOptions
      )
    } catch (error) {
      return failed(`cached release is unusable: ${error instanceof Error ? error.message : String(error)}`)
    }

    const pairingOptions = {
      port: WEBMATE_BRIDGE_PORT,
      workmateVersion: this.deps.appVersion,
      minServerVersion: WEBMATE_MIN_SERVER_VERSION
    }

    if (this.window.isOpen() && this.windowOptions) {
      return this.runApplyViaWindow(release, ensured, pairingOptions, this.windowOptions)
    }

    return applyWebmateUpdate({
      paths: this.paths,
      release,
      pairing: ensured,
      pairingOptions,
      download: url => this.fetchBytes(url),
      readStatus: () => this.status(),
      sendCommand: action => this.sendCommand(action),
      waitForCommand: (id, timeoutMs) =>
        waitForCommandResult(id, { timeoutMs, readLastCommand: () => this.readLastCommand() }),
      onProgress: (stage, message) => this.progress(stage, message, release.version),
      log: this.log
    })
  }

  /**
   * Update while the Workmate browser window is open. chrome.runtime.reload()
   * on a CDP-loaded extension unloads it for good, so instead: drain, close
   * the window, swap the folder (the closed-browser path of the updater), open
   * the window again, and wait for the new version's hello; no hello means the
   * previous folder comes back and the window is opened once more.
   */
  private async runApplyViaWindow(
    release: ReleaseManifest,
    pairing: PairingFile,
    pairingOptions: PairingOptions,
    options: WindowLaunchOptions
  ): Promise<ApplyOutcome> {
    const version = release.version

    const fail = (stage: ApplyStage, error: string, extra: Partial<ApplyOutcome> = {}): ApplyOutcome => {
      this.progress('error', error, version)

      return { ok: false, version, stage, error, rolledBack: false, pending: false, live: true, ...extra }
    }

    // 1. drain — the extension stops taking new runs and tells us when it is idle.
    if (this.status().connected) {
      this.progress('drain', version, version)
      const id = this.sendCommand('prepare_update')

      const result = await waitForCommandResult(id, {
        timeoutMs: 65_000,
        readLastCommand: () => this.readLastCommand()
      })

      if (result && !result.ok && (result.busy ?? 0) > 0) {
        this.sendCommand('resume')

        return fail('drain', result.error || `browser still busy (${result.busy} run(s))`)
      }
    }

    // 2. close the window so nothing holds the folder.
    this.progress('reload', version, version)
    await this.window.close()

    // 3. swap through the updater's closed-browser path.
    const swapped = await applyWebmateUpdate({
      paths: this.paths,
      release,
      pairing,
      pairingOptions,
      download: url => this.fetchBytes(url),
      readStatus: () => ({ ...this.status(), connected: false }),
      sendCommand: action => this.sendCommand(action),
      waitForCommand: (id, timeoutMs) =>
        waitForCommandResult(id, { timeoutMs, readLastCommand: () => this.readLastCommand() }),
      onProgress: (stage, message) => {
        if (stage !== 'done') {
          this.progress(stage, message, version)
        }
      },
      log: this.log
    })

    if (!swapped.ok) {
      // Nothing changed on disk; give the person their window back.
      await this.window
        .open(options)
        .catch(error =>
          this.log(
            `[webmate] window: reopen after failed swap: ${error instanceof Error ? error.message : String(error)}`
          )
        )

      return { ...swapped, live: true }
    }

    // 4. open again and wait for the new version to say hello.
    this.progress('confirm', version, version)

    let reopenError: string | null = null

    try {
      await this.window.open(options)
    } catch (error) {
      reopenError = error instanceof Error ? error.message : String(error)
      this.log(`[webmate] window: reopen failed after swap: ${reopenError}`)
    }

    // A browser that refused the new folder outright will never say hello — roll back at once
    // instead of making the person watch a closed window for a minute.
    const deadline = reopenError ? 0 : Date.now() + 60_000
    let confirmed = false

    while (Date.now() < deadline) {
      const status = this.status()

      if (status.connected && status.extensionVersion === version) {
        confirmed = true

        break
      }

      await new Promise(resolve => setTimeout(resolve, 500))
    }

    if (confirmed) {
      this.progress('done', version, version)
      this.log(`[webmate] updated to ${version} in the Workmate browser window`)

      return { ok: true, version, stage: 'done', error: null, rolledBack: false, pending: false, live: true }
    }

    // 5. no hello: back to the previous folder, window opened once more.
    const failure = reopenError ? `browser refused the new version: ${reopenError}` : 'no hello from the new version'

    this.progress('rollback', version, version)
    await this.window.close()
    const rolledBack = await restorePrevious(this.paths, version).catch(() => false)

    await this.window
      .open(options)
      .catch(error =>
        this.log(`[webmate] window: reopen after rollback: ${error instanceof Error ? error.message : String(error)}`)
      )

    const check = readUpdateCheck(this.paths)

    writeUpdateCheck(this.paths, {
      installedVersion: readWebmateStatus(this.paths).installedVersion,
      available: false,
      failedVersions: check.failedVersions.includes(version)
        ? check.failedVersions
        : [...check.failedVersions, version],
      lastApply: {
        version,
        ok: false,
        at: new Date().toISOString(),
        error: failure,
        rolledBack
      }
    })

    return fail('rollback', failure, { rolledBack })
  }

  private progress(stage: ApplyStage, message: string, version: string): void {
    const payload: UpdateProgressPayload = { stage, message, version, at: Date.now() }

    this.log(`[webmate] update ${version}: ${stage}${message && message !== version ? ` — ${message}` : ''}`)
    this.deps.broadcast(WEBMATE_UPDATE_PROGRESS_CHANNEL, payload)
  }

  /** Windows: a swap deferred while the browser held the folder runs once the extension is gone. */
  private async applyPendingIfIdle(status: WebmateLocalStatus): Promise<void> {
    if (!status.update?.pendingVersion || status.connected || this.pendingSwapInFlight || this.applyInFlight) {
      return
    }

    this.pendingSwapInFlight = true

    try {
      const outcome = await applyPendingSwap(this.paths, { log: this.log })

      if (outcome?.ok) {
        this.progress('done', outcome.version, outcome.version)
      }
    } finally {
      this.pendingSwapInFlight = false
      this.status()
    }
  }
}

/** One line for the log about a sign-in command's outcome. */
function describeAuthResult(result: WebmateLastCommand | null): string {
  if (!result) {
    return 'no answer from the server'
  }

  const parts = (result.results ?? []).map(
    entry =>
      `${entry.browser ?? entry.instanceId}: ${entry.outcome || (entry.ok ? 'ok' : 'failed')}${entry.email ? ` (${entry.email})` : ''}${entry.message && !entry.ok ? ` — ${entry.message}` : ''}`
  )

  return `${result.ok ? 'ok' : `failed${result.error ? ` (${result.error})` : ''}`}${parts.length ? `; ${parts.join('; ')}` : ''}`
}
