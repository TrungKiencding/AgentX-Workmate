/**
 * The desktop app's own updates, end to end: check the signed feed, download the
 * installer for this machine, and install it — replacing the app and, through the
 * install stamp the new build carries, the agent behind it.
 *
 * One object owns the state and every renderer only mirrors it (`agentx:app-update:*`
 * in main.ts), so the status bar, the About panel and the updates dialog can never
 * disagree. Each step's side effects are injected; main.ts supplies Electron's.
 *
 *   idle ──check──▶ up-to-date | available ──download──▶ downloading ──▶ ready
 *                                   ▲                        │             │
 *                                   └──── cancel / error ────┘          install
 *                                                                          ▼
 *                                          next launch reads the outcome ◀ installing
 *
 * A check never hides what is already known: a failed check keeps an `available` or
 * `ready` release and only records `checkError`, and one that lands while a download
 * or an install is under way leaves that step where it is.
 */

import path from 'node:path'

import { compareVersions } from '../signed-manifest'

import { DownloadError, downloadVerified, type FetchLike, fileMatches } from './download'
import {
  APP_DOWNLOAD_PAGE_URL,
  type AppReleaseFeed,
  assetKeyFor,
  isNewerRelease,
  type ParseAppReleaseFeedOptions,
  verifyAppReleaseFeed
} from './feed'

export type AppUpdatePhase = 'available' | 'downloading' | 'idle' | 'installing' | 'ready' | 'up-to-date'

/**
 * Why this copy cannot replace itself; the app then points at the download page.
 *
 * - dev-build: an unpackaged development run.
 * - unsupported-platform: no installers are published for this OS (Linux).
 * - no-installer-for-machine: the release has no build for this platform/arch.
 * - not-a-bundle / translocated / not-writable: macOS, see install-mac.ts.
 * - not-installer-build: Windows copy the NSIS installer did not put in place.
 */
export type AppUpdateBlock =
  | 'dev-build'
  | 'no-installer-for-machine'
  | 'not-a-bundle'
  | 'not-installer-build'
  | 'not-writable'
  | 'translocated'
  | 'unsupported-platform'

export interface AppUpdateRelease {
  version: string
  publishedAt: string
  notes: Record<string, string[]>
  /** Size of this machine's installer; null when the release has none for it. */
  bytes: null | number
}

export interface AppUpdateProblem {
  /** download: network | http | size | hash | disk. install: stage | launch. check: feed. */
  kind: string
  message: string
}

export interface AppUpdateState {
  phase: AppUpdatePhase
  currentVersion: string
  checking: boolean
  checkedAt: null | number
  checkError: null | string
  release: AppUpdateRelease | null
  progress: { receivedBytes: number; totalBytes: number } | null
  downloadError: AppUpdateProblem | null
  installError: AppUpdateProblem | null
  blocked: AppUpdateBlock | null
  downloadPageUrl: string
  /** The version the app was updated from, on the first launch after an update. */
  updatedFrom: null | string
  /** The last install that did not take, read back on the next launch. */
  lastInstallFailed: { version: string; message: string } | null
  /** This launch could not bring the agent up to this app's version. */
  agentUpdateFailed: AgentUpdateFailure | null
}

export interface ActiveWork {
  count: number
  titles: string[]
}

/**
 * Why the agent did not reach the version this app ships, on a launch that tried
 * to bring it forward (main.ts ensureRuntime): another process held the install
 * open, the fresh install failed, or the person cancelled it. The app then runs
 * the agent it already had.
 */
export type AgentUpdateFailure = 'cancelled' | 'failed' | 'held-open'

export type InstallOutcome =
  | { started: true }
  | { started: false; reason: 'active-work'; activeWork: ActiveWork }
  | { started: false; reason: 'failed'; message: string }

/** What one install needs from the platform: stage, record, hand off, quit. */
export interface InstallHandoff {
  /**
   * Do everything that can still fail while the app is open (macOS: stage the new
   * bundle and write the swap script), then start the detached process that finishes
   * the job once the app has quit. Throwing leaves the app running and ready to retry.
   */
  start: (installer: string, version: string) => Promise<void>
}

