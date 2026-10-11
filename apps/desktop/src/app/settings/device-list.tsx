import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import type { DesktopDevice } from '@/global'
import { useI18n } from '@/i18n'
import { Monitor } from '@/lib/icons'
import { $devices, refreshDevices, revokeDevice, signOutKeycloak } from '@/store/account'

import { describeRevokeFailure, deviceDisplayName, groupDevices } from './device-presentation'
import { DeviceRow } from './device-row'
import { ListRow, ListRowSkeleton, SectionHeading } from './primitives'

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
  const [signOutOpen, setSignOutOpen] = useState(false)
  const [rotateKey, setRotateKey] = useState(true)
  const [outcome, setOutcome] = useState<{ message: string; retry: DesktopDevice | null } | null>(null)
  const groups = groupDevices(devices.devices, devices.current)

  function openRevoke(device: DesktopDevice) {
    setTarget(device)
    setRotateKey(true)
    setOutcome(null)
  }

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
  if (!devices.available) {
    return null
  }

  if (!devices.loaded) {
    return (
      <>
        <SectionHeading icon={Monitor} title={copy.devicesTitle} />
        <ListRowSkeleton />
      </>
    )
  }

  if (devices.status === 'unconfigured') {
    return null
  }

  const unreachable = devices.status !== 'ok'

  return (
    <section aria-label={copy.devicesTitle} className="min-w-0">
      <SectionHeading
        aside={
          <Button disabled={devices.refreshing} onClick={() => void refreshDevices()} size="sm" variant="ghost">
            {devices.refreshing ? t.common.loading : t.common.refresh}
          </Button>
        }
        icon={Monitor}
        title={copy.devicesTitle}
      />

      <div className="grid gap-4">
        {unreachable ? (
          <p className="text-sm text-destructive" role="alert">
            {devices.status === 'revoked' ? copy.deviceRevokedSelf : copy.deviceOffline}
          </p>
        ) : null}
        {groups.duplicateNames.size > 0 ? (
          <p className="text-sm text-muted-foreground">{copy.deviceDuplicateHint}</p>
        ) : null}

        {groups.current.map(device => (
          <DeviceRow
            canRename={Boolean(devices.can_rename)}
            device={device}
            disabled={unreachable || devices.refreshing}
            duplicate={groups.duplicateNames.has(device.display_name || device.name)}
            key={device.id}
            onRevoke={openRevoke}
            onSignOut={() => setSignOutOpen(true)}
          />
        ))}

        {groups.other.length > 0 ? (
          <section aria-label={copy.deviceOtherTitle(groups.other.length)} className="grid gap-1">
            <h3 className="text-sm font-medium text-muted-foreground">{copy.deviceOtherTitle(groups.other.length)}</h3>
            {groups.other.map(device => (
              <DeviceRow
                canRename={Boolean(devices.can_rename)}
                device={device}
                disabled={unreachable || devices.refreshing}
                duplicate={groups.duplicateNames.has(device.display_name || device.name)}
                key={device.id}
                onRevoke={openRevoke}
                onSignOut={() => setSignOutOpen(true)}
              />
            ))}
          </section>
        ) : null}

        {groups.revoked.length > 0 ? (
          <details className="text-sm">
            <summary className="cursor-pointer py-2 font-medium text-muted-foreground">
              {copy.deviceHistoryTitle(groups.revoked.length)}
            </summary>
            <p className="py-2 text-muted-foreground">{copy.deviceHistoryHint}</p>
            {groups.revoked.map(device => (
              <DeviceRow
                canRename={Boolean(devices.can_rename)}
                device={device}
                disabled={unreachable || devices.refreshing}
                duplicate={groups.duplicateNames.has(device.display_name || device.name)}
                key={device.id}
                onRevoke={openRevoke}
                onSignOut={() => setSignOutOpen(true)}
              />
            ))}
          </details>
        ) : null}

        {!unreachable && devices.devices.length === 0 ? (
          <ListRow description={copy.devicesEmptyDesc} title={copy.devicesEmpty} />
        ) : null}

        {outcome ? (
          <div className="grid gap-2 text-sm" role="status">
            <p>{outcome.message}</p>
            {outcome.retry ? (
              <div>
                <Button
                  disabled={unreachable || devices.refreshing}
                  onClick={() => outcome.retry && openRevoke(outcome.retry)}
                  size="sm"
                  variant="outline"
                >
                  {copy.deviceRotateRetry}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <ConfirmDialog
        confirmLabel={copy.deviceSignOutHere}
        description={copy.signOutConfirmDesc}
        onClose={() => setSignOutOpen(false)}
        onConfirm={signOutKeycloak}
        open={signOutOpen}
        title={copy.signOutConfirmTitle}
      />
      <ConfirmDialog
        busyLabel={target?.revoked ? copy.keyRotating : copy.deviceRevoking}
        confirmLabel={target?.revoked ? copy.deviceRotateRetry : copy.deviceRevoke}
        description={
          <div className="grid gap-3">
            <p>
              {target?.revoked
                ? copy.deviceRotateRetryDesc
                : copy.deviceRevokeConfirmDesc(target ? deviceDisplayName(target, copy) : copy.deviceUnnamed)}
            </p>
            {target ? (
              <p className="break-all text-xs text-muted-foreground">
                {copy.deviceIdentity}: {target.id}
              </p>
            ) : null}
            {!target?.revoked ? (
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
            ) : null}
          </div>
        }
        destructive
        onClose={() => setTarget(null)}
        onConfirm={async () => {
          if (!target) {
            return
          }

          const result = await revokeDevice(target.id, { rotateKey: target.revoked || rotateKey })

          if (result.status !== 'ok') {
            // Thrown so ConfirmDialog keeps itself open and shows the reason,
            // rather than closing on a failure that looks like success.
            throw new Error(describeRevokeFailure(result, copy))
          }

          const rotated = result.key_rotated === true

          const message = rotated
            ? target.revoked
              ? copy.deviceRotationDone
              : copy.deviceRevokedWithKey
            : result.key_rotation === 'failed'
              ? copy.deviceRotationFailed
              : result.key_rotation === 'unsupported'
                ? copy.deviceRotationUnsupported
                : result.key_rotation === 'no_key'
                  ? copy.deviceRotationNoKey
                  : copy.deviceRevokedWithoutKey

          setOutcome({
            message,
            retry:
              rotated || result.key_rotation === 'unsupported' || result.key_rotation === 'no_key'
                ? null
                : result.device || { ...target, revoked: true }
          })
        }}
        open={target !== null}
        title={target?.revoked ? copy.deviceRotateRetry : copy.deviceRevokeConfirmTitle}
      />
    </section>
  )
}
