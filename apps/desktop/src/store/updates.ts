/**
 * Updates that are not this app's own (that is store/app-update.ts): the remote
 * AgentX backend a desktop in remote mode is connected to, the contract check that
 * notices a backend older than this app, and the running versions.
 *
 * A remote backend updates itself through its own `/api/agentx/update`; this store
 * checks it, applies it, and follows it through the restart.
 */

import { atom } from 'nanostores'

import type { BackendUpdateApplyResult, BackendUpdateStage, BackendUpdateStatus, DesktopVersionInfo } from '@/global'
import { checkHermesUpdate, getActionStatus, updateHermes } from '@/hermes'
import { translateNow } from '@/i18n'
import { persistString, storedString } from '@/lib/storage'
import { $appUpdate, restartApp } from '@/store/app-update'
import { dismissNotification, notify } from '@/store/notifications'
import { $connection } from '@/store/session'
import { closeUpdateOverlay, openUpdateOverlay } from '@/store/update-overlay'
import { checkWebmateUpdate } from '@/store/webmate'
import type { BackendUpdateCheckResponse } from '@/types/hermes'

export interface BackendUpdateApplyState {
  applying: boolean
  stage: BackendUpdateStage
  message: string
  error: string | null
  /** When the stage is 'manual': the exact command to run on the backend host. */
  command: string | null
  log: readonly { stage: BackendUpdateStage; message: string; at: number }[]
}

const IDLE: BackendUpdateApplyState = {
  applying: false,
  stage: 'idle',
  message: '',
  error: null,
  command: null,
  log: []
}

export const $desktopVersion = atom<DesktopVersionInfo | null>(null)
export const $backendUpdateStatus = atom<BackendUpdateStatus | null>(null)
export const $backendUpdateApply = atom<BackendUpdateApplyState>(IDLE)
export const $backendUpdateChecking = atom<boolean>(false)

export const resetBackendUpdateApplyState = () => $backendUpdateApply.set(IDLE)

const BACKEND_UPDATE_TOAST_ID = 'backend-update-available'
// Time-based snooze rather than per-commit dismissal: a busy backend branch
// would otherwise re-raise the notice on every new commit.
const BACKEND_UPDATE_TOAST_SNOOZE_KEY = 'agentx:update-toast-snooze-until'
const BACKEND_UPDATE_TOAST_COOLDOWN_MS = 24 * 60 * 60 * 1000

function snoozeBackendUpdateToast(): void {
  persistString(BACKEND_UPDATE_TOAST_SNOOZE_KEY, String(Date.now() + BACKEND_UPDATE_TOAST_COOLDOWN_MS))
}

function isBackendUpdateToastSnoozed(): boolean {
  const until = Number(storedString(BACKEND_UPDATE_TOAST_SNOOZE_KEY) || 0)

  return Number.isFinite(until) && Date.now() < until
}

// Must match tui_gateway's DESKTOP_BACKEND_CONTRACT that this build was written
// against. The backend reports its own value in session runtime info; a lower
// value (or none — a pre-GUI checkout) means GUI<->backend skew.
// v2: requires the file.attach RPC (remote-gateway non-image file upload).
// v3: requires approvals.mode config RPCs and session.info reconciliation.
// v4: requires explicit Fast-off session creation and session-scoped Fast edits.
// v5: requires raised WebSocket frame size for large one-shot file.attach.
const REQUIRED_BACKEND_CONTRACT = 5
const SKEW_TOAST_ID = 'backend-contract-skew'
// The contract check runs on every session.resume (applyRuntimeInfo), so
// without a snooze the warning re-popped on every thread the user opened, even
// right after they closed it. Persist a cooldown when the user dismisses it. It
// still reminds again after the window if the backend is still behind, and
// clears immediately once the backend catches up.
const SKEW_TOAST_SNOOZE_KEY = 'agentx:backend-skew-toast-snooze-until'
const SKEW_TOAST_COOLDOWN_MS = 24 * 60 * 60 * 1000

function snoozeSkewToast(): void {
  persistString(SKEW_TOAST_SNOOZE_KEY, String(Date.now() + SKEW_TOAST_COOLDOWN_MS))
}

function isSkewToastSnoozed(): boolean {
  const until = Number(storedString(SKEW_TOAST_SNOOZE_KEY) || 0)

  return Number.isFinite(until) && Date.now() < until
}

