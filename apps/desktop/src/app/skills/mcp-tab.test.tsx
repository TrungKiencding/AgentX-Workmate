// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as HermesApi from '@/hermes'
import type { McpCatalogEntry, McpCatalogResponse } from '@/types/hermes'

// The MCP tab's catalog (Agent Hub P3.12): the person's AgentX Hub servers
// above the shipped ones — what the hub vouches for, what this machine runs
// of each (the version, an update, the tools kept off) — and the verbs:
// install (by `agentx-hub/<slug>`, values typed here), update, replace a copy
// edited here (after a confirmation), remove, open on the Hub.

const installMcpCatalogEntry = vi.fn()
const removeHubMcpServer = vi.fn()
const notify = vi.fn()
const notifyError = vi.fn()

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<typeof HermesApi>()),
  installMcpCatalogEntry: (id: string, env?: Record<string, string>) => installMcpCatalogEntry(id, env),
  removeHubMcpServer: (slug: string) => removeHubMcpServer(slug)
}))

vi.mock('@/store/notifications', () => ({
  notify: (...args: unknown[]) => notify(...args),
  notifyError: (...args: unknown[]) => notifyError(...args)
}))

const openExternal = vi.fn()

function hubEntry(overrides: Partial<McpCatalogEntry> = {}): McpCatalogEntry {
  return {
    name: 'linear',
    description: 'Linear issues and projects for an agent.',
    source: 'https://hub.test/mcp/servers/linear',
    transport: 'stdio',
    auth_type: 'api_key',
    required_env: [{ name: 'LINEAR_API_KEY', prompt: 'A Linear API key', required: true }],
    command: 'npx',
    args: ['-y', '@acme/linear-mcp@1.4.0'],
    url: null,
    install_url: null,
    install_ref: null,
    bootstrap: [],
    default_enabled: ['list_issues'],
    post_install: '',
    needs_install: false,
    installed: false,
    enabled: false,
    origin: 'hub',
    id: 'agentx-hub/linear',
    slug: 'linear',
    version: '1.4.0',
    verified: true,
    trust: 'reviewed',
    verdict: 'safe',
    tools: ['create_issue', 'list_issues'],
    page: 'https://hub.test/mcp/servers/linear',
    blocked_tools: [],
    ...overrides
  }
}

const shipped: McpCatalogEntry = {
  ...hubEntry(),
  name: 'figma',
  description: 'Figma designs.',
  origin: 'official',
  id: 'figma',
  slug: undefined,
  version: undefined,
  verified: undefined,
  trust: undefined,
  tools: undefined,
  page: undefined,
  required_env: []
}

const HUB: NonNullable<McpCatalogResponse['hub']> = {
  hub_url: 'https://hub.test',
  fetched_at: 1,
  error: '',
  servers: 1,
  signed_in: true
}

async function renderCatalog(entries: McpCatalogEntry[], hub: McpCatalogResponse['hub'] = HUB, unsupported = 0) {
  const { McpCatalog } = await import('./mcp-tab')
  const onInstalled = vi.fn()
  await act(async () => {
    render(
      <McpCatalog entries={entries} hub={hub} loading={false} onInstalled={onInstalled} unsupported={unsupported} />
    )
  })

  return { onInstalled }
}

