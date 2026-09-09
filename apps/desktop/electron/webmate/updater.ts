/**
 * WebMate updates: check the signed feed, apply a release, roll back.
 *
 * apps/desktop/WEBMATE-INTEGRATION-PLAN.md §2.5. The feed is `release.json`
 * on the WebMate repository's main branch, Ed25519-signed; Workmate installs a
 * release only when the signature verifies AND the downloaded zip's sha256
 * matches. There is no "install anyway".
 *
 * Applying, in order:
 *   1. download → sha256 → keep as versions/<ver>.zip
 *   2. extract to versions/<ver>/, check manifest version + key, add workmate.json
 *   3. connected? ask the server to drain (`prepare_update`, ≤ 60 s)
 *   4. swap by two renames (AgentX WebMate → versions/prev, versions/<ver> → AgentX WebMate);
 *      a busy folder on Windows leaves `pendingVersion` in update-check.json
 *   5. connected? `reload`
 *   6. connected? wait ≤ 60 s for a hello with the new version, else swap back and reload again
 *   7. browser closed: skip 3, 5 and 6
 *
 * Every side effect is injected so the whole sequence — including the rollback
 * — runs in tests against a temp dir with a fake server.
 */

import { promises as fsp } from 'node:fs'
import fs from 'node:fs'
import nodePath from 'node:path'

import type { WebmateCommandAction, WebmateLastCommand } from './commands'
import { extensionIdFromPublicKey, readInstalledVersion, renameWithRetry } from './extension-store'
import {
  defaultPairingIo,
  type PairingFile,
  type PairingIo,
  type PairingOptions,
  writeWorkmateJsonInto
} from './pairing'
import { WEBMATE_EXTENSION_ID, type WebmatePaths } from './paths'
import {
  compareVersions,
  parseReleaseManifest,
  type ParseReleaseOptions,
  type ReleaseManifest,
  sha256Hex,
  verifyReleaseManifest,
  WEBMATE_RELEASE_FEED_URL,
  WEBMATE_RELEASE_PUBLIC_KEY
} from './release-feed'
import type { WebmateLocalStatus } from './status'
import { extractZip } from './zip'

// ---------------------------------------------------------------------------
// update-check.json
// ---------------------------------------------------------------------------

export interface FeedSummary {
  version: string
  publishedAt: string
  minWorkmate: string
  minProtocol: number
  notes: Record<string, string>
  chrome: { url: string; sha256: string; bytes: number }
}

export interface LastApply {
  version: string
  ok: boolean
  at: string
  error: string | null
  rolledBack: boolean
}

export interface UpdateCheckFile {
  schema: 1
  checkedAt: string | null
  ok: boolean
  error: string | null
  feed: FeedSummary | null
  installedVersion: string | null
  /** A newer signed release exists and nothing blocks installing it. */
  available: boolean
  /** The feed needs a newer Workmate than this one. */
  blockedByMinWorkmate: boolean
  /** The extension currently attached speaks a protocol older than the feed's floor: update is mandatory. */
  belowMinProtocol: boolean
  /** Staged and verified, waiting for the browser to release the folder (Windows). */
  pendingVersion: string | null
  /** Versions that were swapped in and never said hello — not retried automatically. */
  failedVersions: string[]
  lastApply: LastApply | null
}

export const EMPTY_UPDATE_CHECK: UpdateCheckFile = {
  schema: 1,
  checkedAt: null,
  ok: false,
  error: null,
  feed: null,
  installedVersion: null,
  available: false,
  blockedByMinWorkmate: false,
  belowMinProtocol: false,
  pendingVersion: null,
  failedVersions: [],
  lastApply: null
}

export type UpdateIo = Pick<PairingIo, 'readText' | 'writeTextAtomic' | 'now'>

