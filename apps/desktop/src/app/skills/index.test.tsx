// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type * as ReactRouterDom from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as HermesApi from '@/hermes'
import { queryClient } from '@/lib/query-client'

const getSkills = vi.fn()
const getToolsets = vi.fn()
const setSkillEnabled = vi.fn()
const setToolsetEnabled = vi.fn()
const getToolsetConfig = vi.fn()
const selectToolsetProvider = vi.fn()
const getUsageAnalytics = vi.fn()
const requestComposerInsert = vi.fn()

// Partial mock: keep the real module (SkillsView pulls in @/store/profile,
// whose import-time subscription calls setApiRequestProfile) and stub only the
// calls we assert on.
vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<typeof HermesApi>()),
  getSkills: () => getSkills(),
  getToolsets: () => getToolsets(),
  setSkillEnabled: (name: string, enabled: boolean) => setSkillEnabled(name, enabled),
  setToolsetEnabled: (name: string, enabled: boolean) => setToolsetEnabled(name, enabled),
  getToolsetConfig: (name: string) => getToolsetConfig(name),
  selectToolsetProvider: (toolset: string, provider: string) => selectToolsetProvider(toolset, provider),
  getUsageAnalytics: (days: number) => getUsageAnalytics(days)
}))

// Notifications hit nanostores/timers we don't care about here.
vi.mock('@/store/notifications', () => ({
  notify: vi.fn(),
  notifyError: vi.fn()
}))

// "Thử ngay" dispatches on the composer-insert bus; capture the call instead
// of mounting a composer.
vi.mock('@/app/chat/composer/focus', () => ({
  requestComposerInsert: (text: string, options: unknown) => requestComposerInsert(text, options)
}))

// The vision detail and "Thử ngay" navigate via useNavigate; spy on it so the
// targets are assertable.
const navigateSpy = vi.fn()

vi.mock('react-router', async importOriginal => ({
  ...(await importOriginal<typeof ReactRouterDom>()),
  useNavigate: () => navigateSpy
}))

function toolset(overrides: Record<string, unknown> = {}) {
  return {
    name: 'web',
    label: 'Web Search',
    description: 'web_search, web_extract',
    enabled: true,
    available: true,
    configured: true,
    tools: ['web_search', 'web_extract'],
    ...overrides
  }
}

function skill(overrides: Record<string, unknown> = {}) {
  return {
    name: 'vneb-report',
    description: 'Weekly report for VNEB.',
    category: 'productivity',
    enabled: true,
    usage: 3,
    provenance: 'bundled',
    ...overrides
  }
}

