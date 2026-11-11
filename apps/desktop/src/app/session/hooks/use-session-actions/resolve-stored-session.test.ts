import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as HermesModule from '@/hermes'
import { getSession } from '@/hermes'
import { $activeGatewayProfile, $profiles } from '@/store/profile'
import { $sessions } from '@/store/session'
import type { SessionInfo } from '@/types/hermes'

import { resolveSessionProfile, resolveStoredSession } from './utils'

vi.mock('@/hermes', async importActual => ({
  ...(await importActual<typeof HermesModule>()),
  getSession: vi.fn()
}))

const mockGetSession = vi.mocked(getSession)

const session = (over: Partial<SessionInfo>): SessionInfo => over as SessionInfo

const profiles = (...names: string[]) => names.map(name => ({ name }) as never)

describe('resolveStoredSession profile ownership', () => {
  beforeEach(() => {
    $sessions.set([])
    $profiles.set(profiles('default', 'meta'))
    $activeGatewayProfile.set('meta')
    mockGetSession.mockReset()
  })

  afterEach(() => {
    $sessions.set([])
    $profiles.set([])
    $activeGatewayProfile.set('default')
  })

  it('returns a cached row that carries an owning profile', async () => {
    $sessions.set([session({ id: 's1', profile: 'default' })])

    const resolved = await resolveStoredSession('s1')

    expect(resolved?.profile).toBe('default')
    expect(mockGetSession).not.toHaveBeenCalled()
  })

  it('treats a profile-less cache hit as unresolved when multiple profiles exist', async () => {
    $sessions.set([session({ id: 's1' })])
    mockGetSession.mockRejectedValueOnce(new Error('404: Session not found'))
    mockGetSession.mockResolvedValueOnce(session({ id: 's1', profile: 'default' }))

    const resolved = await resolveStoredSession('s1')

    expect(resolved?.profile).toBe('default')
    // rung 2 (the active profile, by name — it is not the primary) then rung 3
    // (stamped cross-profile probe)
    expect(mockGetSession).toHaveBeenNthCalledWith(1, 's1', 'meta')
    expect(mockGetSession).toHaveBeenNthCalledWith(2, 's1', 'default')
  })

  it('accepts a profile-less cache hit for single-profile users', async () => {
    $profiles.set(profiles('default'))
    $sessions.set([session({ id: 's1' })])

    const resolved = await resolveStoredSession('s1')

    expect(resolved?.id).toBe('s1')
    expect(mockGetSession).not.toHaveBeenCalled()
  })

  it('stamps the active profile on a bare by-id hit from an older backend', async () => {
    $activeGatewayProfile.set('default')
    mockGetSession.mockResolvedValueOnce(session({ id: 's1' }))

    const resolved = await resolveStoredSession('s1')

    // The primary profile is active, so the bare GET is its own backend.
    expect(mockGetSession).toHaveBeenCalledWith('s1')
    expect(resolved?.profile).toBe('default')
    // the upserted cache row is owned too, so the next hit short-circuits
    expect($sessions.get().find(s => s.id === 's1')?.profile).toBe('default')
  })

  // Pilot 2026-11: an assistant's conversation opened from the Trợ lý page came
  // up blank. A bare GET is answered by the primary backend, so with the
  // assistant's profile active the lookup missed there, and the cross-profile
  // probe then skipped the assistant as "already asked".
  it('finds a session on the active profile when that profile is not the primary', async () => {
    $profiles.set(profiles('default', 'meta', 'bot-nghien-cuu'))
    $activeGatewayProfile.set('bot-nghien-cuu')
    mockGetSession.mockImplementation(async (_id, profile) => {
      if (profile === 'bot-nghien-cuu') {
        return session({ id: 'cron_abc_20261110', message_count: 4 })
      }

      throw new Error('404: Session not found')
    })

    const resolved = await resolveStoredSession('cron_abc_20261110')

    expect(mockGetSession).toHaveBeenCalledTimes(1)
    expect(mockGetSession).toHaveBeenCalledWith('cron_abc_20261110', 'bot-nghien-cuu')
    expect(resolved?.profile).toBe('bot-nghien-cuu')
    await expect(resolveSessionProfile('cron_abc_20261110')).resolves.toBe('bot-nghien-cuu')
  })

  it('never asks one profile twice', async () => {
    $profiles.set(profiles('default', 'meta', 'bot'))
    $activeGatewayProfile.set('bot')
    mockGetSession.mockRejectedValue(new Error('404: Session not found'))

    await expect(resolveStoredSession('missing')).resolves.toBeUndefined()

    expect(mockGetSession.mock.calls).toEqual([
      ['missing', 'bot'],
      ['missing', 'default'],
      ['missing', 'meta']
    ])
  })

  it('probed desktop profile overrides a remote backend answering as its own "default"', async () => {
    // Per-profile remote override: Electron strips the desktop alias before
    // forwarding, so the standalone backend stamps its backend-local root.
    mockGetSession.mockRejectedValueOnce(new Error('404: Session not found'))
    mockGetSession.mockResolvedValueOnce(session({ id: 's1', profile: 'default' }))
    $activeGatewayProfile.set('default')
    $profiles.set(profiles('default', 'meta'))

    const resolved = await resolveStoredSession('s1')

    expect(resolved?.profile).toBe('meta')
    expect($sessions.get().find(s => s.id === 's1')?.profile).toBe('meta')
  })

  it('stamps the probed profile on a scoped hit from an older backend that omits it', async () => {
    mockGetSession.mockRejectedValueOnce(new Error('404: Session not found'))
    mockGetSession.mockResolvedValueOnce(session({ id: 's1' }))

    const resolved = await resolveStoredSession('s1')

    expect(resolved?.profile).toBe('default')
    // the cached row is owned too — no unowned row is ever re-cached
    expect($sessions.get().find(s => s.id === 's1')?.profile).toBe('default')
  })

  it('resolveSessionProfile routes a default-profile session from a non-default gateway', async () => {
    mockGetSession.mockRejectedValueOnce(new Error('404: Session not found'))
    mockGetSession.mockResolvedValueOnce(session({ id: 's1', profile: 'default' }))

    await expect(resolveSessionProfile('s1')).resolves.toBe('default')
  })
})
