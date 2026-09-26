// @vitest-environment jsdom
import { QueryClientProvider, type UseQueryResult } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as HermesApi from '@/hermes'
import { queryClient } from '@/lib/query-client'
import type * as Notifications from '@/store/notifications'
import { $activeGatewayProfile } from '@/store/profile'
import type { McpCatalogEntry, McpCatalogResponse, SkillHubChangesResponse } from '@/types/hermes'

import type { HubSync } from './hub-status'
import type { McpGatewayListing } from './mcp-model'

// Kho tiện ích → MCP: every connection on this machine on the "Connected"
// shelf — its live state, the one verb that fixes what is wrong, the switch —
// and every one it could add on the shelves under it (the AgentX Hub's, the
// gateway's, AgentX's own). The technical surfaces (mcp.json, the logs) open
// on demand. State is the old connections tab's: whole-map replace, live
// sessions reloaded after each write, probes per exact config.

const getHermesConfigRecord = vi.fn()
const getMcpCatalog = vi.fn()
const testMcpServer = vi.fn()
const saveMcpServers = vi.fn()
const installMcpCatalogEntry = vi.fn()
const removeHubMcpServer = vi.fn()
const getActionStatus = vi.fn()
const getLogs = vi.fn()
const notify = vi.fn()
const notifyError = vi.fn()

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<typeof HermesApi>()),
  getActionStatus: (name: string, lines: number) => getActionStatus(name, lines),
  getHermesConfigRecord: () => getHermesConfigRecord(),
  getLogs: (options: unknown) => getLogs(options),
  getMcpCatalog: (refresh?: boolean) => getMcpCatalog(refresh),
  installMcpCatalogEntry: (id: string, env?: Record<string, string>) => installMcpCatalogEntry(id, env),
  removeHubMcpServer: (slug: string) => removeHubMcpServer(slug),
  saveMcpServers: (servers: unknown) => saveMcpServers(servers),
  testMcpServer: (name: string) => testMcpServer(name)
}))

// The browser sign-in, held open by a test that needs it to land mid-edit.
const completeOAuth = vi.fn()

vi.mock('@/lib/mcp-dashboard-oauth', () => ({
  completeMcpDesktopOAuth: (options: unknown) => completeOAuth(options)
}))

vi.mock('@/store/notifications', async importOriginal => ({
  ...(await importOriginal<typeof Notifications>()),
  notify: (...args: unknown[]) => notify(...args),
  notifyError: (...args: unknown[]) => notifyError(...args)
}))

// CodeMirror measures text with layout APIs jsdom does not have; the editor
// is only the draft's view, so a textarea stands in for it.
vi.mock('@/components/chat/code-editor', () => ({
  CodeEditor: ({ initialValue, onChange }: { initialValue: string; onChange: (value: string) => void }) => (
    <textarea
      aria-label="mcp.json"
      defaultValue={initialValue}
      onChange={event => onChange(event.currentTarget.value)}
    />
  )
}))

const api = vi.fn()
const openExternal = vi.fn()
const request = vi.fn()

function entry(overrides: Partial<McpCatalogEntry> = {}): McpCatalogEntry {
  return {
    name: 'figma',
    description: 'Official Figma remote MCP.',
    source: 'https://figma.com',
    transport: 'http',
    auth_type: 'oauth',
    required_env: [],
    command: null,
    args: [],
    url: 'https://mcp.figma.com/mcp',
    install_url: null,
    install_ref: null,
    bootstrap: [],
    default_enabled: null,
    post_install: '',
    needs_install: false,
    installed: false,
    enabled: false,
    origin: 'official',
    id: 'figma',
    ...overrides
  }
}

function hubEntry(overrides: Partial<McpCatalogEntry> = {}): McpCatalogEntry {
  return entry({
    name: 'tracker',
    description: 'Issues and projects for an agent.',
    source: 'https://hub.test/mcp/servers/tracker',
    transport: 'stdio',
    auth_type: 'api_key',
    required_env: [{ name: 'TRACKER_API_KEY', prompt: 'A Tracker API key', required: true }],
    command: 'npx',
    args: ['-y', '@acme/tracker-mcp@1.4.0'],
    url: null,
    origin: 'hub',
    id: 'agentx-hub/tracker',
    slug: 'tracker',
    version: '1.4.0',
    verified: true,
    trust: 'reviewed',
    verdict: 'safe',
    tools: ['create_issue', 'list_issues'],
    page: 'https://hub.test/mcp/servers/tracker',
    blocked_tools: [],
    ...overrides
  })
}

const HUB: NonNullable<McpCatalogResponse['hub']> = {
  hub_url: 'https://hub.test',
  fetched_at: 1,
  error: '',
  servers: 1,
  signed_in: true
}

function catalog(entries: McpCatalogEntry[], overrides: Partial<McpCatalogResponse> = {}): McpCatalogResponse {
  return { entries, diagnostics: [], hub: HUB, ...overrides }
}

function listing(overrides: Partial<McpGatewayListing> = {}): McpGatewayListing {
  return {
    available: true,
    reason: null,
    session: true,
    endpoints: [],
    device: { entries: 0, token: false, expires_at: null, days_left: null, state: 'none' },
    ...overrides
  }
}