async function renderSkills(tab = 'toolsets') {
  const { SkillsView } = await import('./index')
  let result: ReturnType<typeof render>
  await act(async () => {
    result = render(
      // SkillsView reads skills/toolsets via useQuery, so it needs a provider.
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/skills?tab=${tab}`]}>
          <SkillsView />
        </MemoryRouter>
      </QueryClientProvider>
    )
  })

  return result!
}

beforeEach(() => {
  // Radix dialogs/menus call these on open; jsdom implements neither.
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.releasePointerCapture = vi.fn()

  getSkills.mockResolvedValue([])
  getToolsets.mockResolvedValue([toolset()])
  setSkillEnabled.mockResolvedValue({ ok: true, name: 'vneb-report', enabled: false })
  setToolsetEnabled.mockResolvedValue({ ok: true, name: 'web', enabled: false })
  getToolsetConfig.mockResolvedValue({ has_category: true, active_provider: null, providers: [] })
  getUsageAnalytics.mockResolvedValue({ tools: [] })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  // Shared singleton client — drop cached skills/toolsets so each test refetches.
  queryClient.clear()
})

describe('SkillsView tabs', () => {
  it('orders the tabs skills · store · tools · connections, with the store beside the skills', async () => {
    await renderSkills('skills')

    const tabs = await screen.findAllByRole('tab')
    expect(tabs.map(tab => tab.textContent?.replace(/\d+$/, '').trim())).toEqual([
      'Available skills',
      'Skill store',
      'Tools',
      'Advanced connections'
    ])
  })
})

describe('SkillsView — the skills you have', () => {
  it('lists bundled and learned skills as cards and keeps hub-installed skills for the store', async () => {
    getSkills.mockResolvedValue([
      skill(),
      skill({ name: 'notes', description: 'Learned here.', provenance: 'agent', usage: 0 }),
      skill({ name: 'demo-core', description: 'From the hub', provenance: 'hub' })
    ])

    await renderSkills('skills')

    const cards = await screen.findAllByTestId('skill-card')
    expect(cards.map(card => card.getAttribute('data-skill'))).toEqual(['vneb-report', 'notes'])
    // The tab counts what it shows — two, not three.
    expect(screen.getByRole('tab', { name: /Available skills/ }).textContent).toContain('2')
    // Only the learned one is badged; the bundled one is the resting state.
    expect(within(cards[1]).getByText('Learned')).toBeTruthy()
    expect(within(cards[0]).queryByText('Built-in')).toBeNull()
  })

  it('turns a skill off from its card switch', async () => {
    getSkills.mockResolvedValue([skill()])

    await renderSkills('skills')

    const sw = await screen.findByRole('switch', { name: 'Turn Vneb Report off' })
    expect(sw.getAttribute('aria-checked')).toBe('true')

    await act(async () => {
      fireEvent.click(sw)
    })

    await waitFor(() => expect(setSkillEnabled).toHaveBeenCalledWith('vneb-report', false))
    // A switched-off skill has nothing to try.
    expect(screen.queryByTestId('skill-try-now')).toBeNull()
  })

  it('"Try now" opens a fresh chat with the slash command pre-typed', async () => {
    getSkills.mockResolvedValue([skill()])

    await renderSkills('skills')

    await act(async () => {
      fireEvent.click(await screen.findByTestId('skill-try-now'))
    })

    expect(navigateSpy).toHaveBeenCalledWith('/')
    expect(requestComposerInsert).toHaveBeenCalledWith('/vneb-report ', { mode: 'inline', target: 'main' })
  })

  it('keeps the technical tail and the learned-skill tools behind "Details"', async () => {
    getSkills.mockResolvedValue([skill({ name: 'notes', provenance: 'agent' })])

    await renderSkills('skills')

    const card = await screen.findByTestId('skill-card')
    // Nothing administrative on the tile itself.
    expect(within(card).queryByText('Technical details')).toBeNull()
    expect(within(card).queryByTestId('skill-upload-hub')).toBeNull()

    await act(async () => {
      fireEvent.click(within(card).getByRole('button', { name: 'Details' }))
    })

    const dialog = await screen.findByTestId('skill-detail')
    expect(within(dialog).getByText('Technical details')).toBeTruthy()
    expect(within(dialog).getByTestId('skill-upload-hub')).toBeTruthy()
    expect(within(dialog).getByTestId('skill-propose-workspace')).toBeTruthy()

    await act(async () => {
      fireEvent.click(within(dialog).getByTestId('skill-upload-hub'))
    })

    // The detail closes and the publish dialog takes over — one modal at a time.
    expect(await screen.findByText('Upload “notes” to AgentX Hub')).toBeTruthy()
    expect(screen.queryByTestId('skill-detail')).toBeNull()
  })
})

describe('SkillsView toolset management', () => {
  it('renders a switch for each toolset and toggles it off', async () => {
    await renderSkills()

    // The switch names the action, so an enabled tool offers to turn it
    // off. The hand-written copy layer (skills.toolsets.web) gives the
    // accessible name its friendly label, not the backend's.
    const sw = await screen.findByRole('switch', { name: 'Turn Web search off' })
    expect(sw.getAttribute('aria-checked')).toBe('true')

    await act(async () => {
      fireEvent.click(sw)
    })

    await waitFor(() => expect(setToolsetEnabled).toHaveBeenCalledWith('web', false))
  })

  it('renders toolset titles without leading emoji', async () => {
    getToolsets.mockResolvedValue([toolset({ name: 'cronjob', label: '⏰ Cron Jobs', description: 'cron tools' })])

    await renderSkills()

    await screen.findByRole('switch', { name: 'Turn Scheduled tasks off' })
    expect(screen.queryByText(/⏰/)).toBeNull()
  })

  it('fetches a tool’s provider config only when its detail is opened', async () => {
    await renderSkills()

    const card = await screen.findByTestId('toolset-card')
    // A grid of cards must not fan out one config request per tool.
    expect(getToolsetConfig).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(within(card).getByTestId('toolset-details'))
    })

    await screen.findByTestId('toolset-detail')
    await waitFor(() => expect(getToolsetConfig).toHaveBeenCalledWith('web'))
  })

  it('leads with "Set up" when a tool still needs keys', async () => {
    getToolsets.mockResolvedValue([toolset({ configured: false })])

    await renderSkills()

    const card = await screen.findByTestId('toolset-card')
    expect(within(card).getByText('Needs setup')).toBeTruthy()
    expect(within(card).getByTestId('toolset-set-up')).toBeTruthy()
    expect(within(card).queryByTestId('toolset-details')).toBeNull()
  })

  it('shows a vision explainer that deep-links to Settings → Models', async () => {
    // Vision has no TOOL_CATEGORIES provider matrix — its model lives in the
    // auxiliary model config, so the detail must point there instead of
    // rendering an empty panel.
    getToolsets.mockResolvedValue([
      toolset({
        name: 'vision',
        label: 'Vision / Image Analysis',
        description: 'vision_analyze',
        tools: ['vision_analyze']
      })
    ])
    getToolsetConfig.mockResolvedValue({ has_category: false, active_provider: null, providers: [] })

    await renderSkills()

    await act(async () => {
      fireEvent.click(await screen.findByTestId('toolset-details'))
    })

    expect(await screen.findByText(/auxiliary model configuration/)).toBeTruthy()
    const link = screen.getByRole('button', { name: /Choose vision model in Settings/ })

    await act(async () => {
      fireEvent.click(link)
    })

    // Internal route change into the Models section with the aux slot target —
    // consumed by ModelSettings' deep-link highlight. Never an external URL.
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith('/settings?tab=config:model&aux=vision'))
  })
})
