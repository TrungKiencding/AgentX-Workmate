import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { DesktopLicense } from '@/global'
import { setTimeFormatLocale } from '@/lib/time'
import { $license } from '@/store/license'

import { en } from '../../i18n/en'
import type { AccountIsolationState } from '../../store/account'

import { AccountSettings, describeKey, describeRotateFailure } from './account-settings'

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

// "Issue a new key" used to be a button that did nothing visible when the
// service refused: the refreshed state read exactly as before the click. The
// refusal now reaches the screen in the service's own words.
describe('rotating the key', () => {
  it('shows why a refused rotation did not happen', async () => {
    const litellm = {
      base_url: 'https://proxy.test',
      detail: '',
      key_alias: 'second-brain-kien-8c5f68bd',
      masked_key: 'sk-…4Bqf',
      models: ['chat-a'],
      ok: true,
      provider: 'litellm',
      status: 'reused'
    }

    Object.defineProperty(window, 'agentxDesktop', {
      configurable: true,
      value: {
        account: {
          provision: async () => ({
            litellm: {
              ...litellm,
              detail: 'the second brain could not issue a key: LiteLLM returned HTTP 400: alias exists',
              ok: false,
              status: 'error'
            },
            ok: false
          }),
          status: async () => ({
            account: 'le-trung-kien-8c5f68bd',
            home: '/home/kien/.agentx/accounts/le-trung-kien-8c5f68bd',
            isolated: true,
            litellm,
            signedIn: true
          })
        },
        keycloak: {
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
      }
    })

    render(<AccountSettings />)

    fireEvent.click(await screen.findByRole('button', { name: en.settings.account.keyRotate }))

    const alert = await screen.findByRole('alert')

    expect(alert.textContent).toBe(
      en.settings.account.keyRotateFailed(
        'the second brain could not issue a key: LiteLLM returned HTTP 400: alias exists'
      )
    )
    // The key it still holds is still described as working — nothing was lost.
    expect(screen.getByText('sk-…4Bqf · https://proxy.test')).toBeTruthy()
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
    const line = describeKey(state({ base_url: 'https://proxy.test', masked_key: 'sk-…4Bqf', ok: true }), copy)

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

describe('describeRotateFailure', () => {
  it('says a license refusal the way the license is said everywhere', () => {
    setTimeFormatLocale('en')

    const line = describeRotateFailure(
      {
        litellm: {
          base_url: '',
          code: 'license_expired',
          detail: "this account's AgentX license does not cover AI right now (HTTP 403)",
          key_alias: '',
          license: {
            access: 'read_only',
            contact: '',
            enforced: true,
            last_day: '2026-12-31',
            notice: 'read_only',
            plan: { name: 'Pilot 2026', slug: 'pilot-2026' },
            state: 'expired'
          },
          masked_key: '',
          models: [],
          ok: false,
          provider: 'litellm',
          status: 'license_inactive'
        },
        ok: false
      },
      en
    )

    setTimeFormatLocale(undefined)

    expect(line).toBe(
      en.settings.account.keyRotateFailed(
        'Your Pilot 2026 plan expired on Dec 31, 2026. Workmate is in read-only mode.'
      )
    )
  })

  it('keeps the service words for anything else', () => {
    const line = describeRotateFailure({ error: 'no backend', ok: false }, en)

    expect(line).toBe(en.settings.account.keyRotateFailed('no backend'))
  })
})