// The configured servers: working, an OAuth one that wants a sign-in, one that
// fails, one switched off. Config order is shelf order.
const SERVERS = {
  'ghi-chu': { command: '/usr/bin/python3', args: ['notes.py'] },
  linear: { url: 'https://mcp.linear.app/mcp', auth: 'oauth' },
  broken: { command: 'nope' },
  archive: { command: 'npx', args: ['-y', 'archive'], enabled: false }
}

const PROBES: Record<string, HermesApi.McpTestResult> = {
  'ghi-chu': {
    ok: true,
    tools: [
      { name: 'search_notes', description: 'Find notes.' },
      { name: 'create_note', description: 'Write one.' },
      { name: 'delete_note', description: 'Remove one.' }
    ]
  },
  linear: { ok: false, error: 'HTTP 401 Unauthorized', tools: [] },
  broken: { ok: false, error: 'spawn nope ENOENT\n    at Process.spawn', tools: [] },
  tracker: { ok: true, tools: [{ name: 'list_issues', description: '' }] },
  'agentx-tracker': { ok: true, tools: [] }
}

const sync: HubSync = {
  changes: {} as UseQueryResult<SkillHubChangesResponse>,
  tick: vi.fn().mockResolvedValue(undefined),
  ticking: false
}

async function storeElement({
  path = '/skills?tab=mcp',
  query = '',
  hubSync = sync
}: { hubSync?: HubSync; path?: string; query?: string } = {}) {
  const { McpStore } = await import('./mcp-store')

  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <McpStore
          gateway={{ request } as unknown as HermesApi.HermesGateway}
          query={query}
          switcher={<span />}
          sync={hubSync}
        />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

async function renderStore(options: { hubSync?: HubSync; path?: string; query?: string } = {}) {
  const element = await storeElement(options)
  let result: ReturnType<typeof render>

  await act(async () => {
    result = render(element)
  })

  return result!
}

async function openEditorFromMenu(): Promise<HTMLElement> {
  fireEvent.pointerDown(await screen.findByTestId('mcp-more'), { button: 0, ctrlKey: false, pointerType: 'mouse' })
  await act(async () => {
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit mcp.json' }))
  })

  return screen.findByTestId('mcp-config-dialog')
}

/** A connection's card, once the config has put it on the shelf. */
async function findCard(server: string): Promise<HTMLElement> {
  await waitFor(() => expect(card(server)).toBeTruthy())

  return card(server)
}

function lastSaved(): Record<string, Record<string, unknown>> {
  return saveMcpServers.mock.calls.at(-1)![0] as Record<string, Record<string, unknown>>
}

/** A promise the test settles by hand. */
function held<T>() {
  let settle!: (value: T) => void
  const promise = new Promise<T>(resolve => (settle = resolve))

  return { promise, settle }
}

/** The cards on one shelf, by the config key / catalog id they carry. */
function shelf(testId: string) {
  return within(screen.getByTestId(testId))
}

function card(server: string): HTMLElement {
  const found = screen.getAllByTestId('mcp-server-card').find(node => node.getAttribute('data-server') === server)

  if (!found) {
    throw new Error(`no card for ${server}`)
  }

  return found
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.releasePointerCapture = vi.fn()
  Object.assign(window, {
    agentxDesktop: { ...(window as { agentxDesktop?: object }).agentxDesktop, api, openExternal }
  })

  getHermesConfigRecord.mockResolvedValue({ mcp_servers: SERVERS })
  getMcpCatalog.mockResolvedValue(
    catalog([
      entry(),
      entry({ name: 'linear', id: 'linear', url: 'https://mcp.linear.app/mcp', installed: true, enabled: true })
    ])
  )
  testMcpServer.mockImplementation(async (name: string) => PROBES[name] ?? { ok: true, tools: [] })
  saveMcpServers.mockResolvedValue({ ok: true })
  installMcpCatalogEntry.mockResolvedValue({ ok: true, name: 'tracker', id: 'agentx-hub/tracker', registered: true })
  removeHubMcpServer.mockResolvedValue({ ok: true, name: 'tracker' })
  getLogs.mockResolvedValue({ lines: [] })
  request.mockResolvedValue({})
  api.mockImplementation(async ({ path }: { path: string }) =>
    path.startsWith('/api/mcp/gateway') ? listing() : Promise.reject(new Error(`unexpected ${path}`))
  )
})

afterEach(async () => {
  cleanup()
  vi.clearAllMocks()
  queryClient.clear()
  // Probe results outlive the component on purpose; each test starts cold.
  ;(await import('./mcp-model')).probeCache.clear()
  $activeGatewayProfile.set('default')
})

