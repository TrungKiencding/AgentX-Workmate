// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type * as ReactRouterDom from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as HermesApi from '@/hermes'
import { queryClient } from '@/lib/query-client'
import type * as Notifications from '@/store/notifications'
import type { SkillHubCatalogResponse, SkillHubResult, SkillInfo } from '@/types/hermes'

const getSkillHubCatalog = vi.fn()
const getSkillHubChanges = vi.fn()
const getSkills = vi.fn()
const tickSkillHub = vi.fn()
const searchSkillsHub = vi.fn()
const installSkillFromHub = vi.fn()
const previewSkillHub = vi.fn()
const uninstallSkillFromHub = vi.fn()
const setSkillEnabled = vi.fn()
const getActionStatus = vi.fn()
const requestComposerInsert = vi.fn()

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<typeof HermesApi>()),
  getActionStatus: (name: string) => getActionStatus(name),
  getSkillHubCatalog: (refresh?: boolean) => getSkillHubCatalog(refresh),
  getSkillHubChanges: () => getSkillHubChanges(),
  getSkills: () => getSkills(),
  installSkillFromHub: (identifier: string) => installSkillFromHub(identifier),
  previewSkillHub: (identifier: string) => previewSkillHub(identifier),
  searchSkillsHub: (query: string, source: string) => searchSkillsHub(query, source),
  setSkillEnabled: (name: string, enabled: boolean) => setSkillEnabled(name, enabled),
  tickSkillHub: () => tickSkillHub(),
  uninstallSkillFromHub: (name: string) => uninstallSkillFromHub(name)
}))

// Toasts hit nanostores/timers we don't care about here; the pure
// `readableError` stays real so an inline error reads like the toast would.
vi.mock('@/store/notifications', async importOriginal => ({
  ...(await importOriginal<typeof Notifications>()),
  notify: vi.fn(),
  notifyError: vi.fn()
}))

vi.mock('@/app/chat/composer/focus', () => ({
  requestComposerInsert: (text: string, options: unknown) => requestComposerInsert(text, options)
}))

const navigateSpy = vi.fn()

