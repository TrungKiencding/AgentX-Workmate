import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DesktopDevice } from '@/global'
import { en } from '@/i18n/en'
import { $devices } from '@/store/account'

import { DeviceList } from './device-list'
import { describeLastSeen, describeRevokeFailure } from './device-presentation'

// The device list is where somebody who has lost a laptop goes. Two things
// have to hold: it must say which machine is which, and it must not lie about
// what a revocation did — a person told "revoked" who still has a working key
// on the stolen machine is worse off than one told nothing.

const original = window.agentxDesktop

function stubDevices(bridge: Record<string, unknown> | null, rest: Record<string, unknown> = {}) {
  Object.defineProperty(window, 'agentxDesktop', {
    configurable: true,
    value: bridge === null ? { ...rest } : { devices: bridge, ...rest }
  })
}

function device(overrides: Partial<DesktopDevice> = {}): DesktopDevice {
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
    refreshing: false,
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

    expect(await screen.findByRole('article', { name: /^MacBook Pro/ })).toBeTruthy()
    expect(screen.getByRole('article', { name: /^Windows desktop/ })).toBeTruthy()
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
        devices: [device({ current: true, id: 'device-a' }), device({ id: 'device-b', name: 'Windows desktop' })],
        status: 'ok'
      }),
      revoke
    })

    render(<DeviceList />)

    fireEvent.click(await screen.findByRole('button', { name: /revoke device/i }))

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
        devices: [device({ id: 'device-b' })],
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
    expect(await screen.findByText(en.settings.account.deviceRotationUnsupported)).toBeTruthy()
  })

  it('does not claim an account with no model key still has a usable old key', async () => {
    stubDevices({
      list: async () => ({ current: 'device-a', devices: [device({ id: 'device-b' })], status: 'ok' }),
      revoke: async () => ({ key_rotated: false, key_rotation: 'no_key', status: 'ok' })
    })
    render(<DeviceList />)
    fireEvent.click(await screen.findByRole('button', { name: /^revoke device$/i }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /^revoke device$/i }))
    const result = await screen.findByRole('status')

    expect(result.textContent).toContain(en.settings.account.deviceRotationNoKey)
    expect(within(result).queryByRole('button')).toBeNull()
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
    expect(describeRevokeFailure({ detail: 'something specific', status: 'error' }, englishCopy())).toBe(
      'something specific'
    )
  })

  it('has an answer even with nothing to go on', () => {
    expect(describeRevokeFailure({}, englishCopy())).toMatch(/could not revoke/i)
  })
})

