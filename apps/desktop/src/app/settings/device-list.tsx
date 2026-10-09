import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import type { DesktopDevice } from '@/global'
import { useI18n } from '@/i18n'
import { Check, Monitor } from '@/lib/icons'
import { $devices, refreshDevices, revokeDevice, signOutKeycloak } from '@/store/account'

import { ListRow, Pill, SectionHeading } from './primitives'

type AccountCopy = ReturnType<typeof useI18n>['t']['settings']['account']

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

/** The one line under a device's name: what it is, and when it was last here. */
function describeDevice(device: DesktopDevice, copy: AccountCopy): string {
  const parts = [device.platform, device.app_version].filter(Boolean)

  const when = device.revoked ? copy.deviceRevoked : describeLastSeen(device.last_seen_at, copy)

  return [parts.join(' · '), when].filter(Boolean).join(' — ')
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

/**
 * Settings → Account → Devices: which machines you are signed in on.
 *
 * Renders nothing at all when no service is configured. An install with no
 * second brain has no device list, and an empty section headed "Devices" reads
 * as a feature that is broken rather than one that is absent.
 *
 * Everything else degrades in place: an unreachable service shows a line
 * saying so, and the rest of Settings is untouched.
 */
export function DeviceList() {
  const { t } = useI18n()
  const devices = useStore($devices)
  const copy = t.settings.account
  const [target, setTarget] = useState<DesktopDevice | null>(null)
  const [rotateKey, setRotateKey] = useState(true)
  const [outcome, setOutcome] = useState<null | string>(null)

  useEffect(() => {
    void refreshDevices()
  }, [])

  // Somebody revoked THIS machine. Hand the app back to the sign-in gate:
  // clearing the stored tokens is what stops it from carrying on as a device
  // its owner has already cut off, and the gate is where the person is told
  // what to do about it.
  //
  // Only on `revoked`, never on `offline`. The service says `device_revoked`
  // for a tombstone it actually holds; an unreachable service says nothing at
  // all, and signing somebody out over a network blip would be the exact
  // mistake the offline contract exists to prevent.
  useEffect(() => {
    if (devices.loaded && devices.status === 'revoked') {
      void signOutKeycloak()
    }
  }, [devices.loaded, devices.status])

  // Not loaded yet, or this build has no bridge for it.
  if (!devices.loaded || !devices.available) {
    return null
  }

  if (devices.status === 'unconfigured') {
    return null
  }

  const unreachable = devices.status !== 'ok'

  return (
    <>
      <SectionHeading icon={Monitor} title={copy.devicesTitle} />

      <div className="grid gap-1">
        {unreachable ? (
          <ListRow
            description={devices.status === 'revoked' ? copy.deviceRevokedSelf : copy.deviceOffline}
            title={copy.devicesTitle}
          />
        ) : null}

        {devices.devices.map(device => (
          <ListRow
            action={
              device.revoked ? undefined : (
                <Button
                  onClick={() => {
                    setTarget(device)
                    // Checked by default on every open: rotation is what
                    // actually cuts the revoked machine's model access, and
                    // it is self-healing for the others. Resetting it here
                    // stops a previous "no" from silently applying to the
                    // next revocation.
                    setRotateKey(true)
                    setOutcome(null)
                  }}
                  variant="outline"
                >
                  {copy.deviceRevoke}
                </Button>
              )
            }
            description={describeDevice(device, copy)}
            hint={
              device.current ? (
                <Pill tone="primary">
                  <Check className="size-3" />
                  {copy.deviceCurrent}
                </Pill>
              ) : undefined
            }
            key={device.id}
            title={device.name || copy.deviceUnnamed}
          />
        ))}

        {!unreachable && devices.devices.length === 0 ? (
          <ListRow description={copy.devicesEmptyDesc} title={copy.devicesEmpty} />
        ) : null}

        {outcome ? <ListRow description={outcome} title={copy.deviceRevoke} /> : null}
      </div>

      <ConfirmDialog
        confirmLabel={copy.deviceRevoke}
        description={
          <div className="grid gap-3">
            <p>{copy.deviceRevokeConfirmDesc(target?.name || copy.deviceUnnamed)}</p>
            <label className="flex items-start gap-2 text-left">
              <Checkbox
                checked={rotateKey}
                className="mt-0.5"
                onCheckedChange={value => setRotateKey(value === true)}
              />
              <span>
                <span className="block">{copy.deviceRotateKey}</span>
                <span className="block text-muted-foreground">{copy.deviceRotateKeyDesc}</span>
              </span>
            </label>
          </div>
        }
        destructive
        onClose={() => setTarget(null)}
        onConfirm={async () => {
          if (!target) {
            return
          }

          const result = await revokeDevice(target.id, { rotateKey })

          if (result.status !== 'ok') {
            // Thrown so ConfirmDialog keeps itself open and shows the reason,
            // rather than closing on a failure that looks like success.
            throw new Error(describeRevokeFailure(result, copy))
          }

          setOutcome(result.key_rotated ? copy.deviceRevokedWithKey : copy.deviceRevokedWithoutKey)
        }}
        open={target !== null}
        title={copy.deviceRevokeConfirmTitle}
      />
    </>
  )
}
