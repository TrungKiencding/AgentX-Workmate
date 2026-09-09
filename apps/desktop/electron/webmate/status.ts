/**
 * Everything the desktop can know about WebMate without asking the backend,
 * read from `<webmate>/`: the folder (installed version), pairing.json
 * (present?), state.json (what the MCP server says), prefs.json and
 * update-check.json. One `readWebmateStatus()` returns the merged view; the
 * watcher re-reads on change and pushes it to the renderer, which is how the
 * onboarding step flips to "Đã kết nối · Google Chrome" with no button.
 *
 * state.json is written only by the MCP server. A server that was force-quit
 * leaves `listening: true` behind with a dead pid; that is reported as
 * `stale` so the UI says "not running" rather than "connected".
 */

import fs from 'node:fs'
import nodePath from 'node:path'

import { parseLastCommand, type WebmateLastCommand } from './commands'
import { readInstalledVersion } from './extension-store'
import type { WebmatePaths } from './paths'
import { parsePrefs, prefsFile, type WebmatePrefs } from './prefs'

export interface WebmateBridgeState {
  schema: number
  pid: number | null
  port: number | null
  serverVersion: string | null
  listening: boolean
  connected: boolean
  pairingRequired: boolean
  browser: string | null
  extensionVersion: string | null
  installType: 'workmate' | 'dev' | null
  signedIn: boolean | null
  protocolVersion: number | null
  lastHelloAt: string | null
  error: string | null
  lastCommand: WebmateLastCommand | null
  updatedAt: string | null
}

/** `update-check.json` as the updater writes it (see updater.ts). Kept loose here: this module only relays it. */
export interface WebmateUpdateCheckSummary {
  checkedAt: string | null
  ok: boolean
  error: string | null
  feedVersion: string | null
  available: boolean
  blockedByMinWorkmate: boolean
  belowMinProtocol: boolean
  pendingVersion: string | null
  failedVersions: string[]
  notes: Record<string, string>
  minProtocol: number | null
}

export interface WebmateLocalStatus {
  paths: WebmatePaths
  installedVersion: string | null
  pairingPresent: boolean
  bridge: WebmateBridgeState | null
  /** state.json claims to listen but its pid is gone. */
  stale: boolean
  serverRunning: boolean
  connected: boolean
  browser: string | null
  extensionVersion: string | null
  installType: 'workmate' | 'dev' | null
  signedIn: boolean | null
  protocolVersion: number | null
  lastCommand: WebmateLastCommand | null
  error: string | null
  prefs: WebmatePrefs
  update: WebmateUpdateCheckSummary | null
  readAt: number
}

export interface StatusIo {
  readText(path: string): string | null
  exists(path: string): boolean
  pidAlive(pid: number): boolean
  now(): Date
  pathModule: typeof nodePath
}

export function defaultStatusIo(): StatusIo {
  return {
    readText: p => {
      try {
        return fs.readFileSync(p, 'utf8')
      } catch {
        return null
      }
    },
    exists: p => fs.existsSync(p),
    pidAlive: pid => {
      if (pid === process.pid) {
        return true
      }

      try {
        process.kill(pid, 0)

        return true
      } catch (error) {
        // EPERM: exists, owned by someone else. ESRCH: gone.
        return (error as NodeJS.ErrnoException).code === 'EPERM'
      }
    },
    now: () => new Date(),
    pathModule: nodePath
  }
}

