// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as HermesApi from '@/hermes'
import type { SkillHubChangesResponse } from '@/types/hermes'

const getSkillHubChanges = vi.fn()
const tickSkillHub = vi.fn()
const updateSkillsFromHub = vi.fn()

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<typeof HermesApi>()),
  getSkillHubChanges: () => getSkillHubChanges(),
  tickSkillHub: () => tickSkillHub(),
  updateSkillsFromHub: () => updateSkillsFromHub()
}))

vi.mock('@/store/notifications', () => ({
  notify: vi.fn(),
  notifyError: vi.fn()
}))

function changes(overrides: Partial<SkillHubChangesResponse> = {}): SkillHubChangesResponse {
  return {
    enabled: true,
    configured: true,
    base_url: 'https://skills.dev-server.cloud',
    realtime: true,
    org_auto_install: true,
    credentials: 'mailbox',
    device_id: '11111111-2222-3333-4444-555555555555',
    stream: 'connected',
    cursor: 42,
    revision: 1,
    last: { status: 'ok', detail: '', at: '2026-09-03T10:00:00Z' },
    installs: [
      {
        id: 'inst-1',
        slug: 'vneb-report',
        name: 'vneb-report',
        kind: 'core',
        product: 'workmate',
        device_id: '11111111-2222-3333-4444-555555555555',
        version: null,
        latest_version: '1.1.0',
        desired_state: 'installed',
        reported_state: 'installed',
        reported_version: '1.0.0',
        error: '',
        reason: '',
        update_available: true,
        local: { installed: true, name: 'vneb-report', version: '1.0.0', content_hash: 'sha256:abc', install_path: 'vneb-report', enabled: true }
      },
      {
        id: 'inst-2',
        slug: 'leaky',
        name: 'leaky',
        kind: 'core',
        product: 'workmate',
        device_id: null,
        version: '1.0.0',
        latest_version: '1.0.0',
        desired_state: 'disabled',
        reported_state: 'disabled',
        reported_version: '1.0.0',
        error: '',
        reason: 'leaks the reactor code',
        update_available: false,
        local: { installed: true, name: 'leaky', version: '1.0.0', content_hash: 'sha256:def', install_path: 'leaky', enabled: false }
      }
    ],
    updates: [{ install_id: 'inst-1', slug: 'vneb-report', name: 'vneb-report', current: '1.0.0', latest: '1.1.0' }],
    org: { org_id: 'astralx', skills: [{ slug: 'team-notes', name: 'team-notes', kind: 'core', version: '1.0.0', content_hash: null }] },
    history: [{ action: 'installed', slug: 'vneb-report', version: '1.0.0', detail: '', at: '2026-09-03T09:59:00Z' }],
    generated_at: '2026-09-03T10:00:00Z',
    ...overrides
  }
}

async function renderStatus() {
  const { HubStatus } = await import('./hub-status')
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let result: ReturnType<typeof render>
  await act(async () => {
    result = render(
      <QueryClientProvider client={client}>
        <HubStatus />
      </QueryClientProvider>
    )
  })

  return { client, result: result! }
}

beforeEach(() => {
  getSkillHubChanges.mockResolvedValue(changes())
  tickSkillHub.mockResolvedValue({ status: 'ok', detail: '' })
  updateSkillsFromHub.mockResolvedValue({ ok: true, pid: 1, name: 'skills-update' })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('HubStatus', () => {
  it('ticks on mount (delivering the bearer) and shows what the hub wants on this machine', async () => {
    await renderStatus()

    await waitFor(() => expect(tickSkillHub).toHaveBeenCalledTimes(1))
    expect(await screen.findByTestId('hub-installs')).toBeTruthy()
    const rows = screen.getAllByTestId('hub-install')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('vneb-report')
    expect(rows[0].textContent).toContain('Installed')
    expect(rows[1].textContent).toContain('Switched off')
    expect(rows[1].textContent).toContain('leaks the reactor code')
    expect(rows[1].textContent).toContain('switched off on this machine')
    expect(screen.getByTestId('hub-stream').textContent).toBe('Live connection')
    // Updates are offered, with the fleet-wide update action.
    expect(screen.getByTestId('hub-updates').textContent).toContain('1 update available')
    expect(screen.getByTestId('hub-updates').textContent).toContain('1.0.0 → 1.1.0')
    expect(screen.getByText('1 organisation skill')).toBeTruthy()
    expect(screen.getByTestId('hub-history').textContent).toContain('vneb-report@1.0.0 installed')
    expect(screen.queryByTestId('hub-status-line')).toBeNull()
  })

  it('says why nothing syncs when the backend is offline or signed out', async () => {
    getSkillHubChanges.mockResolvedValue(changes({ stream: 'waiting', last: { status: 'offline', detail: 'x' }, installs: [], updates: [], history: [], org: null }))

    await renderStatus()

    expect((await screen.findByTestId('hub-status-line')).textContent).toBe('The Hub cannot be reached — installed skills keep working.')
    expect(screen.getByText(/Nothing has been requested from the Hub/)).toBeTruthy()
    getSkillHubChanges.mockResolvedValue(changes({ last: { status: 'signed_out', detail: '' }, installs: [] }))
  })

  it('"Sync now" runs a tick and refreshes; a changed revision invalidates the skills list', async () => {
    const { client } = await renderStatus()
    await waitFor(() => expect(tickSkillHub).toHaveBeenCalledTimes(1))
    const invalidate = vi.spyOn(client, 'invalidateQueries')

    getSkillHubChanges.mockResolvedValue(changes({ revision: 2 }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sync now' }))
    })

    await waitFor(() => expect(tickSkillHub).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['skills-list'] }))
  })

  it('"Update installed" runs the fleet update action', async () => {
    await renderStatus()
    await screen.findByTestId('hub-updates')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Update installed' }))
    })

    await waitFor(() => expect(updateSkillsFromHub).toHaveBeenCalledTimes(1))
  })
})
