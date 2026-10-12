/**
 * The one object main.ts talks to for WebMate. It owns the status watcher,
 * the browser scan cache, prefs, the guided-install actions and the updater,
 * and pushes changes to every renderer window. main.ts only registers the
 * `agentx:webmate:*` IPC handlers that call into it (constraint 6).
 *
 * Side effects that belong to Electron (shell.openPath, clipboard, the window
 * list) are injected so this module stays a plain Node module with tests.
 */

import { promises as fsp, readFileSync, unlinkSync } from 'node:fs'
import nodePath from 'node:path'
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
import { ensureExtensionFolder, readInstalledVersion, verifyBundledPackage } from './extension-store'
import {
  type ExecCapture,
  openExtensionsPage,
  type OpenGuideResult,
  openUrlInBrowser,
  type SpawnDetached
} from './guide'
import {
  assertParticipantsUnchanged,
  browsersConfirmed,
  drainBrowsers,
  managedConnections,
  reloadBrowsers
} from './lifecycle'
import { defaultPairingIo, ensurePairing, parsePairingFile } from './pairing'
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
  compareVersions,
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
  type UpdateCheckFile
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
  browserWindow?: WorkmateBrowserWindow
  commandWaitMs?: number
  helloTimeoutMs?: number
  bridgePort?: number
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
  private mutationTail: Promise<unknown> = Promise.resolve()
  private mutationCount = 0
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
    this.window =
      deps.browserWindow ??
      new WorkmateBrowserWindow({
        log: this.log,
        onChange: () => this.broadcastStatus()
      })
  }

  /** Serialize disk/browser mutations; feed reads remain independent. */
  private mutate<T>(work: () => Promise<T>): Promise<T> {
    this.mutationCount++
    const result = this.mutationTail.then(work)
    this.mutationTail = result
      .catch(() => undefined)
      .finally(() => {
        this.mutationCount--

        if (this.mutationCount === 0 && !this.pendingSwapInFlight) {
          void this.applyPendingIfIdle(this.status()).catch(error =>
            this.log(`[webmate] pending update: ${String(error)}`)
          )
        }
      })

    return result
  }

  private commandDeps() {
    return {
      readStatus: () => this.status(),
      sendCommand: (action: WebmateCommandAction, payload?: WebmateCommandPayload) => this.sendCommand(action, payload),
      waitForCommand: async (id: string, timeoutMs: number) => {
        const result = await waitForCommandResult(id, {
          timeoutMs: this.deps.commandWaitMs ?? timeoutMs,
          readLastCommand: () => this.readLastCommand(),
          readResult: commandId => this.readCommandResult(commandId)
        })

        if (!result) {
          // Cancel a command still queued behind an auth request. In-flight
          // commands are already claimed by deletion and cannot be replayed.
          try {
            unlinkSync(nodePath.join(this.paths.commandsDir, `${id}.json`))
          } catch {
            /* already claimed */
          }
        }

        return result
      }
    }
  }

  private windowLifecycle() {
    const options = this.window.isOpen() ? this.windowOptions : null

    return options
      ? {
          close: () => this.window.close(),
          open: async () => {
            await this.window.open(options)
          },
          instanceId: () => this.window.instanceId()
        }
      : undefined
  }

  private applyRelease(release: ReleaseManifest, download: (url: string) => Promise<Buffer>): Promise<ApplyOutcome> {
    const pairingOptions = {
      port: this.deps.bridgePort ?? WEBMATE_BRIDGE_PORT,
      workmateVersion: this.deps.appVersion,
      minServerVersion: WEBMATE_MIN_SERVER_VERSION
    }

    const { pairing } = ensurePairing(this.paths, pairingOptions)

    return applyWebmateUpdate({
      paths: this.paths,
      release,
      pairing,
      pairingOptions,
      download,
      ...this.commandDeps(),
      browserWindow: this.windowLifecycle(),
      helloTimeoutMs: this.deps.helloTimeoutMs,
      onProgress: (stage, message) => this.progress(stage, message, release.version),
      log: this.log
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

    return this.mutate(() => this.runOpenWindow(request))
  }

  private async runOpenWindow(request: { browserId?: string | null }): Promise<OpenWindowOutcome> {
    const browsers = await this.scan()
    const browser = chooseWindowBrowser(browsers, request.browserId ?? this.getPrefs().browser?.id ?? null)

    if (!browser) {
      return { ok: false, error: 'no-chromium-browser', window: this.window.current() }
    }

    const server = await this.ensureServerForWindow()

    if (server) {
      return { ok: false, error: server, window: this.window.current() }
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
    return this.mutate(async () => {
      await this.window.close()

      return this.window.current()
    })
  }

  // -- folder + pairing (phase 1, re-exposed) --------------------------------

  bootstrap(): Promise<BootstrapResult> {
    if (!this.bootstrapInFlight) {
      this.bootstrapInFlight = this.mutate(() =>
        bootstrapWebmate({
          agentxHome: this.deps.agentxHome,
          resourcesPath: this.deps.resourcesPath,
          appRoot: this.deps.appRoot,
          appVersion: this.deps.appVersion,
          isPackaged: this.deps.isPackaged,
          bridgePort: this.deps.bridgePort,
          log: this.log,
          installExtension: async bundled => {
            const installed = readInstalledVersion(this.paths.installDir)

            if (!bundled || (installed && compareVersions(installed, bundled.version) >= 0)) {
              return ensureExtensionFolder(this.paths, bundled, { isPackaged: this.deps.isPackaged, log: this.log })
            }

            const zip = await fsp.readFile(bundled.zipPath)
            const verified = await verifyBundledPackage(bundled, zip, { isPackaged: this.deps.isPackaged })

            if (!verified.release) {
              return ensureExtensionFolder(this.paths, bundled, {
                isPackaged: this.deps.isPackaged,
                log: this.log,
                deferSwap: this.status().connected
              })
            }

            if (compareVersions(verified.release.minWorkmate, this.deps.appVersion) > 0) {
              throw new Error('bundled extension needs a newer Workmate')
            }

            const outcome = await this.applyRelease(verified.release, async () => zip)

            return {
              action: outcome.ok ? (installed ? 'updated' : 'installed') : 'skipped',
              installedVersion: readInstalledVersion(this.paths.installDir),
              bundledVersion: bundled.version,
              reason: outcome.error ?? undefined,
              stagedDir: outcome.pending ? nodePath.join(this.paths.versionsDir, bundled.version) : undefined,
              verified: { sha256: true, signature: verified.signature }
            }
          }
        })
      ).finally(() => {
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
  resetToken(): Promise<{ ok: boolean; reloaded: boolean }> {
    return this.mutate(async () => {
      const before = this.status()
      const commands = this.commandDeps()
      const window = this.windowLifecycle()

      const pairingOptions = {
        port: this.deps.bridgePort ?? WEBMATE_BRIDGE_PORT,
        workmateVersion: this.deps.appVersion,
        minServerVersion: WEBMATE_MIN_SERVER_VERSION
      }

      const oldPairing = parsePairingFile(defaultPairingIo().readText(this.paths.pairingFile))
      let rotated = false

      try {
        await drainBrowsers(commands, before, this.deps.commandWaitMs ?? 65_000)
        await window?.close()
        assertParticipantsUnchanged(before, this.status())
        const outcome = ensurePairing(this.paths, { ...pairingOptions, rotate: true })
        rotated = true
        await reloadBrowsers(commands)
        await window?.open()
        const windowId = window ? await window.instanceId() : null

        if (window && !windowId) {
          throw new Error('could not verify the Workmate browser identity')
        }

        if (window || (before.connected && (!before.connections.length || managedConnections(before).length))) {
          const deadline = Date.now() + (this.deps.helloTimeoutMs ?? 60_000)

          while (Date.now() < deadline) {
            const current = this.status()
            const windowConfirmed = !window || current.connections.some(c => c.instanceId === windowId && c.paired)

            if (windowConfirmed && browsersConfirmed(before, current, before.installedVersion ?? '', true)) {
              return { ok: outcome.pairingWritten, reloaded: true }
            }

            await new Promise(resolve => setTimeout(resolve, 250))
          }

          throw new Error('browsers did not reconnect with the new pairing token')
        }

        return { ok: outcome.pairingWritten, reloaded: false }
      } catch (error) {
        // A reset must leave the last working credential and browser usable.
        if (rotated && oldPairing) {
          await window?.close()
          defaultPairingIo().writeTextAtomic(this.paths.pairingFile, `${JSON.stringify(oldPairing)}\n`)
          ensurePairing(this.paths, pairingOptions)
          await reloadBrowsers(commands).catch(recovery => this.log(`[webmate] reset recovery: ${String(recovery)}`))
        }

        this.sendCommand('resume')
        await window?.open().catch(recovery => this.log(`[webmate] window recovery: ${String(recovery)}`))
        throw error
      }
    })
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
        readLastCommand: () => this.readLastCommand(),
        readResult: id => this.readCommandResult(id)
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
      readLastCommand: () => this.readLastCommand(),
      readResult: id => this.readCommandResult(id)
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

  private readCommandResult(id: string): WebmateLastCommand | null {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) {
      return null
    }

    try {
      return parseLastCommand(
        JSON.parse(readFileSync(nodePath.join(this.paths.commandsDir, 'results', `${id}.json`), 'utf8'))
      )
    } catch {
      return null
    }
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
      signal: AbortSignal.timeout(60_000),
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
          void this.applyUpdate().catch(error => this.log(`[webmate] auto-update: ${String(error)}`))
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

    this.applyInFlight = this.mutate(() => this.runApply()).finally(() => {
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

    return this.applyRelease(release, url => this.fetchBytes(url))
  }

  private progress(stage: ApplyStage, message: string, version: string): void {
    const payload: UpdateProgressPayload = { stage, message, version, at: Date.now() }

    this.log(`[webmate] update ${version}: ${stage}${message && message !== version ? ` — ${message}` : ''}`)
    this.deps.broadcast(WEBMATE_UPDATE_PROGRESS_CHANNEL, payload)
  }

  /** Windows: a swap deferred while the browser held the folder runs once the extension is gone. */
  private async applyPendingIfIdle(status: WebmateLocalStatus): Promise<void> {
    if (
      !status.update?.pendingVersion ||
      status.connected ||
      this.window.isOpen() ||
      this.pendingSwapInFlight ||
      this.mutationCount > 0
    ) {
      return
    }

    this.pendingSwapInFlight = true

    try {
      const outcome = await this.mutate(async () => {
        if (this.status().connected || this.window.isOpen()) {
          return null
        }

        return applyPendingSwap(this.paths, {
          log: this.log,
          pairingOptions: {
            port: this.deps.bridgePort ?? WEBMATE_BRIDGE_PORT,
            workmateVersion: this.deps.appVersion,
            minServerVersion: WEBMATE_MIN_SERVER_VERSION
          }
        })
      })

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
