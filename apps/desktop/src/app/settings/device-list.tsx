import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Tip } from '@/components/ui/tooltip'
import type { DesktopDevice } from '@/global'
import { useI18n } from '@/i18n'
import { ChevronLeft, ChevronRight, Monitor } from '@/lib/icons'
import { fmtDateTime } from '@/lib/time'
import { $devices, refreshDevices, revokeDevices, signOutKeycloak } from '@/store/account'

import { DeviceDetailsDialog } from './device-details-dialog'
import {
  describeLastSeen,
  describeRevokeFailure,
  deviceDisplayName,
  type DeviceGroup,
  devicePlatform,
  groupDevices
} from './device-presentation'
import { ListRow, ListRowSkeleton, Pill, SectionHeading } from './primitives'

const PAGE_SIZE = 10

/**
 * What a revocation is aimed at: one machine (every install folded into its
 * row), or every machine but this one. `revoked` is the retry of a key
 * rotation that failed the first time.
 */
interface RevokeTarget {
  devices: DesktopDevice[]
  label: string
  others: boolean
  revoked: boolean
}

function groupTarget(group: DeviceGroup, copy: Parameters<typeof deviceDisplayName>[1]): RevokeTarget {
  const newest = group.devices[0]!

  return { devices: group.devices, label: deviceDisplayName(newest, copy), others: false, revoked: newest.revoked }
}

/**
 * Settings → Account → Devices: which machines you are signed in on.
 *
 * Renders nothing at all when no service is configured. An install with no
 * keys service has no device list, and an empty section headed "Devices" reads
 * as a feature that is broken rather than one that is absent.
 *
 * Everything else degrades in place: an unreachable service shows a line
 * saying so, and the rest of Settings is untouched.
 */
