import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppUpdateState, BackendUpdateStatus } from '@/global'

const storage = new Map<string, string>()

vi.mock('@/lib/storage', () => ({
  persistBoolean: (key: string, value: boolean) => {
    storage.set(key, String(value))
  },
  storedBoolean: (key: string, fallback: boolean) => {
    const value = storage.get(key)

    return value === undefined ? fallback : value === 'true'
  },
  persistString: (key: string, value: null | string) => {
    if (value === null) {
      storage.delete(key)
    } else {
      storage.set(key, value)
    }
  },
  storedString: (key: string) => storage.get(key) ?? null
}))

const notifySpy = vi.fn()
const dismissSpy = vi.fn()

vi.mock('@/store/notifications', () => ({
  notify: (...args: unknown[]) => notifySpy(...args),
  dismissNotification: (...args: unknown[]) => dismissSpy(...args)
}))

const checkHermesUpdateSpy = vi.fn()
const updateHermesSpy = vi.fn()
const getActionStatusSpy = vi.fn()

vi.mock('@/hermes', () => ({
  checkHermesUpdate: (...args: unknown[]) => checkHermesUpdateSpy(...args),
  updateHermes: (...args: unknown[]) => updateHermesSpy(...args),
  getActionStatus: (...args: unknown[]) => getActionStatusSpy(...args)
}))

const appUpdateState = atom<AppUpdateState | null>(null)
const restartAppSpy = vi.fn()

vi.mock('@/store/app-update', () => ({
  $appUpdate: appUpdateState,
  restartApp: (...args: unknown[]) => restartAppSpy(...args)
}))

const checkWebmateSpy = vi.fn()

vi.mock('@/store/webmate', () => ({ checkWebmateUpdate: (...args: unknown[]) => checkWebmateSpy(...args) }))

const {
  $backendUpdateApply,
  $backendUpdateStatus,
  applyBackendUpdate,
  checkBackendUpdates,
  maybeNotifyBackendUpdate,
  reportBackendContract,
  reportInstallMethodWarning,
  requestActiveUpdate,
  resetBackendUpdateApplyState,
  startUpdatePoller,
  stopUpdatePoller
} = await import('./updates')

const { $updateOverlayOpen, $updateOverlayTarget } = await import('./update-overlay')
const { setConnection } = await import('./session')

const status = (over: Partial<BackendUpdateStatus> = {}): BackendUpdateStatus => ({
  supported: true,
  updateAvailable: true,
  behind: 3,
  fetchedAt: 0,
  ...over
})

const lastToast = () =>
  notifySpy.mock.calls.at(-1)?.[0] as {
    action: { label: string; onClick: () => void }
    message: string
    onDismiss: () => void
    scope?: string
  }

const setRemote = (on: boolean) =>
  setConnection({
    baseUrl: 'http://box:9119',
    isFullscreen: false,
    mode: on ? 'remote' : 'local',
    nativeOverlayWidth: 0,
    token: 't',
    wsUrl: 'ws://box:9119',
    logs: [],
    windowButtonPosition: null
  })

const BACKEND_CURRENT = {
  install_method: 'git',
  current_version: '0.16.0',
  behind: 0,
  update_available: false,
  can_apply: true,
  update_command: 'agentx update',
  message: null
}

beforeEach(() => {
  storage.clear()
  notifySpy.mockClear()
  dismissSpy.mockClear()
  restartAppSpy.mockClear()
  appUpdateState.set(null)
  vi.useRealTimers()
})

afterEach(() => {
  setRemote(false)
})

