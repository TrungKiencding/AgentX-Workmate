import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { DropdownMenu, DropdownMenuContent } from '@/components/ui/dropdown-menu'
import {
  $modelVisibilityOpen,
  $visibleModels,
  modelVisibilityKey,
  setModelVisibilityOpen,
  setVisibleModels
} from '@/store/model-visibility'

import { ModelCatalogMenu, type ModelMenuController } from './model-catalog-menu'

// Radix calls these on open; jsdom doesn't implement them.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.releasePointerCapture = vi.fn()
})

const getGlobalModelOptions = vi.fn()

vi.mock('@/hermes', () => ({
  getGlobalModelOptions: (...args: unknown[]) => getGlobalModelOptions(...args),
  setApiRequestProfile: vi.fn()
}))

beforeEach(() => {
  $visibleModels.set(null)
  setModelVisibilityOpen(false)
  getGlobalModelOptions.mockResolvedValue({
    providers: [{ models: ['gemini-3.1-pro', 'gemini-2.5-flash'], name: 'Google', slug: 'google' }]
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// A minimal controller — these tests are about the CATALOG's own behaviour
// (what it lists, what it offers), not about what any host does with a pick.
function renderMenu(over: Partial<ModelMenuController> = {}) {
  const select = vi.fn()

  const controller: ModelMenuController = {
    applyPreset: vi.fn(),
    current: { effort: '', fast: false, model: '', provider: '' },
    presetFor: () => ({}),
    select,
    setOptions: vi.fn(),
    ...over
  }

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  render(
    <QueryClientProvider client={client}>
      <DropdownMenu open>
        <DropdownMenuContent>
          <ModelCatalogMenu controller={controller} />
        </DropdownMenuContent>
      </DropdownMenu>
    </QueryClientProvider>
  )

  return select
}

// Curation is ONE global preference, so it belongs to the catalog rather than
// to whichever surface mounted it. If a host had to opt in, the composer and
// the kanban board would end up disagreeing about what "my models" means —
// which is exactly the drift extracting this component was meant to prevent.
describe('the catalog owns model curation', () => {
  it('honours the stored Edit Models shortlist', async () => {
    setVisibleModels(new Set([modelVisibilityKey('google', 'gemini-2.5-flash')]))

    renderMenu()

    await screen.findByText(/Gemini 2\.5 Flash/i)
    expect(screen.queryByText(/Gemini 3\.1 Pro/i)).toBeNull()
  })

  it('still finds a hidden model by search — curation narrows the default view, not the catalog', async () => {
    setVisibleModels(new Set([modelVisibilityKey('google', 'gemini-2.5-flash')]))

    renderMenu()
    await screen.findByText(/Gemini 2\.5 Flash/i)

    const input = screen.getByRole('textbox', { name: 'Search models' })

    fireEvent.change(input, { target: { value: 'gemini-3.1' } })

    await vi.waitFor(() => {
      expect(screen.queryByText(/Gemini 3\.1 Pro/i)).not.toBeNull()
    })
  })

  it('offers Manage models without the host wiring it up', async () => {
    renderMenu()
    await screen.findByText(/Gemini 3\.1 Pro/i)

    fireEvent.click(screen.getByText('Manage models'))

    expect($modelVisibilityOpen.get()).toBe(true)
  })
})

// The menu is as quiet as the catalog allows. Most people have two models from
// one gateway: a search field and a provider heading over that would only push
// the two choices down.
describe('the catalog keeps a short list quiet', () => {
  it('a short, fully shown, single-provider list has no search and no heading', async () => {
    renderMenu()
    await screen.findByText(/Gemini 3\.1 Pro/i)

    expect(screen.queryByRole('textbox', { name: 'Search models' })).toBeNull()
    expect(screen.queryByText('Google')).toBeNull()
  })

  it('a long list gets the search field', async () => {
    getGlobalModelOptions.mockResolvedValue({
      providers: [{ models: ['a-1', 'a-2', 'a-3', 'a-4', 'a-5', 'a-6'], name: 'Lab', slug: 'lab' }]
    })

    renderMenu()
    await screen.findByText('A 6')

    expect(screen.getByRole('textbox', { name: 'Search models' })).toBeTruthy()
  })

  it('two providers get their headings back', async () => {
    getGlobalModelOptions.mockResolvedValue({
      providers: [
        { models: ['gemini-3.1-pro'], name: 'Google', slug: 'google' },
        { models: ['gpt-5.5'], name: 'OpenAI', slug: 'openai' }
      ]
    })

    renderMenu()

    expect(await screen.findByText('Google')).toBeTruthy()
    expect(screen.getByText('OpenAI')).toBeTruthy()
  })
})

// A surface shows only the options it can carry: controls that silently do
// nothing are worse than no controls.
describe('the catalog offers only the options a surface can carry', () => {
  const current = { effort: '', fast: false, model: 'gemini-3.1-pro', provider: 'google' }

  it('shows the thinking dial for the selected model by default', async () => {
    renderMenu({ current })

    expect(await screen.findByRole('menuitemradio', { name: 'Medium' })).toBeTruthy()
  })

  it('hides it for a surface that stores no thinking depth', async () => {
    renderMenu({ current, options: { effort: false, fast: false } })
    await screen.findByText(/Gemini 3\.1 Pro/i)

    expect(screen.queryByRole('menuitemradio')).toBeNull()
    expect(screen.queryByText('Thinking')).toBeNull()
  })

  it('hides fast for a surface with no fast flag, even on a fast-capable model', async () => {
    getGlobalModelOptions.mockResolvedValue({
      providers: [
        {
          capabilities: { 'gpt-5.5': { fast: true, reasoning: true } },
          models: ['gpt-5.5'],
          name: 'OpenAI',
          slug: 'openai'
        }
      ]
    })

    renderMenu({ current: { ...current, model: 'gpt-5.5', provider: 'openai' }, options: { fast: false } })

    expect(await screen.findByRole('menuitemradio', { name: 'Medium' })).toBeTruthy()
    expect(screen.queryByRole('menuitemcheckbox')).toBeNull()
  })

  it('hides the dial for a model the catalog says takes no reasoning', async () => {
    getGlobalModelOptions.mockResolvedValue({
      providers: [
        {
          capabilities: { 'gemini-3.1-pro': { fast: false, reasoning: false } },
          models: ['gemini-3.1-pro'],
          name: 'Google',
          slug: 'google'
        }
      ]
    })

    renderMenu({ current })
    await screen.findByText(/Gemini 3\.1 Pro/i)

    expect(screen.queryByRole('menuitemradio')).toBeNull()
  })
})
