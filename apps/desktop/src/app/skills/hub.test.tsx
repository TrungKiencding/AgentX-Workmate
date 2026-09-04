// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as HermesApi from '@/hermes'
import type { SkillHubCatalogResponse, SkillHubResult } from '@/types/hermes'

const getSkillHubCatalog = vi.fn()
const getSkillHubSources = vi.fn()
const getSkillHubChanges = vi.fn()
const tickSkillHub = vi.fn()
const searchSkillsHub = vi.fn()
const installSkillFromHub = vi.fn()
const getActionStatus = vi.fn()

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<typeof HermesApi>()),
  getActionStatus: (name: string) => getActionStatus(name),
  getSkillHubCatalog: (refresh?: boolean) => getSkillHubCatalog(refresh),
  getSkillHubChanges: () => getSkillHubChanges(),
  getSkillHubSources: () => getSkillHubSources(),
  installSkillFromHub: (identifier: string) => installSkillFromHub(identifier),
  searchSkillsHub: (query: string, source: string) => searchSkillsHub(query, source),
  tickSkillHub: () => tickSkillHub()
}))

vi.mock('@/store/notifications', () => ({
  notify: vi.fn(),
  notifyError: vi.fn()
}))

function skill(overrides: Partial<SkillHubResult> = {}): SkillHubResult {
  return {
    name: 'vneb-report',
    description: 'Weekly report for VNEB.',
    source: 'agentx-hub',
    identifier: 'agentx-hub/vneb-report',
    trust_level: 'agentx-hub-verified',
    repo: null,
    tags: ['report'],
    extra: { downloads: 12, kind: 'core', version: '1.1.0', visibility: 'public' },
    ...overrides
  }
}

function catalog(overrides: Partial<SkillHubCatalogResponse> = {}): SkillHubCatalogResponse {
  return {
    skills: [
      skill(),
      skill({
        description: 'My own notes.',
        extra: { kind: 'browser', version: '0.2.0', visibility: 'private' },
        identifier: 'agentx-hub/kien/notes',
        name: 'notes',
        trust_level: 'community'
      })
    ],
    installed: {},
    fetched_at: 1_780_000_000,
    stale: false,
    authenticated: false,
    hub_url: 'https://skills.dev-server.cloud',
    error: '',
    ...overrides
  }
}

async function renderHub(query = '') {
  const { SkillsHub } = await import('./hub')
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let result: ReturnType<typeof render>
  await act(async () => {
    result = render(
      <QueryClientProvider client={client}>
        <SkillsHub query={query} />
      </QueryClientProvider>
    )
  })

  return { client, result: result! }
}

beforeEach(() => {
  getSkillHubCatalog.mockResolvedValue(catalog())
  getSkillHubSources.mockResolvedValue({ sources: [{ id: 'agentx-hub', label: 'AgentX Hub' }], index_available: true, featured: [], installed: {} })
  // Nothing pushed to this machine: the desired-state panel must stay away.
  getSkillHubChanges.mockResolvedValue({ enabled: true, configured: true, base_url: 'https://skills.dev-server.cloud', stream: 'off', revision: 1, last: { status: 'signed_out', detail: '', at: '' }, installs: [], updates: [], history: [], org: null })
  tickSkillHub.mockResolvedValue({ status: 'signed_out', detail: '' })
  searchSkillsHub.mockResolvedValue({ results: [], source_counts: {}, timed_out: [], installed: {} })
  installSkillFromHub.mockResolvedValue({ ok: true, pid: 1, name: 'skills-install-vneb-report' })
  getActionStatus.mockResolvedValue({ name: 'skills-install-vneb-report', running: false, exit_code: 0, lines: [] })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('SkillsHub — the skill store', () => {
  it('syncs the catalogue on open, with no sign-in, and shows one card per skill', async () => {
    await renderHub()

    // Opening the tab is a sync: the backend answers from its 30-minute cache.
    await waitFor(() => expect(getSkillHubCatalog).toHaveBeenCalledTimes(1))
    expect(getSkillHubCatalog).toHaveBeenCalledWith(undefined)

    const cards = await screen.findAllByTestId('hub-card')
    expect(cards).toHaveLength(2)
    expect(cards[0].textContent).toContain('vneb-report')
    expect(cards[0].textContent).toContain('1.1.0')
    // A personal skill is badged as such; a public one is not.
    expect(cards[1].textContent).toContain('Private')
    expect(cards[0].textContent).not.toContain('Private')
    // Both kinds are in the store, each badged.
    expect(cards[0].textContent).toContain('Desktop')
    expect(cards[1].textContent).toContain('Browser')
    // The store front: the hub, its state, what it holds, when it synced.
    const bar = screen.getByTestId('hub-catalog-bar').textContent ?? ''
    expect(bar).toContain('AgentX Hub')
    expect(bar).toContain('skills.dev-server.cloud')
    expect(bar).toContain('2 skills from the Hub')
    expect(screen.getByTestId('hub-store-state').textContent).toBe('Connected')
  })

  it('a card is metadata until Install is pressed', async () => {
    await renderHub()
    const cards = await screen.findAllByTestId('hub-card')

    expect(installSkillFromHub).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Install' })[0])
    })

    await waitFor(() => expect(installSkillFromHub).toHaveBeenCalledWith('agentx-hub/vneb-report'))
    expect(cards).toHaveLength(2)
  })

  it('"Sync now" forces a fresh sync instead of the cache', async () => {
    await renderHub()
    await waitFor(() => expect(getSkillHubCatalog).toHaveBeenCalledTimes(1))

    await act(async () => {
      fireEvent.click(screen.getByTestId('hub-sync'))
    })

    await waitFor(() => expect(getSkillHubCatalog).toHaveBeenCalledWith(true))
    // …and reconciles what the hub asked of this machine in the same press.
    expect(tickSkillHub).toHaveBeenCalled()
  })

  it('keeps the pushed-installs panel out of the way while the hub wants nothing', async () => {
    await renderHub()
    await screen.findAllByTestId('hub-card')

    expect(screen.queryByTestId('hub-status')).toBeNull()
  })

  it('says so when the hub could not be reached and the cards are the last sync', async () => {
    getSkillHubCatalog.mockResolvedValue(catalog({ error: 'https://skills.dev-server.cloud did not answer with a catalog', stale: true }))

    await renderHub()

    expect((await screen.findByTestId('hub-catalog-offline')).textContent).toContain('cannot be reached')
    expect(screen.getByTestId('hub-store-state').textContent).toBe('Unreachable')
  })
})