/** On-disk memory between launches (userData/app-update.json). */
export interface PersistedUpdateState {
  lastRunVersion?: string
  pendingInstall?: { version: string; from: string; startedAt: number }
}

export interface InstallResult {
  version: string
  ok: boolean
  message: string
}

export interface AppUpdaterDeps {
  currentVersion: string
  platform: string
  arch: string
  /** Why installing in place is impossible on this copy, before any release is known. */
  locationBlock: AppUpdateBlock | null
  feedUrl: string
  publicKeyPem: string
  feedOptions: ParseAppReleaseFeedOptions
  /** Where installers are downloaded, one folder per version. */
  downloadDir: string
  fetch: FetchLike
  handoff: InstallHandoff
  activeWork: () => ActiveWork
  quit: () => void
  readPersisted: () => PersistedUpdateState
  writePersisted: (state: PersistedUpdateState) => void
  /** The swap script's report (macOS); null when there is none. Consumed: read once. */
  takeInstallResult: () => InstallResult | null
  /** Delete every download folder whose version `keep` rejects, and any stray file. */
  pruneDownloads: (keep: (version: string) => boolean) => Promise<void>
  broadcast: (state: AppUpdateState) => void
  log: (line: string) => void
  now?: () => number
}

const FEED_MAX_BYTES = 256 * 1024

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class AppUpdater {
  private state: AppUpdateState
  private feed: AppReleaseFeed | null = null
  private checkInFlight: null | Promise<AppUpdateState> = null
  private downloadAbort: AbortController | null = null
  private readonly deps: AppUpdaterDeps
  private readonly now: () => number

  constructor(deps: AppUpdaterDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
    this.state = {
      phase: 'idle',
      currentVersion: deps.currentVersion,
      checking: false,
      checkedAt: null,
      checkError: null,
      release: null,
      progress: null,
      downloadError: null,
      installError: null,
      blocked: deps.locationBlock,
      downloadPageUrl: APP_DOWNLOAD_PAGE_URL,
      updatedFrom: null,
      lastInstallFailed: null,
      agentUpdateFailed: null
    }
  }

  getState(): AppUpdateState {
    return this.state
  }

  private set(patch: Partial<AppUpdateState>): AppUpdateState {
    this.state = { ...this.state, ...patch }
    this.deps.broadcast(this.state)

    return this.state
  }

  /**
   * Settle what the last launch left behind: did a pending install take, which
   * version ran before this one, which downloads are now stale. Runs once at startup,
   * before the first check.
   */
  async initialize(): Promise<AppUpdateState> {
    const { currentVersion } = this.deps
    const persisted = this.deps.readPersisted()
    const result = this.deps.takeInstallResult()
    const pending = persisted.pendingInstall
    let updatedFrom: null | string = null
    let lastInstallFailed: AppUpdateState['lastInstallFailed'] = null

    if (pending && pending.version === currentVersion) {
      updatedFrom = pending.from
      this.deps.log(`[app-update] updated ${pending.from} → ${currentVersion}`)
    } else if (pending) {
      const message =
        result && result.version === pending.version && !result.ok ? result.message : 'the installer did not finish'

      lastInstallFailed = { version: pending.version, message }
      this.deps.log(`[app-update] install of ${pending.version} did not take (still ${currentVersion}): ${message}`)
    } else if (persisted.lastRunVersion && compareVersions(currentVersion, persisted.lastRunVersion) > 0) {
      // Installed by hand from the download page: still worth saying it worked.
      updatedFrom = persisted.lastRunVersion
    }

    this.deps.writePersisted({ lastRunVersion: currentVersion })
    // A download newer than this version may still be installed; keep it until a
    // check says which release is current.
    await this.prune(version => compareVersions(version, currentVersion) > 0)

    return this.set({ updatedFrom, lastInstallFailed })
  }

  private async prune(keep: (version: string) => boolean): Promise<void> {
    try {
      await this.deps.pruneDownloads(keep)
    } catch (error) {
      this.deps.log(`[app-update] could not prune old downloads: ${errorMessage(error)}`)
    }
  }

  /** Fetch and verify the feed. Concurrent calls share one request. */
  check(): Promise<AppUpdateState> {
    if (this.state.phase === 'downloading' || this.state.phase === 'installing') {
      return Promise.resolve(this.state)
    }

    if (!this.checkInFlight) {
      this.checkInFlight = this.runCheck().finally(() => {
        this.checkInFlight = null
      })
    }

    return this.checkInFlight
  }

  private async fetchFeed(): Promise<AppReleaseFeed> {
    const response = await this.deps.fetch(this.deps.feedUrl, {
      redirect: 'follow',
      headers: { accept: 'application/json', 'cache-control': 'no-cache', pragma: 'no-cache' }
    })

    if (!response.ok) {
      throw new Error(`the update feed answered HTTP ${response.status}`)
    }

    const text = await response.text()

    if (text.length > FEED_MAX_BYTES) {
      throw new Error('the update feed is too large')
    }

    let raw: unknown

    try {
      raw = JSON.parse(text)
    } catch {
      throw new Error('the update feed is not JSON')
    }

    return verifyAppReleaseFeed(raw, this.deps.publicKeyPem, this.deps.feedOptions)
  }

  private async runCheck(): Promise<AppUpdateState> {
    this.set({ checking: true })

    let feed: AppReleaseFeed

    try {
      feed = await this.fetchFeed()
    } catch (error) {
      const message = errorMessage(error)

      this.deps.log(`[app-update] check failed: ${message}`)

      return this.set({ checking: false, checkedAt: this.now(), checkError: message })
    }

    // check() is not started mid-install, but one already under way can land there:
    // what is being installed stays as it is, and the app is about to quit.
    if (this.state.phase === 'installing') {
      return this.set({ checking: false, checkedAt: this.now() })
    }

    this.feed = feed

    if (!isNewerRelease(feed, this.deps.currentVersion)) {
      this.supersedeDownload()
      await this.prune(() => false)

      return this.set({
        phase: 'up-to-date',
        checking: false,
        checkedAt: this.now(),
        checkError: null,
        release: null,
        progress: null,
        downloadError: null,
        installError: null,
        blocked: this.deps.locationBlock
      })
    }

    const asset = feed.assets[assetKeyFor(this.deps.platform, this.deps.arch)] ?? null
    const known = this.state.release?.version === feed.version

    if (!known) {
      this.supersedeDownload()
    }

    const release: AppUpdateRelease = {
      version: feed.version,
      publishedAt: feed.publishedAt,
      notes: feed.notes,
      bytes: asset ? asset.bytes : null
    }

    const blocked = this.deps.locationBlock ?? (asset ? null : 'no-installer-for-machine')

    await this.prune(version => version === feed.version)

    // A known release keeps its place in the flow, a download that started while
    // this check was under way included; a new one starts over.
    const phase = known ? this.state.phase : 'available'

    this.set({
      phase,
      checking: false,
      checkedAt: this.now(),
      checkError: null,
      release,
      blocked,
      ...(known ? {} : { progress: null, downloadError: null, installError: null })
    })

    if (
      phase === 'available' &&
      asset &&
      !blocked &&
      (await fileMatches(this.installerPath(feed), asset.sha256, asset.bytes))
    ) {
      this.deps.log(`[app-update] ${feed.version} was already downloaded and verified`)
      this.set({ phase: 'ready' })
    }

    return this.state
  }

  /** Stop a download that a check has made moot; the check says what is current. */
  private supersedeDownload(): void {
    const running = this.downloadAbort

    this.downloadAbort = null
    running?.abort()
  }

  private installerPath(feed: AppReleaseFeed): string {
    const asset = feed.assets[assetKeyFor(this.deps.platform, this.deps.arch)]

    return path.join(
      this.deps.downloadDir,
      feed.version,
      decodeURIComponent(path.posix.basename(new URL(asset.url).pathname))
    )
  }

  /** Download this machine's installer for the available release. */
  async download(): Promise<AppUpdateState> {
    const feed = this.feed
    const asset = feed?.assets[assetKeyFor(this.deps.platform, this.deps.arch)]

    if (this.state.phase !== 'available' || !feed || !asset || this.state.blocked) {
      return this.state
    }

    const abort = new AbortController()

    this.downloadAbort = abort
    this.set({
      phase: 'downloading',
      progress: { receivedBytes: 0, totalBytes: asset.bytes },
      downloadError: null,
      installError: null
    })
    this.deps.log(`[app-update] downloading ${feed.version} from ${asset.url}`)

    try {
      await downloadVerified(
        {
          url: asset.url,
          sha256: asset.sha256,
          bytes: asset.bytes,
          destination: this.installerPath(feed),
          signal: abort.signal,
          onProgress: (receivedBytes, totalBytes) => {
            if (this.downloadAbort === abort) {
              this.set({ progress: { receivedBytes, totalBytes } })
            }
          }
        },
        this.deps.fetch
      )
    } catch (error) {
      if (this.downloadAbort !== abort) {
        return this.state
      }

      this.downloadAbort = null

      if (error instanceof DownloadError && error.kind === 'aborted') {
        this.deps.log('[app-update] download cancelled')

        return this.set({ phase: 'available', progress: null })
      }

      const kind = error instanceof DownloadError ? error.kind : 'disk'

      this.deps.log(`[app-update] download failed (${kind}): ${errorMessage(error)}`)

      return this.set({ phase: 'available', progress: null, downloadError: { kind, message: errorMessage(error) } })
    }

    if (this.downloadAbort !== abort) {
      return this.state
    }

    this.downloadAbort = null
    this.deps.log(`[app-update] ${feed.version} downloaded and verified`)

    return this.set({ phase: 'ready', progress: null })
  }

  cancelDownload(): AppUpdateState {
    this.downloadAbort?.abort()

    return this.state
  }

  /**
   * Install the downloaded release and quit. Refuses (without touching anything) while
   * the agent is mid-turn unless the person has confirmed they want to stop it.
   */
  async install({ confirmActiveWork = false }: { confirmActiveWork?: boolean } = {}): Promise<InstallOutcome> {
    const feed = this.feed

    if (this.state.phase !== 'ready' || !feed) {
      return { started: false, reason: 'failed', message: 'there is no downloaded update to install' }
    }

    const activeWork = this.deps.activeWork()

    if (activeWork.count > 0 && !confirmActiveWork) {
      return { started: false, reason: 'active-work', activeWork }
    }

    const installer = this.installerPath(feed)
    const asset = feed.assets[assetKeyFor(this.deps.platform, this.deps.arch)]

    this.set({ phase: 'installing', installError: null })

    // The file was verified when it finished downloading, but it has sat on disk
    // since; it is about to run, so verify it again.
    if (!(await fileMatches(installer, asset.sha256, asset.bytes))) {
      this.deps.log(`[app-update] ${installer} no longer matches the release; downloading again`)

      return this.failInstall('stage', 'the downloaded installer changed on disk; download it again', 'available')
    }

    try {
      await this.deps.handoff.start(installer, feed.version)
    } catch (error) {
      return this.failInstall('stage', errorMessage(error), 'ready')
    }

    this.deps.writePersisted({
      lastRunVersion: this.deps.currentVersion,
      pendingInstall: { version: feed.version, from: this.deps.currentVersion, startedAt: this.now() }
    })
    this.deps.log(`[app-update] handing over to the ${feed.version} installer and quitting`)
    this.deps.quit()

    return { started: true }
  }

  private failInstall(kind: string, message: string, phase: AppUpdatePhase): InstallOutcome {
    this.deps.log(`[app-update] install failed (${kind}): ${message}`)
    this.set({ phase, installError: { kind, message } })

    return { started: false, reason: 'failed', message }
  }

  /** How this launch's attempt to bring the agent forward went (null: it got there). */
  reportAgentUpdate(failure: AgentUpdateFailure | null): AppUpdateState {
    return this.set({ agentUpdateFailed: failure })
  }

  /** Forget the "updated from" / "last install failed" notices once shown. */
  acknowledgeNotices(): AppUpdateState {
    return this.set({ updatedFrom: null, lastInstallFailed: null })
  }
}
