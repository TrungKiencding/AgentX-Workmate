import { atom } from 'nanostores'

import { getMessagingPlatforms } from '@/hermes'
import type { MessagingPlatformInfo } from '@/types/hermes'

export const $messagingPlatforms = atom<MessagingPlatformInfo[] | null>(null)

let snapshotProfile = ''
let refreshInFlight: { profile: string; promise: Promise<MessagingPlatformInfo[]> } | null = null

/** Shared platform snapshot for the Messaging page and persistent sidebar. */
export function refreshMessagingPlatforms(profile = 'default'): Promise<MessagingPlatformInfo[]> {
  if (snapshotProfile !== profile) {
    snapshotProfile = profile
    $messagingPlatforms.set(null)
  }

  if (refreshInFlight?.profile === profile) {
    return refreshInFlight.promise
  }

  const promise = getMessagingPlatforms()
    .then(result => {
      if (snapshotProfile === profile) {
        $messagingPlatforms.set(result.platforms)
      }

      return result.platforms
    })
    .finally(() => {
      if (refreshInFlight?.promise === promise) {
        refreshInFlight = null
      }
    })

  refreshInFlight = { profile, promise }

  return promise
}

export function updateMessagingPlatforms(
  update: (platforms: MessagingPlatformInfo[] | null) => MessagingPlatformInfo[] | null
): void {
  $messagingPlatforms.set(update($messagingPlatforms.get()))
}
