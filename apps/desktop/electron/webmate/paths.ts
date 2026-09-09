/**
 * Where AgentX WebMate lives on this machine, as seen from the desktop app.
 *
 * One folder under the AgentX install root — NOT under accounts/<slug> — because
 * the browser extension belongs to the machine, not to whoever is signed in
 * (apps/desktop/WEBMATE-INTEGRATION-PLAN.md §2.1). The MCP server resolves the
 * same folder from `WEBMATE_DIR`, which the catalog entry passes explicitly,
 * so both sides agree without either guessing about the other.
 *
 * Pure: takes the root and a path module so the Windows shapes can be tested
 * on any host.
 */

import nodePath from 'node:path'

/** Fixed Chrome/Edge extension ID (derived from the manifest `key` pinned in WebMate's brand config). */
export const WEBMATE_EXTENSION_ID = 'pfadeibckkgklmmjghiikadphihbpape'

/** The folder name the browser is pointed at. Never changes: Chrome stores the absolute path. */
export const WEBMATE_INSTALL_DIR_NAME = 'AgentX WebMate'

export const WEBMATE_BRIDGE_PORT = 17374
export const WEBMATE_BRIDGE_PATH = '/extension'

/** Oldest MCP server that speaks the paired handshake; written into workmate.json for the extension's status line. */
export const WEBMATE_MIN_SERVER_VERSION = '1.1.0'

export interface WebmatePaths {
  root: string
  installDir: string
  workmateJson: string
  pairingFile: string
  stateFile: string
  commandsDir: string
  versionsDir: string
  prevDir: string
  updateCheckFile: string
  profileDir: string
}

/**
 * Climb out of `accounts/<slug>` and `profiles/<name>` — the layers Workmate
 * puts under the install root. Mirrors `_strip_home_scoping_segments()` in
 * hermes_constants.py and `stripHomeScopingSegments` in the MCP server.
 */
export function stripHomeScopingSegments(home: string, pathModule: typeof nodePath = nodePath): string {
  let current = pathModule.resolve(home)

  if (pathModule.basename(pathModule.dirname(current)) === 'profiles') {
    current = pathModule.dirname(pathModule.dirname(current))
  }

  if (pathModule.basename(pathModule.dirname(current)) === 'accounts') {
    current = pathModule.dirname(pathModule.dirname(current))
  }

  return current
}

/** Every path the desktop touches, from the AgentX install root. */
export function webmatePaths(agentxRoot: string, pathModule: typeof nodePath = nodePath): WebmatePaths {
  const root = pathModule.join(stripHomeScopingSegments(agentxRoot, pathModule), 'webmate')
  const installDir = pathModule.join(root, WEBMATE_INSTALL_DIR_NAME)
  const versionsDir = pathModule.join(root, 'versions')

  return {
    root,
    installDir,
    workmateJson: pathModule.join(installDir, 'workmate.json'),
    pairingFile: pathModule.join(root, 'pairing.json'),
    stateFile: pathModule.join(root, 'state.json'),
    commandsDir: pathModule.join(root, 'commands'),
    versionsDir,
    prevDir: pathModule.join(versionsDir, 'prev'),
    updateCheckFile: pathModule.join(root, 'update-check.json'),
    profileDir: pathModule.join(root, 'profile')
  }
}

/** The bridge URL the extension dials — loopback only, by construction. */
export function webmateBridgeUrl(port: number = WEBMATE_BRIDGE_PORT): string {
  return `ws://127.0.0.1:${port}${WEBMATE_BRIDGE_PATH}`
}
