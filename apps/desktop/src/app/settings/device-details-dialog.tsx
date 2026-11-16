import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { fmtDateTime } from '@/lib/time'
import { renameDevices } from '@/store/account'

import { describeLastSeen, deviceDisplayName, type DeviceGroup, devicePlatform } from './device-presentation'

interface DeviceDetailsDialogProps {
  group: DeviceGroup | null
  canRename: boolean
  disabled: boolean
  onClose: () => void
  onRevoke: (group: DeviceGroup) => void
  onSignOut: () => void
}

/**
 * Everything the table leaves out for one machine: the newest install's
 * particulars, every install folded into the row, and the actions that are
 * rare enough to live a click away — rename, sign out here, retry a rotation.
 */
export function DeviceDetailsDialog({
  group,
  canRename,
  disabled,
  onClose,
  onRevoke,
  onSignOut
}: DeviceDetailsDialogProps) {
  const { t } = useI18n()
  const copy = t.settings.account
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const device = group?.devices[0]

  const date = (iso: string | null) => {
    const value = Date.parse(iso || '')

    return Number.isFinite(value) ? fmtDateTime.format(value) : copy.deviceUnknown
  }

  function close() {
    setEditing(false)
    setError('')
    onClose()
  }

  return (
    <Dialog onOpenChange={open => !open && close()} open={Boolean(group && device)}>
      {group && device ? (
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="[overflow-wrap:anywhere]">{deviceDisplayName(device, copy)}</DialogTitle>
          </DialogHeader>

          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
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
            {device.revoked ? (
              <>
                <dt className="text-muted-foreground">{copy.deviceAccountAccess}</dt>
                <dd>{copy.deviceRevokedAt(date(device.revoked_at))}</dd>
              </>
            ) : null}
          </dl>

          {/* Every install the row stands for, so the folding hides nothing:
              each one is still there, by id, for a support ticket. */}
          <section aria-label={copy.deviceInstallsTitle} className="grid gap-1 text-sm">
            <h3 className="text-muted-foreground">{copy.deviceInstalls(group.devices.length)}</h3>
            <ul className="grid gap-1">
              {group.devices.map(install => (
                <li className="flex flex-wrap items-baseline gap-x-3" key={install.id}>
                  <span className="font-mono text-xs break-all" data-selectable-text="true">
                    {install.id}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {devicePlatform(install.platform, copy)} · {install.app_version || copy.deviceUnknown} ·{' '}
                    {install.revoked
                      ? copy.deviceRevokedAt(date(install.revoked_at))
                      : describeLastSeen(install.last_seen_at, copy)}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          {editing ? (
            <form
              className="grid gap-2"
              onSubmit={event => {
                event.preventDefault()

                if (saving || disabled) {
                  return
                }

                setSaving(true)
                setError('')
                // Every install in the row takes the label, so the row stays
                // one row after the rename.
                void renameDevices(
                  group.devices.map(install => install.id),
                  name.trim()
                )
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
                autoFocus
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
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            {canRename && !editing ? (
              <Button
                disabled={disabled}
                onClick={() => {
                  setName(device.display_name || '')
                  setEditing(true)
                  setError('')
                }}
                variant="outline"
              >
                {copy.deviceRename}
              </Button>
            ) : null}
            {group.current ? (
              <Button disabled={disabled} onClick={onSignOut} variant="outline">
                {copy.deviceSignOutHere}
              </Button>
            ) : null}
            {device.revoked ? (
              <Button disabled={disabled} onClick={() => onRevoke(group)} variant="outline">
                {copy.deviceRotateRetry}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  )
}
