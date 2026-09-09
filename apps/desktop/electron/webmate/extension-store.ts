/**
 * The unpacked extension folder Workmate manages: `<webmate>/AgentX WebMate`.
 *
 * On every boot the installer's bundled package (resources/webmate/*.zip plus
 * its release.json) is compared with what is on disk; a missing or older
 * folder is staged under versions/<ver>/, checked, and swapped in by rename
 * so the folder Chrome holds by absolute path never disappears
 * (apps/desktop/WEBMATE-INTEGRATION-PLAN.md §2.1, §2.5 steps 1–2 and 4).
 *
 * What is checked before a byte of the package reaches the folder:
 *   - the zip's sha256 equals release.json's `chrome.sha256`;
 *   - release.json's Ed25519 signature verifies (mandatory in a packaged
 *     app; a source build may bundle an unsigned local zip and says so);
 *   - the extracted manifest's `key` derives to the fixed extension ID and its
 *     `version` equals the release's.
 * There is no "install anyway": a failed check leaves the current folder alone.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import nodePath from 'node:path'

import { WEBMATE_EXTENSION_ID, type WebmatePaths } from './paths'
import { compareVersions, parseReleaseManifest, sha256Hex, verifyReleaseManifest, type ReleaseManifest } from './release-feed'
import { extractZip } from './zip'

/** Chrome's ID for a manifest `key`: SHA-256 of the SPKI, first 16 bytes, nibbles a–p. */
export function extensionIdFromPublicKey(keyBase64: string): string {
  const der = Buffer.from(String(keyBase64 || ''), 'base64')

  if (!der.length) {
    throw new Error('manifest key is empty')
  }

  const digest = createHash('sha256').update(der).digest()
  let id = ''

  for (const byte of digest.subarray(0, 16)) {
    id += String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 15))
  }

  return id
}

export interface BundledExtension {
  zipPath: string
  releaseJsonPath: string | null
  version: string
}

const CHROME_ZIP = /^agentx-webmate-chrome-(\d+\.\d+\.\d+)\.zip$/

/**
 * Find the package the installer shipped: `<resourcesPath>/webmate/` in a
 * packaged app, `<appRoot>/build/webmate/` after a local `npm run build`.
 * Null when neither has a Chrome zip (a source build that skipped the fetch
 * step — the updater then fetches the signed feed on first launch).
 */
export function locateBundledExtension(dirs: Array<string | null | undefined>): BundledExtension | null {
  for (const dir of dirs) {
    if (!dir) {
      continue
    }

    let names: string[]

    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }

    const zips = names
      .map(name => ({ name, match: CHROME_ZIP.exec(name) }))
      .filter(entry => entry.match)
      .sort((a, b) => compareVersions(b.match![1], a.match![1]))

    if (!zips.length) {
      continue
    }

    const releaseJson = nodePath.join(dir, 'release.json')

    return {
      zipPath: nodePath.join(dir, zips[0].name),
      releaseJsonPath: fs.existsSync(releaseJson) ? releaseJson : null,
      version: zips[0].match![1]
    }
  }

  return null
}

export function readInstalledVersion(installDir: string): string | null {
  try {
    const manifest = JSON.parse(fs.readFileSync(nodePath.join(installDir, 'manifest.json'), 'utf8'))

    return typeof manifest?.version === 'string' && manifest.version ? manifest.version : null
  } catch {
    return null
  }
}

export interface EnsureOptions {
  isPackaged: boolean
  expectedExtensionId?: string
  log?: (message: string) => void
  /** Injected for tests (Windows rename retries). */
  renameRetries?: number
  renameRetryDelayMs?: number
}

export type InstallAction = 'installed' | 'updated' | 'kept' | 'skipped'

export interface InstallOutcome {
  action: InstallAction
  installedVersion: string | null
  bundledVersion: string | null
  reason?: string
  /** Set when the swap failed because the browser holds the folder (Windows); the staged folder stays for a later swap. */
  stagedDir?: string
  verified: { sha256: boolean; signature: boolean | 'unsigned' }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** rename() with the Windows-flavoured retry: EBUSY/EPERM while a browser holds a handle. */
export async function renameWithRetry(from: string, to: string, retries = 5, delayMs = 2_000): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsp.rename(from, to)

      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code

      if ((code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES') || attempt >= retries) {
        throw error
      }

      await sleep(delayMs)
    }
  }
}

/**
 * Verify a bundled package. Returns the parsed release manifest (or null for an
 * unsigned local bundle in a source build) or throws with the reason.
 */