const INSTALL_METHOD_TOAST_ID = 'install-method-not-supported'
// Same time-based snooze pattern as the update/skew toasts: the warning is
// re-derived from every session.info (session.create/resume/activate all
// route through applyRuntimeInfo), so without a snooze it would re-pop on
// every session switch even right after the user dismissed it.
const INSTALL_METHOD_TOAST_SNOOZE_KEY = 'agentx:install-method-toast-snooze-until'
const INSTALL_METHOD_TOAST_COOLDOWN_MS = 24 * 60 * 60 * 1000

function snoozeInstallMethodToast(): void {
  persistString(INSTALL_METHOD_TOAST_SNOOZE_KEY, String(Date.now() + INSTALL_METHOD_TOAST_COOLDOWN_MS))
}

function isInstallMethodToastSnoozed(): boolean {
  const until = Number(storedString(INSTALL_METHOD_TOAST_SNOOZE_KEY) || 0)

  return Number.isFinite(until) && Date.now() < until
}

function isRemoteMode(): boolean {
  return $connection.get()?.mode === 'remote'
}

/**
 * Guard against this desktop talking to a backend that predates its contract.
 *
 * A remote backend is brought forward through its own update. A local one is the
 * agent this app installs: each launch brings it up to the app's version, so the
 * fix is a restart — and when this launch already tried and said so
 * (store/app-update.ts), that notice covers it and this one stays quiet.
 *
 * Runs on every session open; closing the toast snoozes it for a cooldown so it
 * doesn't nag on every thread switch.
 */
export function reportBackendContract(contract: number | undefined): void {
  if ((contract ?? 0) >= REQUIRED_BACKEND_CONTRACT) {
    dismissNotification(SKEW_TOAST_ID)
    // Backend caught up — forget any prior snooze so a future regression warns
    // immediately rather than staying silent for the rest of the window.
    persistString(SKEW_TOAST_SNOOZE_KEY, null)

    return
  }

  const remote = isRemoteMode()

  if (isSkewToastSnoozed() || (!remote && $appUpdate.get()?.agentUpdateFailed)) {
    return
  }

  notify({
    action: remote
      ? {
          label: translateNow('notifications.updateHermes'),
          onClick: () => {
            snoozeSkewToast()
            void applyBackendUpdate()
          }
        }
      : {
          label: translateNow('notifications.restartApp'),
          onClick: () => {
            snoozeSkewToast()
            void restartApp()
          }
        },
    durationMs: 0,
    id: SKEW_TOAST_ID,
    kind: 'warning',
    message: translateNow(remote ? 'notifications.backendOutOfDateMessage' : 'notifications.agentOutOfDateMessage'),
    onDismiss: () => snoozeSkewToast(),
    scope: 'app',
    title: translateNow('notifications.backendOutOfDateTitle')
  })
}

export function reportInstallMethodWarning(message: string | undefined): void {
  if (!message) {
    dismissNotification(INSTALL_METHOD_TOAST_ID)

    return
  }

  if (isInstallMethodToastSnoozed()) {
    return
  }

  notify({
    durationMs: 0,
    id: INSTALL_METHOD_TOAST_ID,
    kind: 'warning',
    message,
    onDismiss: () => snoozeInstallMethodToast(),
    scope: 'app',
    title: translateNow('notifications.installMethodUnsupportedTitle')
  })
}

/**
 * Tell the person their remote backend has an update, at most once per cooldown
 * window. Closing the toast — dismissing it or opening the dialog from it —
 * (re)starts the cooldown; the snooze is persisted, so it survives relaunches.
 */
export function maybeNotifyBackendUpdate(status: BackendUpdateStatus | null): void {
  if (!status || !status.supported || status.error || !status.updateAvailable) {
    return
  }

  if (isBackendUpdateToastSnoozed() || $backendUpdateApply.get().applying) {
    return
  }

  const behind = status.behind ?? 0

  notify({
    action: {
      label: translateNow('notifications.seeWhatsNew'),
      onClick: () => {
        snoozeBackendUpdateToast()
        openUpdateOverlay('backend')
      }
    },
    durationMs: 0,
    icon: 'gift',
    id: BACKEND_UPDATE_TOAST_ID,
    kind: 'info',
    message:
      behind > 0
        ? translateNow('notifications.backendUpdateMessage', behind)
        : translateNow('notifications.backendUpdateMessageNoCount'),
    onDismiss: () => snoozeBackendUpdateToast(),
    scope: 'app',
    title: translateNow('notifications.backendUpdateTitle')
  })
}

