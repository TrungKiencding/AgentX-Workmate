import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppUpdateState } from '@/global'

const stored = new Map<string, unknown>()

vi.mock('@/lib/storage', () => ({
  readJson: (key: string) => stored.get(key) ?? null,
  writeJson: (key: string, value: unknown) => void stored.set(key, value),
  // What store/session.ts reads at import.
  persistBoolean: (key: string, value: boolean) => void stored.set(key, value),
  persistString: (key: string, value: null | string) => void stored.set(key, value),
  storedBoolean: (key: string, fallback: boolean) => (stored.get(key) as boolean | undefined) ?? fallback,
  storedString: (key: string) => (stored.get(key) as null | string | undefined) ?? null
}))

const notifySpy = vi.fn()
const dismissSpy = vi.fn()

vi.mock('@/store/notifications', () => ({
  notify: (...args: unknown[]) => notifySpy(...args),
  dismissNotification: (...args: unknown[]) => dismissSpy(...args)
}))

let secondary = false

vi.mock('@/store/windows', () => ({ isSecondaryWindow: () => secondary }))

const {
  $appUpdate,
  $appUpdateActiveWork,
  cancelAppUpdateDownload,
  checkAppUpdate,
  deferAppUpdate,
  dismissActiveWorkPrompt,
  downloadAppUpdate,
  downloadProblemKey,
  installAppUpdate,
  resetAppUpdateNotices,
  restartApp,
  startAppUpdateSync
} = await import('./app-update')

const { $updateOverlayOpen, $updateOverlayTarget } = await import('./update-overlay')
const { $gatewayState } = await import('./session')

const release = {
  version: '1.0.4',
  publishedAt: '2026-10-02T00:00:00.000Z',
  notes: { en: ['Update from the app'], vi: ['Cập nhật trong ứng dụng'] },
  bytes: 126_000_000
}

function state(over: Partial<AppUpdateState> = {}): AppUpdateState {
  return {
    phase: 'idle',
    currentVersion: '1.0.3',
    checking: false,
    checkedAt: null,
    checkError: null,
    release: null,
    progress: null,
    downloadError: null,
    installError: null,
    blocked: null,
    downloadPageUrl: 'https://example.test/#download',
    updatedFrom: null,
    lastInstallFailed: null,
    agentUpdateFailed: null,
    ...over
  }
}

let push: (next: AppUpdateState) => void = () => undefined

const bridge = {
  get: vi.fn(),
  check: vi.fn(),
  download: vi.fn(),
  cancel: vi.fn(),
  install: vi.fn(),
  acknowledge: vi.fn(),
  restart: vi.fn(),
  onState: vi.fn((callback: (next: AppUpdateState) => void) => {
    push = callback

    return () => {
      push = () => undefined
    }
  })
}

const toasts = () => notifySpy.mock.calls.map(call => call[0] as Record<string, any>)
const toast = (id: string) => toasts().filter(item => item.id === id)

beforeEach(() => {
  stored.clear()
  secondary = false
  notifySpy.mockClear()
  dismissSpy.mockClear()
  Object.values(bridge).forEach(fn => fn.mockClear())
  bridge.get.mockResolvedValue(state())
  bridge.acknowledge.mockResolvedValue(state())
  $appUpdate.set(null)
  $appUpdateActiveWork.set(null)
  $updateOverlayOpen.set(false)
  $gatewayState.set('open')
  resetAppUpdateNotices()
  ;(window as unknown as { agentxDesktop: unknown }).agentxDesktop = { appUpdate: bridge }
})

afterEach(() => {
  delete (window as unknown as { agentxDesktop?: unknown }).agentxDesktop
})

describe('startAppUpdateSync', () => {
  it('mirrors the state main pushes, starting from the current one', async () => {
    bridge.get.mockResolvedValue(state({ phase: 'up-to-date' }))

    const stop = startAppUpdateSync()

    await vi.waitFor(() => expect($appUpdate.get()?.phase).toBe('up-to-date'))
    push(state({ phase: 'available', release }))
    expect($appUpdate.get()?.release?.version).toBe('1.0.4')

    stop()
    push(state({ phase: 'ready', release }))
    expect($appUpdate.get()?.phase).toBe('available')
  })

  it('does nothing without the desktop bridge', () => {
    delete (window as unknown as { agentxDesktop?: unknown }).agentxDesktop

    expect(() => startAppUpdateSync()()).not.toThrow()
  })
})

