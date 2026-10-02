/**
 * The desktop app's own updates, as the renderer sees them: a mirror of the state
 * the main process owns (electron/app-update/), the actions that drive it, and the
 * notices that tell the person what happened.
 *
 * Every window mirrors the same state, so the status bar, About and the updates
 * dialog always agree; only the main window raises notices, so a second chat
 * window does not repeat them.
 */

import { atom } from 'nanostores'

import type { AppUpdateActiveWork, AppUpdateInstallOutcome, AppUpdateState } from '@/global'
import { translateNow } from '@/i18n'
import { readJson, writeJson } from '@/lib/storage'
import { dismissNotification, notify } from '@/store/notifications'
import { $gatewayState } from '@/store/session'
import { $updateOverlayOpen, $updateOverlayTarget, openUpdateOverlay } from '@/store/update-overlay'
import { isSecondaryWindow } from '@/store/windows'

export const $appUpdate = atom<AppUpdateState | null>(null)

/**
 * Agent work the person is being asked about before the install stops it. Set when
 * an install was refused for it; cleared by confirming or cancelling.
 */
export const $appUpdateActiveWork = atom<AppUpdateActiveWork | null>(null)

const AVAILABLE_TOAST_ID = 'app-update-available'
const READY_TOAST_ID = 'app-update-ready'
const RESULT_TOAST_ID = 'app-update-result'
const AGENT_TOAST_ID = 'app-update-agent'
const DOWNLOAD_TOAST_ID = 'app-update-download'

// Closing the "update available" notice, or starting the download, quiets it for
// a day, for that version only: a newer release is news again straight away. A
// download that fails or is cancelled has the dialog and About to say so; the
// notice coming back would only nag.
const SNOOZE_KEY = 'agentx:app-update-snooze'
const SNOOZE_MS = 24 * 60 * 60 * 1000

interface Snooze {
  version: string
  until: number
}

function snooze(version: string): void {
  writeJson(SNOOZE_KEY, { version, until: Date.now() + SNOOZE_MS } satisfies Snooze)
}

function isSnoozed(version: string): boolean {
  const value = readJson<Snooze>(SNOOZE_KEY)

  return Boolean(value && value.version === version && Date.now() < value.until)
}

/**
 * Which explanation a failed download gets (appUpdate.downloadFailed), from the
 * kind main reports (electron/app-update/download.ts DownloadError).
 */
export function downloadProblemKey(kind: string): 'disk' | 'http' | 'mismatch' | 'network' | 'other' {
  switch (kind) {
    case 'disk':

    case 'http':

    case 'network':
      return kind

    case 'hash':

    case 'size':
      return 'mismatch'

    default:
      return 'other'
  }
}

function bridge() {
  return typeof window === 'undefined' ? undefined : window.agentxDesktop?.appUpdate
}

// What the last notice was about, so a state broadcast (one per download tick)
// never raises the same notice twice.
let announced: null | string = null
let agentAnnounced: AppUpdateState['agentUpdateFailed'] = null
// The version the "available" notice is up for. Cleared when it goes, so a check
// after its snooze runs out raises it again: an app left open for days still
// hears about the update.
let availableUp: null | string = null

function closeAvailable(version: string): void {
  availableUp = null
  snooze(version)
}

// Run once the app is in front of the person. The first launch after an update
// can spend minutes bringing the agent forward behind the connecting screen; a
// notice that times out would expire there unseen.
function whenConnected(run: () => void): void {
  if ($gatewayState.get() === 'open') {
    run()

    return
  }

  const off = $gatewayState.listen(next => {
    if (next === 'open') {
      off()
      run()
    }
  })
}

// The updates dialog, open on this app's update, already shows all a notice would.
function dialogIsOpen(): boolean {
  return $updateOverlayOpen.get() && $updateOverlayTarget.get() === 'client'
}

// A download that fails while the dialog is closed (hidden, to download in the
// background) says so here; an open dialog already shows why.
function announceDownloadProblem(state: AppUpdateState): void {
  const problem = state.phase === 'available' ? state.downloadError : null

  if (!problem) {
    dismissNotification(DOWNLOAD_TOAST_ID)

    return
  }

  if (dialogIsOpen()) {
    return
  }

  notify({
    id: DOWNLOAD_TOAST_ID,
    kind: 'warning',
    scope: 'app',
    title: translateNow('appUpdate.downloadFailedToastTitle'),
    message: translateNow(`appUpdate.downloadFailed.${downloadProblemKey(problem.kind)}`),
    detail: problem.message,
    action: { label: translateNow('appUpdate.retryDownload'), onClick: () => void downloadAppUpdate() }
  })
}