describe('device management experience', () => {
  it('keeps identically named installs separate and puts revoked records in collapsed history', async () => {
    stubDevices({
      list: async () => ({
        current: 'device-a',
        status: 'ok',
        devices: [
          device({ id: 'device-a' }),
          device({ id: 'device-b' }),
          device({ id: 'revoked', name: 'Old Mac', revoked: true, revoked_at: '2026-10-10T00:00:00Z' })
        ]
      })
    })
    const { container } = render(<DeviceList />)
    await screen.findByText(en.settings.account.deviceOtherTitle(1))
    expect(screen.getByText(en.settings.account.deviceDuplicateHint)).toBeTruthy()
    const history = screen.getByText(en.settings.account.deviceHistoryTitle(1)).closest('details')!
    expect(history.open).toBe(false)
    expect(screen.getAllByText(en.settings.account.deviceCurrent)).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: en.settings.account.deviceRevoke })).toHaveLength(1)
    expect(container.textContent).toContain('macOS')
    expect(container.textContent).not.toContain('darwin')
  })

  it('offers only local sign-out on the current device, with explicit confirmation', async () => {
    const signOut = vi.fn(async () => undefined)
    const revoke = vi.fn()
    stubDevices(
      { list: async () => ({ current: 'device-a', status: 'ok', devices: [device({ id: 'device-a' })] }), revoke },
      { keycloak: { signOut } }
    )
    render(<DeviceList />)
    const row = await screen.findByRole('article')
    row.querySelector('details')!.open = true
    fireEvent.click(screen.getByRole('button', { name: en.settings.account.deviceSignOutHere }))
    expect(await screen.findByRole('dialog')).toBeTruthy()
    expect(signOut).not.toHaveBeenCalled()
    expect(revoke).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.common.cancel }))
    expect(signOut).not.toHaveBeenCalled()
  })

  it('keeps failed revocations in the dialog and prevents duplicate submissions while pending', async () => {
    let finish!: (value: unknown) => void

    const revoke = vi.fn(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )

    stubDevices({
      list: async () => ({ current: 'device-a', status: 'ok', devices: [device({ id: 'device-b' })] }),
      revoke
    })
    render(<DeviceList />)
    fireEvent.click(await screen.findByRole('button', { name: en.settings.account.deviceRevoke }))
    fireEvent.click(screen.getAllByRole('button', { name: en.settings.account.deviceRevoke }).at(-1)!)
    await waitFor(() => expect(revoke).toHaveBeenCalledTimes(1))
    expect(screen.getByText(en.settings.account.deviceRevoking)).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' })
    expect(revoke).toHaveBeenCalledTimes(1)
    finish({ status: 'offline' })
    expect(await screen.findByText(en.settings.account.deviceOffline)).toBeTruthy()
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect($devices.get().devices[0].revoked).toBe(false)
  })

  it('does not revoke when Space toggles the checkbox or Enter activates Cancel', async () => {
    const revoke = vi.fn()
    stubDevices({
      list: async () => ({ current: 'device-a', status: 'ok', devices: [device({ id: 'device-b' })] }),
      revoke
    })
    render(<DeviceList />)
    fireEvent.click(await screen.findByRole('button', { name: en.settings.account.deviceRevoke }))
    fireEvent.keyDown(screen.getByRole('checkbox'), { key: ' ' })
    fireEvent.keyDown(screen.getByRole('button', { name: en.common.cancel }), { key: 'Enter' })
    expect(revoke).not.toHaveBeenCalled()
  })

  it('allows retry after partial failure and keeps recovery available when Settings reopens', async () => {
    let row = device({ id: 'device-b', name: 'Old Mac' })
    let attempts = 0

    const revoke = vi.fn(async () => {
      attempts += 1
      row = { ...row, revoked: true, revoked_at: '2026-10-10T00:00:00Z' }

      return { status: 'ok', device: row, key_rotated: attempts > 1, key_rotation: attempts > 1 ? 'rotated' : 'failed' }
    })

    stubDevices({ list: async () => ({ current: 'device-a', status: 'ok', devices: [row] }), revoke })
    const view = render(<DeviceList />)
    fireEvent.click(await screen.findByRole('button', { name: en.settings.account.deviceRevoke }))
    fireEvent.click(screen.getAllByRole('button', { name: en.settings.account.deviceRevoke }).at(-1)!)
    expect(await screen.findByText(en.settings.account.deviceRotationFailed)).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(within(screen.getByRole('status')).getByRole('button', { name: en.settings.account.deviceRotateRetry }))
    fireEvent.click(screen.getAllByRole('button', { name: en.settings.account.deviceRotateRetry }).at(-1)!)
    expect(await screen.findByText(en.settings.account.deviceRotationDone)).toBeTruthy()
    expect(revoke).toHaveBeenLastCalledWith('device-b', { rotateKey: true })
    view.unmount()
    render(<DeviceList />)
    const history = (await screen.findByText(en.settings.account.deviceHistoryTitle(1))).closest('details')!
    history.open = true
    history.querySelector('article details')!.setAttribute('open', '')
    expect(within(history).getByRole('button', { name: en.settings.account.deviceRotateRetry })).toBeTruthy()
  })

  it('changes an account label while keeping the original machine name', async () => {
    let row = device({ id: 'device-b' })

    const rename = vi.fn(async (_id, name) => {
      row = { ...row, display_name: name }

      return { status: 'ok', device: row }
    })

    stubDevices({ list: async () => ({ current: 'device-a', status: 'ok', can_rename: true, devices: [row] }), rename })
    render(<DeviceList />)
    const article = await screen.findByRole('article')
    article.querySelector('details')!.open = true
    fireEvent.click(screen.getByRole('button', { name: en.settings.account.deviceRename }))
    fireEvent.change(screen.getByRole('textbox', { name: en.settings.account.deviceRename }), {
      target: { value: ' Work laptop ' }
    })
    fireEvent.click(screen.getByRole('button', { name: en.common.save }))
    await waitFor(() => expect(rename).toHaveBeenCalledWith('device-b', 'Work laptop'))
    expect(await screen.findByText('Work laptop')).toBeTruthy()
    expect(screen.getByText('MacBook Pro')).toBeTruthy()
  })
})
