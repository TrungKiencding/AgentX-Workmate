// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as HermesApi from '@/hermes'
import { queryClient } from '@/lib/query-client'
import type * as Notifications from '@/store/notifications'

// The Tiện ích page as a whole: three tabs — the skills AgentX has, the tools
// it may use, and Kho tiện ích, the one store for adding either kind. The
// store's kinds keep the `?tab=` ids the two stores always had (`hub`, `mcp`),
// so every deep link into them still lands; each "have" tab opens the store
// on its own kind; the store reopens on the kind last looked at.

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<typeof HermesApi>()),
  getHermesConfigRecord: vi.fn().mockResolvedValue({ mcp_servers: { notes: { command: 'python3' } } }),
  getMcpCatalog: vi.fn().mockResolvedValue({ entries: [], diagnostics: [], hub: null }),
  getSkillHubCatalog: vi.fn().mockResolvedValue({
    skills: [],
    installed: {},
    fetched_at: 1_780_000_000,
    stale: false,
    authenticated: false,
    hub_url: 'https://agenthub.astralx.com.vn',
    error: ''
  }),
  getSkillHubChanges: vi.fn().mockResolvedValue({
    enabled: true,
    configured: true,
    stream: 'off',
    revision: 1,
    last: { status: 'ok', detail: '', at: '' },
    installs: [],
    updates: [],
    history: [],
    workspaces: []
  }),
  getSkills: vi.fn().mockResolvedValue([
    {
      name: 'vneb-report',
      description: 'Weekly report.',
      category: 'productivity',
      enabled: true,
      provenance: 'bundled'
    }
  ]),
  getToolsets: vi.fn().mockResolvedValue([
    {
      name: 'web',
      label: 'Web',
      description: '',
      enabled: true,
      available: true,
      configured: true,
      tools: ['web_search']
    }
  ]),
  getUsageAnalytics: vi.fn().mockResolvedValue({ tools: [] }),
  testMcpServer: vi.fn().mockResolvedValue({ ok: true, tools: [] }),
  tickSkillHub: vi.fn().mockResolvedValue({ status: 'ok', detail: '' })
}))

vi.mock('@/store/notifications', async importOriginal => ({
  ...(await importOriginal<typeof Notifications>()),
  notify: vi.fn(),
  notifyError: vi.fn()
}))

/** Where the page navigated, so a test can read `?tab=`. */
function LocationProbe() {
  const { search } = useLocation()

  return <output data-testid="location">{search}</output>
}

async function renderPage(tab: string) {
  const { SkillsView } = await import('./index')
  await act(async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/skills?tab=${tab}`]}>
          <SkillsView />
          <LocationProbe />
        </MemoryRouter>
      </QueryClientProvider>
    )
  })
}

const tab = (name: string) => screen.getByRole('tab', { name: new RegExp(`^${name}`) })
const segment = (name: string) => within(screen.getByTestId('store-segments')).getByRole('button', { name })

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Object.assign(window, {
    agentxDesktop: {
      ...(window as { agentxDesktop?: object }).agentxDesktop,
      api: vi.fn().mockResolvedValue({ available: false, reason: 'signed_out', endpoints: [], device: null })
    }
  })
})

afterEach(async () => {
  cleanup()
  vi.clearAllMocks()
  queryClient.clear()
  ;(await import('./store')).$storeSegment.set('hub')
})

describe('Kho tiện ích', () => {
  it('opens on the kind a deep link names: the old `?tab=mcp` lands on the store’s MCP', async () => {
    await renderPage('mcp')

    expect(tab('Store').getAttribute('aria-selected')).toBe('true')
    expect(segment('MCP').getAttribute('aria-pressed')).toBe('true')
    expect(await screen.findByTestId('mcp-shelf-connected')).toBeTruthy()
    // The line under the title teaches what this kind is.
    expect(screen.getByText(/MCP connects AgentX to other apps/)).toBeTruthy()
    // The store searches here too.
    expect(screen.getByPlaceholderText('Search MCP connections')).toBeTruthy()
  })

  it('switches kind inside the store, and reopens on the kind last looked at', async () => {
    await renderPage('hub')

    expect(segment('Skills').getAttribute('aria-pressed')).toBe('true')
    expect(await screen.findByTestId('hub-catalog-line')).toBeTruthy()

    await act(async () => {
      fireEvent.click(segment('MCP'))
    })
    expect(screen.getByTestId('location').textContent).toBe('?tab=mcp')
    expect(await screen.findByTestId('mcp-shelf-connected')).toBeTruthy()

    // Away to Tools and back: the store is still on MCP.
    await act(async () => {
      fireEvent.click(tab('Tools'))
    })
    expect(screen.getByTestId('location').textContent).toBe('?tab=toolsets')

    await act(async () => {
      fireEvent.click(tab('Store'))
    })
    expect(screen.getByTestId('location').textContent).toBe('?tab=mcp')
    expect(segment('MCP').getAttribute('aria-pressed')).toBe('true')
  })

  it('each tab of what AgentX has opens the store on its own kind', async () => {
    await renderPage('skills')

    await act(async () => {
      fireEvent.click(await screen.findByTestId('open-store-hub'))
    })
    expect(screen.getByTestId('location').textContent).toBe('?tab=hub')
    expect(segment('Skills').getAttribute('aria-pressed')).toBe('true')

    cleanup()
    await renderPage('toolsets')

    await act(async () => {
      fireEvent.click(await screen.findByTestId('open-store-mcp'))
    })
    expect(screen.getByTestId('location').textContent).toBe('?tab=mcp')
    await waitFor(() => expect(segment('MCP').getAttribute('aria-pressed')).toBe('true'))
  })

  it('a search typed about one kind does not follow the person to the other', async () => {
    await renderPage('hub')

    fireEvent.change(await screen.findByPlaceholderText('Search the skill store'), { target: { value: 'report' } })

    await act(async () => {
      fireEvent.click(segment('MCP'))
    })

    expect((screen.getByPlaceholderText('Search MCP connections') as HTMLInputElement).value).toBe('')
  })
})
