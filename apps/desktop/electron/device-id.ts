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
 * Parsing is deliberately total, like `account-store.ts`: a truncated or
 * hand-edited file yields a fresh id rather than throwing. This is read during
 * boot, and the cost of the failure modes is wildly asymmetric — a new id
 * costs one stale row in a device list somebody can delete, while a throw here
 * costs the user their app.
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
 * mints a fresh id.
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

  if (!parsed || typeof parsed !== 'object' || !isDeviceId(parsed.id)) {
    return null
  }

  return {
    id: parsed.id,
    name: typeof parsed.name === 'string' ? parsed.name : '',
    createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : ''
  }
}

/**
 * Return this install's device record, creating or repairing it as needed.
 *
 * Writes only when something actually changed — a fresh id, or a machine the
 * user has since renamed — so the common path is one read.
 */
export function readDeviceRecord(io: DeviceStoreIo): DeviceRecord {
  const name = deviceNameFrom(io.hostname())

  let stored: DeviceRecord | null = null

  try {
    stored = parseDeviceRecord(io.readText())
  } catch (error) {
    io.rememberLog?.(
      `[device] could not read the device id: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }

  if (stored && stored.name === name) {
    return stored
  }

  const record: DeviceRecord = {
    id: stored?.id || (io.newId ? io.newId() : randomUUID()),
    name,
    createdAt: stored?.createdAt || (io.now ? io.now() : new Date()).toISOString()
  }

  try {
    io.writeText(JSON.stringify(record, null, 2))
  } catch (error) {
    // An unwritable userData means the id is regenerated on the next launch,
    // which shows up as a duplicate row in a device list. Still better than
    // refusing to start.
    io.rememberLog?.(
      `[device] could not persist the device id: ${
        error instanceof Error ? error.message : String(error)
      }`
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