vi.mock('react-router', async importOriginal => ({
  ...(await importOriginal<typeof ReactRouterDom>()),
  useNavigate: () => navigateSpy
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

function localSkill(overrides: Partial<SkillInfo> = {}): SkillInfo {
  return {
    name: 'vneb-report',
    description: 'Weekly report for VNEB.',
    category: 'productivity',
    enabled: true,
    usage: 0,
    provenance: 'hub',
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

// A resolved preview — the SKILL.md the hub hands back for the first skill.
const PREVIEW = {
  name: 'vneb-report',
  description: 'Weekly report for VNEB.',
  source: 'agentx-hub',
  identifier: 'agentx-hub/vneb-report',
  trust_level: 'agentx-hub-verified',
  repo: null,
  tags: [],
  skill_md: '# Weekly VNEB report\n\nOpens the portal and files the report.',
  files: ['SKILL.md']
}

// The catalogue's `installed` map for the first skill, as the backend writes it.
const INSTALLED_REPORT = {
  'agentx-hub/vneb-report': { name: 'vneb-report', trust_level: 'agentx-hub-verified', scan_verdict: 'safe' }
}

async function renderHub(query = '') {
  const { SkillsHub } = await import('./hub')
  let result: ReturnType<typeof render>
  await act(async () => {
    result = render(
      // The app's own QueryClient: the store's switch writes the skills list
      // through the shared optimistic cache (`skills-data.ts`), so the test
      // must read from the same client to see the card repaint.
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <SkillsHub query={query} />
        </MemoryRouter>
      </QueryClientProvider>
    )
  })

  return result!
}

beforeEach(() => {
  // Radix menus call these on open; jsdom implements neither.
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.releasePointerCapture = vi.fn()

  getSkillHubCatalog.mockResolvedValue(catalog())
  getSkills.mockResolvedValue([])
  // Nothing pushed to this machine: the desired-state panel must stay away.
  getSkillHubChanges.mockResolvedValue({
    enabled: true,
    configured: true,
    base_url: 'https://skills.dev-server.cloud',
    stream: 'off',
    revision: 1,
    last: { status: 'signed_out', detail: '', at: '' },
    installs: [],
    updates: [],
    history: [],
    org: null
  })
  tickSkillHub.mockResolvedValue({ status: 'signed_out', detail: '' })
  searchSkillsHub.mockResolvedValue({ results: [], source_counts: {}, timed_out: [], installed: {} })
  installSkillFromHub.mockResolvedValue({ ok: true, pid: 1, name: 'skills-install-vneb-report' })
  previewSkillHub.mockResolvedValue(PREVIEW)
  uninstallSkillFromHub.mockResolvedValue({ ok: true, pid: 2, name: 'skills-uninstall-vneb-report' })
  setSkillEnabled.mockResolvedValue({ ok: true, name: 'vneb-report', enabled: false })
  getActionStatus.mockResolvedValue({ name: 'skills-install-vneb-report', running: false, exit_code: 0, lines: [] })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  // Shared singleton client — drop the cached catalogue/skills between tests.
  queryClient.clear()
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
    expect(bar).toContain('AgentX skill store')
    expect(bar).toContain('skills.dev-server.cloud')
    expect(bar).toContain('2 skills from the Hub')
    expect(screen.getByTestId('hub-store-state').textContent).toBe('Connected')
  })

  it('a card is metadata until "Add this skill" is pressed', async () => {
    await renderHub()
    const cards = await screen.findAllByTestId('hub-card')

    expect(installSkillFromHub).not.toHaveBeenCalled()
    // Nothing to switch or try before the skill is on this machine.
    expect(screen.queryByTestId('hub-card-switch')).toBeNull()
    expect(screen.queryByTestId('hub-card-try-now')).toBeNull()

    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Add this skill' })[0])
    })

    await waitFor(() => expect(installSkillFromHub).toHaveBeenCalledWith('agentx-hub/vneb-report'))
    expect(cards).toHaveLength(2)
  })

  it('an added skill is managed from its card: switch, "Try now", and "Remove this skill"', async () => {
    getSkillHubCatalog.mockResolvedValue(catalog({ installed: INSTALLED_REPORT }))
    getSkills.mockResolvedValue([localSkill()])

    await renderHub()

    const card = (await screen.findAllByTestId('hub-card'))[0]
    expect(within(card).getByTestId('hub-card-installed').textContent).toBe('Added')
    expect(within(card).queryByRole('button', { name: 'Add this skill' })).toBeNull()

    // "Try now" is the same gesture as on a skill you already had.
    await act(async () => {
      fireEvent.click(within(card).getByTestId('hub-card-try-now'))
    })

    expect(navigateSpy).toHaveBeenCalledWith('/')
    expect(requestComposerInsert).toHaveBeenCalledWith('/vneb-report ', { mode: 'inline', target: 'main' })

    // The switch flips the backend's own row for the installed copy…
    const sw = within(card).getByRole('switch', { name: 'Turn vneb-report off' })
    expect(sw.getAttribute('aria-checked')).toBe('true')

    await act(async () => {
      fireEvent.click(sw)
    })

    await waitFor(() => expect(setSkillEnabled).toHaveBeenCalledWith('vneb-report', false))
    // …and a switched-off skill has nothing to try.
    await waitFor(() => expect(within(card).queryByTestId('hub-card-try-now')).toBeNull())

    // Removal lives behind the card's ⋯ menu, named in full.
    const trigger = within(card).getByRole('button', { name: 'Actions' })
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })

    await act(async () => {
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove this skill' }))
    })

    await waitFor(() => expect(uninstallSkillFromHub).toHaveBeenCalledWith('vneb-report'))
  })

  it('"Preview" shows the SKILL.md, and a refused preview says so instead of going blank', async () => {
    // The bug: a private skill the catalogue listed answered 404 on preview,
    // and the dialog showed a spinner that ended in an empty pane.
    previewSkillHub.mockRejectedValue(
      new Error(
        'Error invoking remote method \'agentx:api\': Error: 404: {"detail":"Skill not found: agentx-hub/vneb-report"}'
      )
    )

    await renderHub()
    const card = (await screen.findAllByTestId('hub-card'))[0]

    await act(async () => {
      fireEvent.click(within(card).getByRole('button', { name: 'Preview' }))
    })

    // One retry, then the failure is a sentence with the hub's reason and a way back.
    const banner = await screen.findByTestId('hub-preview-error', {}, { timeout: 4000 })
    expect(banner.textContent).toContain('Skill preview failed')
    expect(banner.textContent).toContain('Skill not found: agentx-hub/vneb-report')
    expect(previewSkillHub).toHaveBeenCalledTimes(2)

    previewSkillHub.mockResolvedValue(PREVIEW)

    await act(async () => {
      fireEvent.click(within(banner).getByRole('button', { name: 'Retry' }))
    })

    expect(await screen.findByText('Opens the portal and files the report.')).toBeTruthy()
    expect(screen.queryByTestId('hub-preview-error')).toBeNull()
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

  it('searches the hub and nowhere else', async () => {
    await renderHub('report')

    // One search, aimed at the hub — no fan-out to GitHub, ClawHub, skills.sh…
    await waitFor(() => expect(searchSkillsHub).toHaveBeenCalledWith('report', 'agentx-hub'))
    expect(searchSkillsHub).toHaveBeenCalledTimes(1)
    // …and no list of other hubs anywhere on the tab.
    const bar = screen.getByTestId('hub-catalog-bar').textContent ?? ''

    for (const other of ['GitHub', 'ClawHub', 'LobeHub', 'skills.sh', 'browse.sh', 'Official']) {
      expect(bar).not.toContain(other)
    }
  })

  it('says so when the hub could not be reached and the cards are the last sync', async () => {
    getSkillHubCatalog.mockResolvedValue(
      catalog({ error: 'https://skills.dev-server.cloud did not answer with a catalog', stale: true })
    )

    await renderHub()

    expect((await screen.findByTestId('hub-catalog-offline')).textContent).toContain('cannot be reached')
    expect(screen.getByTestId('hub-store-state').textContent).toBe('Unreachable')
  })
})
