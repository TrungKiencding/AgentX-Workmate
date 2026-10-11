import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopDevice, DesktopDeviceList, DesktopDeviceRevokeResult } from '@/global'

import { $devices, $keycloakAccount, refreshDevices, renameDevice, revokeDevice } from './account'

const original = window.agentxDesktop

const current: DesktopDevice = {
  id: 'current',
  name: 'same-host',
  platform: 'darwin',
  app_version: '1',
  current: true,
  created_at: '2026-10-01T00:00:00Z',
  last_seen_at: '2026-10-11T00:00:00Z',
  revoked_at: null,
  revoked: false
}

const other: DesktopDevice = { ...current, id: 'other', current: false }
const list: DesktopDeviceList = { current: current.id, devices: [current, other], status: 'ok', can_rename: true }
const revoked: DesktopDevice = { ...other, revoked: true, revoked_at: '2026-10-11T01:00:00Z' }

function deferred<T>() {
  let resolve!: (value: T) => void

  const promise = new Promise<T>(done => {
    resolve = done
  })

  return { promise, resolve }
}

function stub(bridge: Record<string, unknown>) {
  Object.defineProperty(window, 'agentxDesktop', { configurable: true, value: { devices: bridge } })
}

beforeEach(() => {
  $keycloakAccount.set({ ...$keycloakAccount.get(), userId: 'alice', issuer: 'sso', signedIn: true })
  $devices.set({ ...list, available: true, loaded: true, refreshing: false })
})

afterEach(() => {
  $keycloakAccount.set({ ...$keycloakAccount.get(), userId: '', signedIn: false })
  Object.defineProperty(window, 'agentxDesktop', { configurable: true, value: original })
})

