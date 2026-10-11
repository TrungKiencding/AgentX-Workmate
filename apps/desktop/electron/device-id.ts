/**
 * device-id.ts
 *
 * Gives this INSTALL a stable name, so the service can tell one of a person's
 * machines from another.
 *
 * The second-brain service hands every device the same model key and the same
 * conversation history — which is the point — but that makes the devices
 * indistinguishable from the server's side unless each one says who it is.
 * Settings has to be able to list "MacBook Pro, Windows desktop, that laptop
 * in the drawer" and revoke one of them, and a revocation that cannot name a
 * device is a revocation of the account.
 *
 * The id belongs to the INSTALL, not to the person: it lives in Electron's
 * `userData` beside `accounts.json` and `connection.json` rather than in any
 * AgentX home, so signing out and signing in as somebody else does not turn
 * one machine into two, and a self-update does not either.
 *
 * It holds no secret and identifies no person — a random v4 UUID plus the
 * hostname the OS already broadcasts on the local network. Everything about
 * WHO is signed in comes from the verified token; this only answers WHERE.
 *
 * Parsing is deliberately total, like `account-store.ts`: a truncated file
 * recovers the same identity from its backup. Only when neither copy is usable
 * do we generate a fresh id, so file damage does not usually add a stale row
 * and an I/O failure cannot prevent the app from starting.
 */

import { randomUUID } from 'node:crypto'

/** Header carrying the device id on every service request. */
export const DEVICE_ID_HEADER = 'X-AgentX-Device'

/** Header carrying the human-readable name shown in the device list. */
export const DEVICE_NAME_HEADER = 'X-AgentX-Device-Name'

/**
 * The shape the service accepts. Checked on the way out as well as on the way
 * in: a hand-edited file must not be able to put arbitrary text into a header.
 */
export const DEVICE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Longest device name we will send. Bounded because it reaches a header. */
const DEVICE_NAME_MAX = 64

export interface DeviceRecord {
  id: string
  /** Hostname at the time of writing; refreshed whenever the machine is renamed. */
  name: string
  createdAt: string
}

export interface DeviceStoreIo {
  readText(): string | null
  writeText(text: string): void
  readBackupText?(): string | null
  writeBackupText?(text: string): void
  hostname(): string
  now?(): Date
  newId?(): string
  rememberLog?(message: string): void
}

/** True when `value` is shaped like an id we could have written. */
export function isDeviceId(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_ID_RE.test(value)
}

/**
 * Reduce a hostname to something safe to put in a header.
 *
 * Header values cannot carry CR/LF, and a machine name is user-controlled
 * (people call their laptops anything). Everything outside a conservative set
 * collapses to a space, and the result is bounded.
 */
export function deviceNameFrom(hostname: string): string {
  const cleaned = (hostname || '')
    .replace(/[^\x20-\x7E]+/g, ' ')
    .replace(/[^A-Za-z0-9 ._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DEVICE_NAME_MAX)
    .trim()

  return cleaned || 'unknown device'
}

/**
 * Parse the stored record, discarding anything that does not survive
 * validation. Returns null when there is nothing usable — the caller then
 * tries the backup before minting a fresh id.
 */
export function parseDeviceRecord(raw: string | null | undefined): DeviceRecord | null {
  if (!raw) {
    return null
  }

  let parsed: any

  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  const id = typeof parsed?.id === 'string' ? parsed.id.toLowerCase() : ''

  if (!parsed || typeof parsed !== 'object' || !isDeviceId(id)) {
    return null
  }

  return {
    id,
    name: typeof parsed.name === 'string' ? parsed.name : '',
    createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : ''
  }
}

/**
 * Return this install's device record, creating or repairing it as needed.
 *
 * Writes only when something actually changed or a missing copy needs repair.
 * UUID casing never changes the install's identity.
 */
export function readDeviceRecord(io: DeviceStoreIo): DeviceRecord {
  const name = deviceNameFrom(io.hostname())

  let stored: DeviceRecord | null = null

  try {
    stored = parseDeviceRecord(io.readText())
  } catch (error) {
    io.rememberLog?.(`[device] could not read the device id: ${error instanceof Error ? error.message : String(error)}`)
  }

  let recovered = false

  if (!stored && io.readBackupText) {
    try {
      stored = parseDeviceRecord(io.readBackupText())
      recovered = stored !== null
    } catch {
      // Both copies are unusable: retain the existing boot recovery policy.
    }
  }

  if (stored && stored.name === name && !recovered && !io.writeBackupText) {
    return stored
  }

  const record: DeviceRecord = {
    id: stored?.id || (io.newId ? io.newId() : randomUUID()),
    name,
    createdAt: stored?.createdAt || (io.now ? io.now() : new Date()).toISOString()
  }

  try {
    if (!stored || stored.name !== name || recovered) {
      io.writeText(JSON.stringify(record, null, 2))
    }
  } catch (error) {
    // The backup can still preserve the id when the primary cannot be written.
    // Failure to write both copies must not prevent the app from starting.
    io.rememberLog?.(
      `[device] could not persist the device id: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  try {
    if (io.writeBackupText && parseDeviceRecord(io.readBackupText?.())?.id !== record.id) {
      io.writeBackupText(JSON.stringify(record, null, 2))
    }
  } catch (error) {
    io.rememberLog?.(
      `[device] could not back up the device id: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  return record
}

/**
 * The headers every service request carries.
 *
 * Returns an empty object rather than a malformed header when the record is
 * unusable: an absent device header is a case the service answers with a
 * clear `400 device_header_missing`, while a malformed one is a case nobody
 * has thought about.
 */
export function deviceHeaders(record: DeviceRecord | null | undefined): Record<string, string> {
  if (!record || !isDeviceId(record.id)) {
    return {}
  }

  return {
    [DEVICE_ID_HEADER]: record.id,
    [DEVICE_NAME_HEADER]: deviceNameFrom(record.name)
  }
}
