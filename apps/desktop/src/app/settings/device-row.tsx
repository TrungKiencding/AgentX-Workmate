import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { DesktopDevice } from '@/global'
import { useI18n } from '@/i18n'
import { Check, Monitor } from '@/lib/icons'
import { fmtDateTime } from '@/lib/time'
import { renameDevice } from '@/store/account'

import { describeLastSeen, deviceDisplayName, devicePlatform } from './device-presentation'
import { Pill } from './primitives'

interface DeviceRowProps {
  device: DesktopDevice
  duplicate: boolean
  disabled: boolean
  canRename: boolean
  onRevoke: (device: DesktopDevice) => void
  onSignOut: () => void
}

/** Hallmark · component: device row · design-system: apps/desktop/DESIGN.md */
export function DeviceRow({ device, duplicate, disabled, canRename, onRevoke, onSignOut }: DeviceRowProps) {
  const { t } = useI18n()
  const copy = t.settings.account
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const nameLabel = deviceDisplayName(device, copy)

  const date = (iso: string | null) => {
    const value = Date.parse(iso || '')

    return Number.isFinite(value) ? fmtDateTime.format(value) : copy.deviceUnknown
  }

  const metadata = [
    device.client_name,
    devicePlatform(device.platform, copy),
    device.revoked ? copy.deviceRevokedAt(date(device.revoked_at)) : describeLastSeen(device.last_seen_at, copy)
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <article aria-label={`${nameLabel} · ${device.id}`} className="@container min-w-0 py-2">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-1 gap-3">
          <Monitor className="mt-1 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 text-base font-medium [overflow-wrap:anywhere]">{nameLabel}</span>
              {device.current && !device.revoked ? (
                <Pill tone="primary">
                  <Check className="size-3" />
                  {copy.deviceCurrent}
                </Pill>
              ) : null}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{metadata}</p>
            {duplicate ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {copy.deviceRecordId(device.id.slice(-8))} · {copy.deviceRegisteredAt(date(device.created_at))}
              </p>
            ) : null}
          </div>
        </div>
        {!device.revoked && !device.current ? (
          <Button disabled={disabled} onClick={() => onRevoke(device)} size="sm" variant="ghost">
            {copy.deviceRevoke}
          </Button>
        ) : null}
      </div>

      <details className="mt-2 text-sm">
        <summary className="cursor-pointer text-muted-foreground">{copy.deviceDetails}</summary>
        <dl className="mt-2 grid grid-cols-1 @sm:grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">{copy.deviceHostname}</dt>
          <dd className="break-all">{device.name || copy.deviceUnknown}</dd>
          <dt className="text-muted-foreground">{copy.deviceApp}</dt>
          <dd>{device.client_name || copy.deviceUnknown}</dd>
          <dt className="text-muted-foreground">{copy.deviceVersion}</dt>
          <dd>{device.app_version || copy.deviceUnknown}</dd>
          <dt className="text-muted-foreground">{copy.deviceRegistered}</dt>
          <dd>{date(device.created_at)}</dd>
          <dt className="text-muted-foreground">{copy.deviceLastActivity}</dt>
          <dd>{date(device.last_seen_at)}</dd>
          <dt className="text-muted-foreground">{copy.deviceIdentity}</dt>
          <dd className="break-all font-mono text-xs">{device.id}</dd>
          {device.revoked ? (
            <>
              <dt className="text-muted-foreground">{copy.deviceAccountAccess}</dt>
              <dd>{copy.deviceRevokedAt(date(device.revoked_at))}</dd>
            </>
          ) : null}
        </dl>
        <div className="mt-3 flex flex-wrap gap-3">
          {canRename && !editing ? (
            <Button
              disabled={disabled}
              onClick={() => {
                setName(device.display_name || '')
                setEditing(true)
                setError('')
              }}
              size="sm"
              variant="ghost"
            >
              {copy.deviceRename}
            </Button>
          ) : null}
          {device.current && !device.revoked ? (
            <Button disabled={disabled} onClick={onSignOut} size="sm" variant="ghost">
              {copy.deviceSignOutHere}
            </Button>
          ) : null}
          {device.revoked ? (
            <Button disabled={disabled} onClick={() => onRevoke(device)} size="sm" variant="outline">
              {copy.deviceRotateRetry}
            </Button>
          ) : null}
        </div>
        {editing ? (
          <form
            className="mt-3 grid gap-2"
            onSubmit={event => {
              event.preventDefault()

              if (saving || disabled) {
                return
              }

              setSaving(true)
              setError('')
              void renameDevice(device.id, name.trim())
                .then(result => {
                  if (result.status === 'ok') {
                    setEditing(false)
                  } else {
                    setError(copy.deviceRenameFailed)
                  }
                })
                .finally(() => setSaving(false))
            }}
          >
            <Input
              aria-label={copy.deviceRename}
              disabled={saving || disabled}
              maxLength={64}
              onChange={event => setName(event.target.value)}
              placeholder={device.name || copy.deviceUnnamed}
              value={name}
            />
            <p className="text-xs text-muted-foreground">{copy.deviceRenameHint}</p>
            <div className="flex gap-2">
              <Button disabled={saving || disabled} size="sm" type="submit">
                {saving ? t.common.saving : t.common.save}
              </Button>
              <Button disabled={saving} onClick={() => setEditing(false)} size="sm" type="button" variant="ghost">
                {t.common.cancel}
              </Button>
            </div>
          </form>
        ) : null}
        {error ? (
          <p className="mt-2 text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </details>
    </article>
  )
}