describe('McpStore — what is connected', () => {
  it('shelves every connection with what is wrong and the verb that fixes it', async () => {
    await renderStore()

    await waitFor(() =>
      expect(within(card('broken')).getByTestId('mcp-server-status').textContent).toBe('Connection error')
    )
    const connected = shelf('mcp-shelf-connected')
    expect(connected.getAllByTestId('mcp-server-card').map(node => node.getAttribute('data-server'))).toEqual([
      'ghi-chu',
      'linear',
      'broken',
      'archive'
    ])

    // Working: how many tools it gives AgentX, no pill.
    expect(within(card('ghi-chu')).getByTestId('mcp-server-tools').textContent).toBe('3 tools')
    expect(within(card('ghi-chu')).queryByTestId('mcp-server-status')).toBeNull()
    // Wants a sign-in: says so, and offers it (its catalog copy names it).
    expect(within(card('linear')).getByText('Linear', { selector: 'span' })).toBeTruthy()
    expect(within(card('linear')).getByTestId('mcp-server-status').textContent).toBe('Needs sign-in')
    expect(within(card('linear')).getByTestId('mcp-server-sign-in').textContent).toBe('Sign in')
    // Failed: retry.
    expect(within(card('broken')).getByTestId('mcp-server-retry')).toBeTruthy()
    // Off: never probed, said in words.
    expect(within(card('archive')).getByTestId('mcp-server-status').textContent).toBe('Off')
    expect(testMcpServer).not.toHaveBeenCalledWith('archive')
    // Added by hand: its description says so.
    expect(within(card('ghi-chu')).getByText('A connection you added, running on this computer.')).toBeTruthy()

    // The catalog stays put: connected there reads "Connected", the rest "Connect".
    const recommended = shelf('mcp-shelf-catalog')
    const [figma, linear] = recommended.getAllByTestId('mcp-catalog-entry')
    expect(within(figma).getByRole('button', { name: 'Connect' })).toBeTruthy()
    expect(within(linear).getByTestId('mcp-catalog-connected').textContent).toBe('Connected')
    expect(screen.getByTestId('mcp-store-line').textContent).toContain('4 connected · 1 available')
  })

  it('switching one off rewrites the whole map and reloads live sessions', async () => {
    await renderStore()

    await act(async () => {
      fireEvent.click(await screen.findByRole('switch', { name: 'Disable Ghi Chu' }))
    })

    await waitFor(() =>
      expect(saveMcpServers).toHaveBeenCalledWith({ ...SERVERS, 'ghi-chu': { ...SERVERS['ghi-chu'], enabled: false } })
    )
    await waitFor(() => expect(request).toHaveBeenCalledWith('reload.mcp', { confirm: true, session_id: undefined }))
  })

  it('the detail lists the tools, each one a toggle that writes the filter', async () => {
    await renderStore()
    await waitFor(() => expect(within(card('ghi-chu')).getByTestId('mcp-server-tools')).toBeTruthy())

    await act(async () => {
      fireEvent.click(within(card('ghi-chu')).getByTestId('mcp-server-details'))
    })

    const dialog = await screen.findByTestId('mcp-server-detail')
    expect(within(dialog).getByTestId('mcp-server-tools-count').textContent).toBe('3 of 3 on')

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Disable create_note' }))
    })

    await waitFor(() =>
      expect(saveMcpServers).toHaveBeenCalledWith({
        ...SERVERS,
        'ghi-chu': { ...SERVERS['ghi-chu'], tools: { exclude: ['create_note'] } }
      })
    )
  })

  it('a failure says why in one line and offers the retry beside it', async () => {
    await renderStore()
    await waitFor(() => expect(within(card('broken')).getByTestId('mcp-server-retry')).toBeTruthy())

    await act(async () => {
      fireEvent.click(within(card('broken')).getByTestId('mcp-server-details'))
    })

    const problem = within(await screen.findByTestId('mcp-server-detail')).getByTestId('mcp-server-error')
    // The first line of the failure — never the stack under it.
    expect(problem.textContent).toContain('spawn nope ENOENT')
    expect(problem.textContent).not.toContain('Process.spawn')
    testMcpServer.mockClear()

    await act(async () => {
      fireEvent.click(within(problem).getByRole('button', { name: 'Retry' }))
    })

    expect(testMcpServer).toHaveBeenCalledWith('broken')
  })

  it('removing asks first, then writes the map without it', async () => {
    await renderStore()

    await act(async () => {
      fireEvent.click(within(await screen.findByTestId('mcp-shelf-connected')).getAllByTestId('mcp-server-details')[2])
    })
    await act(async () => {
      fireEvent.click(await screen.findByTestId('mcp-server-remove'))
    })

    // The detail closes and the confirmation takes over — one modal at a time.
    const confirm = await screen.findByRole('dialog')
    expect(confirm.textContent).toContain('Remove Broken from AgentX?')
    expect(screen.queryByTestId('mcp-server-detail')).toBeNull()
    expect(saveMcpServers).not.toHaveBeenCalled()
    getMcpCatalog.mockClear()

    await act(async () => {
      fireEvent.click(within(confirm).getByRole('button', { name: 'Remove connection' }))
    })

    const { broken: _gone, ...rest } = SERVERS
    await waitFor(() => expect(saveMcpServers).toHaveBeenCalledWith(rest))
    // Which servers exist changed: the catalogue's "Connected" pills are asked again.
    await waitFor(() => expect(getMcpCatalog).toHaveBeenCalled())
  })

  it('a command-palette jump opens that connection’s detail', async () => {
    await renderStore({ path: '/skills?tab=mcp&server=linear' })

    const dialog = await screen.findByTestId('mcp-server-detail')
    expect(within(dialog).getByText('Linear', { selector: 'span' })).toBeTruthy()
    expect(within(dialog).getByTestId('mcp-server-auth').textContent).toContain('Linear needs you to sign in')
  })
})

