import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { en } from '@/i18n/en'
import { $devices } from '@/store/account'

import { describeLastSeen, describeRevokeFailure, DeviceList } from './device-list'

// The device list is where somebody who has lost a laptop goes. Two things
// have to hold: it must say which machine is which, and it must not lie about
// what a revocation did — a person told "revoked" who still has a working key
// on the stolen machine is worse off than one told nothing.

const original = window.agentxDesktop

function stubDevices(
  bridge: Record<string, unknown> | null,
  rest: Record<string, unknown> = {}
) {
  Object.defineProperty(window, 'agentxDesktop', {
    configurable: true,
    value: bridge === null ? { ...rest } : { devices: bridge, ...rest }
  })
}

function device(overrides: Record<string, unknown> = {}) {
  return {
    app_version: '0.18.0',
    created_at: '2026-08-01T00:00:00+00:00',
    current: false,
    id: '8f2b1c3d-0000-4000-8000-000000000001',
    last_seen_at: new Date().toISOString(),
    name: 'MacBook Pro',
    platform: 'darwin',
    revoked: false,
    revoked_at: null,
    ...overrides
  }
}

afterEach(() => {
  cleanup()
  $devices.set({
    available: false,
    current: '',
    devices: [],
    loaded: false,
    status: 'unconfigured'
  })
  Object.defineProperty(window, 'agentxDesktop', { configurable: true, value: original })
})

describe('DeviceList', () => {
  it('lists devices and marks the current one', async () => {
    stubDevices({
      list: async () => ({
        current: 'device-a',
        devices: [
          device({ current: true, id: 'device-a', name: 'MacBook Pro' }),
          device({ id: 'device-b', name: 'Windows desktop', platform: 'win32' })
        ],
        status: 'ok'
      }),
      revoke: async () => ({ status: 'ok' })
    })

    render(<DeviceList />)

    expect(await screen.findByText('MacBook Pro')).toBeTruthy()
    expect(screen.getByText('Windows desktop')).toBeTruthy()
    // Exactly one row says "this device" — the caller's, not a row property.
    expect(screen.getAllByText(/this device/i)).toHaveLength(1)
  })

  it('renders nothing when no account service is configured', async () => {
    // An install with no second brain has no device list. An empty section
    // headed "Your devices" reads as broken rather than absent.
    stubDevices({
      list: async () => ({ current: '', devices: [], status: 'unconfigured' }),
      revoke: async () => ({ status: 'unconfigured' })
    })

    const { container } = render(<DeviceList />)

    await waitFor(() => expect($devices.get().loaded).toBe(true))
    expect(container.textContent).toBe('')
  })

  it('degrades to a line when the service cannot be reached', async () => {
    const signOut = vi.fn(async () => ({ ok: true }))

    stubDevices(
      {
        list: async () => ({ current: 'device-a', devices: [], status: 'offline' }),
        revoke: async () => ({ status: 'offline' })
      },
      { keycloak: { signOut } }
    )

    render(<DeviceList />)

    expect(await screen.findByText(/could not reach the agentx account service/i)).toBeTruthy()
    // Never on `offline`. Signing somebody out over a network blip is the
    // exact mistake the offline contract exists to prevent.
    expect(signOut).not.toHaveBeenCalled()
  })

  it('hands a revoked device back to the sign-in gate', async () => {
    const signOut = vi.fn(async () => ({ ok: true }))
    const resetBootstrap = vi.fn(async () => undefined)

    stubDevices(
      {
        list: async () => ({ current: 'device-a', devices: [], status: 'revoked' }),
        revoke: async () => ({ status: 'revoked' })
      },
      { keycloak: { signOut }, resetBootstrap }
    )

    render(<DeviceList />)

    // Clearing the stored tokens is what stops this machine carrying on as a
    // device its owner has already cut off.
    await waitFor(() => expect(signOut).toHaveBeenCalled())
  })

  it('asks for confirmation before revoking, with the new-key box already ticked', async () => {
    const revoke = vi.fn(async () => ({ key_rotated: true, status: 'ok' }))

    stubDevices({
      list: async () => ({
        current: 'device-a',
        devices: [
          device({ current: true, id: 'device-a' }),
          device({ id: 'device-b', name: 'Windows desktop' })
        ],
        status: 'ok'
      }),
      revoke
    })

    render(<DeviceList />)

    fireEvent.click((await screen.findAllByRole('button', { name: /revoke device/i }))[1])

    // The safe default: revoking alone cannot cut model access, because the
    // devices share one key.
    const checkbox = await screen.findByRole('checkbox')

    expect(checkbox.getAttribute('data-state')).toBe('checked')
    expect(revoke).not.toHaveBeenCalled()
  })

  it('revokes with rotation by default', async () => {
    const revoke = vi.fn(async () => ({ key_rotated: true, status: 'ok' }))

    stubDevices({
      list: async () => ({
        current: 'device-a',
        devices: [device({ id: 'device-b', name: 'Windows desktop' })],
        status: 'ok'
      }),
      revoke
    })

    render(<DeviceList />)

    fireEvent.click(await screen.findByRole('button', { name: /^revoke device$/i }))
    fireEvent.click((await screen.findAllByRole('button', { name: /^revoke device$/i })).at(-1)!)

    await waitFor(() => expect(revoke).toHaveBeenCalledWith('device-b', { rotateKey: true }))
  })

  it('lets the new-key box be cleared', async () => {
    const revoke = vi.fn(async () => ({ key_rotated: false, status: 'ok' }))

    stubDevices({
      list: async () => ({
        current: 'device-a',
        devices: [device({ id: 'device-b', name: 'Windows desktop' })],
        status: 'ok'
      }),
      revoke
    })

    render(<DeviceList />)

    fireEvent.click(await screen.findByRole('button', { name: /^revoke device$/i }))
    fireEvent.click(await screen.findByRole('checkbox'))
    fireEvent.click((await screen.findAllByRole('button', { name: /^revoke device$/i })).at(-1)!)

    await waitFor(() => expect(revoke).toHaveBeenCalledWith('device-b', { rotateKey: false }))
  })

  it('explains the last-device refusal instead of failing generically', async () => {
    stubDevices({
      list: async () => ({
        current: 'device-a',
        devices: [device({ current: true, id: 'device-a' })],
        status: 'ok'
      }),
      revoke: async () => ({
        error: 'cannot_revoke_last_device',
        status: 'error',
        status_code: 409
      })
    })

    render(<DeviceList />)

    fireEvent.click(await screen.findByRole('button', { name: /^revoke device$/i }))
    fireEvent.click((await screen.findAllByRole('button', { name: /^revoke device$/i })).at(-1)!)

    // "Could not revoke that device" would leave the person guessing at what
    // to do; this one names the way out.
    expect(await screen.findByText(/only device left on your account/i)).toBeTruthy()
  })

  it('says plainly when the key was not rotated', async () => {
    stubDevices({
      list: async () => ({
        current: 'device-a',
        devices: [device({ id: 'device-b', name: 'Windows desktop' })],
        status: 'ok'
      }),
      revoke: async () => ({ key_rotated: false, key_rotation: 'unsupported', status: 'ok' })
    })

    render(<DeviceList />)

    fireEvent.click(await screen.findByRole('button', { name: /^revoke device$/i }))
    fireEvent.click((await screen.findAllByRole('button', { name: /^revoke device$/i })).at(-1)!)

    // Telling somebody who just revoked a stolen laptop that its model access
    // is gone, when it is not, is the failure this line exists to prevent.
    expect(await screen.findByText(/keeps the model key it already holds/i)).toBeTruthy()
  })
})

