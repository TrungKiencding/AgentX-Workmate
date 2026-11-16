import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { DesktopLicense } from '@/global'
import { setTimeFormatLocale } from '@/lib/time'
import { $license } from '@/store/license'

import { en } from '../../i18n/en'

import { AccountSettings } from './account-settings'

// Settings → Account is the only place the desktop app tells you who you are
// signed in as, and the only way out. These pin that it names a person rather
// than a UUID, and that it degrades honestly on an ungated install.

const original = window.agentxDesktop

function stubStatus(status: Record<string, unknown> | null) {
  Object.defineProperty(window, 'agentxDesktop', {
    configurable: true,
    value: status === null ? {} : { keycloak: { status: async () => status } }
  })
}

afterEach(() => {
  cleanup()
  Object.defineProperty(window, 'agentxDesktop', { configurable: true, value: original })
})

describe('AccountSettings', () => {
  it('names the signed-in person and offers a way out', async () => {
    stubStatus({
      clientId: 'agentx-workmate',
      configured: true,
      displayName: 'Le Trung Kien',
      email: 'kienlt1@astralx.com.vn',
      issuer: 'https://sso.example.com/realms/agent-hub',
      signedIn: true,
      userId: 'kc-sub-1'
    })

    render(<AccountSettings />)

    expect(await screen.findByText('Le Trung Kien')).toBeTruthy()
    expect(screen.getByText('kienlt1@astralx.com.vn')).toBeTruthy()
    expect(screen.getByRole('button', { name: /sign out/i })).toBeTruthy()
    // The identity provider, the per-account home and the model key are left
    // off this page: none of them is something the user acts on.
    expect(screen.queryByText('https://sso.example.com/realms/agent-hub')).toBeNull()
  })

  it('falls back through email then subject id rather than showing a blank name', async () => {
    // Sessions stored before the app carried identity claims have only `sub`.
    stubStatus({ configured: true, signedIn: true, userId: 'kc-sub-1' })

    render(<AccountSettings />)

    expect(await screen.findByText('kc-sub-1')).toBeTruthy()
  })

  it('says so plainly when the install has no AgentX account', async () => {
    stubStatus({ configured: false, signedIn: false })

    render(<AccountSettings />)

    expect(await screen.findByText(/no agentx account on this install/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /sign out/i })).toBeNull()
  })

  it('offers no sign-out when nobody is signed in', async () => {
    stubStatus({ configured: true, issuer: 'https://sso.example.com/realms/agent-hub', signedIn: false })

    render(<AccountSettings />)

    await waitFor(() => expect(screen.getByText(/signed out/i)).toBeTruthy())
    expect(screen.queryByRole('button', { name: /sign out/i })).toBeNull()
  })

  it('renders without a keycloak bridge at all', async () => {
    stubStatus(null)

    render(<AccountSettings />)

    expect(await screen.findByText(/no agentx account on this install/i)).toBeTruthy()
  })
})

// The AgentX license row: plan, state, the day that matters, whom to ask, and
// "Check again" — whenever a license is known, enforced or not; nothing while
// none is (an SSO that predates licensing).
describe('the AgentX license row', () => {
  const KEYCLOAK = {
    status: async () => ({
      clientId: 'agentx-workmate',
      configured: true,
      displayName: 'Le Trung Kien',
      email: 'kienlt1@astralx.com.vn',
      issuer: 'https://sso.example.com/realms/agent-hub',
      signedIn: true,
      userId: 'kc-sub-1'
    })
  }

  const ACTIVE: DesktopLicense = {
    access: 'full',
    contact: 'it@astralx.com.vn',
    days_left: 120,
    enforced: true,
    last_day: '2027-05-31',
    notice: null,
    plan: { name: 'Pilot 2026', slug: 'pilot-2026' },
    reminder: null,
    state: 'active'
  }

  function stub(license: DesktopLicense | null, refresh?: () => Promise<unknown>) {
    const view = { account: 'kien', detail: '', license, status: 'cached' }

    Object.defineProperty(window, 'agentxDesktop', {
      configurable: true,
      value: {
        keycloak: KEYCLOAK,
        license: {
          get: async () => view,
          onChanged: () => () => undefined,
          refresh: refresh ?? (async () => ({ ...view, status: 'ok' }))
        }
      }
    })
  }

  beforeEach(() => {
    setTimeFormatLocale('en')
    $license.set({ account: null, available: false, checking: false, lastCheck: null, license: null, loaded: false })
  })

  afterEach(() => setTimeFormatLocale(undefined))

  it('shows the plan, its state, its last day and whom to ask', async () => {
    stub(ACTIVE)

    render(<AccountSettings />)

    expect(await screen.findByText(en.license.title)).toBeTruthy()
    expect(screen.getByText(en.license.states.active)).toBeTruthy()
    expect(screen.getByText('Pilot 2026 · Last day: May 31, 2027')).toBeTruthy()
    expect(screen.getByText('Contact: it@astralx.com.vn')).toBeTruthy()
    expect(screen.getByRole('button', { name: en.license.checkAgain })).toBeTruthy()
  })

  it('shows the plan while the license is not enforced, too', async () => {
    stub({ ...ACTIVE, enforced: false, state: 'expired' })

    render(<AccountSettings />)

    expect(await screen.findByText(en.license.states.expired)).toBeTruthy()
  })

  it('names the start day of a plan that has not started', async () => {
    stub({ ...ACTIVE, access: 'read_only', notice: 'read_only', starts_on: '2026-10-15', state: 'scheduled' })

    render(<AccountSettings />)

    expect(await screen.findByText('Pilot 2026 · Starts: Oct 15, 2026 · Last day: May 31, 2027')).toBeTruthy()
    expect(screen.getByText(en.license.states.scheduled)).toBeTruthy()
  })

  it('is absent while no license is known', async () => {
    stub(null)

    render(<AccountSettings />)

    expect(await screen.findByText('Le Trung Kien')).toBeTruthy()
    await waitFor(() => expect($license.get().loaded).toBe(true))
    expect(screen.queryByText(en.license.title)).toBeNull()
  })

  it('says when a check could not reach the service, and keeps what it knew', async () => {
    stub(ACTIVE, async () => ({ account: 'kien', detail: 'unreachable', license: ACTIVE, status: 'offline' }))

    render(<AccountSettings />)

    fireEvent.click(await screen.findByRole('button', { name: en.license.checkAgain }))

    expect((await screen.findByRole('status')).textContent).toBe(en.license.checkFailed)
    expect(screen.getByText(en.license.states.active)).toBeTruthy()
  })
})