describe('McpStore — what can be added', () => {
  it('connecting from the Hub asks for the values it needs first, then installs by the hub id', async () => {
    getMcpCatalog.mockResolvedValue(catalog([hubEntry()]))
    installMcpCatalogEntry.mockResolvedValue({ ok: true, name: 'tracker', id: 'agentx-hub/tracker', registered: false })
    await renderStore()

    const hubCard = await within(await screen.findByTestId('mcp-hub-catalog')).findByTestId('mcp-hub-entry')
    expect(within(hubCard).getByText('Reviewed')).toBeTruthy()
    expect(within(hubCard).getByText('Needs an API key')).toBeTruthy()
    expect(within(hubCard).getByText('Runs on this computer')).toBeTruthy()

    await act(async () => {
      fireEvent.click(within(hubCard).getByRole('button', { name: 'Connect' }))
    })
    expect(installMcpCatalogEntry).not.toHaveBeenCalled()
    const field = within(hubCard).getByLabelText(/A Tracker API key/)
    expect(field.getAttribute('type')).toBe('password')
    expect(within(hubCard).getByText('TRACKER_API_KEY')).toBeTruthy()

    fireEvent.change(field, { target: { value: 'secret' } })
    getHermesConfigRecord.mockClear()

    await act(async () => {
      fireEvent.click(within(hubCard).getByRole('button', { name: 'Connect' }))
    })

    await waitFor(() =>
      expect(installMcpCatalogEntry).toHaveBeenCalledWith('agentx-hub/tracker', { TRACKER_API_KEY: 'secret' })
    )
    // The new server lands on the "Connected" shelf: config and catalog are asked again.
    await waitFor(() => expect(getHermesConfigRecord).toHaveBeenCalled())
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'success',
        title: 'Tracker connected.',
        message: expect.stringContaining('AgentX Hub')
      })
    )
  })

  it('a connected hub server updates in place; one edited here is replaced only after a confirmation', async () => {
    getHermesConfigRecord.mockResolvedValue({ mcp_servers: { tracker: { command: 'npx', args: ['-y', 'x'] } } })
    getMcpCatalog.mockResolvedValue(
      catalog([
        hubEntry({
          installed: true,
          enabled: true,
          installed_version: '1.3.0',
          update_available: true,
          version: '1.5.0'
        })
      ])
    )
    await renderStore()

    const connected = await screen.findByTestId('mcp-shelf-connected')
    await waitFor(() => expect(within(connected).getByTestId('mcp-server-update')).toBeTruthy())
    expect(within(card('tracker')).getByText('AgentX Hub · v1.3.0')).toBeTruthy()
    expect(within(card('tracker')).getByTestId('mcp-server-update-available').textContent).toBe(
      'Update 1.5.0 available'
    )
    // On the hub's shelf the same server reads as connected, and nothing more.
    expect(within(screen.getByTestId('mcp-hub-catalog')).getByTestId('mcp-catalog-connected')).toBeTruthy()

    await act(async () => {
      fireEvent.click(within(connected).getByTestId('mcp-server-update'))
    })
    await waitFor(() => expect(installMcpCatalogEntry).toHaveBeenCalledWith('agentx-hub/tracker', {}))

    cleanup()
    installMcpCatalogEntry.mockClear()
    queryClient.clear()
    getMcpCatalog.mockResolvedValue(
      catalog([hubEntry({ installed: true, enabled: true, update_available: true, version: '1.5.0', modified: true })])
    )
    await renderStore()

    await waitFor(() => expect(within(card('tracker')).getByText('Edited here')).toBeTruthy())
    expect(within(card('tracker')).queryByTestId('mcp-server-update')).toBeNull()

    await act(async () => {
      fireEvent.click(within(card('tracker')).getByTestId('mcp-server-details'))
    })
    await act(async () => {
      fireEvent.click(
        within(await screen.findByTestId('mcp-server-detail')).getByRole('button', {
          name: 'Replace with the Hub version…'
        })
      )
    })

    const confirm = await screen.findByRole('dialog')
    expect(confirm.textContent).toContain('Replace Tracker with the version from the AgentX Hub?')
    expect(installMcpCatalogEntry).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(within(confirm).getByRole('button', { name: 'Replace with the Hub version' }))
    })
    await waitFor(() => expect(installMcpCatalogEntry).toHaveBeenCalledWith('agentx-hub/tracker', {}))
  })

  it('a hub server leaves through the hub, so the hub hears it', async () => {
    getHermesConfigRecord.mockResolvedValue({ mcp_servers: { tracker: { command: 'npx' } } })
    getMcpCatalog.mockResolvedValue(
      catalog([hubEntry({ installed: true, enabled: true, blocked_tools: ['create_issue'] })])
    )
    await renderStore()

    await waitFor(() =>
      expect(within(card('tracker')).getByTestId('mcp-hub-blocked').textContent).toBe('1 tool blocked')
    )

    await act(async () => {
      fireEvent.click(within(card('tracker')).getByTestId('mcp-server-details'))
    })
    expect(
      within(await screen.findByTestId('mcp-server-detail')).getByTestId('mcp-hub-blocked-detail').textContent
    ).toContain('create_issue')
    await act(async () => {
      fireEvent.click(screen.getByTestId('mcp-server-remove'))
    })
    await act(async () => {
      fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove connection' }))
    })

    await waitFor(() => expect(removeHubMcpServer).toHaveBeenCalledWith('tracker'))
    expect(saveMcpServers).not.toHaveBeenCalled()
  })

  it('never installs over a name another server holds', async () => {
    getMcpCatalog.mockResolvedValue(catalog([hubEntry({ name_taken: true })]))
    await renderStore()

    const hubCard = await screen.findByTestId('mcp-hub-entry')
    expect(within(hubCard).getByText('Another server uses this name here.')).toBeTruthy()
    expect((within(hubCard).getByRole('button', { name: 'Connect' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('says what the hub has to say: signed out, out of reach, servers Workmate cannot run', async () => {
    getMcpCatalog.mockResolvedValue(
      catalog([], {
        hub: { ...HUB, signed_in: false, error: 'could not reach the hub' },
        diagnostics: [
          { name: 'agentx-hub/a', kind: 'hub_unsupported', message: '' },
          { name: 'agentx-hub/b', kind: 'hub_unsupported', message: '' }
        ]
      })
    )
    await renderStore()

    expect((await screen.findByTestId('mcp-hub-signin')).textContent).toContain('Sign in to AgentX')
    expect(screen.getByTestId('mcp-hub-offline').textContent).toContain('could not be reached')
    expect(screen.getByText(/2 Hub servers cannot run in Workmate/)).toBeTruthy()
    expect(screen.getByTestId('mcp-hub-state').textContent).toBe('Unreachable')
  })

  it('says the hub signs with a key this machine does not trust, and how to trust it', async () => {
    getMcpCatalog.mockResolvedValue(
      catalog([], {
        hub: {
          ...HUB,
          error: 'the feed is signed with a key this machine does not trust',
          notices: [{ code: 'hub_key_untrusted', kid: 'k9' }]
        }
      })
    )
    await renderStore()

    const warning = (await screen.findByTestId('mcp-hub-key-untrusted')).textContent ?? ''
    expect(warning).toContain('k9')
    expect(warning).toContain('agentx mcp hub-keys --reset')
    // The hub answered: it is not out of reach.
    expect(screen.queryByTestId('mcp-hub-offline')).toBeNull()
    expect(screen.getByTestId('mcp-hub-state').textContent).toBe('Untrusted signing key')
  })
  it('asks the catalogue again once a tick lands, when it answered "signed out" before the bearer arrived', async () => {
    getMcpCatalog.mockResolvedValue(catalog([], { hub: { ...HUB, signed_in: false } }))
    const { rerender } = await renderStore()
    expect(await screen.findByTestId('mcp-hub-signin')).toBeTruthy()

    // The store's first tick hands the backend the bearer.
    getMcpCatalog.mockResolvedValue(catalog([hubEntry()]))
    const ticking = await storeElement({ hubSync: { ...sync, ticking: true } })
    await act(async () => {
      rerender(ticking)
    })
    const ticked = await storeElement({ hubSync: { ...sync, ticking: false } })
    await act(async () => {
      rerender(ticked)
    })

    expect(await screen.findByTestId('mcp-hub-entry')).toBeTruthy()
    expect(screen.queryByTestId('mcp-hub-signin')).toBeNull()
  })
})

describe('McpStore — the AgentX Gateway', () => {
  it('lists the endpoints, connects one in a click, and marks what is already here', async () => {
    let added: null | string = null

    api.mockImplementation(async (req: { path: string; method?: string; body?: unknown }) => {
      if (req.path === '/api/mcp/gateway') {
        return listing({
          endpoints: [
            {
              kind: 'server',
              ref: 'tracker',
              label: 'Tracker',
              url: 'https://hub.test/gw/s/tracker',
              status: 'ready',
              tools: 4,
              added
            },
            {
              kind: 'toolset',
              ref: 'ts_1',
              label: 'Dự án',
              url: 'https://hub.test/gw/t/ts_1',
              status: 'needs_connection',
              tools: 0,
              added: null
            }
          ],
          device: added
            ? { entries: 1, token: true, expires_at: '2026-12-24T00:00:00Z', days_left: 89, state: 'ok' }
            : { entries: 0, token: false, expires_at: null, days_left: null, state: 'none' }
        })
      }

      if (req.path === '/api/mcp/gateway/add') {
        added = 'agentx-tracker'

        return { ok: true, name: 'agentx-tracker', url: 'https://hub.test/gw/s/tracker' }
      }

      throw new Error(`unexpected ${req.path}`)
    })
    await renderStore()

    const gatewayShelf = await screen.findByTestId('mcp-gateway')
    const endpoints = within(gatewayShelf).getAllByTestId('mcp-gateway-endpoint')
    expect(endpoints.map(node => node.getAttribute('data-ref'))).toEqual(['tracker', 'ts_1'])
    expect(within(endpoints[0]).getByText('4 tools')).toBeTruthy()
    expect(within(endpoints[1]).getByText('Connect it on the hub')).toBeTruthy()
    expect(within(endpoints[1]).getByText('Toolset')).toBeTruthy()

    getHermesConfigRecord.mockResolvedValue({
      mcp_servers: { ...SERVERS, 'agentx-tracker': { url: 'https://hub.test/gw/s/tracker' } }
    })

    await act(async () => {
      fireEvent.click(within(endpoints[0]).getByRole('button', { name: 'Connect' }))
    })

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        expect.objectContaining({
          path: '/api/mcp/gateway/add',
          method: 'POST',
          body: { kind: 'server', ref: 'tracker' }
        })
      )
    )
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'success', title: 'Tracker connected through the gateway' })
    )
    // It joins "Connected" as a gateway connection, under its own name…
    await waitFor(() => expect(within(card('agentx-tracker')).getByText('Tracker', { selector: 'span' })).toBeTruthy())
    expect(within(card('agentx-tracker')).getByText('AgentX Gateway')).toBeTruthy()
    // …and its endpoint reads as connected, with how long this machine's token lasts.
    await waitFor(() =>
      expect(within(screen.getAllByTestId('mcp-gateway-endpoint')[0]).getByText('Connected')).toBeTruthy()
    )
    expect(screen.getByTestId('mcp-gateway-token').textContent).toContain('89 more days')
  })

  it('asks for a new sign-in when the token lapsed and nothing here renews it', async () => {
    api.mockResolvedValue(
      listing({
        session: false,
        device: { entries: 1, token: true, expires_at: '2026-09-01T00:00:00Z', days_left: 0, state: 'expired' }
      })
    )
    await renderStore()

    expect((await screen.findByTestId('mcp-gateway-signin')).textContent).toContain('sign in to AgentX again')
  })

  it('stays away from every profile but the default one', async () => {
    $activeGatewayProfile.set('work')
    await renderStore()

    await screen.findByTestId('mcp-shelf-connected')
    expect(api).not.toHaveBeenCalled()
    expect(screen.queryByTestId('mcp-gateway')).toBeNull()
  })
})

