import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The flags exist so a hidden feature keeps NO door open — not a hotkey, not a
// deep link. These tests walk the doors. Each one also runs with the flag
// forced on, because "hidden" has to mean gated, not deleted: if the on-path
// stopped working nobody would notice until the flag came back.
const flags = vi.hoisted(() => ({ billing: false, profileManagement: false, providerAccounts: false }))

vi.mock('@/lib/product-flags', () => ({
  get BILLING_ENABLED() {
    return flags.billing
  },
  get PROFILE_MANAGEMENT_ENABLED() {
    return flags.profileManagement
  },
  get PROVIDER_ACCOUNTS_ENABLED() {
    return flags.providerAccounts
  }
}))

// SettingsView mounts a dozen panels that all reach the backend. Every `@/hermes`
// call funnels through `window.agentxDesktop.api`, so one resolving stub stands
// in for the lot without naming each panel's endpoint.
vi.mock('@/hermes', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@/hermes')),
  getEnvVars: vi.fn().mockResolvedValue({}),
  getHermesConfigDefaults: vi.fn().mockResolvedValue({}),
  getHermesConfigRecord: vi.fn().mockResolvedValue({}),
  listOAuthProviders: vi.fn().mockResolvedValue({ providers: [] }),
  saveHermesConfig: vi.fn().mockResolvedValue({})
}))

beforeEach(() => {
  flags.billing = false
  flags.profileManagement = false
  flags.providerAccounts = false
  vi.resetModules()
  ;(window as unknown as { agentxDesktop: unknown }).agentxDesktop = {
    api: vi.fn().mockResolvedValue({}),
    terminal: undefined
  }
})

afterEach(cleanup)

describe('PROFILE_MANAGEMENT_ENABLED — hotkeys', () => {
  it('leaves no bindable action for creating or managing profiles', async () => {
    const { defaultBindings, KEYBIND_ACTION_IDS, keybindAction } = await import('@/lib/keybinds/actions')
    const { $bindings, setBinding } = await import('@/store/keybinds')

    expect(KEYBIND_ACTION_IDS).not.toContain('profile.create')
    expect(KEYBIND_ACTION_IDS).not.toContain('nav.profiles')

    // Gone from the panel's row list and from the shipped defaults…
    expect(keybindAction('profile.create')).toBeUndefined()
    expect(defaultBindings()['profile.create']).toBeUndefined()

    // …and unbindable, so a user can't re-open the door by assigning a chord.
    setBinding('profile.create', ['mod+alt+p'])
    expect($bindings.get()['profile.create']).toBeUndefined()
  })

  it('keeps the profile SWITCH hotkeys, which only reach a profile that exists', async () => {
    const { KEYBIND_ACTION_IDS } = await import('@/lib/keybinds/actions')

    expect(KEYBIND_ACTION_IDS).toContain('profile.default')
    expect(KEYBIND_ACTION_IDS).toContain('profile.switch.1')
  })

  it('restores both actions when the flag comes back', async () => {
    flags.profileManagement = true
    vi.resetModules()

    const { KEYBIND_ACTION_IDS } = await import('@/lib/keybinds/actions')

    expect(KEYBIND_ACTION_IDS).toContain('profile.create')
    expect(KEYBIND_ACTION_IDS).toContain('nav.profiles')
  })
})

// `useOverlayRouting` decides whether the /profiles overlay mounts. Probe it
// through a component so the redirect it performs is observable as a route.
function renderAtProfilesRoute(useOverlayRouting: () => { profilesOpen: boolean }) {
  function Probe() {
    const { profilesOpen } = useOverlayRouting()
    const { pathname } = useLocation()

    return (
      <div>
        <span data-testid="path">{pathname}</span>
        <span data-testid="open">{String(profilesOpen)}</span>
      </div>
    )
  }

  return render(
    <MemoryRouter initialEntries={['/profiles']}>
      <Probe />
    </MemoryRouter>
  )
}

describe('PROFILE_MANAGEMENT_ENABLED — the /profiles deep link', () => {
  it('reports the overlay closed and bounces a stale link back to chat', async () => {
    const { useOverlayRouting } = await import('@/app/shell/hooks/use-overlay-routing')

    renderAtProfilesRoute(useOverlayRouting)

    // Closed on the very first render: the overlay must never flash before the
    // redirect effect runs.
    expect(screen.getByTestId('open').textContent).toBe('false')
    expect(screen.getByTestId('path').textContent).toBe('/')
  })

  it('opens the overlay and stays put when the flag comes back', async () => {
    flags.profileManagement = true
    vi.resetModules()

    const { useOverlayRouting } = await import('@/app/shell/hooks/use-overlay-routing')

    renderAtProfilesRoute(useOverlayRouting)

    expect(screen.getByTestId('open').textContent).toBe('true')
    expect(screen.getByTestId('path').textContent).toBe('/profiles')
  })
})

// The Settings nav is the surface the flags were asked for by name, so assert on
// the rows a user would actually read rather than on the flags themselves.
// SettingsView mounts every panel, hence the QueryClient + IPC stub above.
async function renderSettingsAt(search: string) {
  const { SettingsView } = await import('@/app/settings')
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  render(
    <MemoryRouter initialEntries={[`/settings${search}`]}>
      <QueryClientProvider client={client}>
        <SettingsView onClose={vi.fn()} />
      </QueryClientProvider>
    </MemoryRouter>
  )
}

const navRows = () =>
  [...screen.queryAllByRole('button'), ...screen.queryAllByRole('link')]
    .map(el => (el.textContent ?? '').trim())
    .filter(Boolean)

describe('BILLING_ENABLED — the Settings nav', () => {
  it('has no Billing row, and `?tab=billing` cannot conjure one', async () => {
    await renderSettingsAt('')
    expect(navRows()).not.toContain('Billing')

    cleanup()

    // Off SETTINGS_VIEWS too, so a stale deep link coerces to the default view
    // instead of opening a page with no row leading back to it.
    await renderSettingsAt('?tab=billing')
    expect(navRows()).not.toContain('Billing')
  })

  it('brings the row back when the flag does', async () => {
    flags.billing = true
    vi.resetModules()

    await renderSettingsAt('')

    expect(navRows()).toContain('Billing')
  })
})

describe('PROVIDER_ACCOUNTS_ENABLED — the Providers sub-nav', () => {
  it('offers API keys and Custom Endpoints, but no Accounts', async () => {
    await renderSettingsAt('?tab=providers')

    const rows = navRows()
    expect(rows).toContain('API keys')
    expect(rows).toContain('Custom Endpoints')
    expect(rows).not.toContain('Accounts')
  })

  it('brings the sub-view back when the flag does', async () => {
    flags.providerAccounts = true
    vi.resetModules()

    await renderSettingsAt('?tab=providers')

    expect(navRows()).toContain('Accounts')
  })
})