describe('device reconciliation', () => {
  it('keeps the last known list through an outage, without allowing a revoked caller to retain it', async () => {
    stub({ list: async () => ({ status: 'offline', current: '', devices: [] }) })
    await refreshDevices()
    expect($devices.get().devices).toEqual(list.devices)
    expect($devices.get().current).toBe(current.id)
    expect($devices.get().status).toBe('offline')
    stub({ list: async () => ({ status: 'revoked', current: current.id, devices: [] }) })
    await refreshDevices()
    expect($devices.get().devices).toEqual([])
    expect($devices.get().status).toBe('revoked')
  })

  it('handles a synchronous bridge failure and stops loading', async () => {
    stub({
      list: () => {
        throw new Error('IPC unavailable')
      }
    })
    await refreshDevices()
    expect($devices.get().status).toBe('offline')
    expect($devices.get().refreshing).toBe(false)
    expect($devices.get().devices).toEqual(list.devices)
  })

  it('never publishes a read that completed behind a newer read', async () => {
    const old = deferred<DesktopDeviceList>()
    const newest = { ...list, devices: [current, revoked] }
    stub({ list: vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(newest) })
    const pending = refreshDevices()
    await refreshDevices()
    old.resolve(list)
    await pending
    expect($devices.get().devices).toEqual(newest.devices)
  })

  it('never shows another account’s cached or pending devices', async () => {
    const old = deferred<DesktopDeviceList>()
    stub({ list: () => old.promise })
    const pending = refreshDevices()
    $keycloakAccount.set({ ...$keycloakAccount.get(), userId: 'bob' })
    expect($devices.get().devices).toEqual([])
    old.resolve(list)
    await pending
    expect($devices.get().devices).toEqual([])
    expect($devices.get().loaded).toBe(false)
  })

  it('applies a confirmed revocation before refetch and retains it if refetch goes offline', async () => {
    const refetch = deferred<DesktopDeviceList>()
    stub({
      revoke: async () => ({ status: 'ok', device: revoked, key_rotation: 'failed', key_rotated: false }),
      list: () => refetch.promise
    })
    const pending = revokeDevice(other.id, { rotateKey: true })
    await vi.waitFor(() => expect($devices.get().devices.find(row => row.id === other.id)?.revoked).toBe(true))
    refetch.resolve({ ...list, status: 'offline', devices: [] })
    expect((await pending).key_rotation).toBe('failed')
    expect($devices.get().devices.find(row => row.id === other.id)).toEqual(revoked)
  })

  it('invalidates reads started before a mutation', async () => {
    const old = deferred<DesktopDeviceList>()
    stub({
      revoke: async () => ({ status: 'ok', device: revoked }),
      list: vi
        .fn()
        .mockReturnValueOnce(old.promise)
        .mockResolvedValueOnce({ ...list, devices: [current, revoked] })
    })
    const pending = refreshDevices()
    await revokeDevice(other.id)
    old.resolve(list)
    await pending
    expect($devices.get().devices.find(row => row.id === other.id)?.revoked).toBe(true)
  })

  it('leaves a device authorized after a rejected revocation', async () => {
    stub({ revoke: async () => ({ status: 'error', error: 'cannot_revoke_last_device' }), list: async () => list })
    expect((await revokeDevice(other.id)).status).toBe('error')
    expect($devices.get().devices).toEqual(list.devices)
  })

  it('handles self-revocation immediately without relying on another authenticated request', async () => {
    const reread = vi.fn()
    stub({ revoke: async () => ({ status: 'ok', device: { ...current, revoked: true } }), list: reread })
    await revokeDevice(current.id)
    expect($devices.get().status).toBe('revoked')
    expect($devices.get().devices).toEqual([])
    expect(reread).not.toHaveBeenCalled()
  })

  it('does not apply an old mutation after switching accounts', async () => {
    const response = deferred<DesktopDeviceRevokeResult>()
    const reread = vi.fn()
    stub({ revoke: () => response.promise, list: reread })
    const pending = revokeDevice(other.id)
    $keycloakAccount.set({ ...$keycloakAccount.get(), userId: 'bob' })
    response.resolve({ status: 'ok', device: revoked })
    await pending
    expect($devices.get().devices).toEqual([])
    expect(reread).not.toHaveBeenCalled()
  })

  it('keeps a confirmed label through an offline refresh', async () => {
    const rename = vi.fn(async () => ({ status: 'ok', device: { ...other, display_name: 'Work laptop' } }))
    stub({ rename, list: async () => ({ ...list, devices: [], status: 'offline' }) })
    await renameDevice(other.id, 'Work laptop')
    expect(rename).toHaveBeenCalledWith(other.id, 'Work laptop')
    expect($devices.get().devices.find(row => row.id === other.id)?.display_name).toBe('Work laptop')
  })

  it('ignores a mutation from a previous login even after returning to the same account', async () => {
    const response = deferred<DesktopDeviceRevokeResult>()
    const reread = vi.fn()
    stub({ revoke: () => response.promise, list: reread })
    const pending = revokeDevice(other.id)
    $keycloakAccount.set({ ...$keycloakAccount.get(), userId: 'bob' })
    $keycloakAccount.set({ ...$keycloakAccount.get(), userId: 'alice' })
    response.resolve({ status: 'ok', device: revoked })
    await pending
    expect($devices.get().devices).toEqual([])
    expect(reread).not.toHaveBeenCalled()
  })

  it('handles synchronous rename errors without leaving a pending form', async () => {
    stub({
      rename: () => {
        throw new Error('IPC unavailable')
      },
      list: async () => list
    })
    expect((await renameDevice(other.id, 'Work laptop')).status).toBe('offline')
    expect($devices.get().devices).toEqual(list.devices)
    expect($devices.get().refreshing).toBe(false)
  })

  it('requires both service and preload support before enabling rename', async () => {
    stub({ list: async () => list })
    await refreshDevices()
    expect($devices.get().can_rename).toBe(false)
    stub({ list: async () => list, rename: vi.fn() })
    await refreshDevices()
    expect($devices.get().can_rename).toBe(true)
  })
})
