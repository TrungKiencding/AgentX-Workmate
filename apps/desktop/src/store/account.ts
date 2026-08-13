import { atom } from 'nanostores'

import type {
  DesktopAccountStatus,
  DesktopDeviceList,
  DesktopDeviceRevokeResult,
  DesktopKeycloakStatus,
  DesktopSyncOutcome,
  DesktopSyncStatus
} from '@/global'

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
 * The account home this person owns on this machine, and its model key.
 *
 * Separate from `$keycloakAccount` because the two answer different questions
 * and fail differently: identity comes off the local token store and is always
 * available, while this reaches the backend and can be stale, absent, or
 * reporting a LiteLLM that is down. Keeping them apart means an unreachable
 * proxy cannot make the identity panel look broken.
 */
export interface AccountIsolationState extends DesktopAccountStatus {
  available: boolean
  loaded: boolean
}

const INITIAL_ISOLATION: AccountIsolationState = {
  account: null,
  available: false,
  loaded: false,
  signedIn: false
}

export const $accountIsolation = atom<AccountIsolationState>(INITIAL_ISOLATION)

/** Re-read the account's home and key state. Never throws. */
export async function refreshAccountIsolation(): Promise<AccountIsolationState> {
  const bridge = window.agentxDesktop?.account

  if (!bridge) {
    const next = { ...INITIAL_ISOLATION, loaded: true }

    $accountIsolation.set(next)

    return next
  }

  try {
    const status = await bridge.status()

    const next: AccountIsolationState = {
      ...INITIAL_ISOLATION,
      ...status,
      available: true,
      loaded: true
    }

    $accountIsolation.set(next)

    return next
  } catch {
    const next: AccountIsolationState = { ...INITIAL_ISOLATION, available: true, loaded: true }

    $accountIsolation.set(next)

    return next
  }
}

/**
 * Mint a fresh model key for this account, retiring the current one.
 *
 * The user-facing reason to do this is a leaked key. It is not a repair
 * button: a key that merely stopped working is replaced automatically on the
 * next launch.
 */
export async function rotateAccountKey(): Promise<AccountIsolationState> {
  await window.agentxDesktop?.account?.provision({ rotate: true }).catch(() => undefined)

  return refreshAccountIsolation()
}

/**
 * The machines this person is signed in on.
 *
 * A third store rather than a field on `$accountIsolation`, for the reason the
 * first two are separate: these three answer different questions and fail
 * differently. Identity comes off the local token store and is always
 * available; the account home reaches the local backend; this reaches a
 * central service that may not be deployed at all. Folding them together would
 * let an undeployed service make the identity panel look broken.
 */
export interface DeviceListState extends DesktopDeviceList {
  /** The preload bridge exposes `devices` at all — it is optional. */
  available: boolean
  /** `list()` has resolved at least once; distinguishes "loading" from "empty". */
  loaded: boolean
}

const INITIAL_DEVICES: DeviceListState = {
  available: false,
  current: '',
  devices: [],
  loaded: false,
  status: 'unconfigured'
}

export const $devices = atom<DeviceListState>(INITIAL_DEVICES)

/**
 * Re-read the device list. Never throws.
 *
 * Every failure arrives as a `status` rather than an exception, because the
 * caller's response to each one is different and none of them is "crash": an
 * unreachable service is a sentence in the panel, an unconfigured one hides
 * the section, and a revoked device signs the person out.
 */
export async function refreshDevices(): Promise<DeviceListState> {
  const bridge = window.agentxDesktop?.devices

  if (!bridge) {
    const next = { ...INITIAL_DEVICES, loaded: true }

    $devices.set(next)

    return next
  }

  try {
    const body = await bridge.list()

    const next: DeviceListState = {
      ...INITIAL_DEVICES,
      ...body,
      available: true,
      devices: body?.devices || [],
      loaded: true
    }

    $devices.set(next)

    return next
  } catch {
    const next: DeviceListState = {
      ...INITIAL_DEVICES,
      available: true,
      loaded: true,
      status: 'offline'
    }

    $devices.set(next)

    return next
  }
}