// --- The two pure helpers ---------------------------------------------------

function englishCopy() {
  return en.settings.account
}

describe('describeLastSeen', () => {
  const now = Date.parse('2026-08-13T12:00:00+00:00')

  it('reads recent activity as "now" rather than as "0 minutes ago"', () => {
    expect(describeLastSeen('2026-08-13T11:59:30+00:00', englishCopy(), now)).toMatch(/active now/i)
  })

  it('counts in the largest unit that still means something', () => {
    expect(describeLastSeen('2026-08-13T11:30:00+00:00', englishCopy(), now)).toMatch(/30 minutes/)
    expect(describeLastSeen('2026-08-13T09:00:00+00:00', englishCopy(), now)).toMatch(/3 hours/)
    expect(describeLastSeen('2026-08-10T12:00:00+00:00', englishCopy(), now)).toMatch(/3 days/)
  })

  it('does not render NaN when the service sends something unparseable', () => {
    const answer = describeLastSeen('not a date', englishCopy(), now)

    expect(answer).not.toMatch(/nan/i)
    expect(answer).toMatch(/unknown/i)
  })
})

describe('describeRevokeFailure', () => {
  it('branches on the machine-readable code, not on the prose', () => {
    const answer = describeRevokeFailure(
      { detail: 'whatever the server said today', error: 'cannot_revoke_last_device' },
      englishCopy()
    )

    expect(answer).toMatch(/only device left/i)
  })

  it('falls back to the service detail when the code is unknown', () => {
    expect(
      describeRevokeFailure({ detail: 'something specific', status: 'error' }, englishCopy())
    ).toBe('something specific')
  })

  it('has an answer even with nothing to go on', () => {
    expect(describeRevokeFailure({}, englishCopy())).toMatch(/could not revoke/i)
  })
})