export function parseUpdateCheck(text: string | null): UpdateCheckFile {
  if (!text) {
    return EMPTY_UPDATE_CHECK
  }

  let raw: unknown

  try {
    raw = JSON.parse(text)
  } catch {
    return EMPTY_UPDATE_CHECK
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return EMPTY_UPDATE_CHECK
  }

  const record = raw as Record<string, unknown>
  const feed = record.feed && typeof record.feed === 'object' ? (record.feed as Record<string, unknown>) : null
  const chrome = feed?.chrome && typeof feed.chrome === 'object' ? (feed.chrome as Record<string, unknown>) : null

  const lastApply =
    record.lastApply && typeof record.lastApply === 'object' ? (record.lastApply as Record<string, unknown>) : null

  return {
    schema: 1,
    checkedAt: typeof record.checkedAt === 'string' ? record.checkedAt : null,
    ok: record.ok === true,
    error: typeof record.error === 'string' ? record.error : null,
    feed:
      feed && typeof feed.version === 'string' && chrome
        ? {
            version: feed.version,
            publishedAt: typeof feed.publishedAt === 'string' ? feed.publishedAt : '',
            minWorkmate: typeof feed.minWorkmate === 'string' ? feed.minWorkmate : '0.0.0',
            minProtocol: typeof feed.minProtocol === 'number' ? feed.minProtocol : 1,
            notes: Object.fromEntries(
              Object.entries((feed.notes as Record<string, unknown>) || {}).filter(([, v]) => typeof v === 'string')
            ) as Record<string, string>,
            chrome: {
              url: String(chrome.url || ''),
              sha256: String(chrome.sha256 || ''),
              bytes: typeof chrome.bytes === 'number' ? chrome.bytes : 0
            }
          }
        : null,
    installedVersion: typeof record.installedVersion === 'string' ? record.installedVersion : null,
    available: record.available === true,
    blockedByMinWorkmate: record.blockedByMinWorkmate === true,
    belowMinProtocol: record.belowMinProtocol === true,
    pendingVersion: typeof record.pendingVersion === 'string' && record.pendingVersion ? record.pendingVersion : null,
    failedVersions: Array.isArray(record.failedVersions)
      ? record.failedVersions.filter((v): v is string => typeof v === 'string')
      : [],
    lastApply:
      lastApply && typeof lastApply.version === 'string'
        ? {
            version: lastApply.version,
            ok: lastApply.ok === true,
            at: typeof lastApply.at === 'string' ? lastApply.at : '',
            error: typeof lastApply.error === 'string' ? lastApply.error : null,
            rolledBack: lastApply.rolledBack === true
          }
        : null
  }
}

export function readUpdateCheck(paths: WebmatePaths, io: UpdateIo = defaultPairingIo()): UpdateCheckFile {
  return parseUpdateCheck(io.readText(paths.updateCheckFile))
}