export function DeviceList() {
  const { t } = useI18n()
  const devices = useStore($devices)
  const copy = t.settings.account
  const [target, setTarget] = useState<RevokeTarget | null>(null)
  // By install id, not by value or group key, so the open dialog follows the
  // list as it refreshes — a rename changes the group's key, not its installs.
  const [detailsId, setDetailsId] = useState<string | null>(null)
  const [signOutOpen, setSignOutOpen] = useState(false)
  const [rotateKey, setRotateKey] = useState(true)
  const [outcome, setOutcome] = useState<{ message: string; retry: RevokeTarget | null } | null>(null)
  const groups = groupDevices(devices.devices, devices.current)
  const others = groups.active.filter(group => !group.current).flatMap(group => group.devices)

  const details =
    [...groups.active, ...groups.revoked].find(group => group.devices.some(device => device.id === detailsId)) ?? null

  function openRevoke(next: RevokeTarget) {
    setDetailsId(null)
    setTarget(next)
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

  const busy = unreachable || devices.refreshing

  return (
    <section aria-label={copy.devicesTitle} className="min-w-0">
      <SectionHeading
        aside={
          <div className="flex items-center gap-1">
            {others.length > 0 ? (
              <Button
                disabled={busy}
                onClick={() => openRevoke({ devices: others, label: '', others: true, revoked: false })}
                size="sm"
                variant="outline"
              >
                {copy.deviceRevokeOthers}
              </Button>
            ) : null}
            <Button disabled={devices.refreshing} onClick={() => void refreshDevices()} size="sm" variant="ghost">
              {devices.refreshing ? t.common.loading : t.common.refresh}
            </Button>
          </div>
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

        {groups.active.length > 0 ? (
          <DeviceTable
            disabled={busy}
            groups={groups.active}
            label={copy.devicesTitle}
            onOpen={group => setDetailsId(group.devices[0]!.id)}
            onRevoke={group => openRevoke(groupTarget(group, copy))}
          />
        ) : null}

        {groups.revoked.length > 0 ? (
          <details className="text-sm">
            <summary className="cursor-pointer py-2 font-medium text-muted-foreground">
              {copy.deviceHistoryTitle(groups.revoked.length)}
            </summary>
            <p className="py-2 text-muted-foreground">{copy.deviceHistoryHint}</p>
            <DeviceTable
              disabled={busy}
              groups={groups.revoked}
              label={copy.deviceHistoryTitle(groups.revoked.length)}
              onOpen={group => setDetailsId(group.devices[0]!.id)}
              revoked
            />
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
                  disabled={busy}
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

      <DeviceDetailsDialog
        canRename={Boolean(devices.can_rename)}
        disabled={busy}
        group={details}
        onClose={() => setDetailsId(null)}
        onRevoke={group => openRevoke(groupTarget(group, copy))}
        onSignOut={() => {
          setDetailsId(null)
          setSignOutOpen(true)
        }}
      />
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
        confirmLabel={
          target?.revoked ? copy.deviceRotateRetry : target?.others ? copy.deviceRevokeOthers : copy.deviceRevoke
        }
        description={
          <div className="grid gap-3">
            <p>
              {target?.revoked
                ? copy.deviceRotateRetryDesc
                : target?.others
                  ? copy.deviceRevokeOthersConfirmDesc(target.devices.length)
                  : copy.deviceRevokeConfirmDesc(target?.label || copy.deviceUnnamed)}
            </p>
            {target && !target.revoked && !target.others && target.devices.length > 1 ? (
              <p>{copy.deviceRevokeGroupNote(target.devices.length)}</p>
            ) : null}
            {target?.devices.length === 1 ? (
              <p className="break-all text-xs text-muted-foreground">
                {copy.deviceIdentity}: {target.devices[0]!.id}
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

          // A retry only needs the rotation, and one revoked install carries it.
          const ids = target.revoked ? [target.devices[0]!.id] : target.devices.map(device => device.id)
          const result = await revokeDevices(ids, { rotateKey: target.revoked || rotateKey })

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
                : {
                    devices: [result.device || { ...target.devices.at(-1)!, revoked: true }],
                    label: target.label,
                    others: target.others,
                    revoked: true
                  }
          })
        }}
        open={target !== null}
        title={
          target?.revoked
            ? copy.deviceRotateRetry
            : target?.others
              ? copy.deviceRevokeOthersConfirmTitle
              : copy.deviceRevokeConfirmTitle
        }
      />
    </section>
  )
}

/**
 * One table of machines, ten to a page — the list used to print every install
 * there ever was, one tall card each. Machine (with platform and app under
 * it), when it was registered, when it was last active, and the one action a
 * row needs; the rest is behind the name.
 */
function DeviceTable({
  disabled,
  groups,
  label,
  onOpen,
  onRevoke,
  revoked = false
}: {
  disabled: boolean
  groups: DeviceGroup[]
  label: string
  onOpen: (group: DeviceGroup) => void
  onRevoke?: (group: DeviceGroup) => void
  revoked?: boolean
}) {
  const { t } = useI18n()
  const copy = t.settings.account
  const [page, setPage] = useState(0)
  const pages = Math.max(1, Math.ceil(groups.length / PAGE_SIZE))
  // Clamped rather than reset: a revocation that empties the last page lands
  // on the page before it, not back at the top.
  const current = Math.min(page, pages - 1)
  const from = current * PAGE_SIZE
  const visible = groups.slice(from, from + PAGE_SIZE)

  const date = (iso: string | null) => {
    const value = Date.parse(iso || '')

    return Number.isFinite(value) ? fmtDateTime.format(value) : copy.deviceUnknown
  }

  return (
    <div className="@container min-w-0">
      <table aria-label={label} className="w-full table-fixed border-collapse text-sm">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="py-2 pr-4 font-normal">{copy.deviceColDevice}</th>
            <th className="hidden w-48 py-2 pr-4 font-normal @2xl:table-cell">{copy.deviceRegistered}</th>
            <th className="w-36 py-2 pr-4 font-normal @xl:w-48">
              {revoked ? copy.deviceColRevoked : copy.deviceLastActivity}
            </th>
            <th className="w-36 py-2 font-normal">
              <span className="sr-only">{copy.deviceColActions}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {visible.map(group => {
            const newest = group.devices[0]!
            const name = deviceDisplayName(newest, copy)

            const meta = [
              devicePlatform(newest.platform, copy),
              newest.client_name,
              group.devices.length > 1 ? copy.deviceInstalls(group.devices.length) : ''
            ]
              .filter(Boolean)
              .join(' · ')

            return (
              <tr className="border-t border-(--border-subtle) align-middle" key={group.key}>
                <td className="min-w-0 py-2.5 pr-4">
                  <div className="flex min-w-0 items-center gap-2">
                    <Tip label={name}>
                      <button
                        className="min-w-0 truncate text-left text-base text-(--text-primary) underline-offset-4 hover:underline"
                        onClick={() => onOpen(group)}
                        type="button"
                      >
                        {name}
                      </button>
                    </Tip>
                    {group.current ? <Pill tone="primary">{copy.deviceCurrent}</Pill> : null}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">{meta}</p>
                </td>
                <td className="hidden py-2.5 pr-4 text-muted-foreground @2xl:table-cell">{date(newest.created_at)}</td>
                <td
                  className="py-2.5 pr-4 text-muted-foreground"
                  title={revoked ? undefined : date(newest.last_seen_at)}
                >
                  {revoked ? date(newest.revoked_at) : describeLastSeen(newest.last_seen_at, copy)}
                </td>
                <td className="py-2.5 text-right">
                  {onRevoke && !group.current && !revoked ? (
                    <Button disabled={disabled} onClick={() => onRevoke(group)} size="sm" variant="ghost">
                      {copy.deviceRevoke}
                    </Button>
                  ) : null}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {pages > 1 ? (
        <nav
          aria-label={t.ui.pagination.label}
          className="flex items-center justify-between gap-3 border-t border-(--border-subtle) pt-3 text-sm text-muted-foreground"
        >
          <span>{copy.devicePageRange(from + 1, from + visible.length, groups.length)}</span>
          <div className="flex items-center gap-1">
            <Button
              aria-label={t.ui.pagination.previousAria}
              disabled={current === 0}
              onClick={() => setPage(current - 1)}
              size="icon-sm"
              variant="ghost"
            >
              <ChevronLeft />
            </Button>
            <span className="tabular-nums">{copy.devicePage(current + 1, pages)}</span>
            <Button
              aria-label={t.ui.pagination.nextAria}
              disabled={current >= pages - 1}
              onClick={() => setPage(current + 1)}
              size="icon-sm"
              variant="ghost"
            >
              <ChevronRight />
            </Button>
          </div>
        </nav>
      ) : null}
    </div>
  )
}
