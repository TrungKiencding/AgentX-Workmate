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
import { type BrowserInfo, type BrowserScanIo, defaultBrowserScanIo, scanBrowsers } from './browsers'
import {
  parseLastCommand,
  sendWebmateCommand,
  waitForCommandResult,
  type WebmateCommandAction,
  type WebmateLastCommand
} from './commands'
import { openExtensionsPage, type OpenGuideResult, type SpawnDetached } from './guide'
import { defaultPairingIo, ensurePairing, parsePairingFile } from './pairing'
import { WEBMATE_BRIDGE_PORT, WEBMATE_MIN_SERVER_VERSION, type WebmatePaths, webmatePaths } from './paths'
import { prefsFile, readPrefs, type WebmatePrefs, type WebmatePrefsPatch, writePrefs } from './prefs'
import {
  parseReleaseManifest,
  type ParseReleaseOptions,
  WEBMATE_RELEASE_FEED_URL,
  WEBMATE_RELEASE_PUBLIC_KEY
} from './release-feed'
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
  scanIo?: BrowserScanIo
  fetchImpl?: typeof fetch
  platform?: NodeJS.Platform
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

  constructor(private readonly deps: WebmateServiceDeps) {
    this.paths = webmatePaths(deps.agentxHome)
    this.log = deps.log ?? (() => {})
    this.env = deps.env ?? process.env
    this.platform = deps.platform ?? process.platform
  }

  // -- lifecycle ------------------------------------------------------------

  start(): void {
    if (this.watcher) {
      return
    }

    this.watcher = new WebmateStatusWatcher({
      paths: this.paths,
      onChange: status => {
        this.deps.broadcast(WEBMATE_STATUS_CHANNEL, status)
        void this.rememberConnection(status)
        void this.applyPendingIfIdle(status)
      }
    })
    this.watcher.start()
  }

  stop(): void {
    this.watcher?.stop()
    this.watcher = null
  }

  /** A fresh read (and a broadcast if anything changed). */
  status(): WebmateLocalStatus {
    return this.watcher ? this.watcher.refresh() : readWebmateStatus(this.paths)
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
      this.deps.spawnDetached
    )

    if (opened.command) {
      this.log(`[webmate] opened extensions page: ${opened.command}`)
    }

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

  // -- commands -------------------------------------------------------------

  private sendCommand(action: WebmateCommandAction): string {
    return sendWebmateCommand(this.paths, action)
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

    return applyWebmateUpdate({
      paths: this.paths,
      release,
      pairing: ensured,
      pairingOptions: {
        port: WEBMATE_BRIDGE_PORT,
        workmateVersion: this.deps.appVersion,
        minServerVersion: WEBMATE_MIN_SERVER_VERSION
      },
      download: url => this.fetchBytes(url),
      readStatus: () => this.status(),
      sendCommand: action => this.sendCommand(action),
      waitForCommand: (id, timeoutMs) =>
        waitForCommandResult(id, { timeoutMs, readLastCommand: () => this.readLastCommand() }),
      onProgress: (stage, message) => this.progress(stage, message, release.version),
      log: this.log
    })
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