function announce(state: AppUpdateState): void {
  if (isSecondaryWindow()) {
    return
  }

  const api = bridge()

  if (state.updatedFrom) {
    const message = translateNow('appUpdate.updatedToastMessage', state.updatedFrom, state.currentVersion)

    whenConnected(() =>
      notify({
        id: RESULT_TOAST_ID,
        kind: 'success',
        scope: 'app',
        durationMs: 8000,
        placement: 'default',
        title: translateNow('appUpdate.updatedToastTitle'),
        message
      })
    )
    void api?.acknowledge()
  } else if (state.lastInstallFailed) {
    notify({
      id: RESULT_TOAST_ID,
      kind: 'error',
      scope: 'app',
      title: translateNow('appUpdate.installFailedToastTitle'),
      message: translateNow('appUpdate.installFailedToastMessage', state.lastInstallFailed.version),
      detail: state.lastInstallFailed.message,
      action: { label: translateNow('appUpdate.tryAgain'), onClick: () => openUpdateOverlay('client') }
    })
    void api?.acknowledge()
  }

  if (state.agentUpdateFailed && state.agentUpdateFailed !== agentAnnounced) {
    notify({
      id: AGENT_TOAST_ID,
      kind: 'warning',
      scope: 'app',
      title: translateNow('appUpdate.agentToastTitle'),
      message: translateNow(`appUpdate.agentToastMessage.${state.agentUpdateFailed}`),
      action: { label: translateNow('appUpdate.restart'), onClick: () => void restartApp() }
    })
  } else if (!state.agentUpdateFailed) {
    dismissNotification(AGENT_TOAST_ID)
  }

  agentAnnounced = state.agentUpdateFailed

  const version = state.release?.version
  const key = version ? `${state.phase}:${version}` : state.phase
  const previous = announced
  const changed = key !== previous

  announced = key

  if (changed) {
    announceDownloadProblem(state)
  }

  if (state.phase === 'available' && version) {
    if (changed) {
      dismissNotification(READY_TOAST_ID)
    }

    if (availableUp === version || isSnoozed(version) || dialogIsOpen()) {
      return
    }

    availableUp = version
    notify({
      id: AVAILABLE_TOAST_ID,
      kind: 'info',
      scope: 'app',
      icon: 'gift',
      durationMs: 0,
      title: translateNow('appUpdate.availableToastTitle'),
      message: translateNow('appUpdate.availableToastMessage', version),
      action: {
        label: translateNow('appUpdate.seeWhatsNew'),
        onClick: () => {
          closeAvailable(version)
          openUpdateOverlay('client')
        }
      },
      onDismiss: () => closeAvailable(version)
    })

    return
  }

  if (!changed) {
    return
  }

  availableUp = null
  dismissNotification(AVAILABLE_TOAST_ID)

  if (state.phase === 'ready' && version) {
    // Back from an install that did not take, the dialog says why.
    if (previous === `installing:${version}` || dialogIsOpen()) {
      return
    }

    notify({
      id: READY_TOAST_ID,
      kind: 'info',
      scope: 'app',
      icon: 'cloud-download',
      durationMs: 0,
      title: translateNow('appUpdate.readyToastTitle'),
      message: translateNow('appUpdate.readyToastMessage', version),
      action: { label: translateNow('appUpdate.restartToUpdate'), onClick: () => openUpdateOverlay('client') }
    })
  } else {
    dismissNotification(READY_TOAST_ID)
  }
}

function receive(state: AppUpdateState | null | undefined): AppUpdateState | null {
  if (!state) {
    return $appUpdate.get()
  }

  $appUpdate.set(state)
  announce(state)

  return state
}

/** Mirror main's state into this window. Returns the unsubscribe. */
export function startAppUpdateSync(): () => void {
  const api = bridge()

  if (!api) {
    return () => undefined
  }

  const off = api.onState(state => void receive(state))

  api
    .get()
    .then(receive)
    .catch(() => undefined)

  return off
}

export async function checkAppUpdate(): Promise<AppUpdateState | null> {
  const api = bridge()

  return api ? receive(await api.check()) : null
}

export async function downloadAppUpdate(): Promise<AppUpdateState | null> {
  const api = bridge()

  if (!api) {
    return null
  }

  const version = $appUpdate.get()?.release?.version

  if (version) {
    snooze(version)
  }

  return receive(await api.download())
}

export async function cancelAppUpdateDownload(): Promise<AppUpdateState | null> {
  const api = bridge()

  return api ? receive(await api.cancel()) : null
}

/**
 * Install the downloaded update; the app quits for the installer when it starts.
 * Refused while the agent is mid-turn unless `confirmActiveWork` — the refusal
 * lands in $appUpdateActiveWork for the dialog to ask about.
 */
export async function installAppUpdate({
  confirmActiveWork = false
}: { confirmActiveWork?: boolean } = {}): Promise<AppUpdateInstallOutcome | null> {
  const api = bridge()

  if (!api) {
    return null
  }

  const outcome = await api.install({ confirmActiveWork })

  $appUpdateActiveWork.set(!outcome.started && outcome.reason === 'active-work' ? outcome.activeWork : null)

  return outcome
}

export function dismissActiveWorkPrompt(): void {
  $appUpdateActiveWork.set(null)
}

/** "Later" in the dialog: the same as closing the available notice, for a day. */
export function deferAppUpdate(): void {
  const state = $appUpdate.get()
  const version = state?.release?.version

  if (state?.phase === 'available' && version) {
    closeAvailable(version)
    dismissNotification(AVAILABLE_TOAST_ID)
  }
}

/** Restart the app; the boot brings the agent up to this version again. */
export async function restartApp(): Promise<void> {
  await bridge()?.restart()
}

/** Test hook: forget which notices this window has raised. */
export function resetAppUpdateNotices(): void {
  announced = null
  agentAnnounced = null
  availableUp = null
}
