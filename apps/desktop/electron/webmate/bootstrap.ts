/**
 * What the desktop does for WebMate on every launch, in one idempotent call:
 *
 *   1. make sure `<root>/webmate/AgentX WebMate` holds the extension the
 *      installer bundled (install or update it from resources/webmate);
 *   2. make sure a pairing exists and the folder carries it (workmate.json).
 *
 * Nothing here touches the browser — that is the guided step (phase 2). It
 * only prepares the folder a user drags onto chrome://extensions, so the
 * onboarding step and Settings always find it ready.
 *
 * Failures are reported, never thrown: a broken bundle must not stop the app
 * from starting, and the status endpoint / Settings surface the reason.
 */

import fs from 'node:fs'
import nodePath from 'node:path'

import {
  ensureExtensionFolder,
  type InstallOutcome,
  locateBundledExtension,
  readInstalledVersion
} from './extension-store'
import { ensurePairing, type PairingOutcome } from './pairing'
import { WEBMATE_BRIDGE_PORT, WEBMATE_MIN_SERVER_VERSION, type WebmatePaths, webmatePaths } from './paths'

export interface BootstrapOptions {
  /** The AgentX install root (or any AGENTX_HOME under it). */
  agentxHome: string
  /** `process.resourcesPath` in a packaged app; null in dev. */
  resourcesPath: string | null
  /** `app.getAppPath()` — the checkout in dev, so build/webmate is found after a local build. */
  appRoot: string
  appVersion: string
  isPackaged: boolean
  bridgePort?: number
  log?: (message: string) => void
  /** Injected for tests. */
  pathModule?: typeof nodePath
}

export interface BootstrapResult {
  paths: WebmatePaths
  bundledVersion: string | null
  extension: InstallOutcome | null
  pairing: Pick<PairingOutcome, 'pairingWritten' | 'workmateJsonWritten' | 'extensionPresent'> | null
  installedVersion: string | null
  error: string | null
}

export async function bootstrapWebmate(options: BootstrapOptions): Promise<BootstrapResult> {
  const log = options.log ?? (() => {})
  const pathModule = options.pathModule ?? nodePath
  const paths = webmatePaths(options.agentxHome, pathModule)

  const bundled = locateBundledExtension([
    options.resourcesPath ? pathModule.join(options.resourcesPath, 'webmate') : null,
    pathModule.join(options.appRoot, 'build', 'webmate')
  ])

  const result: BootstrapResult = {
    paths,
    bundledVersion: bundled?.version ?? null,
    extension: null,
    pairing: null,
    installedVersion: null,
    error: null
  }

  try {
    result.extension = await ensureExtensionFolder(paths, bundled, { isPackaged: options.isPackaged, log })
  } catch (error) {
    result.error = `extension: ${error instanceof Error ? error.message : String(error)}`
    log(`[webmate] ${result.error}`)
  }

  try {
    const pairing = ensurePairing(paths, {
      port: options.bridgePort ?? WEBMATE_BRIDGE_PORT,
      workmateVersion: options.appVersion,
      minServerVersion: WEBMATE_MIN_SERVER_VERSION
    })

    result.pairing = {
      pairingWritten: pairing.pairingWritten,
      workmateJsonWritten: pairing.workmateJsonWritten,
      extensionPresent: pairing.extensionPresent
    }

    if (pairing.pairingWritten) {
      log(`[webmate] pairing written to ${paths.pairingFile}`)
    }
  } catch (error) {
    const message = `pairing: ${error instanceof Error ? error.message : String(error)}`

    result.error = result.error ? `${result.error}; ${message}` : message
    log(`[webmate] ${message}`)
  }

  result.installedVersion = readInstalledVersion(paths.installDir)

  return result
}

export interface LocalWebmateStatus {
  paths: WebmatePaths
  installedVersion: string | null
  pairingPresent: boolean
  /** state.json as the MCP server wrote it, or null. */
  bridge: Record<string, unknown> | null
}

/** The facts the desktop can read without the backend: folder, pairing, state.json. */
export function readLocalWebmateStatus(agentxHome: string, pathModule: typeof nodePath = nodePath): LocalWebmateStatus {
  const paths = webmatePaths(agentxHome, pathModule)

  const readJson = (file: string): Record<string, unknown> | null => {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))

      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
    } catch {
      return null
    }
  }

  const pairing = readJson(paths.pairingFile)

  return {
    paths,
    installedVersion: readInstalledVersion(paths.installDir),
    pairingPresent: typeof pairing?.token === 'string' && pairing.token.length > 0,
    bridge: readJson(paths.stateFile)
  }
}
