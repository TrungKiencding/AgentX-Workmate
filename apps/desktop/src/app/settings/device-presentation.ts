import type { DesktopDevice } from '@/global'
import type { Translations } from '@/i18n/types'

type AccountCopy = Translations['settings']['account']

/**
 * When a machine was last used, in words rather than a timestamp.
 *
 * "3 days ago" is the question being asked here — "is this the laptop I left
 * at the office?" — and an ISO string makes the reader do the subtraction.
 * Exported so its edges are testable without rendering anything.
 */
export function describeLastSeen(iso: string, copy: AccountCopy, now = Date.now()): string {
  const seen = Date.parse(iso || '')

  if (Number.isNaN(seen)) {
    return copy.deviceLastSeenUnknown
  }

  const minutes = Math.floor((now - seen) / 60_000)

  if (minutes < 2) {
    return copy.deviceLastSeenNow
  }

  if (minutes < 60) {
    return copy.deviceLastSeenMinutes(minutes)
  }

  const hours = Math.floor(minutes / 60)

  if (hours < 24) {
    return copy.deviceLastSeenHours(hours)
  }

  return copy.deviceLastSeenDays(Math.floor(hours / 24))
}

/**
 * Turn a revoke outcome into a sentence the person can act on.
 *
 * Table-driven over the service's machine-readable code rather than its prose,
 * so improving a message on the server cannot silently change what the app
 * says here — and so the one refusal a person can actually do something about,
 * "this is your last device", gets its own explanation instead of a generic
 * failure.
 */
export function describeRevokeFailure(
  result: { detail?: string; error?: string; status?: string },
  copy: AccountCopy
): string {
  if (result.error === 'cannot_revoke_last_device') {
    return copy.deviceRevokeLastError
  }

  const byStatus: Record<string, string> = {
    offline: copy.deviceOffline,
    revoked: copy.deviceRevokedSelf,
    unconfigured: copy.deviceUnconfigured
  }

  return byStatus[result.status || ''] || result.detail || copy.deviceRevokeFailed
}

export function deviceDisplayName(device: DesktopDevice, copy: AccountCopy): string {
  return device.display_name || device.name || copy.deviceUnnamed
}

export function devicePlatform(platform: string, copy: AccountCopy): string {
  const names: Record<string, string> = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' }

  return names[platform] || platform || copy.deviceUnknown
}

function timestamp(value: string | null): number {
  return Date.parse(value || '') || 0
}

/** Names are hints, never identity: distinct installs must remain individually revocable. */
export function groupDevices(devices: DesktopDevice[], current: string) {
  const live = devices.filter(device => !device.revoked)
  const names = new Map<string, number>()

  for (const device of live) {
    const name = device.display_name || device.name

    names.set(name, (names.get(name) || 0) + 1)
  }

  const newest = (a: DesktopDevice, b: DesktopDevice) => timestamp(b.last_seen_at) - timestamp(a.last_seen_at)

  return {
    current: live.filter(device => device.id === current).map(device => ({ ...device, current: true })),
    duplicateNames: new Set([...names].filter(([, count]) => count > 1).map(([name]) => name)),
    other: live
      .filter(device => device.id !== current)
      .map(device => ({ ...device, current: false }))
      .sort(newest),
    revoked: devices.filter(device => device.revoked).sort((a, b) => timestamp(b.revoked_at) - timestamp(a.revoked_at))
  }
}
