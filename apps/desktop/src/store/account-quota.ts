import { atom, onMount } from 'nanostores'

import type { DesktopAccountQuotaView } from '@/global'
import { $keycloakAccount } from '@/store/account'

export interface AccountQuotaState extends DesktopAccountQuotaView {
  loaded: boolean
  refreshing: boolean
}

const INITIAL: AccountQuotaState = { status: 'unavailable', quota: null, loaded: false, refreshing: false }
export const $accountQuota = atom<AccountQuotaState>(INITIAL)
let generation = 0
let pending: Promise<void> | null = null
let mounted = false

function scope() {
  const account = $keycloakAccount.get()

  return JSON.stringify([account.issuer, account.userId, account.signedIn])
}

let accountScope = scope()
$keycloakAccount.listen(() => {
  const next = scope()

  if (next !== accountScope) {
    accountScope = next
    generation++
    pending = null
    $accountQuota.set({ ...INITIAL })

    if (mounted) {
      void refreshAccountQuota()
    }
  }
})

/** Coalesce focus, timer and turn-completion reads; never publish a previous person's answer. */
export function refreshAccountQuota(): Promise<void> {
  if (pending) {
    return pending
  }

  const read = window.agentxDesktop?.account?.quota

  if (!$keycloakAccount.get().signedIn || !read) {
    $accountQuota.set({ ...INITIAL, loaded: true })

    return Promise.resolve()
  }

  const requestGeneration = generation

  const request = Promise.resolve()
    .then(() => {
      if (requestGeneration !== generation) {
        return { status: 'unavailable', quota: null } as DesktopAccountQuotaView
      }

      // Publish after `pending` is assigned: get() may mount the store and
      // trigger its first refresh, which must join this very same read.
      $accountQuota.set({ ...$accountQuota.get(), refreshing: true })

      return read()
    })
    .catch((): DesktopAccountQuotaView => ({ status: 'offline', quota: null }))
    .then(view => {
      if (requestGeneration !== generation) {
        return
      }

      const previous = $accountQuota.get()
      const transient = view.status === 'offline' || view.status === 'error'
      $accountQuota.set({ ...view, quota: transient ? previous.quota : view.quota, loaded: true, refreshing: false })
    })
    .finally(() => {
      if (requestGeneration === generation) {
        pending = null
      }
    })

  pending = request

  return request
}

/** Only active while a chat composer consumes the budget. Hidden windows do no periodic work. */
onMount($accountQuota, () => {
  mounted = true
  void refreshAccountQuota()

  const refresh = () => {
    if (document.visibilityState !== 'hidden') {
      void refreshAccountQuota()
    }
  }

  const interval = window.setInterval(refresh, 30_000)
  window.addEventListener('focus', refresh)
  document.addEventListener('visibilitychange', refresh)

  return () => {
    mounted = false
    window.clearInterval(interval)
    window.removeEventListener('focus', refresh)
    document.removeEventListener('visibilitychange', refresh)
  }
})

export function invalidateAccountQuota(): void {
  if (mounted) {
    void refreshAccountQuota()
  }
}