describe('maybeNotifyBackendUpdate', () => {
  it('names how many changes are waiting when the backend can count them', () => {
    maybeNotifyBackendUpdate(status())

    expect(notifySpy).toHaveBeenCalledTimes(1)
    expect(lastToast()).toMatchObject({
      icon: 'gift',
      message: 'The connected backend has 3 new changes.',
      // About the backend, not the open chat: moving between chats leaves it up.
      scope: 'app'
    })
  })

  it('still announces an update the backend cannot count', () => {
    maybeNotifyBackendUpdate(status({ behind: 0 }))

    expect(lastToast().message).toBe('A newer version of the connected backend is ready.')
  })

  it('opens the backend dialog from its action', () => {
    maybeNotifyBackendUpdate(status())
    lastToast().action.onClick()

    expect($updateOverlayOpen.get()).toBe(true)
    expect($updateOverlayTarget.get()).toBe('backend')
  })

  it('stays quiet for a day once closed, then reminds again', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)

    maybeNotifyBackendUpdate(status())
    lastToast().onDismiss()
    notifySpy.mockClear()

    maybeNotifyBackendUpdate(status({ behind: 9 }))
    expect(notifySpy).not.toHaveBeenCalled()

    vi.setSystemTime(25 * 60 * 60 * 1000)
    maybeNotifyBackendUpdate(status())
    expect(notifySpy).toHaveBeenCalledTimes(1)
  })

  it('says nothing without an update, for an unsupported backend, or after a failed check', () => {
    maybeNotifyBackendUpdate(status({ updateAvailable: false, behind: 0 }))
    maybeNotifyBackendUpdate(status({ supported: false }))
    maybeNotifyBackendUpdate(status({ error: 'check-failed' }))
    maybeNotifyBackendUpdate(null)

    expect(notifySpy).not.toHaveBeenCalled()
  })
})

describe('reportBackendContract', () => {
  it('dismisses the toast when the backend meets the contract', () => {
    reportBackendContract(5)

    expect(dismissSpy).toHaveBeenCalledWith('backend-contract-skew')
    expect(notifySpy).not.toHaveBeenCalled()
  })

  it('offers to update a remote backend that is behind', () => {
    setRemote(true)
    updateHermesSpy.mockReset().mockResolvedValue({ ok: false, message: 'no' })

    reportBackendContract(1)
    lastToast().action.onClick()

    expect(lastToast().message).toBe(
      'Your AgentX backend is older than this desktop build and may not work correctly. Update to align them.'
    )
    expect(updateHermesSpy).toHaveBeenCalled()
    expect(restartAppSpy).not.toHaveBeenCalled()
  })

  it('offers a restart for the local agent, never `agentx update`', () => {
    updateHermesSpy.mockReset()

    reportBackendContract(undefined)
    lastToast().action.onClick()

    expect(lastToast()).toMatchObject({ action: { label: 'Restart AgentX' }, scope: 'app' })
    expect(restartAppSpy).toHaveBeenCalled()
    expect(updateHermesSpy).not.toHaveBeenCalled()
  })

  it('leaves the local case to the agent-update notice when this launch already reported one', () => {
    appUpdateState.set({ agentUpdateFailed: 'failed' } as AppUpdateState)

    reportBackendContract(1)

    expect(notifySpy).not.toHaveBeenCalled()
  })

  it('stays quiet on later session opens once closed, and warns again after a catch-up', () => {
    reportBackendContract(1)
    lastToast().onDismiss()
    notifySpy.mockClear()

    reportBackendContract(1)
    expect(notifySpy).not.toHaveBeenCalled()

    reportBackendContract(5)
    reportBackendContract(4)
    expect(notifySpy).toHaveBeenCalledTimes(1)
  })
})

describe('reportInstallMethodWarning', () => {
  it('warns app-wide until closed, then stays quiet for a day', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)

    reportInstallMethodWarning('Installed with pip; updates need a git checkout.')

    expect(lastToast()).toMatchObject({
      message: 'Installed with pip; updates need a git checkout.',
      scope: 'app'
    })

    lastToast().onDismiss()
    notifySpy.mockClear()

    reportInstallMethodWarning('Installed with pip; updates need a git checkout.')
    expect(notifySpy).not.toHaveBeenCalled()

    vi.setSystemTime(25 * 60 * 60 * 1000)
    reportInstallMethodWarning('Installed with pip; updates need a git checkout.')
    expect(notifySpy).toHaveBeenCalledTimes(1)
  })

  it('withdraws the warning once the backend stops reporting it', () => {
    reportInstallMethodWarning(undefined)

    expect(dismissSpy).toHaveBeenCalledWith('install-method-not-supported')
    expect(notifySpy).not.toHaveBeenCalled()
  })
})