beforeEach(() => {
  installMcpCatalogEntry.mockResolvedValue({
    ok: true,
    name: 'linear',
    id: 'agentx-hub/linear',
    background: false,
    registered: true
  })
  removeHubMcpServer.mockResolvedValue({ ok: true, name: 'linear' })
  Object.assign(window, { agentxDesktop: { ...(window as { agentxDesktop?: object }).agentxDesktop, openExternal } })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('McpCatalog — AgentX Hub', () => {
  it('lists the hub’s servers above the shipped ones, with what the hub vouches for', async () => {
    await renderCatalog([hubEntry({ verdict: 'caution', blocked_tools: ['create_issue'] }), shipped])
    const section = screen.getByTestId('mcp-hub-catalog')
    const card = within(section).getByTestId('mcp-hub-entry')
    expect(card.getAttribute('data-hub-slug')).toBe('linear')

    for (const text of ['Verified', 'Reviewed', 'v1.4.0', 'Scan: caution']) {
      expect(within(card).getByText(text)).toBeTruthy()
    }

    expect(within(card).getByTestId('mcp-hub-blocked').textContent).toContain('1 tool blocked: create_issue')
    // the shipped entry is not in the hub section
    expect(within(section).queryByText('Figma')).toBeNull()
    expect(screen.getAllByText('Figma').length).toBeGreaterThan(0)

    fireEvent.click(within(card).getByRole('button', { name: /Open on the Hub/ }))
    expect(openExternal).toHaveBeenCalledWith('https://hub.test/mcp/servers/linear')
  })

  it('installs by the hub id with the values typed here, and says when the hub is told later', async () => {
    installMcpCatalogEntry.mockResolvedValue({
      ok: true,
      name: 'linear',
      id: 'agentx-hub/linear',
      background: false,
      registered: false
    })
    const { onInstalled } = await renderCatalog([hubEntry()])
    const card = screen.getByTestId('mcp-hub-entry')

    // the first click asks for the values
    await act(async () => {
      fireEvent.click(within(card).getByRole('button', { name: 'Install' }))
    })
    expect(installMcpCatalogEntry).not.toHaveBeenCalled()
    const input = card.querySelector('input[type="password"]') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'lin-value' } })
    await act(async () => {
      fireEvent.click(within(card).getByRole('button', { name: 'Install' }))
    })

    await waitFor(() =>
      expect(installMcpCatalogEntry).toHaveBeenCalledWith('agentx-hub/linear', { LINEAR_API_KEY: 'lin-value' })
    )
    expect(onInstalled).toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'success',
        message: 'Installed. The AgentX Hub is told as soon as it can be reached.'
      })
    )
  })

  it('updates an installed server without asking its values again', async () => {
    await renderCatalog([
      hubEntry({ installed: true, enabled: true, installed_version: '1.3.0', update_available: true, version: '1.5.0' })
    ])
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Update to 1.5.0' }))
    })
    await waitFor(() => expect(installMcpCatalogEntry).toHaveBeenCalledWith('agentx-hub/linear', {}))
  })

  it('replaces a copy edited here only after a confirmation', async () => {
    await renderCatalog([hubEntry({ installed: true, enabled: true, modified: true })])
    expect(screen.getByText('Edited on this machine: the Hub does not overwrite it.')).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Replace with the Hub version…' }))
    })
    expect(installMcpCatalogEntry).not.toHaveBeenCalled()
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('Replace linear with the version from the AgentX Hub?')
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Replace with the Hub version' }))
    })
    await waitFor(() => expect(installMcpCatalogEntry).toHaveBeenCalledWith('agentx-hub/linear', {}))
  })

  it('removes a hub server here', async () => {
    const { onInstalled } = await renderCatalog([hubEntry({ installed: true, enabled: true })])
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    })
    await waitFor(() => expect(removeHubMcpServer).toHaveBeenCalledWith('linear'))
    expect(onInstalled).toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'linear removed. The AgentX Hub hears it on the next sync.' })
    )
  })

  it('says why the hub lists nothing: signed out, offline, servers Workmate cannot run', async () => {
    await renderCatalog([], { ...HUB, signed_in: false, error: 'could not reach the hub' }, 2)
    expect(screen.getByTestId('mcp-hub-signin').textContent).toContain('Sign in to AgentX Hub')
    expect(screen.getByTestId('mcp-hub-offline').textContent).toContain('could not be reached')
    expect(screen.getByText(/2 Hub servers cannot run in Workmate/)).toBeTruthy()
  })

  it('shows no hub section outside the default profile, and never installs over a name another server holds', async () => {
    await renderCatalog([shipped], null)
    expect(screen.queryByTestId('mcp-hub-catalog')).toBeNull()
    cleanup()
    await renderCatalog([hubEntry({ name_taken: true })])
    expect(screen.getByText('Another server uses this name here.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Install' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