/**
 * The "Check for updates" entry points (menu, command palette): this app's own
 * update in local mode, the connected backend's in remote mode — applying it
 * straight away when one is known to be waiting.
 */
export function requestActiveUpdate(): void {
  if (!isRemoteMode()) {
    openUpdateOverlay('client')

    return
  }

  openUpdateOverlay('backend')

  if ($backendUpdateStatus.get()?.updateAvailable) {
    void applyBackendUpdate()
  }
}

/** Re-read the running versions from the main process and publish them on
 *  `$desktopVersion`. Called when the About panel mounts and the window
 *  regains focus, so About never shows a version from before an update. */
export async function refreshDesktopVersion(): Promise<DesktopVersionInfo | null> {
  if (typeof window === 'undefined') {
    return null
  }

  // Best-effort UI sync: callers kick this off with `void refreshDesktopVersion()`,
  // so a rejection from the IPC bridge (main shutting down mid-reload, the
  // bridge not ready on first paint) would surface as an unhandled rejection.
  try {
    const next = await window.agentxDesktop?.getVersion?.()

    if (next) {
      $desktopVersion.set(next)
    }

    return next ?? null
  } catch {
    return null
  }
}

function mapBackendCheck(res: BackendUpdateCheckResponse): BackendUpdateStatus {
  const behind = res.behind ?? 0

  return {
    supported: res.can_apply,
    message: res.message ?? undefined,
    updateAvailable: res.update_available,
    behind: behind > 0 ? behind : 0,
    currentVersion: res.current_version,
    commits: res.commits,
    fetchedAt: Date.now()
  }
}

export async function checkBackendUpdates(): Promise<BackendUpdateStatus | null> {
  if (!isRemoteMode() || $backendUpdateChecking.get()) {
    return $backendUpdateStatus.get()
  }

  $backendUpdateChecking.set(true)

  try {
    const status = mapBackendCheck(await checkHermesUpdate(true))
    $backendUpdateStatus.set(status)
    maybeNotifyBackendUpdate(status)

    return status
  } catch (error) {
    const fallback: BackendUpdateStatus = {
      supported: $backendUpdateStatus.get()?.supported ?? true,
      error: 'check-failed',
      message: error instanceof Error ? error.message : String(error),
      fetchedAt: Date.now()
    }

    $backendUpdateStatus.set(fallback)

    return fallback
  } finally {
    $backendUpdateChecking.set(false)
  }
}

const BACKEND_RETURN_POLL_MS = 1500
const BACKEND_RETURN_MAX_ATTEMPTS = 40

async function waitForBackendReturn(): Promise<boolean> {
  for (let attempt = 0; attempt < BACKEND_RETURN_MAX_ATTEMPTS; attempt += 1) {
    await new Promise(resolve => globalThis.setTimeout(resolve, BACKEND_RETURN_POLL_MS))

    try {
      await checkHermesUpdate()

      return true
    } catch {
      continue
    }
  }

  return false
}

function finishBackendApply(returned: boolean): BackendUpdateApplyResult {
  if (returned) {
    $backendUpdateApply.set(IDLE)
    closeUpdateOverlay()
    void checkBackendUpdates()

    return { ok: true, message: 'Backend update applied.' }
  }

  $backendUpdateApply.set({
    ...$backendUpdateApply.get(),
    applying: false,
    stage: 'error',
    error: 'apply-failed',
    message: translateNow('updates.applyStatus.noReturn')
  })

  return { ok: false, error: 'apply-failed', message: 'Backend did not come back online.' }
}

function ingestBackendActionStatus(status: Awaited<ReturnType<typeof getActionStatus>>): void {
  const current = $backendUpdateApply.get()

  const log = status.lines
    .filter(line => line.trim().length > 0)
    .map(line => ({ at: Date.now(), message: line, stage: current.stage }))
    .slice(-50)

  const latest = log.at(-1)?.message

  if (log.length === 0 && !latest) {
    return
  }

  $backendUpdateApply.set({
    ...current,
    log,
    message: latest ?? current.message
  })
}

