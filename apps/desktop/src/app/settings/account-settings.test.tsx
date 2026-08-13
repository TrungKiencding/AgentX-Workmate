import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { en } from '../../i18n/en'
import type { AccountIsolationState } from '../../store/account'

import { AccountSettings, describeKey } from './account-settings'

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

// The model-key line. It is table-driven over the provisioning status, and
// the two statuses added with the key vault are the ones worth pinning: an
// install nobody has finished setting up, and a device that has been cut off.
describe('describeKey', () => {
  const copy = en.settings.account

  function state(overrides: Record<string, unknown>) {
    return {
      base_url: '',
      detail: 'operator-facing prose',
      key_alias: '',
      masked_key: '',
      models: [],
      ok: false,
      provider: 'litellm',
      status: 'missing',
      ...overrides
    } as NonNullable<AccountIsolationState['litellm']>
  }

  it('shows the key and where it points once there is one', () => {
    const line = describeKey(
      state({ base_url: 'https://proxy.test', masked_key: 'sk-…4Bqf', ok: true }),
      copy
    )

    expect(line).toBe('sk-…4Bqf · https://proxy.test')
  })

  it('tells a revoked device to sign in again', () => {
    // Not "try later": this is the one failure the user has to act on, and
    // the key sitting in their .env is not the problem.
    expect(describeKey(state({ status: 'revoked' }), copy)).toBe(copy.keyRevoked)
  })

  it('does not describe an unfinished install as settled policy', () => {
    // `unconfigured` used to share a sentence with `disabled` — "this install
    // does not issue per-account model keys" — which reads as a decision
    // rather than as something somebody still has to do. Since the shipped
    // mode asks a service that may not be deployed yet, this is the state a
    // fresh install lands in, and it has to point somewhere.
    const line = describeKey(state({ status: 'unconfigured' }), copy)

    expect(line).toBe(copy.keyUnconfigured)
    expect(line).not.toBe(copy.keyDisabled)
  })

  it('still says an outage leaves the existing key working', () => {
    expect(describeKey(state({ status: 'offline' }), copy)).toBe(copy.keyOffline)
  })

  it('falls through to the backend detail for states a user cannot act on', () => {
    expect(describeKey(state({ status: 'error' }), copy)).toBe('operator-facing prose')
  })
})
