import { atom } from 'nanostores'

import type { DesktopKeycloakStatus } from '@/global'

/**
 * Who is signed in to AgentX, for the account surface.
 *
 * There was no auth store before this: `$desktopBoot` is boot progress,
 * `$connection` is transport config, `$gateway` is sockets. The identity lives
 * in the Electron main process (the encrypted token store), so the renderer
 * needs somewhere to hold the answer once rather than each component asking.
 */
export interface KeycloakAccountState extends DesktopKeycloakStatus {
  /** The preload bridge exposes `keycloak` at all — it is optional. */
  available: boolean
  /** `status()` has resolved at least once; distinguishes "loading" from "signed out". */
  loaded: boolean
}

const INITIAL: KeycloakAccountState = {
  available: false,
  clientId: '',
  configured: false,
  displayName: '',
  email: '',
  issuer: '',
  loaded: false,
  signedIn: false,
  userId: ''
}

export const $keycloakAccount = atom<KeycloakAccountState>(INITIAL)

/**
 * Re-read the stored session.
 *
 * Reads the token store off disk in the main process, so it answers with no
 * network — the panel must still render who you are while Keycloak is
 * unreachable. Never throws; a failure reports "not configured" rather than
 * leaving the caller to handle two shapes.
 */
export async function refreshKeycloakAccount(): Promise<KeycloakAccountState> {
  const bridge = window.agentxDesktop?.keycloak

  if (!bridge) {
    const next = { ...INITIAL, loaded: true }

    $keycloakAccount.set(next)

    return next
  }

  try {
    const status = await bridge.status()
    const next: KeycloakAccountState = { ...INITIAL, ...status, available: true, loaded: true }

    $keycloakAccount.set(next)

    return next
  } catch {
    const next: KeycloakAccountState = { ...INITIAL, available: true, loaded: true }

    $keycloakAccount.set(next)

    return next
  }
}

/**
 * Sign out, then hand the app back to the sign-in gate.
 *
 * `signOut()` clears the stored tokens and opens Keycloak's end-session URL in
 * the system browser — without that second half the browser SSO session
 * survives and the next sign-in walks straight back in, which does not look
 * like signing out. `resetBootstrap()` clears the latched boot state so the
 * reload lands on SignInOverlay instead of a half-dead shell.
 */
export async function signOutKeycloak(): Promise<void> {
  await window.agentxDesktop?.keycloak?.signOut()
  await window.agentxDesktop?.resetBootstrap().catch(() => undefined)
  window.location.reload()
}
