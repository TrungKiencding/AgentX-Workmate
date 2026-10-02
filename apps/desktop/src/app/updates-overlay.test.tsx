import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppUpdateState } from '@/global'
import { readJson } from '@/lib/storage'
import { $appUpdate, $appUpdateActiveWork } from '@/store/app-update'
import { $updateOverlayOpen, $updateOverlayTarget } from '@/store/update-overlay'
import { $backendUpdateStatus, resetBackendUpdateApplyState } from '@/store/updates'

import { UpdatesOverlay } from './updates-overlay'

// The updates dialog is where a person decides to download and install. Pinned
// here: each state says what is true and offers only what can work from it.

const original = window.agentxDesktop

const release = {
  version: '1.0.4',
  publishedAt: '2026-10-02T00:00:00.000Z',
  notes: { en: ['Update from inside the app', 'Sign-in lasts 14 days'], vi: ['Cập nhật trong ứng dụng'] },
  bytes: 120 * 1024 * 1024
}

function state(over: Partial<AppUpdateState> = {}): AppUpdateState {
  return {
    phase: 'available',
    currentVersion: '1.0.3',
    checking: false,
    checkedAt: 1,
    checkError: null,
    release,
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

const bridge = {
  get: vi.fn(),
  check: vi.fn(),
  download: vi.fn(),
  cancel: vi.fn(),
  install: vi.fn(),
  acknowledge: vi.fn(),
  restart: vi.fn(),
  onState: vi.fn(() => () => undefined)
}

const openExternal = vi.fn()

function open(next: AppUpdateState | null, target: 'backend' | 'client' = 'client') {
  $appUpdate.set(next)
  $updateOverlayTarget.set(target)
  $updateOverlayOpen.set(true)

  return render(<UpdatesOverlay />)
}

beforeEach(() => {
  Object.values(bridge).forEach(fn => fn.mockReset())
  bridge.onState.mockReturnValue(() => undefined)
  bridge.check.mockResolvedValue(state({ phase: 'up-to-date', release: null }))
  openExternal.mockReset()
  Object.defineProperty(window, 'agentxDesktop', {
    configurable: true,
    value: { appUpdate: bridge, openExternal }
  })
})

afterEach(() => {
  cleanup()
  $updateOverlayOpen.set(false)
  $appUpdateActiveWork.set(null)
  $appUpdate.set(null)
  $backendUpdateStatus.set(null)
  resetBackendUpdateApplyState()
  Object.defineProperty(window, 'agentxDesktop', { configurable: true, value: original })
})

describe('UpdatesOverlay — this app', () => {
  it('shows an available release with its notes and downloads it', async () => {
    bridge.download.mockResolvedValue(state({ phase: 'ready' }))

    open(state())

    expect(screen.getByText('AgentX Workmate 1.0.4 is available')).toBeTruthy()
    expect(screen.getByText('Update from inside the app')).toBeTruthy()
    expect(screen.getByText('Sign-in lasts 14 days')).toBeTruthy()
    // An available release needs no fresh check on open.
    expect(bridge.check).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Download update (120 MB)' }))

    await waitFor(() => expect(bridge.download).toHaveBeenCalled())
  })

  it('puts the release off for a day with Later', () => {
    open(state())

    fireEvent.click(screen.getByRole('button', { name: 'Later' }))

    expect($updateOverlayOpen.get()).toBe(false)
    expect(readJson<{ version: string }>('agentx:app-update-snooze')?.version).toBe('1.0.4')
  })

  it('checks when opened with nothing known, and says when the app is current', async () => {
    open(state({ phase: 'idle', release: null, checkedAt: null }))

    await waitFor(() => expect(bridge.check).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByText('You’re up to date')).toBeTruthy())
    expect(screen.getByText('AgentX Workmate 1.0.3 is the latest version.')).toBeTruthy()
  })

  it('follows a download in the background, and can cancel it', async () => {
    bridge.cancel.mockResolvedValue(state())

    open(state({ phase: 'downloading', progress: { receivedBytes: 60 * 1024 * 1024, totalBytes: release.bytes } }))

    expect(screen.getByText('Downloading AgentX Workmate 1.0.4')).toBeTruthy()
    expect(screen.getByText('60 MB of 120 MB · 50%')).toBeTruthy()

    // Hiding closes the dialog; the download is main's and carries on.
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    expect($updateOverlayOpen.get()).toBe(false)
    expect(bridge.cancel).not.toHaveBeenCalled()

    act(() => $updateOverlayOpen.set(true))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel download' }))

    await waitFor(() => expect(bridge.cancel).toHaveBeenCalled())
    // Back to the release, ready to download again.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Download update (120 MB)' })).toBeTruthy())
  })

  it('asks before stopping the agent’s work, and installs once confirmed', async () => {
    bridge.install
      .mockResolvedValueOnce({
        started: false,
        reason: 'active-work',
        activeWork: { count: 2, titles: ['Weekly report', 'Translate docs'] }
      })
      .mockResolvedValueOnce({ started: true })

    open(state({ phase: 'ready' }))

    expect(screen.getByText('AgentX Workmate 1.0.4 is ready to install')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Restart to update' }))

    await waitFor(() => expect(screen.getByText('The agent is still working')).toBeTruthy())
    expect(bridge.install).toHaveBeenLastCalledWith({ confirmActiveWork: false })
    expect(screen.getByText('Updating now stops the 2 conversations that are still running.')).toBeTruthy()
    expect(screen.getByText('• Weekly report')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Update anyway' }))
    await waitFor(() => expect(bridge.install).toHaveBeenLastCalledWith({ confirmActiveWork: true }))
  })

  it('says why an install could not start, keeps it retryable, and offers the download page', () => {
    open(state({ phase: 'ready', installError: { kind: 'stage', message: 'hdiutil: attach failed' } }))

    const alert = screen.getByRole('alert')

    expect(alert.textContent).toContain('The update couldn’t be installed, so you’re still on this version.')
    // Main's own reason stays readable beneath, for whoever has to dig in.
    expect(alert.textContent).toContain('hdiutil: attach failed')
    expect(screen.getByRole('button', { name: 'Restart to update' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Open the download page' }))
    expect(openExternal).toHaveBeenCalledWith('https://example.test/#download')
  })

  it('explains a failed download in words, by what went wrong', () => {
    const cases = [
      ['network', 'The download stopped because the connection dropped.'],
      ['http', 'The update server didn’t send the installer.'],
      ['hash', 'The downloaded file didn’t match the signed release, so AgentX discarded it.'],
      ['size', 'The downloaded file didn’t match the signed release, so AgentX discarded it.'],
      ['disk', 'The update couldn’t be saved. Free up some disk space and try again.'],
      ['surprise', 'The download didn’t finish. Try again.']
    ]

    for (const [kind, text] of cases) {
      open(state({ downloadError: { kind, message: `raw ${kind} reason` } }))

      const alert = screen.getByRole('alert')

      expect(alert.textContent).toContain(text)
      expect(alert.textContent).toContain(`raw ${kind} reason`)
      expect(screen.getByRole('button', { name: 'Download again' })).toBeTruthy()
      // Nothing was installed, so there is no reason to send anyone elsewhere.
      expect(screen.queryByRole('button', { name: 'Open the download page' })).toBeNull()
      cleanup()
    }
  })

  it('points a copy that cannot replace itself at the download page instead', () => {
    open(state({ blocked: 'translocated' }))

    expect(screen.getByText(/Move AgentX Workmate into Applications/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Download update/ })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Open the download page' }))

    expect(openExternal).toHaveBeenCalledWith('https://example.test/#download')
  })

  it('cannot be dismissed while the app is quitting for the installer', () => {
    open(state({ phase: 'installing' }))

    expect(screen.getByText('Restarting to update…')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /close/i })).toBeNull()

    act(() => {
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    })

    expect($updateOverlayOpen.get()).toBe(true)
  })
})

describe('UpdatesOverlay — a remote backend', () => {
  it('names the changelog groups in the UI language', () => {
    $backendUpdateStatus.set({
      supported: true,
      updateAvailable: true,
      behind: 2,
      commits: [
        { sha: 'a', summary: 'feat: offline sessions', author: 'x', at: 1 },
        { sha: 'b', summary: 'fix: flaky reconnect', author: 'x', at: 2 }
      ]
    })

    open(null, 'backend')

    expect(screen.getByText('Backend update available')).toBeTruthy()
    expect(screen.getByText('What’s new')).toBeTruthy()
    expect(screen.getByText('Fixed')).toBeTruthy()
    expect(screen.getByText('Offline sessions')).toBeTruthy()
  })

  it('says so honestly when the backend lists no changes', () => {
    $backendUpdateStatus.set({ supported: true, updateAvailable: true, behind: 0, commits: [] })

    open(null, 'backend')

    expect(screen.getByText('A newer version is ready. This backend doesn’t list what changed.')).toBeTruthy()
    expect(screen.queryByText('What’s new')).toBeNull()
  })
})
