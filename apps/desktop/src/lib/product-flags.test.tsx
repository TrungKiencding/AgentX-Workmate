import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The flags exist so a hidden feature keeps NO door open — not a hotkey, not a
// deep link. These tests walk the doors. Each one also runs with the flag
// forced on, because "hidden" has to mean gated, not deleted: if the on-path
// stopped working nobody would notice until the flag came back.
const flags = vi.hoisted(() => ({ profileManagement: false }))

vi.mock('@/lib/product-flags', () => ({
  BILLING_ENABLED: false,
  get PROFILE_MANAGEMENT_ENABLED() {
    return flags.profileManagement
  },
  PROVIDER_ACCOUNTS_ENABLED: false
}))

beforeEach(() => {
  flags.profileManagement = false
  vi.resetModules()
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
