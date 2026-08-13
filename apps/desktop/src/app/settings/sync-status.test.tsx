import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { en } from '@/i18n/en'
import { $sync } from '@/store/account'

import { describeSyncState, describeSyncTime, SyncStatus } from './sync-status'

// Synchronisation is the one feature in Settings that is allowed to be behind.
// The panel's job is to say so calmly: a person whose service is down has lost
// nothing, and telling them otherwise would make a working app look broken.
// The properties pinned here are that it says something true in every state,
// and that it disappears entirely when there is nothing to say.

const original = window.agentxDesktop
const copy = en.settings.account

function stubSync(bridge: Record<string, unknown> | null) {
  Object.defineProperty(window, 'agentxDesktop', {
    configurable: true,
    value: bridge === null ? {} : { sync: bridge }
  })
}

const IDLE = {
  available: false,
  configured: false,
  cursor: 0,
  enabled: false,
  loaded: false,
  pending: 0,
  syncing: false
}

afterEach(() => {
  cleanup()
  $sync.set({ ...IDLE })
  Object.defineProperty(window, 'agentxDesktop', { configurable: true, value: original })
})

describe('SyncStatus', () => {
  it('says it is in step when there is nothing waiting', async () => {
    stubSync({
      status: vi.fn().mockResolvedValue({
        configured: true,
        cursor: 12,
        enabled: true,
        last: { status: 'ok' },
        last_pull_at: Date.now() / 1000,
        pending: 0
      }),
      tick: vi.fn()
    })

    render(<SyncStatus />)

    await waitFor(() => {
      expect(screen.getByText(copy.syncUpToDate)).toBeTruthy()
    })
  })

  it('reports how much is still queued', async () => {
    stubSync({
      status: vi.fn().mockResolvedValue({
        configured: true,
        enabled: true,
        last: { status: 'ok' },
        pending: 3
      }),
      tick: vi.fn()
    })

    render(<SyncStatus />)

    await waitFor(() => {
      expect(screen.getByText(copy.syncPending(3))).toBeTruthy()
    })
  })

  it('degrades to a sentence when the service is unreachable', async () => {
    stubSync({
      status: vi.fn().mockResolvedValue({
        configured: true,
        enabled: true,
        last: { detail: 'nope', status: 'offline' },
        pending: 2
      }),
      tick: vi.fn()
    })

    render(<SyncStatus />)

    await waitFor(() => {
      expect(screen.getByText(copy.syncOffline)).toBeTruthy()
    })
  })

  it('shows the last problem when there is one', async () => {
    stubSync({
      status: vi.fn().mockResolvedValue({
        configured: true,
        enabled: true,
        last: { status: 'ok' },
        last_error: 'HTTP 500: the store is unavailable'
      }),
      tick: vi.fn()
    })

    render(<SyncStatus />)

    await waitFor(() => {
      expect(screen.getByText('HTTP 500: the store is unavailable')).toBeTruthy()
    })
  })

  it('renders nothing at all when no service is configured', async () => {
    stubSync({
      status: vi.fn().mockResolvedValue({ configured: false, enabled: true }),
      tick: vi.fn()
    })

    const { container } = render(<SyncStatus />)

    // An empty section headed "Conversation history" reads as a broken
    // feature rather than an absent one.
    await waitFor(() => {
      expect($sync.get().loaded).toBe(true)
    })
    expect(container.textContent).toBe('')
  })

  it('renders nothing when this build has no bridge for it', async () => {
    stubSync(null)

    const { container } = render(<SyncStatus />)

    await waitFor(() => {
      expect($sync.get().loaded).toBe(true)
    })
    expect(container.textContent).toBe('')
  })

  it('says so plainly when synchronisation is switched off', async () => {
    stubSync({
      status: vi.fn().mockResolvedValue({ configured: true, enabled: false }),
      tick: vi.fn()
    })

    render(<SyncStatus />)

    await waitFor(() => {
      expect(screen.getByText(copy.syncDisabledDesc)).toBeTruthy()
    })
  })

  it('syncs on demand and reports the outcome', async () => {
    const tick = vi.fn().mockResolvedValue({ pulled: 2, pushed: 1, status: 'ok' })

    stubSync({
      status: vi.fn().mockResolvedValue({
        configured: true,
        enabled: true,
        last: { status: 'ok' },
        pending: 1
      }),
      tick
    })

    render(<SyncStatus />)

    await waitFor(() => {
      expect(screen.getByText(copy.syncNow)).toBeTruthy()
    })
    fireEvent.click(screen.getByText(copy.syncNow))

    await waitFor(() => {
      expect(tick).toHaveBeenCalled()
      expect(screen.getByText(copy.syncNowDone)).toBeTruthy()
    })
  })

  it('reports a failed on-demand sync instead of claiming success', async () => {
    stubSync({
      status: vi.fn().mockResolvedValue({
        configured: true,
        enabled: true,
        last: { status: 'ok' }
      }),
      tick: vi.fn().mockResolvedValue({ detail: 'down', status: 'offline' })
    })

    render(<SyncStatus />)

    await waitFor(() => {
      expect(screen.getByText(copy.syncNow)).toBeTruthy()
    })
    fireEvent.click(screen.getByText(copy.syncNow))

    await waitFor(() => {
      expect(screen.getAllByText(copy.syncOffline).length).toBeGreaterThan(0)
    })
  })

  it('survives a bridge that throws', async () => {
    stubSync({
      status: vi.fn().mockRejectedValue(new Error('boom')),
      tick: vi.fn()
    })

    const { container } = render(<SyncStatus />)

    await waitFor(() => {
      expect($sync.get().loaded).toBe(true)
    })
    // Unconfigured is the honest reading of "we could not ask", and it keeps
    // the rest of Settings untouched.
    expect(container.textContent).toBe('')
  })
})