describe('checkBackendUpdates', () => {
  beforeEach(() => {
    checkHermesUpdateSpy.mockReset()
    $backendUpdateStatus.set(null)
  })

  it('maps the backend /update/check onto the backend status, including commits', async () => {
    setRemote(true)
    checkHermesUpdateSpy.mockResolvedValue({
      ...BACKEND_CURRENT,
      behind: 2,
      update_available: true,
      commits: [{ sha: 'abc1234', summary: 'feat: x', author: 'a', at: 1 }]
    })

    const result = await checkBackendUpdates()

    expect(result).toMatchObject({ behind: 2, updateAvailable: true, supported: true, currentVersion: '0.16.0' })
    expect($backendUpdateStatus.get()?.commits?.[0]?.summary).toBe('feat: x')
  })

  it('keeps update_available when the backend cannot count commits', async () => {
    setRemote(true)
    checkHermesUpdateSpy.mockResolvedValue({ ...BACKEND_CURRENT, behind: -1, update_available: true })

    const result = await checkBackendUpdates()

    expect(result?.behind).toBe(0)
    expect(result?.updateAvailable).toBe(true)
  })

  it('honours can_apply=false (docker/nix): not supported, carries message', async () => {
    setRemote(true)
    checkHermesUpdateSpy.mockResolvedValue({
      ...BACKEND_CURRENT,
      behind: null,
      can_apply: false,
      message: 'Docker images are immutable.'
    })

    const result = await checkBackendUpdates()

    expect(result?.supported).toBe(false)
    expect(result?.message).toBe('Docker images are immutable.')
  })

  it('is a no-op in local mode', async () => {
    await checkBackendUpdates()

    expect(checkHermesUpdateSpy).not.toHaveBeenCalled()
  })
})

// The menu's "Check for Updates…" and the ⌘K "Update AgentX" row.
describe('requestActiveUpdate', () => {
  beforeEach(() => {
    updateHermesSpy.mockReset().mockResolvedValue({ ok: false, message: 'manual' })
    checkHermesUpdateSpy.mockReset().mockResolvedValue(BACKEND_CURRENT)
    resetBackendUpdateApplyState()
    $backendUpdateStatus.set(null)
    $updateOverlayOpen.set(false)
  })

  it('opens this app’s own update in local mode and never touches the agent', () => {
    requestActiveUpdate()

    expect($updateOverlayOpen.get()).toBe(true)
    expect($updateOverlayTarget.get()).toBe('client')
    expect(updateHermesSpy).not.toHaveBeenCalled()
  })

  it('applies a waiting update on a remote backend', async () => {
    setRemote(true)
    $backendUpdateStatus.set(status())

    requestActiveUpdate()

    expect($updateOverlayTarget.get()).toBe('backend')
    await vi.waitFor(() => expect(updateHermesSpy).toHaveBeenCalled())
  })

  it('only opens the backend dialog when the remote backend is current', () => {
    setRemote(true)
    $backendUpdateStatus.set(status({ updateAvailable: false, behind: 0 }))

    requestActiveUpdate()

    expect($updateOverlayOpen.get()).toBe(true)
    expect(updateHermesSpy).not.toHaveBeenCalled()
  })
})

