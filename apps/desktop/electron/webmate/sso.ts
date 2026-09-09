/**
 * Seamless sign-in decisions (phase 4), kept pure so they are testable:
 *
 *   • which attached browsers should be told to sign in silently
 *     (`auth_hint`), and when to leave them alone;
 *   • where Workmate's own Keycloak sign-in should open, so the SSO cookie
 *     lands in the browser that runs WebMate and the silent sign-in there
 *     can reuse it.
 *
 * The service (service.ts) feeds these the status the watcher pushes and the
 * prefs; nothing here touches files or processes.
 */

import type { BrowserInfo } from './browsers'
import type { WebmateChosenBrowser, WebmatePrefs } from './prefs'
import type { WebmateConnection } from './status'

/** Do not re-hint the same browser more often than this unless it reconnects. */
export const HINT_COOLDOWN_MS = 10 * 60_000

export interface HintDecision {
  /** Instance ids to hint now (the command asks the server for all of them at once). */
  instanceIds: string[]
  /** Why nothing is sent, for the log; null when `instanceIds` is non-empty. */
  reason: 'disabled' | 'no-account' | 'nobody-signed-out' | 'cooling-down' | null
}

/**
 * Which attached browsers deserve an `auth_hint` right now: Workmate-installed
 * extensions that report NOT signed in, not hinted within the cooldown. A
 * browser whose sign-in state is unknown (`null`) is left alone — the hint is
 * cheap, but guessing is how a person gets a surprise sign-in popup.
 */
export function planAuthHints(
  connections: readonly WebmateConnection[],
  prefs: Pick<WebmatePrefs, 'ssoAutoSignIn'>,
  loginHint: string | null,
  lastHintAt: ReadonlyMap<string, number>,
  now: number,
  cooldownMs: number = HINT_COOLDOWN_MS
): HintDecision {
  if (!prefs.ssoAutoSignIn) {
    return { instanceIds: [], reason: 'disabled' }
  }

  if (!loginHint) {
    return { instanceIds: [], reason: 'no-account' }
  }

  const signedOut = connections.filter(c => c.installType === 'workmate' && c.signedIn === false)

  if (!signedOut.length) {
    return { instanceIds: [], reason: 'nobody-signed-out' }
  }

  const due = signedOut.filter(c => {
    const last = lastHintAt.get(c.instanceId)

    return last === undefined || now - last >= cooldownMs
  })

  if (!due.length) {
    return { instanceIds: [], reason: 'cooling-down' }
  }

  return { instanceIds: due.map(c => c.instanceId), reason: null }
}

export type LoginTarget =
  | { kind: 'window' }
  | { kind: 'browser'; browser: BrowserInfo; profileDir: string | null }
  | { kind: 'system'; reason: 'no-choice' | 'browser-gone' | 'window-closed' }

/**
 * Where to open Workmate's sign-in page. The Workmate browser window when
 * that mode is on and the window is open; else the browser/profile the
 * person chose (guided install or Settings → "Chọn trình duyệt"), if it is
 * still on the machine; else the system default browser as before.
 */
export function chooseLoginTarget(
  prefs: Pick<WebmatePrefs, 'mode' | 'browser'>,
  windowOpen: boolean,
  browsers: readonly BrowserInfo[]
): LoginTarget {
  if (prefs.mode === 'window') {
    if (windowOpen) {
      return { kind: 'window' }
    }

    // The person wants the separate window, but it is closed: a sign-in
    // there would need the window first, and their own browser may not hold
    // WebMate at all. Fall through to the chosen browser, then the system.
    if (!prefs.browser) {
      return { kind: 'system', reason: 'window-closed' }
    }
  }

  const chosen = prefs.browser

  if (!chosen) {
    return { kind: 'system', reason: 'no-choice' }
  }

  const browser = browsers.find(candidate => candidate.id === chosen.id && candidate.supported)

  if (!browser || (!browser.executable && !browser.appPath)) {
    return { kind: 'system', reason: 'browser-gone' }
  }

  const profileDir =
    browser.singleProfile || !chosen.profileDir
      ? null
      : browser.profiles.some(profile => profile.dir === chosen.profileDir)
        ? chosen.profileDir
        : null

  return { kind: 'browser', browser, profileDir }
}

/** The `prefs.browser` record for a scanned browser + profile (Settings → "Chọn trình duyệt"). */
export function chosenBrowserFrom(browser: BrowserInfo, profileDir: string | null): WebmateChosenBrowser {
  const profile = profileDir ? browser.profiles.find(candidate => candidate.dir === profileDir) : undefined

  return {
    id: browser.id,
    name: browser.name,
    profileDir: profile?.dir ?? (browser.singleProfile ? null : profileDir),
    profileName: profile?.displayName ?? null
  }
}
