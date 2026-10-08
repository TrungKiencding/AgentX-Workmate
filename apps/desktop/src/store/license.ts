import { atom, computed } from 'nanostores'

import type { DesktopLicense, DesktopLicenseView } from '@/global'
import { translationsNow } from '@/i18n'
import { asLicense, licenseBannerKind, licenseExpiringMessage, licenseReminderKey } from '@/lib/license'
import { persistStringArray, storedStringArray } from '@/lib/storage'
import { notify } from '@/store/notifications'
import { isSecondaryWindow } from '@/store/windows'

/**
 * This person's AgentX license, as the local backend last heard it.
 *
 * The main process owns the cadence (electron/license-sync.ts): it refreshes
 * after sign-in, every half hour and on focus, and pushes every change here.
 * The backend owns the decision — it refuses AI turns from the same record —
 * so this is a mirror for the surfaces that explain it: the composer's banner
 * and lock, Settings → Account, the reminder before a plan ends.
 *
 * A null `license` means none is known: an SSO that predates licensing, or
 * nobody signed in yet. Nothing is shown and nothing is locked.
 */
export interface LicenseState {
  /** The preload bridge exposes `license` at all — it is optional. */
  available: boolean
  /** The first answer has arrived; distinguishes "loading" from "none known". */
  loaded: boolean
  /** The account the license belongs to (the backend's slug). */
  account: null | string
  license: DesktopLicense | null
  /** A "Check again" is in flight. */
  checking: boolean
  /** How the last "Check again" went (`ok`, `offline`, …); null before one. */
  lastCheck: null | string
}

const INITIAL: LicenseState = {
  account: null,
  available: false,
  checking: false,
  lastCheck: null,
  license: null,
  loaded: false
}

export const $license = atom<LicenseState>(INITIAL)

/** The composer is locked: no request may reach AI. */
export const $licenseReadOnly = computed($license, state => state.license?.access === 'read_only')

/** What the composer banner shows, if anything (a coarse edge for the status stack). */
export const $licenseBanner = computed($license, state => licenseBannerKind(state.license))

/** Outcomes of a check that leave the shown license unconfirmed. */
const UNCONFIRMED_CHECKS = new Set(['offline', 'unavailable', 'unauthorized', 'revoked', 'error'])

export function licenseCheckFailed(state: LicenseState): boolean {
  return state.lastCheck !== null && UNCONFIRMED_CHECKS.has(state.lastCheck)
}

function bridge() {
  return typeof window === 'undefined' ? undefined : window.agentxDesktop?.license
}

// ── The reminder ───────────────────────────────────────────────────────────
// Shown once per person, plan, last day and threshold (14, 7, 1 days by
// default), remembered across launches. Only the main window raises it, so a
// second chat window does not repeat it.

// One list for the machine; every entry names the account it was shown to
// (licenseReminderKey), so two people sharing it are each reminded.
const REMINDERS_SHOWN_KEY = 'agentx.desktop.licenseRemindersShown.byAccount.v1'
const REMINDER_TOAST_ID = 'license-reminder'

// Enough for every threshold of a few plans; the oldest are dropped first.
const REMINDERS_REMEMBERED = 50

function remind(state: LicenseState): void {
  const key = licenseReminderKey(state.account, state.license)

  if (!key || !state.license || isSecondaryWindow()) {
    return
  }

  const shown = storedStringArray(REMINDERS_SHOWN_KEY)

  if (shown.includes(key)) {
    return
  }

  persistStringArray(REMINDERS_SHOWN_KEY, [...shown, key].slice(-REMINDERS_REMEMBERED))

  notify({
    durationMs: 0,
    icon: 'calendar',
    id: REMINDER_TOAST_ID,
    kind: 'warning',
    message: licenseExpiringMessage(state.license, translationsNow().license),
    scope: 'app'
  })
}

// ── Receiving ──────────────────────────────────────────────────────────────

function receive(view: DesktopLicenseView | null | undefined): LicenseState {
  const current = $license.get()

  // `unavailable`: the main process could not ask the backend — no news. What
  // this window knows stands, and may be newer than main's copy (a turn the
  // backend just refused for the license).
  const next: LicenseState =
    view && view.status !== 'unavailable'
      ? { ...current, account: view.account ?? null, available: true, license: asLicense(view.license), loaded: true }
      : { ...current, available: true, loaded: true }

  $license.set(next)
  remind(next)

  return next
}

/** Re-read what the backend knows (no keys-service call). Never throws. */
export async function refreshLicense(): Promise<LicenseState> {
  const api = bridge()

  if (!api) {
    const next = { ...$license.get(), loaded: true }

    $license.set(next)

    return next
  }

  try {
    return receive(await api.get())
  } catch {
    return receive(null)
  }
}

/** "Check again": ask the keys service now. Never throws. */
export async function checkLicenseNow(): Promise<LicenseState> {
  const api = bridge()

  if (!api) {
    return $license.get()
  }

  $license.set({ ...$license.get(), checking: true })

  let view: DesktopLicenseView | null = null

  try {
    view = await api.refresh()
  } catch {
    view = null
  }

  const next = receive(view)
  const checked = { ...next, checking: false, lastCheck: view?.status ?? 'unavailable' }

  $license.set(checked)

  return checked
}

/**
 * A turn was refused because the license is read-only (`license_read_only`).
 * The refusal carries the license the backend just decided by — apply it at
 * once so the composer locks, then re-read through the main process, which
 * tells every other window too.
 */
export function noteLicenseRefusal(raw: unknown): void {
  const license = asLicense(raw)

  if (license) {
    $license.set({ ...$license.get(), license, loaded: true })
  }

  void refreshLicense()
}

/** Mirror the main process's view into this window. Returns the unsubscribe. */
export function startLicenseSync(): () => void {
  const api = bridge()

  if (!api) {
    $license.set({ ...INITIAL, loaded: true })

    return () => undefined
  }

  const off = api.onChanged(view => void receive(view))

  void refreshLicense()

  return off
}