describe('applyBackendUpdate', () => {
  beforeEach(() => {
    checkHermesUpdateSpy.mockReset()
    updateHermesSpy.mockReset()
    getActionStatusSpy.mockReset()
    resetBackendUpdateApplyState()
    vi.useFakeTimers()
  })

  it('lands on the manual state with the backend’s command when it cannot update itself', async () => {
    updateHermesSpy.mockResolvedValue({ ok: false, message: 'Managed by nix.', update_command: 'nix flake update' })

    const result = await applyBackendUpdate()

    expect(result).toMatchObject({ manual: true, command: 'nix flake update' })
    expect($backendUpdateApply.get()).toMatchObject({ stage: 'manual', applying: false, command: 'nix flake update' })
  })

  it('waits for the backend to return after the restart drops the connection', async () => {
    updateHermesSpy.mockResolvedValue({ ok: true, name: 'update', pid: 1 })
    getActionStatusSpy.mockRejectedValue(new Error('ECONNREFUSED'))
    checkHermesUpdateSpy.mockResolvedValue(BACKEND_CURRENT)

    const promise = applyBackendUpdate()
    await vi.advanceTimersByTimeAsync(5000)

    expect((await promise).ok).toBe(true)
    expect($backendUpdateApply.get()).toMatchObject({ stage: 'idle', applying: false })
  })

  it('surfaces the update’s log lines while it runs', async () => {
    updateHermesSpy.mockResolvedValue({ ok: true, name: 'update', pid: 1 })
    getActionStatusSpy
      .mockResolvedValueOnce({
        exit_code: null,
        lines: ['Pulling updates...', 'Installing dependencies...'],
        name: 'update',
        pid: 1,
        running: true
      })
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
    checkHermesUpdateSpy.mockResolvedValue(BACKEND_CURRENT)

    const promise = applyBackendUpdate()
    await vi.advanceTimersByTimeAsync(1500)

    expect($backendUpdateApply.get().message).toBe('Installing dependencies...')
    expect($backendUpdateApply.get().log.map(entry => entry.message)).toEqual([
      'Pulling updates...',
      'Installing dependencies...'
    ])

    await vi.advanceTimersByTimeAsync(5000)
    await promise
  })

  it('surfaces an error when the backend never comes back', async () => {
    updateHermesSpy.mockResolvedValue({ ok: true, name: 'update', pid: 1 })
    getActionStatusSpy.mockRejectedValue(new Error('ECONNREFUSED'))
    checkHermesUpdateSpy.mockRejectedValue(new Error('ECONNREFUSED'))

    const promise = applyBackendUpdate()
    await vi.advanceTimersByTimeAsync(70000)

    expect((await promise).ok).toBe(false)
    expect($backendUpdateApply.get().stage).toBe('error')
  })
})

describe('startUpdatePoller', () => {
  const listeners: Record<string, () => void> = {}

  beforeEach(() => {
    checkHermesUpdateSpy.mockReset().mockResolvedValue(BACKEND_CURRENT)
    checkWebmateSpy.mockReset()
    Object.keys(listeners).forEach(key => delete listeners[key])
    ;(globalThis as unknown as { window: unknown }).window = {
      agentxDesktop: { getVersion: vi.fn().mockResolvedValue({ appVersion: '1.0.3', agentVersion: '1.0.3' }) },
      addEventListener: vi.fn((event: string, handler: () => void) => {
        listeners[event] = handler
      }),
      removeEventListener: vi.fn()
    }
    vi.useFakeTimers()
    stopUpdatePoller()
  })

  afterEach(() => {
    stopUpdatePoller()
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('checks a remote backend and WebMate at start, on each interval and on focus', async () => {
    setRemote(true)
    startUpdatePoller()
    await vi.advanceTimersByTimeAsync(0)

    expect(checkHermesUpdateSpy).toHaveBeenCalled()
    expect(checkWebmateSpy).toHaveBeenCalled()

    checkHermesUpdateSpy.mockClear()
    checkWebmateSpy.mockClear()
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)

    expect(checkHermesUpdateSpy).toHaveBeenCalled()
    expect(checkWebmateSpy).toHaveBeenCalled()

    checkWebmateSpy.mockClear()
    listeners.focus?.()

    expect(checkWebmateSpy).toHaveBeenCalled()
  })

  it('leaves this app’s own updates to the main process', async () => {
    startUpdatePoller()
    await vi.advanceTimersByTimeAsync(0)

    // Local mode: no backend check; nothing here asks for the app's own update.
    expect(checkHermesUpdateSpy).not.toHaveBeenCalled()
    expect(checkWebmateSpy).toHaveBeenCalled()
  })
})