describe('McpStore — mcp.json and search', () => {
  it('"Add by hand" opens mcp.json with a starter entry; saving writes the whole document', async () => {
    await renderStore()

    await act(async () => {
      fireEvent.click(await screen.findByTestId('mcp-add-manual'))
    })

    const dialog = await screen.findByTestId('mcp-config-dialog')
    expect(within(dialog).getByText('Advanced configuration (mcp.json)')).toBeTruthy()
    // The whole document, every server kept, the starter entry last.
    const doc = JSON.parse((within(dialog).getByLabelText('mcp.json') as HTMLTextAreaElement).value)
    expect(Object.keys(doc.mcpServers)).toEqual([...Object.keys(SERVERS), 'my-server'])

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    })

    await waitFor(() =>
      expect(saveMcpServers).toHaveBeenCalledWith({
        ...SERVERS,
        'my-server': { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/dir'] }
      })
    )
    await waitFor(() => expect(screen.queryByTestId('mcp-config-dialog')).toBeNull())
  })

  it('leaving with unsaved edits asks first; discarding leaves nothing behind', async () => {
    await renderStore()

    await act(async () => {
      fireEvent.click(await screen.findByTestId('mcp-add-manual'))
    })
    const dialog = await screen.findByTestId('mcp-config-dialog')

    await act(async () => {
      fireEvent.keyDown(dialog, { key: 'Escape' })
    })

    // Still open, now asking.
    expect(within(dialog).getByTestId('mcp-config-discard').textContent).toBe('Discard unsaved changes?')

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Discard' }))
    })
    await waitFor(() => expect(screen.queryByTestId('mcp-config-dialog')).toBeNull())

    // Reopened from ⋯, the document is the config again: nothing to save.
    const more = screen.getByTestId('mcp-more')
    fireEvent.pointerDown(more, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    await act(async () => {
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit mcp.json' }))
    })

    const reopened = await screen.findByTestId('mcp-config-dialog')
    expect((within(reopened).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
    expect(saveMcpServers).not.toHaveBeenCalled()
  })

  it('saves what was typed, and refuses a document that is not JSON', async () => {
    await renderStore()

    fireEvent.pointerDown(await screen.findByTestId('mcp-more'), { button: 0, ctrlKey: false, pointerType: 'mouse' })
    await act(async () => {
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit mcp.json' }))
    })

    const dialog = await screen.findByTestId('mcp-config-dialog')
    const editor = within(dialog).getByLabelText('mcp.json')

    fireEvent.change(editor, {
      target: { value: '{"mcpServers": {"only": {"url": "https://only.test", "type": "http"' }
    })
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    })

    expect(notifyError).toHaveBeenCalledWith(expect.anything(), 'Invalid MCP JSON')
    expect(saveMcpServers).not.toHaveBeenCalled()

    fireEvent.change(editor, {
      target: { value: '{"mcpServers": {"only": {"url": "https://only.test", "type": "http"}}}' }
    })
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    })

    // Pasted `type` is stored as AgentX's `transport`; everything not in the document is gone.
    await waitFor(() =>
      expect(saveMcpServers).toHaveBeenCalledWith({ only: { url: 'https://only.test', transport: 'http' } })
    )
  })

  it('a search narrows every shelf, and says so when nothing matches', async () => {
    const { rerender } = await renderStore({ query: 'lin' })

    await waitFor(() => expect(screen.getAllByTestId('mcp-server-card')).toHaveLength(1))
    expect(card('linear')).toBeTruthy()
    expect(within(screen.getByTestId('mcp-shelf-catalog')).getAllByTestId('mcp-catalog-entry')).toHaveLength(1)

    const next = await storeElement({ query: 'zzz' })
    await act(async () => {
      rerender(next)
    })

    expect(await screen.findByText('No connections found')).toBeTruthy()
    expect(screen.getByText('Nothing matches “zzz”.')).toBeTruthy()
  })

  it('"Sync now" ticks, fetches the hub feed now, and asks the config again', async () => {
    await renderStore()
    await screen.findByTestId('mcp-shelf-connected')
    getHermesConfigRecord.mockClear()

    await act(async () => {
      fireEvent.click(screen.getByTestId('mcp-sync'))
    })

    await waitFor(() => expect(getMcpCatalog).toHaveBeenCalledWith(true))
    expect(sync.tick).toHaveBeenCalledWith(false)
    await waitFor(() => expect(getHermesConfigRecord).toHaveBeenCalled())
  })
})