describe('notices', () => {
  beforeEach(() => {
    startAppUpdateSync()
  })

  it('announces an available release once, however many states follow', () => {
    push(state({ phase: 'available', release }))
    push(state({ phase: 'available', release, checking: true }))
    push(state({ phase: 'available', release, checkedAt: 2 }))

    const announced = toast('app-update-available')

    expect(announced).toHaveLength(1)
    expect(announced[0]).toMatchObject({
      kind: 'info',
      title: 'Update available',
      message: 'AgentX Workmate 1.0.4 is ready to download.'
    })

    announced[0].action.onClick()

    expect($updateOverlayOpen.get()).toBe(true)
    expect($updateOverlayTarget.get()).toBe('client')
  })

  it('stays quiet for a day about a version the person closed, but not about the next one', () => {
    push(state({ phase: 'available', release }))
    toast('app-update-available')[0].onDismiss()
    notifySpy.mockClear()
    resetAppUpdateNotices()

    push(state({ phase: 'available', release }))
    expect(toast('app-update-available')).toHaveLength(0)

    push(state({ phase: 'available', release: { ...release, version: '1.0.5' } }))
    expect(toast('app-update-available')).toHaveLength(1)
  })

  it('raises it again on a later check once the snooze runs out, without a restart', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)

    try {
      push(state({ phase: 'available', release, checkedAt: 1 }))
      toast('app-update-available')[0].onDismiss()

      vi.setSystemTime(23 * 60 * 60 * 1000)
      push(state({ phase: 'available', release, checkedAt: 2 }))
      expect(toast('app-update-available')).toHaveLength(1)

      vi.setSystemTime(25 * 60 * 60 * 1000)
      push(state({ phase: 'available', release, checkedAt: 3 }))
      push(state({ phase: 'available', release, checkedAt: 4 }))
      expect(toast('app-update-available')).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stays quiet about a version once its download has started, should it fail or be cancelled', async () => {
    push(state({ phase: 'available', release }))
    bridge.download.mockResolvedValue(state({ phase: 'downloading', release }))

    await downloadAppUpdate()
    push(state({ phase: 'available', release, downloadError: { kind: 'network', message: 'offline' } }))
    push(state({ phase: 'downloading', release }))
    push(state({ phase: 'available', release }))

    expect(toast('app-update-available')).toHaveLength(1)
  })

  it('raises every notice as one about the app, so moving between chats leaves it up', () => {
    push(state({ phase: 'available', release }))
    push(state({ phase: 'ready', release }))
    push(state({ currentVersion: '1.0.4', updatedFrom: '1.0.3', agentUpdateFailed: 'failed' }))
    push(state({ lastInstallFailed: { version: '1.0.5', message: 'the app did not quit in time' } }))

    expect(toasts().map(item => [item.id, item.scope])).toEqual([
      ['app-update-available', 'app'],
      ['app-update-ready', 'app'],
      ['app-update-result', 'app'],
      ['app-update-agent', 'app'],
      ['app-update-result', 'app']
    ])
  })

  it('tells about a download that failed in the background, with a retry, and withdraws it on retry', () => {
    push(state({ phase: 'available', release }))
    push(state({ phase: 'downloading', release }))
    push(state({ phase: 'available', release, downloadError: { kind: 'network', message: 'socket hang up' } }))
    push(state({ phase: 'available', release, downloadError: { kind: 'network', message: 'socket hang up' } }))

    const failed = toast('app-update-download')

    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({
      kind: 'warning',
      scope: 'app',
      title: 'The update didn’t download',
      message: 'The download stopped because the connection dropped. Check your network and try again.',
      detail: 'socket hang up',
      action: { label: 'Download again' }
    })

    bridge.download.mockResolvedValue(state({ phase: 'downloading', release }))
    failed[0].action.onClick()
    expect(bridge.download).toHaveBeenCalled()

    dismissSpy.mockClear()
    push(state({ phase: 'downloading', release }))
    expect(dismissSpy).toHaveBeenCalledWith('app-update-download')
  })

  it('leaves a failed download to the dialog when it is open', () => {
    $updateOverlayTarget.set('client')
    $updateOverlayOpen.set(true)

    push(state({ phase: 'downloading', release }))
    push(state({ phase: 'available', release, downloadError: { kind: 'hash', message: 'x' } }))

    expect(toast('app-update-download')).toHaveLength(0)
  })

  it('raises nothing the open dialog already shows', () => {
    $updateOverlayTarget.set('client')
    $updateOverlayOpen.set(true)

    push(state({ phase: 'available', release }))
    push(state({ phase: 'downloading', release }))
    push(state({ phase: 'ready', release }))

    expect(toast('app-update-available')).toHaveLength(0)
    expect(toast('app-update-ready')).toHaveLength(0)
  })

  it('does not repeat the restart prompt after an install that did not take', () => {
    push(state({ phase: 'ready', release }))
    push(state({ phase: 'installing', release }))
    push(state({ phase: 'ready', release, installError: { kind: 'stage', message: 'hdiutil: attach failed' } }))

    expect(toast('app-update-ready')).toHaveLength(1)
  })

  it('treats "Later" in the dialog like closing the notice: quiet for a day', () => {
    push(state({ phase: 'available', release }))
    dismissSpy.mockClear()

    deferAppUpdate()

    expect(dismissSpy).toHaveBeenCalledWith('app-update-available')
    notifySpy.mockClear()
    resetAppUpdateNotices()
    push(state({ phase: 'available', release }))
    expect(toast('app-update-available')).toHaveLength(0)
  })

  it('swaps the available notice for a restart prompt once the download is ready', () => {
    push(state({ phase: 'available', release }))
    push(state({ phase: 'downloading', release, progress: { receivedBytes: 1, totalBytes: 2 } }))
    push(state({ phase: 'downloading', release, progress: { receivedBytes: 2, totalBytes: 2 } }))
    push(state({ phase: 'ready', release }))

    expect(dismissSpy).toHaveBeenCalledWith('app-update-available')
    expect(toast('app-update-ready')).toHaveLength(1)
    expect(toast('app-update-ready')[0]).toMatchObject({
      message: 'Restart AgentX to finish updating to 1.0.4.',
      action: { label: 'Restart to update' }
    })
  })

  it('clears both once the app is up to date', () => {
    push(state({ phase: 'ready', release }))
    dismissSpy.mockClear()
    push(state({ phase: 'up-to-date' }))

    expect(dismissSpy).toHaveBeenCalledWith('app-update-available')
    expect(dismissSpy).toHaveBeenCalledWith('app-update-ready')
  })

  it('confirms an update that took once the app is connected, then forgets it', () => {
    $gatewayState.set('connecting')
    push(state({ phase: 'idle', currentVersion: '1.0.4', updatedFrom: '1.0.3' }))

    // Behind the connecting screen it would time out unseen.
    expect(toast('app-update-result')).toHaveLength(0)
    expect(bridge.acknowledge).toHaveBeenCalled()

    $gatewayState.set('open')

    expect(toast('app-update-result')[0]).toMatchObject({
      kind: 'success',
      scope: 'app',
      message: 'AgentX Workmate is now 1.0.4 (was 1.0.3).'
    })

    $gatewayState.set('closed')
    $gatewayState.set('open')
    expect(toast('app-update-result')).toHaveLength(1)
  })

  it('reports an install that did not take, with the reason and a way back', () => {
    push(state({ lastInstallFailed: { version: '1.0.4', message: 'the app did not quit in time' } }))

    const failed = toast('app-update-result')[0]

    expect(failed).toMatchObject({
      kind: 'error',
      message: 'AgentX Workmate 1.0.4 wasn’t installed; you’re still on the previous version.',
      detail: 'the app did not quit in time'
    })
    expect(bridge.acknowledge).toHaveBeenCalled()

    failed.action.onClick()
    expect($updateOverlayOpen.get()).toBe(true)
  })

  it('says when this launch could not bring the agent forward, offering a restart', () => {
    push(state({ agentUpdateFailed: 'held-open' }))
    push(state({ agentUpdateFailed: 'held-open', checking: true }))

    const agent = toast('app-update-agent')

    expect(agent).toHaveLength(1)
    expect(agent[0]).toMatchObject({ kind: 'warning', title: 'The agent wasn’t updated' })
    expect(agent[0].message).toMatch(/Another program was using the AgentX agent/)

    agent[0].action.onClick()
    expect(bridge.restart).toHaveBeenCalled()

    push(state())
    expect(dismissSpy).toHaveBeenCalledWith('app-update-agent')
  })

  it('leaves notices to the main window', () => {
    secondary = true

    push(state({ phase: 'available', release, updatedFrom: '1.0.2', agentUpdateFailed: 'failed' }))

    expect(notifySpy).not.toHaveBeenCalled()
    expect(bridge.acknowledge).not.toHaveBeenCalled()
  })
})

