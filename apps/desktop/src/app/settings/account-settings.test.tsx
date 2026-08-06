import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

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
    expect(screen.getByText('https://sso.example.com/realms/agent-hub')).toBeTruthy()
    expect(screen.getByRole('button', { name: /sign out/i })).toBeTruthy()
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