export async function verifyBundledPackage(
  bundled: BundledExtension,
  zip: Buffer,
  options: Pick<EnsureOptions, 'isPackaged'>
): Promise<{ release: ReleaseManifest | null; signature: boolean | 'unsigned' }> {
  const digest = sha256Hex(zip)

  if (!bundled.releaseJsonPath) {
    if (options.isPackaged) {
      throw new Error('bundled package has no release.json; a packaged app only installs a signed release')
    }

    return { release: null, signature: 'unsigned' }
  }

  const raw = JSON.parse(await fsp.readFile(bundled.releaseJsonPath, 'utf8'))
  const release = parseReleaseManifest(raw)

  if (release.version !== bundled.version) {
    throw new Error(`release.json is for ${release.version} but the bundled zip is ${bundled.version}`)
  }

  if (release.chrome.sha256 !== digest) {
    throw new Error(`bundled zip sha256 ${digest.slice(0, 12)}… does not match release.json ${release.chrome.sha256.slice(0, 12)}…`)
  }

  const signed = verifyReleaseManifest(raw)

  if (!signed) {
    if (options.isPackaged || typeof release.signature === 'string') {
      // A present-but-bad signature is never tolerated; an absent one only in a source build.
      throw new Error(
        typeof release.signature === 'string'
          ? 'release.json signature does not verify with the WebMate release key'
          : 'release.json is unsigned; a packaged app only installs a signed release'
      )
    }

    return { release, signature: 'unsigned' }
  }

  return { release, signature: true }
}

/**
 * Install or update the extension folder from the bundled package.
 * Idempotent; never removes a working folder without a verified replacement.
 */
export async function ensureExtensionFolder(paths: WebmatePaths, bundled: BundledExtension | null, options: EnsureOptions): Promise<InstallOutcome> {
  const log = options.log ?? (() => {})
  const expectedId = options.expectedExtensionId ?? WEBMATE_EXTENSION_ID
  const installedVersion = readInstalledVersion(paths.installDir)
  const base = { installedVersion, bundledVersion: bundled?.version ?? null }

  if (!bundled) {
    return { ...base, action: installedVersion ? 'kept' : 'skipped', reason: 'no bundled package', verified: { sha256: false, signature: 'unsigned' } }
  }

  if (installedVersion && compareVersions(installedVersion, bundled.version) >= 0) {
    return { ...base, action: 'kept', reason: `installed ${installedVersion} is not older than bundled ${bundled.version}`, verified: { sha256: false, signature: 'unsigned' } }
  }

  const zip = await fsp.readFile(bundled.zipPath)
  const { signature } = await verifyBundledPackage(bundled, zip, options)
  const verified = { sha256: bundled.releaseJsonPath !== null, signature }

  const stagedDir = nodePath.join(paths.versionsDir, bundled.version)

  await fsp.rm(stagedDir, { recursive: true, force: true })
  await extractZip(zip, stagedDir)

  const staged = JSON.parse(await fsp.readFile(nodePath.join(stagedDir, 'manifest.json'), 'utf8'))

  if (staged.version !== bundled.version) {
    await fsp.rm(stagedDir, { recursive: true, force: true })
    throw new Error(`extracted manifest is version ${staged.version}, expected ${bundled.version}`)
  }

  if (typeof staged.key !== 'string' || extensionIdFromPublicKey(staged.key) !== expectedId) {
    await fsp.rm(stagedDir, { recursive: true, force: true })
    throw new Error(`extracted manifest key does not derive to the expected extension ID ${expectedId}`)
  }

  // Swap: current → versions/prev, staged → AgentX WebMate. Two renames, same name.
  await fsp.mkdir(paths.versionsDir, { recursive: true })
  const retries = options.renameRetries ?? 5
  const delay = options.renameRetryDelayMs ?? 2_000

  try {
    if (installedVersion !== null || fs.existsSync(paths.installDir)) {
      await fsp.rm(paths.prevDir, { recursive: true, force: true })
      await renameWithRetry(paths.installDir, paths.prevDir, retries, delay)
    }

    await renameWithRetry(stagedDir, paths.installDir, retries, delay)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    log(`[webmate] could not swap the extension folder: ${message}; staged copy kept at ${stagedDir}`)

    // If the old folder was already moved aside but the new one could not land, put the old one back.
    if (!fs.existsSync(paths.installDir) && fs.existsSync(paths.prevDir)) {
      try {
        await fsp.rename(paths.prevDir, paths.installDir)
      } catch {
        /* nothing better to do; the next boot retries */
      }
    }

    return { ...base, action: 'skipped', reason: `folder busy: ${message}`, stagedDir, verified }
  }

  log(`[webmate] ${installedVersion ? `updated ${installedVersion} →` : 'installed'} ${bundled.version} at ${paths.installDir}`)

  return { ...base, action: installedVersion ? 'updated' : 'installed', installedVersion: bundled.version, verified }
}