/**
 * Cut a machine off, optionally issuing a new model key with it.
 *
 * `rotateKey` is what actually removes the revoked machine's model access —
 * one key per person means revocation alone cannot. The service refuses the
 * combination that would leave nobody able to collect the new key, and that
 * refusal comes back as `cannot_revoke_last_device` for the caller to explain.
 *
 * Returns the result rather than swallowing it: the dialog that asked has to
 * say what happened.
 */
export async function revokeDevice(
  id: string,
  options: { rotateKey?: boolean } = {}
): Promise<DesktopDeviceRevokeResult> {
  const bridge = window.agentxDesktop?.devices

  if (!bridge) {
    return { detail: 'This build cannot manage devices.', status: 'unconfigured' }
  }

  let result: DesktopDeviceRevokeResult

  try {
    result = await bridge.revoke(id, options)
  } catch (error) {
    result = {
      detail: error instanceof Error ? error.message : String(error),
      status: 'offline'
    }
  }

  // Whatever happened, the list is now stale — including the case where the
  // revoked machine was this one, which `refreshDevices` reports as `revoked`.
  await refreshDevices()

  return result
}

/**
 * Where conversation history has got to, across this person's machines.
 *
 * Separate from `$devices` for the same reason `$devices` is separate from
 * `$keycloakAccount`: these three fail independently. A person can be signed
 * in with the device list working and synchronisation switched off, and each
 * of those states has a different sentence to show.
 */
export interface SyncState extends DesktopSyncStatus {
  /** The preload bridge exposes `sync` at all — it is optional. */
  available: boolean
  /** `status()` has resolved at least once; distinguishes "loading" from "off". */
  loaded: boolean
  /** A `tick()` requested from Settings is in flight. */
  syncing: boolean
}

const INITIAL_SYNC: SyncState = {
  available: false,
  configured: false,
  cursor: 0,
  enabled: false,
  loaded: false,
  pending: 0,
  syncing: false
}

export const $sync = atom<SyncState>(INITIAL_SYNC)

/**
 * Re-read where synchronisation has got to. Never throws, makes no network call.
 *
 * The backend answers this from its own database, so it still says something
 * useful while the service is unreachable — which is exactly when somebody
 * opens Settings to find out what is going on.
 */
export async function refreshSyncStatus(): Promise<SyncState> {
  const bridge = window.agentxDesktop?.sync

  if (!bridge) {
    const next = { ...INITIAL_SYNC, loaded: true }

    $sync.set(next)

    return next
  }

  try {
    const body = await bridge.status()

    const next: SyncState = {
      ...INITIAL_SYNC,
      ...body,
      available: true,
      loaded: true,
      syncing: false
    }

    $sync.set(next)

    return next
  } catch {
    const next: SyncState = { ...INITIAL_SYNC, available: true, loaded: true }

    $sync.set(next)

    return next
  }
}

/**
 * Synchronise now instead of waiting for the next tick.
 *
 * Not merely a refresh: the backend holds no credential of its own for the
 * signed-in person, so the bearer travelling on this call is what lets it work
 * at all. Returns the outcome for the caller to report, and leaves `$sync`
 * holding the position afterwards.
 */
export async function syncNow(): Promise<DesktopSyncOutcome> {
  const bridge = window.agentxDesktop?.sync

  if (!bridge) {
    return { detail: 'This build cannot synchronise.', status: 'unconfigured' }
  }

  $sync.set({ ...$sync.get(), syncing: true })

  let outcome: DesktopSyncOutcome

  try {
    outcome = await bridge.tick()
  } catch (error) {
    outcome = {
      detail: error instanceof Error ? error.message : String(error),
      status: 'offline'
    }
  }

  // Whatever happened, the position has moved or the reason it did not is
  // now recorded — either way what the panel is showing is stale.
  await refreshSyncStatus()

  return outcome
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