export async function applyBackendUpdate(): Promise<BackendUpdateApplyResult> {
  dismissNotification(BACKEND_UPDATE_TOAST_ID)
  $backendUpdateApply.set({
    ...IDLE,
    applying: true,
    stage: 'prepare',
    message: translateNow('updates.applyStatus.preparing')
  })

  try {
    const started = await updateHermes()

    if (!started.ok) {
      const message = (started as { message?: string }).message || translateNow('updates.applyStatus.notAvailable')
      const command = (started as { update_command?: string }).update_command || 'agentx update'
      $backendUpdateApply.set({ ...IDLE, applying: false, stage: 'manual', message, command })

      return { ok: false, error: 'manual', manual: true, message, command }
    }

    $backendUpdateApply.set({
      ...IDLE,
      applying: true,
      stage: 'pull',
      message: translateNow('updates.applyStatus.pulling')
    })

    let last: Awaited<ReturnType<typeof getActionStatus>> | null = null

    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise(resolve => globalThis.setTimeout(resolve, 1500))

      try {
        last = await getActionStatus(started.name, 200)
        ingestBackendActionStatus(last)
      } catch {
        // The dashboard restarts mid-update, dropping this connection — expected, not a failure.
        $backendUpdateApply.set({
          ...$backendUpdateApply.get(),
          applying: true,
          stage: 'restart',
          message: translateNow('updates.applyStatus.restarting')
        })

        return finishBackendApply(await waitForBackendReturn())
      }

      if (last && !last.running) {
        break
      }
    }

    const ok = !!last && (last.exit_code ?? 1) === 0

    if (ok) {
      $backendUpdateApply.set({
        ...$backendUpdateApply.get(),
        applying: true,
        stage: 'restart',
        message: translateNow('updates.applyStatus.restarting')
      })

      return finishBackendApply(await waitForBackendReturn())
    }

    $backendUpdateApply.set({
      ...$backendUpdateApply.get(),
      applying: false,
      stage: 'error',
      error: 'apply-failed',
      message: translateNow('updates.applyStatus.failed')
    })

    return { ok: false, error: 'apply-failed', message: translateNow('updates.applyStatus.failed') }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    $backendUpdateApply.set({
      ...$backendUpdateApply.get(),
      applying: false,
      stage: 'error',
      error: 'apply-failed',
      message
    })

    return { ok: false, error: 'apply-failed', message }
  }
}

let pollerStarted = false
let backgroundTimer: ReturnType<typeof setInterval> | null = null
let lastFocusAt = 0
let connectionUnsub: (() => void) | null = null
let lastConnectionMode: string | undefined

/**
 * Background checks for what this store watches — a remote backend and the
 * WebMate extension — plus the running versions. This app's own updates are
 * scheduled by the main process (electron/app-update/service.ts). Idempotent.
 */
export function startUpdatePoller(): void {
  if (pollerStarted || typeof window === 'undefined' || !window.agentxDesktop) {
    return
  }

  pollerStarted = true
  void checkBackendUpdates()
  void checkWebmateUpdate()
  void refreshDesktopVersion()

  // The poller starts at mount, before the gateway connects — so the first
  // backend check above sees mode≠remote and no-ops. Re-check once the
  // connection resolves to remote.
  connectionUnsub = $connection.subscribe(conn => {
    if (conn?.mode === lastConnectionMode) {
      return
    }

    lastConnectionMode = conn?.mode

    if (conn?.mode === 'remote') {
      void checkBackendUpdates()
    }
  })

  window.addEventListener('focus', onFocus)
  backgroundTimer = setInterval(
    () => {
      void checkBackendUpdates()
      void checkWebmateUpdate()
    },
    30 * 60 * 1000
  )
}

export function stopUpdatePoller(): void {
  if (backgroundTimer !== null) {
    clearInterval(backgroundTimer)
    backgroundTimer = null
  }

  connectionUnsub?.()
  connectionUnsub = null
  lastConnectionMode = undefined
  window.removeEventListener('focus', onFocus)
  pollerStarted = false
}

function onFocus() {
  const now = Date.now()

  if (now - lastFocusAt < 5 * 60 * 1000) {
    return
  }

  lastFocusAt = now
  void checkBackendUpdates()
  void checkWebmateUpdate()
  void refreshDesktopVersion()
}
