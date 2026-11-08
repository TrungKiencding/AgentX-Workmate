import { atom } from 'nanostores'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const order: string[] = []
const $activeGatewayProfile = atom('default')
const $homeProfile = atom<null | string>(null)

vi.mock('@/hermes', () => ({
  deleteProfile: vi.fn(async (name: string) => {
    order.push(`delete:${name}`)

    return { ok: true, path: '' }
  }),
  getLogs: vi.fn(),
  getStatus: vi.fn()
}))

vi.mock('@/store/gateway', () => ({
  $gateway: atom(null),
  primaryGateway: vi.fn(() => null),
  primaryGatewayProfile: vi.fn(() => 'default'),
  retireGatewayForProfile: vi.fn((name: string) => order.push(`retire:${name}`))
}))

vi.mock('@/store/profile', () => ({
  $activeGatewayProfile,
  $homeProfile,
  ensureGatewayProfile: vi.fn(async (name: string) => {
    order.push(`activate:${name}`)
    $activeGatewayProfile.set(name)
  }),
  homeProfileKey: () => $homeProfile.get() ?? 'default',
  newSessionInProfile: vi.fn(),
  normalizeProfileKey: (name: null | string | undefined) => (name ?? '').trim() || 'default',
  prewarmProfileBackend: vi.fn(),
  refreshProfiles: vi.fn(async () => {
    order.push('refresh')

    return []
  }),
  requestFreshSession: vi.fn((options?: { keepRoute?: boolean }) =>
    order.push(`fresh:${options?.keepRoute ? 'keep-route' : 'navigate'}`)
  ),
  setActiveProfile: vi.fn()
}))

const { host } = await import('./index')

beforeEach(() => {
  order.length = 0
  $activeGatewayProfile.set('default')
  $homeProfile.set(null)
})

describe('host.deleteProfile', () => {
  it('a background assistant: retire its socket first, then delete — no navigation', async () => {
    await host.deleteProfile('writer')

    expect(order).toEqual(['retire:writer', 'delete:writer', 'refresh'])
  })

  it('the live one: go home and reset the chat in place before the delete', async () => {
    $activeGatewayProfile.set('writer')

    await host.deleteProfile('writer')

    expect(order).toEqual(['activate:default', 'fresh:keep-route', 'retire:writer', 'delete:writer', 'refresh'])
  })

  it('home itself: home falls back to the window backend', async () => {
    $homeProfile.set('writer')
    $activeGatewayProfile.set('writer')

    await host.deleteProfile('writer')

    expect(order[0]).toBe('activate:default')
    expect($homeProfile.get()).toBeNull()
  })
})
