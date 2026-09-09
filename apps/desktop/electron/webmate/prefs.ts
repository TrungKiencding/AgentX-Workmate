/**
 * `<webmate>/prefs.json` — what the person decided about WebMate on this machine.
 *
 * Kept next to the extension folder rather than in the renderer's localStorage
 * because two processes need it: the renderer (onboarding step, Settings →
 * Trình duyệt) and the main process (the updater honours `autoUpdate`, the
 * status watcher reports `mode`). One file, temp + rename, deletable with the
 * rest of `<webmate>/` (apps/desktop/WEBMATE-INTEGRATION-PLAN.md §2.1, constraint 9).
 *
 * Nothing here is secret: the token lives in pairing.json.
 */

import { defaultPairingIo, type PairingIo } from './pairing'
import type { WebmatePaths } from './paths'

export type WebmatePrompt = null | 'later' | 'never'
export type WebmateMode = null | 'browser' | 'window'

export interface WebmateChosenBrowser {
  id: string
  name: string
  profileDir: string | null
  profileName: string | null
}

export interface WebmatePrefs {
  schema: 1
  /** Onboarding step: null = not asked yet, 'later' = deferred once, 'never' = never ask again. */
  prompt: WebmatePrompt
  /** Install a newer signed release from the feed without asking. */
  autoUpdate: boolean
  /** Show the "Workmate wants to use your browser" card when a tool fails with a WEBMATE_* code. */
  askWhenNotReady: boolean
  /** 'browser' = the person's own browser (guided install), 'window' = the Workmate browser window (phase 3). */
  mode: WebmateMode
  /** The browser and profile picked in the guided step or in Settings ("Chọn trình duyệt"); null until then. */
  browser: WebmateChosenBrowser | null
  /**
   * Phase 4: sign WebMate in with the Workmate account by itself (an
   * `auth_hint` after every hello from a browser nobody is signed in to), and
   * open Workmate's own sign-in in the chosen browser so the SSO cookie lands
   * where WebMate is.
   */
  ssoAutoSignIn: boolean
  /** ISO time the extension first connected as a Workmate install; null until then. */
  connectedAt: string | null
  /** ISO time until which the "wants to use your browser" card stays quiet ("Không phải bây giờ"). */
  cardSnoozedUntil: string | null
  /** ISO time until which the "update available" toast stays quiet. */
  updateToastSnoozedUntil: string | null
  updatedAt: string
}

export type WebmatePrefsPatch = Partial<Omit<WebmatePrefs, 'schema' | 'updatedAt'>>

export type PrefsIo = Pick<PairingIo, 'readText' | 'writeTextAtomic' | 'now'>

export function defaultPrefs(now: Date = new Date()): WebmatePrefs {
  return {
    schema: 1,
    prompt: null,
    autoUpdate: true,
    askWhenNotReady: true,
    mode: null,
    browser: null,
    ssoAutoSignIn: true,
    connectedAt: null,
    cardSnoozedUntil: null,
    updateToastSnoozedUntil: null,
    updatedAt: now.toISOString()
  }
}

const isIso = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value))

function parseBrowser(value: unknown): WebmateChosenBrowser | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const record = value as Record<string, unknown>

  if (typeof record.id !== 'string' || !record.id) {
    return null
  }

  return {
    id: record.id,
    name: typeof record.name === 'string' ? record.name : record.id,
    profileDir: typeof record.profileDir === 'string' ? record.profileDir : null,
    profileName: typeof record.profileName === 'string' ? record.profileName : null
  }
}

/** prefs.json text → prefs. Unknown or broken input yields the defaults (never throws). */
export function parsePrefs(text: string | null, now: Date = new Date()): WebmatePrefs {
  const defaults = defaultPrefs(now)

  if (!text) {
    return defaults
  }

  let raw: unknown

  try {
    raw = JSON.parse(text)
  } catch {
    return defaults
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return defaults
  }

  const record = raw as Record<string, unknown>

  return {
    schema: 1,
    prompt: record.prompt === 'later' || record.prompt === 'never' ? record.prompt : null,
    autoUpdate: typeof record.autoUpdate === 'boolean' ? record.autoUpdate : defaults.autoUpdate,
    askWhenNotReady: typeof record.askWhenNotReady === 'boolean' ? record.askWhenNotReady : defaults.askWhenNotReady,
    mode: record.mode === 'browser' || record.mode === 'window' ? record.mode : null,
    browser: parseBrowser(record.browser),
    ssoAutoSignIn: typeof record.ssoAutoSignIn === 'boolean' ? record.ssoAutoSignIn : defaults.ssoAutoSignIn,
    connectedAt: isIso(record.connectedAt) ? record.connectedAt : null,
    cardSnoozedUntil: isIso(record.cardSnoozedUntil) ? record.cardSnoozedUntil : null,
    updateToastSnoozedUntil: isIso(record.updateToastSnoozedUntil) ? record.updateToastSnoozedUntil : null,
    updatedAt: isIso(record.updatedAt) ? record.updatedAt : defaults.updatedAt
  }
}

export function prefsFile(paths: WebmatePaths, pathModule: { join: (...parts: string[]) => string }): string {
  return pathModule.join(paths.root, 'prefs.json')
}

export function readPrefs(file: string, io: PrefsIo = defaultPairingIo()): WebmatePrefs {
  return parsePrefs(io.readText(file), io.now())
}

/** Merge `patch` into the file and return the result. Writes only when something changed. */
export function writePrefs(file: string, patch: WebmatePrefsPatch, io: PrefsIo = defaultPairingIo()): WebmatePrefs {
  const current = readPrefs(file, io)
  const merged: WebmatePrefs = { ...current, ...stripUndefined(patch), schema: 1 }
  const { updatedAt: _a, ...currentBody } = current
  const { updatedAt: _b, ...mergedBody } = merged

  if (JSON.stringify(currentBody) === JSON.stringify(mergedBody) && io.readText(file) !== null) {
    return current
  }

  merged.updatedAt = io.now().toISOString()
  io.writeTextAtomic(file, `${JSON.stringify(merged, null, 2)}\n`)

  return merged
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}

/** true while an ISO "snoozed until" lies in the future. */
export function isSnoozed(until: string | null, now: Date = new Date()): boolean {
  return until !== null && Date.parse(until) > now.getTime()
}
