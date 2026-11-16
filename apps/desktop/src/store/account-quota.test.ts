import { cleanStores } from 'nanostores'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { DesktopAccountQuotaView } from '@/global'
import { $keycloakAccount } from '@/store/account'

import { $accountQuota, invalidateAccountQuota, refreshAccountQuota } from './account-quota'

const original = window.agentxDesktop
const account = $keycloakAccount.get()

const answer: DesktopAccountQuotaView = {
  status: 'ok',
  quota: {
    spend: 12,
    limit: 50,
    remaining: 38,
    renews: true,
    reset_at: '2026-12-01T00:00:00Z',
    updated_at: '2026-11-09T12:00:00Z'
  }
}

const stub = (quota: () => Promise<DesktopAccountQuotaView>) =>
  Object.defineProperty(window, 'agentxDesktop', { configurable: true, value: { account: { quota } } })

beforeEach(() => {
  cleanStores($accountQuota)
  $keycloakAccount.set({ ...account, signedIn: true, issuer: 'sso', userId: 'alice' })
})
afterEach(() => {
  cleanStores($accountQuota)
  $keycloakAccount.set(account)
  Object.defineProperty(window, 'agentxDesktop', { configurable: true, value: original })
})

it('coalesces reads and retains an explicitly stale snapshot through outages', async () => {
  const read = vi.fn().mockResolvedValue(answer)
  stub(read)
  await Promise.all([refreshAccountQuota(), refreshAccountQuota(), refreshAccountQuota()])
  expect(read).toHaveBeenCalledTimes(1)
  expect($accountQuota.get().quota).toEqual(answer.quota)
  read.mockRejectedValue(new Error('offline'))
  await refreshAccountQuota()
  expect($accountQuota.get()).toMatchObject({ quota: answer.quota, status: 'offline', refreshing: false })
  read.mockResolvedValue({ status: 'forbidden', quota: null })
  await refreshAccountQuota()
  expect($accountQuota.get().quota).toBeNull()
})

it('drops cached and pending answers across account switches, including back to the same account', async () => {
  let resolve!: (view: DesktopAccountQuotaView) => void
  stub(
    () =>
      new Promise(done => {
        resolve = done
      })
  )
  const old = refreshAccountQuota()
  await Promise.resolve()
  $keycloakAccount.set({ ...$keycloakAccount.get(), userId: 'bob' })
  $keycloakAccount.set({ ...$keycloakAccount.get(), userId: 'alice' })
  resolve(answer)
  await old
  expect($accountQuota.get().quota).toBeNull()
  expect($accountQuota.get().loaded).toBe(false)
})

it('handles a missing capability and a synchronous bridge failure', async () => {
  Object.defineProperty(window, 'agentxDesktop', { configurable: true, value: {} })
  await refreshAccountQuota()
  expect($accountQuota.get()).toMatchObject({ quota: null, loaded: true, refreshing: false })
  stub(() => {
    throw new Error('IPC gone')
  })
  await refreshAccountQuota()
  expect($accountQuota.get()).toMatchObject({ status: 'offline', refreshing: false })
})

it('automatically reads server values on the timer, focus and turn completion without polling hidden windows', async () => {
  vi.useFakeTimers()
  const read = vi.fn().mockResolvedValue(answer)
  stub(read)
  const visibility = vi.spyOn(window.document, 'visibilityState', 'get').mockReturnValue('visible')
  const unsubscribe = $accountQuota.listen(() => {})

  try {
    await refreshAccountQuota()
    read.mockClear()
    const newer = { ...answer, quota: { ...answer.quota!, spend: 25, remaining: 25 } }
    read.mockResolvedValue(newer)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(read).toHaveBeenCalledTimes(1)
    expect($accountQuota.get().quota).toEqual(newer.quota)

    visibility.mockReturnValue('hidden')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(read).toHaveBeenCalledTimes(1)

    visibility.mockReturnValue('visible')
    window.dispatchEvent(new Event('focus'))
    await refreshAccountQuota()
    expect(read).toHaveBeenCalledTimes(2)

    invalidateAccountQuota()
    await refreshAccountQuota()
    expect(read).toHaveBeenCalledTimes(3)
  } finally {
    unsubscribe()
    cleanStores($accountQuota)
    visibility.mockRestore()
    vi.useRealTimers()
  }
})