/** Merge a patch into update-check.json (pendingVersion/failedVersions/lastApply survive checks). */
export function writeUpdateCheck(
  paths: WebmatePaths,
  patch: Partial<UpdateCheckFile>,
  io: UpdateIo = defaultPairingIo()
): UpdateCheckFile {
  const next: UpdateCheckFile = { ...readUpdateCheck(paths, io), ...patch, schema: 1 }

  io.writeTextAtomic(paths.updateCheckFile, `${JSON.stringify(next, null, 2)}\n`)

  return next
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

export interface CheckDeps {
  paths: WebmatePaths
  appVersion: string
  /** Fetch the feed body; reject on any failure (non-2xx included). */
  fetchText: (url: string) => Promise<string>
  feedUrl?: string
  publicKeyPem?: string
  /** Protocol version of the extension currently attached (null when none). */
  protocolVersion?: number | null
  io?: UpdateIo
  parseOptions?: ParseReleaseOptions
  log?: (message: string) => void
}

export function feedSummary(release: ReleaseManifest): FeedSummary {
  return {
    version: release.version,
    publishedAt: release.publishedAt,
    minWorkmate: release.minWorkmate,
    minProtocol: release.minProtocol,
    notes: Object.fromEntries(Object.entries(release.notes).filter(([, v]) => typeof v === 'string')) as Record<
      string,
      string
    >,
    chrome: { ...release.chrome }
  }
}

/**
 * Decide what the feed means for this machine. Pure, so the "available",
 * "blocked" and "mandatory" rules are tested without files.
 */
export function evaluateFeed(input: {
  release: ReleaseManifest
  installedVersion: string | null
  appVersion: string
  protocolVersion: number | null
  failedVersions: string[]
}): Pick<UpdateCheckFile, 'available' | 'blockedByMinWorkmate' | 'belowMinProtocol'> {
  const { release, installedVersion, appVersion, protocolVersion, failedVersions } = input
  const newer = installedVersion === null || compareVersions(release.version, installedVersion) > 0
  const blockedByMinWorkmate = compareVersions(release.minWorkmate, appVersion) > 0
  const belowMinProtocol = protocolVersion !== null && protocolVersion < release.minProtocol

  return {
    available: newer && !blockedByMinWorkmate && !failedVersions.includes(release.version),
    blockedByMinWorkmate,
    belowMinProtocol
  }
}

/**
 * Read the feed, verify it, compare with what is installed, cache the result.
 * A broken or unsigned feed is "no feed": the cache records the error and
 * keeps `available: false`. Never throws.
 */
export async function checkWebmateUpdate(deps: CheckDeps): Promise<UpdateCheckFile> {
  const io = deps.io ?? defaultPairingIo()
  const log = deps.log ?? (() => {})
  const previous = readUpdateCheck(deps.paths, io)
  const installedVersion = readInstalledVersion(deps.paths.installDir)
  const checkedAt = io.now().toISOString()

  let body: string

  try {
    body = await deps.fetchText(deps.feedUrl ?? WEBMATE_RELEASE_FEED_URL)
  } catch (error) {
    const message = `feed unreachable: ${error instanceof Error ? error.message : String(error)}`

    log(`[webmate] update check: ${message}`)

    return writeUpdateCheck(
      deps.paths,
      { ...previous, checkedAt, ok: false, error: message, installedVersion, available: false },
      io
    )
  }

  let raw: unknown

  try {
    raw = JSON.parse(body)
  } catch {
    return writeUpdateCheck(
      deps.paths,
      { ...previous, checkedAt, ok: false, error: 'feed is not JSON', installedVersion, available: false },
      io
    )
  }

  if (!verifyReleaseManifest(raw, deps.publicKeyPem ?? WEBMATE_RELEASE_PUBLIC_KEY, deps.parseOptions)) {
    log('[webmate] update check: release.json signature does not verify; treating as no feed')

    return writeUpdateCheck(
      deps.paths,
      {
        ...previous,
        checkedAt,
        ok: false,
        error: 'feed signature does not verify',
        feed: null,
        installedVersion,
        available: false,
        belowMinProtocol: false
      },
      io
    )
  }

  const release = parseReleaseManifest(raw, deps.parseOptions)

  const verdict = evaluateFeed({
    release,
    installedVersion,
    appVersion: deps.appVersion,
    protocolVersion: deps.protocolVersion ?? null,
    failedVersions: previous.failedVersions
  })

  return writeUpdateCheck(
    deps.paths,
    {
      ...previous,
      checkedAt,
      ok: true,
      error: null,
      feed: feedSummary(release),
      installedVersion,
      ...verdict,
      // A pending version that is no longer newer than what is installed is moot.
      pendingVersion:
        previous.pendingVersion && installedVersion && compareVersions(previous.pendingVersion, installedVersion) <= 0
          ? null
          : previous.pendingVersion
    },
    io
  )
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export type ApplyStage =
  | 'download'
  | 'verify'
  | 'extract'
  | 'drain'
  | 'swap'
  | 'reload'
  | 'confirm'
  | 'rollback'
  | 'done'
  | 'pending'
  | 'error'

export interface ApplyOutcome {
  ok: boolean
  version: string
  stage: ApplyStage
  error: string | null
  /** The new folder did not say hello in time and the previous one is back. */
  rolledBack: boolean
  /** The folder was busy; the staged copy waits for the browser to close. */
  pending: boolean
  /** The browser was attached, so the live path (drain → reload → confirm) ran. */
  live: boolean
}

export interface ApplyDeps {
  paths: WebmatePaths
  release: ReleaseManifest
  pairing: PairingFile
  pairingOptions: PairingOptions
  /** Fetch the zip bytes; reject on any failure. */
  download: (url: string) => Promise<Buffer>
  /** A fresh read of `<webmate>/` (state.json etc.). */
  readStatus: () => WebmateLocalStatus
  sendCommand: (action: WebmateCommandAction) => string
  waitForCommand: (id: string, timeoutMs: number) => Promise<WebmateLastCommand | null>
  io?: UpdateIo
  onProgress?: (stage: ApplyStage, message: string) => void
  log?: (message: string) => void
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  expectedExtensionId?: string
  drainTimeoutMs?: number
  helloTimeoutMs?: number
  helloPollMs?: number
  renameRetries?: number
  renameRetryDelayMs?: number
}

const NOT_CONNECTED_CODES = new Set(['WEBMATE_NOT_CONNECTED', 'WEBMATE_NOT_INSTALLED', 'WEBMATE_OUTDATED'])

/** Move `from` to `to` after clearing `to`; errors bubble (the caller decides between retry, pending and rollback). */
async function replaceDir(from: string, to: string, retries: number, delayMs: number): Promise<void> {
  await fsp.rm(to, { recursive: true, force: true })
  await renameWithRetry(from, to, retries, delayMs)
}

function isBusyError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code

  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'ENOTEMPTY'
}

export async function applyWebmateUpdate(deps: ApplyDeps): Promise<ApplyOutcome> {
  const io = deps.io ?? defaultPairingIo()
  const log = deps.log ?? (() => {})
  const progress = deps.onProgress ?? (() => {})
  const sleep = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const now = deps.now ?? Date.now
  const { paths, release } = deps
  const version = release.version
  const expectedId = deps.expectedExtensionId ?? WEBMATE_EXTENSION_ID
  const retries = deps.renameRetries ?? 5
  const retryDelay = deps.renameRetryDelayMs ?? 2_000
  const stagedDir = nodePath.join(paths.versionsDir, version)
  const zipPath = nodePath.join(paths.versionsDir, `${version}.zip`)

  const fail = (stage: ApplyStage, error: string, extra: Partial<ApplyOutcome> = {}): ApplyOutcome => {
    log(`[webmate] update ${version} failed at ${stage}: ${error}`)
    progress('error', error)
    writeUpdateCheck(
      paths,
      {
        lastApply: {
          version,
          ok: false,
          at: new Date(now()).toISOString(),
          error,
          rolledBack: extra.rolledBack ?? false
        }
      },
      io
    )

    return { ok: false, version, stage, error, rolledBack: false, pending: false, live: false, ...extra }
  }

  // 1. download + sha256
  progress('download', version)
  let zip: Buffer

  try {
    zip = await deps.download(release.chrome.url)
  } catch (error) {
    return fail('download', `download failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  progress('verify', version)
  const digest = sha256Hex(zip)

  if (digest !== release.chrome.sha256) {
    return fail(
      'verify',
      `sha256 mismatch: downloaded ${digest.slice(0, 12)}…, release.json says ${release.chrome.sha256.slice(0, 12)}…`
    )
  }

  await fsp.mkdir(paths.versionsDir, { recursive: true })
  await fsp.writeFile(zipPath, zip)

  // 2. extract + manifest checks + workmate.json
  progress('extract', version)

  try {
    await fsp.rm(stagedDir, { recursive: true, force: true })
    await extractZip(zip, stagedDir)

    const manifest = JSON.parse(await fsp.readFile(nodePath.join(stagedDir, 'manifest.json'), 'utf8'))

    if (manifest.version !== version) {
      throw new Error(`extracted manifest is version ${manifest.version}, expected ${version}`)
    }

    if (typeof manifest.key !== 'string' || extensionIdFromPublicKey(manifest.key) !== expectedId) {
      throw new Error(`extracted manifest key does not derive to the expected extension ID ${expectedId}`)
    }

    writeWorkmateJsonInto(stagedDir, deps.pairing, deps.pairingOptions)
  } catch (error) {
    await fsp.rm(stagedDir, { recursive: true, force: true })

    return fail('extract', error instanceof Error ? error.message : String(error))
  } finally {
    await fsp.rm(zipPath, { force: true })
  }

  // 3. drain, when a browser is attached
  const before = deps.readStatus()
  let live = before.connected

  if (live) {
    progress('drain', version)
    const id = deps.sendCommand('prepare_update')
    const result = await deps.waitForCommand(id, (deps.drainTimeoutMs ?? 60_000) + 5_000)

    if (result === null) {
      // The server never picked the command up: it is not running. Nothing to
      // drain or reload; swap like a closed browser.
      log('[webmate] prepare_update was not acknowledged; treating the browser as closed')
      live = false
    } else if (!result.ok) {
      if (result.error && NOT_CONNECTED_CODES.has(result.error)) {
        live = false
      } else {
        // Still busy after the server's own deadline. Do not cut a task off:
        // lift the drain and try again later.
        deps.sendCommand('resume')
        await fsp.rm(stagedDir, { recursive: true, force: true })

        return fail('drain', result.error || `browser still busy (${result.busy ?? '?'} run(s))`)
      }
    }
  }

  // 4. swap
  progress('swap', version)
  const hadInstall = fs.existsSync(paths.installDir)

  try {
    if (hadInstall) {
      await replaceDir(paths.installDir, paths.prevDir, retries, retryDelay)
    }

    await renameWithRetry(stagedDir, paths.installDir, retries, retryDelay)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    // Put the old folder back if it was moved aside but the new one could not land.
    if (!fs.existsSync(paths.installDir) && fs.existsSync(paths.prevDir)) {
      try {
        await fsp.rename(paths.prevDir, paths.installDir)
      } catch {
        /* the next attempt retries */
      }
    }

    if (live) {
      deps.sendCommand('resume')
    }

    if (isBusyError(error) && fs.existsSync(stagedDir)) {
      log(`[webmate] extension folder is busy (${message}); ${version} stays staged as pendingVersion`)
      progress('pending', version)
      writeUpdateCheck(
        paths,
        {
          pendingVersion: version,
          lastApply: {
            version,
            ok: false,
            at: new Date(now()).toISOString(),
            error: `folder busy: ${message}`,
            rolledBack: false
          }
        },
        io
      )

      return {
        ok: false,
        version,
        stage: 'pending',
        error: `folder busy: ${message}`,
        rolledBack: false,
        pending: true,
        live
      }
    }

    await fsp.rm(stagedDir, { recursive: true, force: true })

    return fail('swap', message, { live })
  }

  if (!live) {
    // 7. browser closed: done after the swap.
    progress('done', version)
    writeUpdateCheck(
      paths,
      {
        installedVersion: readInstalledVersion(paths.installDir),
        available: false,
        pendingVersion: null,
        lastApply: { version, ok: true, at: new Date(now()).toISOString(), error: null, rolledBack: false }
      },
      io
    )
    log(`[webmate] updated to ${version} (browser not attached)`)

    return { ok: true, version, stage: 'done', error: null, rolledBack: false, pending: false, live: false }
  }

  // 5. reload
  progress('reload', version)
  deps.sendCommand('reload')

  // 6. confirm: a hello with the new version
  progress('confirm', version)
  const deadline = now() + (deps.helloTimeoutMs ?? 60_000)
  let confirmed = false

  while (now() < deadline) {
    const status = deps.readStatus()

    if (status.connected && status.extensionVersion === version) {
      confirmed = true

      break
    }

    await sleep(deps.helloPollMs ?? 500)
  }

  if (confirmed) {
    progress('done', version)
    writeUpdateCheck(
      paths,
      {
        installedVersion: version,
        available: false,
        pendingVersion: null,
        lastApply: { version, ok: true, at: new Date(now()).toISOString(), error: null, rolledBack: false }
      },
      io
    )
    log(`[webmate] updated to ${version}; the extension is back`)

    return { ok: true, version, stage: 'done', error: null, rolledBack: false, pending: false, live: true }
  }

  // Rollback: new folder back to staging, previous folder back in place, reload again.
  progress('rollback', version)
  log(`[webmate] ${version} never said hello; rolling back`)

  let rolledBack = false

  try {
    if (fs.existsSync(paths.prevDir)) {
      await replaceDir(paths.installDir, stagedDir, retries, retryDelay)
      await renameWithRetry(paths.prevDir, paths.installDir, retries, retryDelay)
      rolledBack = true
      deps.sendCommand('reload')
    }
  } catch (error) {
    log(`[webmate] rollback failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  const failed = readUpdateCheck(paths, io).failedVersions

  writeUpdateCheck(
    paths,
    {
      installedVersion: readInstalledVersion(paths.installDir),
      available: false,
      failedVersions: failed.includes(version) ? failed : [...failed, version],
      lastApply: {
        version,
        ok: false,
        at: new Date(now()).toISOString(),
        error: 'no hello from the new version',
        rolledBack
      }
    },
    io
  )
  progress('error', 'no hello from the new version')

  return {
    ok: false,
    version,
    stage: 'rollback',
    error: 'no hello from the new version',
    rolledBack,
    pending: false,
    live: true
  }
}

/**
 * Finish a swap that was deferred because the browser held the folder. Runs
 * when the extension is no longer attached; the staged folder must still be
 * there. Returns null when there is nothing pending.
 */
export async function applyPendingSwap(
  paths: WebmatePaths,
  options: { io?: UpdateIo; log?: (message: string) => void; renameRetries?: number; renameRetryDelayMs?: number } = {}
): Promise<ApplyOutcome | null> {
  const io = options.io ?? defaultPairingIo()
  const log = options.log ?? (() => {})
  const check = readUpdateCheck(paths, io)
  const version = check.pendingVersion

  if (!version) {
    return null
  }

  const stagedDir = nodePath.join(paths.versionsDir, version)

  if (!fs.existsSync(nodePath.join(stagedDir, 'manifest.json'))) {
    writeUpdateCheck(paths, { pendingVersion: null }, io)

    return null
  }

  try {
    if (fs.existsSync(paths.installDir)) {
      await replaceDir(paths.installDir, paths.prevDir, options.renameRetries ?? 1, options.renameRetryDelayMs ?? 0)
    }

    await renameWithRetry(stagedDir, paths.installDir, options.renameRetries ?? 1, options.renameRetryDelayMs ?? 0)
  } catch (error) {
    if (!fs.existsSync(paths.installDir) && fs.existsSync(paths.prevDir)) {
      try {
        await fsp.rename(paths.prevDir, paths.installDir)
      } catch {
        /* next time */
      }
    }

    log(`[webmate] pending swap to ${version} still blocked: ${error instanceof Error ? error.message : String(error)}`)

    return {
      ok: false,
      version,
      stage: 'pending',
      error: error instanceof Error ? error.message : String(error),
      rolledBack: false,
      pending: true,
      live: false
    }
  }

  writeUpdateCheck(
    paths,
    {
      installedVersion: version,
      available: false,
      pendingVersion: null,
      lastApply: { version, ok: true, at: io.now().toISOString(), error: null, rolledBack: false }
    },
    io
  )
  log(`[webmate] pending swap to ${version} completed`)

  return { ok: true, version, stage: 'done', error: null, rolledBack: false, pending: false, live: false }
}