describe('describeSyncTime', () => {
  const now = Date.UTC(2026, 7, 13, 12, 0, 0)

  it('says never when it has not happened', () => {
    expect(describeSyncTime(null, copy, now)).toBe(copy.syncNever)
    expect(describeSyncTime(0, copy, now)).toBe(copy.syncNever)
  })

  it('reads epoch seconds, not milliseconds', () => {
    // Passing milliseconds here would read as fifty years ago.
    expect(describeSyncTime(now / 1000 - 3600, copy, now)).toBe(copy.syncHoursAgo(1))
  })

  it('rounds a very recent sync to just now', () => {
    expect(describeSyncTime(now / 1000 - 30, copy, now)).toBe(copy.syncJustNow)
  })

  it('does not say a sync happened in the future', () => {
    // A device whose clock is slightly ahead, or one that just synced.
    expect(describeSyncTime(now / 1000 + 600, copy, now)).toBe(copy.syncJustNow)
  })

  it('scales from minutes to days', () => {
    expect(describeSyncTime(now / 1000 - 600, copy, now)).toBe(copy.syncMinutesAgo(10))
    expect(describeSyncTime(now / 1000 - 86_400 * 3, copy, now)).toBe(copy.syncDaysAgo(3))
  })
})

describe('describeSyncState', () => {
  it('branches on the machine-readable status, not on prose', () => {
    expect(describeSyncState({ last: { status: 'offline' } }, copy)).toBe(copy.syncOffline)
    expect(describeSyncState({ last: { status: 'reauth' } }, copy)).toBe(copy.syncReauth)
    expect(describeSyncState({ last: { status: 'error' } }, copy)).toBe(copy.syncError)
  })

  it('prefers the backlog over a generic all-clear', () => {
    expect(describeSyncState({ last: { status: 'ok' }, pending: 4 }, copy)).toBe(
      copy.syncPending(4)
    )
  })

  it('falls back to up-to-date when nothing has happened yet', () => {
    expect(describeSyncState({}, copy)).toBe(copy.syncUpToDate)
  })
})