describe('downloadProblemKey', () => {
  it('groups the download failures main reports by what the person can do about them', () => {
    expect(['network', 'http', 'disk', 'hash', 'size', 'aborted', ''].map(downloadProblemKey)).toEqual([
      'network',
      'http',
      'disk',
      'mismatch',
      'mismatch',
      'other',
      'other'
    ])
  })
})

describe('actions', () => {
  it('checks, downloads and cancels through main, mirroring what comes back', async () => {
    bridge.check.mockResolvedValue(state({ phase: 'available', release }))
    bridge.download.mockResolvedValue(state({ phase: 'ready', release }))
    bridge.cancel.mockResolvedValue(state({ phase: 'available', release }))

    await checkAppUpdate()
    expect($appUpdate.get()?.phase).toBe('available')

    await downloadAppUpdate()
    expect($appUpdate.get()?.phase).toBe('ready')

    await cancelAppUpdateDownload()
    expect($appUpdate.get()?.phase).toBe('available')
  })

  it('holds an install refused for the agent’s work until it is confirmed or dropped', async () => {
    const activeWork = { count: 2, titles: ['Weekly report', 'Translate docs'] }

    bridge.install.mockResolvedValueOnce({ started: false, reason: 'active-work', activeWork })

    await installAppUpdate()

    expect(bridge.install).toHaveBeenLastCalledWith({ confirmActiveWork: false })
    expect($appUpdateActiveWork.get()).toEqual(activeWork)

    bridge.install.mockResolvedValueOnce({ started: true })
    await installAppUpdate({ confirmActiveWork: true })

    expect(bridge.install).toHaveBeenLastCalledWith({ confirmActiveWork: true })
    expect($appUpdateActiveWork.get()).toBeNull()

    $appUpdateActiveWork.set(activeWork)
    dismissActiveWorkPrompt()
    expect($appUpdateActiveWork.get()).toBeNull()
  })

  it('restarts the app through main', async () => {
    await restartApp()

    expect(bridge.restart).toHaveBeenCalled()
  })
})