function readJson(text: string | null): Record<string, unknown> | null {
  if (!text) {
    return null
  }

  try {
    const raw = JSON.parse(text)

    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const bool = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null)

/** state.json text → typed bridge state (null when missing or not an object). */
export function parseBridgeState(text: string | null): WebmateBridgeState | null {
  const raw = readJson(text)

  if (!raw) {
    return null
  }

  const installType = raw.installType === 'workmate' || raw.installType === 'dev' ? raw.installType : null

  return {
    schema: num(raw.schema) ?? 1,
    pid: num(raw.pid),
    port: num(raw.port),
    serverVersion: str(raw.serverVersion),
    listening: raw.listening === true,
    connected: raw.connected === true,
    pairingRequired: raw.pairingRequired === true,
    browser: str(raw.browser),
    extensionVersion: str(raw.extensionVersion),
    installType,
    signedIn: bool(raw.signedIn),
    protocolVersion: num(raw.protocolVersion),
    lastHelloAt: str(raw.lastHelloAt),
    error: str(raw.error),
    lastCommand: parseLastCommand(raw.lastCommand),
    updatedAt: str(raw.updatedAt)
  }
}

export function parseUpdateCheckSummary(text: string | null): WebmateUpdateCheckSummary | null {
  const raw = readJson(text)

  if (!raw) {
    return null
  }

  const feed = raw.feed && typeof raw.feed === 'object' ? (raw.feed as Record<string, unknown>) : null
  const notes = feed?.notes && typeof feed.notes === 'object' ? (feed.notes as Record<string, unknown>) : {}

  return {
    checkedAt: str(raw.checkedAt),
    ok: raw.ok === true,
    error: str(raw.error),
    feedVersion: str(feed?.version),
    available: raw.available === true,
    blockedByMinWorkmate: raw.blockedByMinWorkmate === true,
    belowMinProtocol: raw.belowMinProtocol === true,
    pendingVersion: str(raw.pendingVersion),
    failedVersions: Array.isArray(raw.failedVersions)
      ? raw.failedVersions.filter((v): v is string => typeof v === 'string')
      : [],
    notes: Object.fromEntries(Object.entries(notes).filter(([, v]) => typeof v === 'string')) as Record<string, string>,
    minProtocol: num(feed?.minProtocol)
  }
}

/** One consistent read of `<webmate>/`. Never throws. */
export function readWebmateStatus(paths: WebmatePaths, io: StatusIo = defaultStatusIo()): WebmateLocalStatus {
  const bridge = parseBridgeState(io.readText(paths.stateFile))
  const pairing = readJson(io.readText(paths.pairingFile))
  const stale = Boolean(bridge?.listening && bridge.pid !== null && !io.pidAlive(bridge.pid))
  const live = bridge !== null && !stale
  const connected = Boolean(live && bridge.connected)

  return {
    paths,
    installedVersion: readInstalledVersionWith(paths.installDir, io),
    pairingPresent: typeof pairing?.token === 'string' && pairing.token.length > 0,
    bridge,
    stale,
    serverRunning: Boolean(live && bridge.listening),
    connected,
    browser: connected ? bridge.browser : null,
    extensionVersion: connected ? bridge.extensionVersion : null,
    installType: connected ? bridge.installType : null,
    signedIn: connected ? bridge.signedIn : null,
    protocolVersion: connected ? bridge.protocolVersion : null,
    lastCommand: live ? bridge.lastCommand : null,
    error: live ? bridge.error : null,
    prefs: parsePrefs(io.readText(prefsFile(paths, io.pathModule)), io.now()),
    update: parseUpdateCheckSummary(io.readText(paths.updateCheckFile)),
    readAt: io.now().getTime()
  }
}

function readInstalledVersionWith(installDir: string, io: StatusIo): string | null {
  const raw = readJson(io.readText(io.pathModule.join(installDir, 'manifest.json')))
  const version = str(raw?.version)

  // Fall back to the fs-backed reader only when the io is the real one and
  // the manifest exists but is being rewritten (a torn read).
  return (
    version ?? (io.exists(io.pathModule.join(installDir, 'manifest.json')) ? readInstalledVersion(installDir) : null)
  )
}

/** What changed between two reads matters to the UI; everything else is noise. */
export function statusSignature(status: WebmateLocalStatus): string {
  const { readAt: _readAt, paths: _paths, ...rest } = status

  return JSON.stringify(rest)
}

export interface WatcherOptions {
  paths: WebmatePaths
  io?: StatusIo
  onChange: (status: WebmateLocalStatus) => void
  /** Poll interval backing up fs.watch (directory watching is best-effort everywhere). */
  pollMs?: number
  watch?: (dir: string, listener: () => void) => { close(): void } | null
  setInterval?: typeof globalThis.setInterval
  clearInterval?: typeof globalThis.clearInterval
}

/**
 * Re-reads `<webmate>/` when anything in it changes and reports each distinct
 * status once. fs.watch on the directory catches the MCP server's temp+rename
 * writes on macOS/Windows; the poll is the fallback for the platforms and
 * filesystems where directory events are unreliable.
 */
export class WebmateStatusWatcher {
  private watcher: { close(): void } | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private lastSignature = ''
  private lastStatus: WebmateLocalStatus | null = null
  private readonly io: StatusIo

  constructor(private readonly options: WatcherOptions) {
    this.io = options.io ?? defaultStatusIo()
  }

  /** Latest status, reading once if nothing has been read yet. */
  current(): WebmateLocalStatus {
    if (!this.lastStatus) {
      this.lastStatus = readWebmateStatus(this.options.paths, this.io)
      this.lastSignature = statusSignature(this.lastStatus)
    }

    return this.lastStatus
  }

  /** Read now; notify if different from the last report. */
  refresh(force = false): WebmateLocalStatus {
    const status = readWebmateStatus(this.options.paths, this.io)
    const signature = statusSignature(status)

    this.lastStatus = status

    if (force || signature !== this.lastSignature) {
      this.lastSignature = signature
      this.options.onChange(status)
    }

    return status
  }

  start(): void {
    if (this.timer) {
      return
    }

    const watchImpl =
      this.options.watch ??
      ((dir: string, listener: () => void) => {
        try {
          fs.mkdirSync(dir, { recursive: true })

          const watcher = fs.watch(dir, { persistent: false }, listener)

          watcher.on('error', () => {
            /* the poll keeps things flowing */
          })

          return watcher
        } catch {
          return null
        }
      })

    this.watcher = watchImpl(this.options.paths.root, () => this.refresh())
    const every = this.options.setInterval ?? setInterval
    this.timer = every(() => this.refresh(), this.options.pollMs ?? 3_000)
    this.refresh(true)
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = null

    if (this.timer) {
      ;(this.options.clearInterval ?? clearInterval)(this.timer)
      this.timer = null
    }
  }
}
