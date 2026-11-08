import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { AppUpdateState } from '@/global'
import { $appUpdate } from '@/store/app-update'
import { $updateOverlayOpen, $updateOverlayTarget } from '@/store/update-overlay'

import { SidebarUpdateButton } from './update-button'

// The sidebar's update button: there while an update is, saying how far it
// has got, and only ever opening the dialog (never a restart on one click).

const release = {
  version: '1.1.3',
  publishedAt: '2026-11-08T00:00:00.000Z',
  notes: { en: ['Better things'] },
  bytes: 200 * 1024 * 1024
}

function state(over: Partial<AppUpdateState> = {}): AppUpdateState {
  return {
    phase: 'available',
    currentVersion: '1.1.2',
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

afterEach(() => {
  cleanup()
  $appUpdate.set(null)
  $updateOverlayOpen.set(false)
  $updateOverlayTarget.set('client')
})

describe('SidebarUpdateButton', () => {
  it('shows nothing until there is an update to act on', () => {
    const quiet: Array<AppUpdateState | null> = [
      null,
      state({ phase: 'idle', release: null }),
      state({ phase: 'up-to-date', release: null }),
      // A check that is still running knows of no release yet.
      state({ phase: 'idle', checking: true, release: null }),
      // A phase that names an update but carries no release cannot say which.
      state({ phase: 'available', release: null })
    ]

    for (const value of quiet) {
      $appUpdate.set(value)
      const { container } = render(<SidebarUpdateButton />)

      expect(container.innerHTML).toBe('')
      cleanup()
    }
  })

  it('offers an available release by version and opens the updates dialog on it', () => {
    $updateOverlayTarget.set('backend')
    $appUpdate.set(state())
    render(<SidebarUpdateButton />)

    const button = screen.getByRole('button', { name: 'AgentX Workmate 1.1.3 is available' })

    expect(button.textContent).toBe('Update to 1.1.3')

    fireEvent.click(button)

    expect($updateOverlayOpen.get()).toBe(true)
    expect($updateOverlayTarget.get()).toBe('client')
  })

  it('stays after a failed download or for a copy that must be reinstalled, where the dialog explains', () => {
    for (const over of [
      { downloadError: { kind: 'network', message: 'socket hang up' } },
      { blocked: 'not-writable' as const }
    ]) {
      $appUpdate.set(state(over))
      render(<SidebarUpdateButton />)

      expect(screen.getByRole('button', { name: 'AgentX Workmate 1.1.3 is available' })).toBeTruthy()
      cleanup()
    }
  })

  it('follows the download, then asks for the restart', () => {
    $appUpdate.set(
      state({ phase: 'downloading', progress: { receivedBytes: 50 * 1024 * 1024, totalBytes: release.bytes } })
    )
    render(<SidebarUpdateButton />)

    expect(screen.getByRole('button').textContent).toBe('Downloading the update · 25%')

    act(() => $appUpdate.set(state({ phase: 'ready' })))

    const restart = screen.getByRole('button')

    expect(restart.textContent).toBe('Restart to update')
    expect(restart.getAttribute('aria-label')).toBe('AgentX Workmate 1.1.3 is ready to install')

    // One click opens the dialog with the notes and the confirm; it never
    // restarts by itself.
    fireEvent.click(restart)
    expect($updateOverlayOpen.get()).toBe(true)
  })

  it('reads 0% before the first byte and never more than 100%', () => {
    $appUpdate.set(state({ phase: 'downloading', progress: null, release: { ...release, bytes: 0 } }))
    render(<SidebarUpdateButton />)
    expect(screen.getByRole('button').textContent).toBe('Downloading the update · 0%')

    act(() => $appUpdate.set(state({ phase: 'downloading', progress: { receivedBytes: 300, totalBytes: 200 } })))
    expect(screen.getByRole('button').textContent).toBe('Downloading the update · 100%')
  })

  it('says the install is under way while the app quits for it', () => {
    $appUpdate.set(state({ phase: 'installing' }))
    render(<SidebarUpdateButton />)

    expect(screen.getByRole('button').textContent).toBe('Installing the update…')
  })

  it('goes once the update is installed', () => {
    $appUpdate.set(state())
    render(<SidebarUpdateButton />)
    expect(screen.getByRole('button')).toBeTruthy()

    act(() => $appUpdate.set(state({ phase: 'up-to-date', currentVersion: '1.1.3', release: null })))

    expect(screen.queryByRole('button')).toBeNull()
  })
})