describe('McpStore — work that overlaps (review regressions)', () => {
  it('mcp.json cannot be opened before the config has loaded — a save of the empty map would remove every server', async () => {
    getHermesConfigRecord.mockImplementation(() => new Promise(() => {}))
    await renderStore()

    fireEvent.pointerDown(await screen.findByTestId('mcp-more'), { button: 0, ctrlKey: false, pointerType: 'mouse' })
    const item = await screen.findByRole('menuitem', { name: 'Edit mcp.json' })
    expect(item.getAttribute('aria-disabled')).toBe('true')

    await act(async () => {
      fireEvent.click(item)
    })
    expect(screen.queryByTestId('mcp-config-dialog')).toBeNull()
    expect(saveMcpServers).not.toHaveBeenCalled()
  })

  it('a connect that lands while mcp.json has unsaved edits survives the save', async () => {
    const install = held<unknown>()
    installMcpCatalogEntry.mockImplementation(() => install.promise)
    await renderStore()

    await act(async () => {
      fireEvent.click(within(await screen.findByTestId('mcp-shelf-catalog')).getByRole('button', { name: 'Connect' }))
    })
    expect(installMcpCatalogEntry).toHaveBeenCalledWith('figma', {})

    const dialog = await openEditorFromMenu()
    fireEvent.change(within(dialog).getByLabelText('mcp.json'), {
      target: { value: JSON.stringify({ mcpServers: { ...SERVERS, broken: { command: 'fixed' } } }) }
    })

    // The install lands: the backend now has figma.
    getHermesConfigRecord.mockResolvedValue({
      mcp_servers: { ...SERVERS, figma: { url: 'https://mcp.figma.com/mcp' } }
    })
    await act(async () => install.settle({ ok: true, name: 'figma', id: 'figma', registered: true }))
    await waitFor(() => expect(card('figma')).toBeTruthy())

    await act(async () => {
      fireEvent.click(within(screen.getByTestId('mcp-config-dialog')).getByRole('button', { name: 'Save' }))
    })

    await waitFor(() => expect(saveMcpServers).toHaveBeenCalled())
    // The person's edit and the install, both.
    expect(lastSaved().broken).toEqual({ command: 'fixed' })
    expect(lastSaved().figma).toEqual({ url: 'https://mcp.figma.com/mcp' })
  })

  it('a sign-in that lands while mcp.json has unsaved edits keeps its `auth: oauth`', async () => {
    const signIn = held<unknown>()
    completeOAuth.mockImplementation(() => signIn.promise)
    await renderStore()

    const signInButton = await within(await findCard('linear')).findByTestId('mcp-server-sign-in')

    await act(async () => {
      fireEvent.click(signInButton)
    })
    expect(completeOAuth).toHaveBeenCalled()

    const dialog = await openEditorFromMenu()
    fireEvent.change(within(dialog).getByLabelText('mcp.json'), {
      target: { value: JSON.stringify({ mcpServers: { ...SERVERS, broken: { command: 'fixed' } } }) }
    })

    await act(async () =>
      signIn.settle({
        flow_id: 'f',
        server_name: 'linear',
        status: 'approved',
        authorization_url: null,
        error: null,
        tools: []
      })
    )

    await act(async () => {
      fireEvent.click(within(screen.getByTestId('mcp-config-dialog')).getByRole('button', { name: 'Save' }))
    })

    await waitFor(() => expect(saveMcpServers).toHaveBeenCalled())
    expect(lastSaved().linear).toEqual({ url: 'https://mcp.linear.app/mcp', auth: 'oauth' })
    expect(lastSaved().broken).toEqual({ command: 'fixed' })
  })

  it('a switch flipped while the browser sign-in is open is not undone when it lands', async () => {
    const signIn = held<unknown>()
    completeOAuth.mockImplementation(() => signIn.promise)
    await renderStore()

    const signInButton = await within(await findCard('linear')).findByTestId('mcp-server-sign-in')

    await act(async () => {
      fireEvent.click(signInButton)
    })
    await act(async () => {
      fireEvent.click(within(card('ghi-chu')).getByRole('switch'))
    })
    await waitFor(() => expect(lastSaved()['ghi-chu']).toEqual({ ...SERVERS['ghi-chu'], enabled: false }))

    await act(async () =>
      signIn.settle({
        flow_id: 'f',
        server_name: 'linear',
        status: 'approved',
        authorization_url: null,
        error: null,
        tools: []
      })
    )

    // The card still reads off: the sign-in merged into the config as it is now.
    await waitFor(() => expect(within(card('linear')).queryByTestId('mcp-server-status')).toBeNull())
    expect(within(card('ghi-chu')).getByTestId('mcp-server-status').textContent).toBe('Off')
  })

  it('two quick switches both land — the second is built on the first', async () => {
    const first = held<{ ok: boolean }>()
    saveMcpServers.mockImplementationOnce(() => first.promise)
    await renderStore()
    await screen.findByTestId('mcp-shelf-connected')

    await act(async () => {
      fireEvent.click(within(card('ghi-chu')).getByRole('switch'))
      fireEvent.click(within(card('broken')).getByRole('switch'))
    })

    // The second write waits for the first…
    expect(saveMcpServers).toHaveBeenCalledTimes(1)
    await act(async () => first.settle({ ok: true }))

    // …then writes both switches, not a map from before the first.
    await waitFor(() => expect(saveMcpServers).toHaveBeenCalledTimes(2))
    expect(lastSaved()['ghi-chu'].enabled).toBe(false)
    expect(lastSaved().broken.enabled).toBe(false)
  })

  it('a command-palette jump opens the detail once, even when a search hides its card', async () => {
    await renderStore({ path: '/skills?tab=mcp&server=linear', query: 'ghi' })

    const detail = await screen.findByTestId('mcp-server-detail')
    expect(within(detail).getByText('Linear', { selector: 'span' })).toBeTruthy()

    await act(async () => {
      fireEvent.keyDown(detail, { key: 'Escape' })
    })
    await waitFor(() => expect(screen.queryByTestId('mcp-server-detail')).toBeNull())

    // A later write (and the config change it brings) must not reopen it.
    await act(async () => {
      fireEvent.click(within(card('ghi-chu')).getByRole('switch'))
    })
    await waitFor(() => expect(saveMcpServers).toHaveBeenCalled())
    expect(screen.queryByTestId('mcp-server-detail')).toBeNull()
  })

  it('the catalogue is asked again once the first tick ends, even when its first answer lands after', async () => {
    const answer = held<McpCatalogResponse>()
    getMcpCatalog.mockImplementationOnce(() => answer.promise)
    const { rerender } = await renderStore()

    // What the backend answers once it holds the bearer.
    getMcpCatalog.mockResolvedValue(catalog([hubEntry()]))

    const ticking = await storeElement({ hubSync: { ...sync, ticking: true } })
    await act(async () => rerender(ticking))
    const ticked = await storeElement({ hubSync: { ...sync, ticking: false } })
    await act(async () => rerender(ticked))

    // The answer taken before the bearer arrived lands after the tick ended.
    await act(async () => answer.settle(catalog([], { hub: { ...HUB, signed_in: false } })))

    expect(await screen.findByTestId('mcp-hub-entry')).toBeTruthy()
    expect(screen.queryByTestId('mcp-hub-signin')).toBeNull()

    // Once per store: the next tick asks nothing more.
    const asked = getMcpCatalog.mock.calls.length
    await act(async () => rerender(await storeElement({ hubSync: { ...sync, ticking: true } })))
    await act(async () => rerender(await storeElement({ hubSync: { ...sync, ticking: false } })))
    expect(getMcpCatalog.mock.calls.length).toBe(asked)
  })

  it('an update checks the connection again — the old tool list is not the new version’s', async () => {
    getHermesConfigRecord.mockResolvedValue({ mcp_servers: { tracker: { command: 'npx', args: ['-y', 'x@1.3.0'] } } })
    getMcpCatalog.mockResolvedValue(
      catalog([
        hubEntry({
          installed: true,
          enabled: true,
          installed_version: '1.3.0',
          update_available: true,
          version: '1.5.0'
        })
      ])
    )
    await renderStore()
    await waitFor(() => expect(within(card('tracker')).getByTestId('mcp-server-update')).toBeTruthy())
    expect(testMcpServer).toHaveBeenCalledTimes(1)

    getHermesConfigRecord.mockResolvedValue({ mcp_servers: { tracker: { command: 'npx', args: ['-y', 'x@1.5.0'] } } })
    await act(async () => {
      fireEvent.click(within(card('tracker')).getByTestId('mcp-server-update'))
    })

    await waitFor(() => expect(testMcpServer).toHaveBeenCalledTimes(2))
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success', title: 'Tracker updated.' }))
  })

  it('a key the server refused says so — signing in is not the fix', async () => {
    getHermesConfigRecord.mockResolvedValue({
      mcp_servers: { keyed: { url: 'https://keyed.test/mcp', headers: { Authorization: 'Bearer k' } } }
    })
    testMcpServer.mockResolvedValue({ ok: false, error: 'HTTP 401 Unauthorized', tools: [] })
    await renderStore()

    await waitFor(() => expect(within(card('keyed')).getByTestId('mcp-server-status').textContent).toBe('Key refused'))
    expect(within(card('keyed')).queryByTestId('mcp-server-sign-in')).toBeNull()
  })

  it('connecting an OAuth server says the sign-in is still to come', async () => {
    await renderStore()

    await act(async () => {
      fireEvent.click(within(await screen.findByTestId('mcp-shelf-catalog')).getByRole('button', { name: 'Connect' }))
    })

    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Figma added. Press Sign in on its card to start using it.' })
      )
    )
  })

  it('says when the hub answered the gateway list with an error', async () => {
    api.mockResolvedValue(
      listing({
        available: false,
        reason: 'error',
        error: { ok: false, status: 'error', code: 'boom', detail: 'the gateway is down' }
      })
    )
    await renderStore()

    expect((await screen.findByTestId('mcp-gateway-failed')).textContent).toBe(
      'The AgentX Gateway list could not be loaded: the gateway is down'
    )
  })

  it('the detail holds focus itself: no tool chip lit up, no tooltip, before anyone asks', async () => {
    await renderStore()
    await waitFor(() => expect(within(card('ghi-chu')).getByTestId('mcp-server-tools')).toBeTruthy())

    await act(async () => {
      fireEvent.click(within(card('ghi-chu')).getByTestId('mcp-server-details'))
    })

    const detail = await screen.findByTestId('mcp-server-detail')
    await waitFor(() => expect(detail.ownerDocument.activeElement).toBe(detail))
  })
})
