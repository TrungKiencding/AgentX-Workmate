import { atom } from 'nanostores'

import type {
  DesktopAccountProvisionResult,
  DesktopAccountStatus,
  DesktopDeviceList,
  DesktopDeviceRevokeResult,
  DesktopDeviceUpdateResult,
  DesktopKeycloakStatus
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
 *
 * Returns what provisioning answered rather than only the refreshed state:
 * a rotation the service refused leaves the current key in place, so the
 * refreshed state reads exactly as it did before the click — and a button
 * that does nothing visible on failure is a button that "does not work".
 * The caller shows the answer.
 */
export async function rotateAccountKey(): Promise<DesktopAccountProvisionResult> {
  const result = await window.agentxDesktop?.account?.provision({ rotate: true }).catch(() => null)

  await refreshAccountIsolation()

  return result ?? { ok: false, error: 'The backend did not answer the provisioning request.' }
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
  refreshing: boolean
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
  refreshing: false,
  status: 'unconfigured'
}

export const $devices = atom<DeviceListState>(INITIAL_DEVICES)

let deviceGeneration = 0
let deviceAccountGeneration = 0

function deviceAccountScope(): string {
  const account = $keycloakAccount.get()

  return JSON.stringify([account.issuer, account.userId, account.signedIn])
}

let deviceScope = deviceAccountScope()

$keycloakAccount.listen(() => {
  const scope = deviceAccountScope()

  if (scope !== deviceScope) {
    deviceScope = scope
    deviceGeneration += 1
    deviceAccountGeneration += 1
    $devices.set({ ...INITIAL_DEVICES })
  }
})

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
  const generation = ++deviceGeneration
  const scope = deviceAccountScope()

  if (!bridge) {
    const next = { ...INITIAL_DEVICES, loaded: true }

    $devices.set(next)

    return next
  }

  $devices.set({ ...$devices.get(), available: true, refreshing: true })

  const body: DesktopDeviceList = await Promise.resolve()
    .then(() => bridge.list())
    .catch(() => ({ status: 'offline' as const, current: '', devices: [] }))

  if (generation !== deviceGeneration || scope !== deviceAccountScope()) {
    return $devices.get()
  }

  const previous = $devices.get()
  const transient = body.status === 'offline' || body.status === 'error'
  const sameDevice = !body.current || !previous.current || body.current === previous.current

  const next: DeviceListState = {
    ...INITIAL_DEVICES,
    ...body,
    available: true,
    can_rename: Boolean(body.can_rename && bridge.rename),
    current: transient && sameDevice ? body.current || previous.current : body.current,
    devices: transient && sameDevice ? previous.devices : body.devices || [],
    loaded: true,
    refreshing: false
  }

  $devices.set(next)

  return next
}

/** Apply the mutation's authoritative row before refetching; stale reads cannot undo it. */
function applyDeviceUpdate(result: DesktopDeviceUpdateResult, id: string): void {
  const previous = $devices.get()

  if (result.status === 'revoked' || (result.status === 'ok' && result.device?.revoked && id === previous.current)) {
    $devices.set({ ...previous, devices: [], refreshing: false, status: 'revoked' })
  } else if (result.status === 'ok' && result.device?.id === id) {
    const row = result.device
    const exists = previous.devices.some(device => device.id === id)

    $devices.set({
      ...previous,
      devices: exists ? previous.devices.map(device => (device.id === id ? row : device)) : [...previous.devices, row],
      refreshing: false
    })
  }
}

export async function renameDevice(id: string, name: string): Promise<DesktopDeviceUpdateResult> {
  const bridge = window.agentxDesktop?.devices

  if (!bridge?.rename) {
    return { status: 'unconfigured' }
  }

  const scope = deviceAccountScope()
  const accountGeneration = deviceAccountGeneration
  deviceGeneration += 1

  const result = await Promise.resolve()
    .then(() => bridge.rename!(id, name))
    .catch(() => ({ status: 'offline' as const }))

  if (scope === deviceAccountScope() && accountGeneration === deviceAccountGeneration) {
    applyDeviceUpdate(result, id)
    await refreshDevices()
  }

  return result
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
  const scope = deviceAccountScope()
  const accountGeneration = deviceAccountGeneration
  deviceGeneration += 1

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
  if (scope === deviceAccountScope() && accountGeneration === deviceAccountGeneration) {
    applyDeviceUpdate(result, id)

    if ($devices.get().status !== 'revoked') {
      await refreshDevices()
    }
  }

  return result
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
