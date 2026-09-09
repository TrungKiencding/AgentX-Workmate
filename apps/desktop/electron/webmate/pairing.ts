/**
 * The pairing between this Workmate and the extension folder it manages.
 *
 * Two files carry one token (apps/desktop/WEBMATE-INTEGRATION-PLAN.md §2.2):
 *
 *   pairing.json               read by the MCP server on every handshake
 *   AgentX WebMate/workmate.json   read by the extension before every dial
 *
 * The MCP server requires `hello.token === pairing.token` and echoes it back;
 * the extension refuses a server that does not echo its token. So the token
 * is what makes "the extension Workmate installed" and "the server Workmate
 * runs" recognise each other, and nothing else on the loopback port.
 *
 * Everything here is idempotent: booting the app calls it every time, and the
 * files are only rewritten when their content would change. Writes go through
 * a temp sibling + rename so a reader never sees half a file, and pairing.json
 * is 0600 on POSIX (Windows ACLs make the user profile private already).
 */

import { randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import nodePath from 'node:path'

import { WEBMATE_MIN_SERVER_VERSION, webmateBridgeUrl, type WebmatePaths } from './paths'

export interface PairingFile {
  schema: 1
  token: string
  port: number
  installId: string
  createdAt: string
}

export interface WorkmateJson {
  schema: 1
  wsUrl: string
  token: string
  installId: string
  workmateVersion: string
  minServerVersion: string
}

/** Filesystem seam, so tests run against a temp dir or an in-memory map. */
export interface PairingIo {
  readText(path: string): string | null
  /** Write whole, atomically (temp + rename); `mode` applies on POSIX. */
  writeTextAtomic(path: string, text: string, mode?: number): void
  exists(path: string): boolean
  mkdirp(path: string): void
  randomToken(): string
  uuid(): string
  now(): Date
}

export function defaultPairingIo(): PairingIo {
  return {
    readText: path => {
      try {
        return fs.readFileSync(path, 'utf8')
      } catch {
        return null
      }
    },
    writeTextAtomic: (path, text, mode) => {
      fs.mkdirSync(nodePath.dirname(path), { recursive: true })
      const tmp = `${path}.${process.pid}.${Date.now()}.tmp`

      fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: mode ?? 0o644 })

      try {
        fs.renameSync(tmp, path)
      } catch (error) {
        fs.rmSync(tmp, { force: true })
        throw error
      }

      if (mode !== undefined && process.platform !== 'win32') {
        try {
          fs.chmodSync(path, mode)
        } catch {
          /* best effort; the file was created with this mode already */
        }
      }
    },
    exists: path => fs.existsSync(path),
    mkdirp: path => fs.mkdirSync(path, { recursive: true }),
    randomToken: () => randomBytes(32).toString('base64'),
    uuid: () => randomUUID(),
    now: () => new Date()
  }
}

const MIN_TOKEN_LENGTH = 32

/** pairing.json → record, or null when missing/invalid (both mean "make a new one"). */
export function parsePairingFile(text: string | null): PairingFile | null {
  if (!text) {
    return null
  }

  let raw: unknown

  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }

  const record = raw as Record<string, unknown>

  if (record.schema !== 1 || typeof record.token !== 'string' || record.token.trim().length < MIN_TOKEN_LENGTH) {
    return null
  }

  return {
    schema: 1,
    token: record.token.trim(),
    port: typeof record.port === 'number' && Number.isInteger(record.port) ? record.port : 0,
    installId: typeof record.installId === 'string' ? record.installId : '',
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : ''
  }
}

export interface PairingOptions {
  port: number
  workmateVersion: string
  minServerVersion?: string
  /** Replace the token even when a valid pairing exists ("Đặt lại token"). */
  rotate?: boolean
}

export interface PairingOutcome {
  pairing: PairingFile
  /** true when pairing.json was created or rotated in this call. */
  pairingWritten: boolean
  /** true when workmate.json was created or changed; false when identical or the folder is absent. */
  workmateJsonWritten: boolean
  /** false when the extension folder does not exist yet (nothing to write into). */
  extensionPresent: boolean
}

export function buildWorkmateJson(pairing: PairingFile, options: PairingOptions): WorkmateJson {
  return {
    schema: 1,
    wsUrl: webmateBridgeUrl(options.port),
    token: pairing.token,
    installId: pairing.installId,
    workmateVersion: options.workmateVersion,
    minServerVersion: options.minServerVersion ?? WEBMATE_MIN_SERVER_VERSION
  }
}

const stringify = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

/**
 * Make sure a pairing exists and the extension folder (if present) carries it.
 * Safe to call on every boot and after every folder swap.
 */
export function ensurePairing(paths: WebmatePaths, options: PairingOptions, io: PairingIo = defaultPairingIo()): PairingOutcome {
  io.mkdirp(paths.root)

  let pairing = parsePairingFile(io.readText(paths.pairingFile))
  let pairingWritten = false
  const portChanged = pairing !== null && pairing.port !== options.port

  if (pairing === null || options.rotate || portChanged) {
    pairing = {
      schema: 1,
      token: options.rotate || pairing === null ? io.randomToken() : pairing.token,
      port: options.port,
      installId: pairing?.installId || io.uuid(),
      createdAt: options.rotate || pairing === null ? io.now().toISOString() : pairing.createdAt || io.now().toISOString()
    }
    io.writeTextAtomic(paths.pairingFile, stringify(pairing), 0o600)
    pairingWritten = true
  }

  const extensionPresent = io.exists(nodePath.join(paths.installDir, 'manifest.json'))
  let workmateJsonWritten = false

  if (extensionPresent) {
    const next = stringify(buildWorkmateJson(pairing, options))

    if (io.readText(paths.workmateJson) !== next) {
      io.writeTextAtomic(paths.workmateJson, next)
      workmateJsonWritten = true
    }
  }

  return { pairing, pairingWritten, workmateJsonWritten, extensionPresent }
}

/** Write workmate.json into an arbitrary staged folder (a version about to be swapped in). */
export function writeWorkmateJsonInto(folder: string, pairing: PairingFile, options: PairingOptions, io: PairingIo = defaultPairingIo()): void {
  io.writeTextAtomic(nodePath.join(folder, 'workmate.json'), stringify(buildWorkmateJson(pairing, options)))
}
