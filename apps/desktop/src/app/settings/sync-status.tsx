import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { RefreshCw } from '@/lib/icons'
import { $sync, refreshSyncStatus, syncNow } from '@/store/account'

import { ListRow, Pill, SectionHeading } from './primitives'

type AccountCopy = ReturnType<typeof useI18n>['t']['settings']['account']

/**
 * When something last happened, in words rather than a timestamp.
 *
 * Mirrors `describeLastSeen` in device-list.tsx: the question is "is this
 * current?", and an ISO string makes the reader do the subtraction. Takes
 * epoch SECONDS, because that is what `state.db` stores and what the backend
 * hands back — passing milliseconds here would read as fifty years ago.
 * Exported so its edges are testable without rendering anything.
 */
export function describeSyncTime(seconds: number | null | undefined, copy: AccountCopy, now = Date.now()): string {
  if (!seconds || !Number.isFinite(seconds)) {
    return copy.syncNever
  }

  const minutes = Math.floor((now - seconds * 1000) / 60_000)

  // A clock that has moved backwards, or a stamp from a device slightly
  // ahead. "In 3 minutes" is not a thing anybody wants to read here.
  if (minutes < 2) {
    return copy.syncJustNow
  }

  if (minutes < 60) {
    return copy.syncMinutesAgo(minutes)
  }

  const hours = Math.floor(minutes / 60)

  if (hours < 24) {
    return copy.syncHoursAgo(hours)
  }

  return copy.syncDaysAgo(Math.floor(hours / 24))
}

/**
 * The one line describing the current state of synchronisation.
 *
 * Table-driven over the backend's machine-readable `status` rather than its
 * prose, for the same reason `describeRevokeFailure` is: improving a sentence
 * on the other side must not silently change what this app says.
 *
 * An unreachable service deliberately reads as information rather than as a
 * fault. Nothing is lost while it is down — the changes are queued — and there
 * is nothing the person can do about it, so alarming them would be all cost.
 */
export function describeSyncState(
  state: { last_error?: string | null; last?: { status?: string }; pending?: number },
  copy: AccountCopy
): string {
  const status = state.last?.status || ''

  const byStatus: Record<string, string> = {
    error: copy.syncError,
    offline: copy.syncOffline,
    reauth: copy.syncReauth,
    signed_out: copy.syncSignedOut
  }

  if (byStatus[status]) {
    return byStatus[status]
  }

  return state.pending ? copy.syncPending(state.pending) : copy.syncUpToDate
}

/**
 * Settings → Account → History: whether this machine is in step with the rest.
 *
 * Renders nothing when no service is configured, exactly as `DeviceList` does:
 * an install with no second brain has no history to converge, and an empty
 * section headed "History" reads as a broken feature rather than an absent
 * one.
 *
 * Nothing here can fail loudly. Synchronisation running behind is not an error
 * a person can act on, and the app is fully usable either way.
 */
export function SyncStatus() {
  const { t } = useI18n()
  const sync = useStore($sync)
  const copy = t.settings.account
  const [outcome, setOutcome] = useState<null | string>(null)

  useEffect(() => {
    void refreshSyncStatus()
  }, [])

  if (!sync.loaded || !sync.available || !sync.configured) {
    return null
  }

  if (!sync.enabled) {
    return (
      <>
        <SectionHeading icon={RefreshCw} title={copy.syncTitle} />
        <div className="grid gap-1">
          <ListRow description={copy.syncDisabledDesc} title={copy.syncDisabled} />
        </div>
      </>
    )
  }

  return (
    <>
      <SectionHeading icon={RefreshCw} title={copy.syncTitle} />

      <div className="grid gap-1">
        <ListRow
          action={
            <Button
              disabled={sync.syncing}
              onClick={async () => {
                const result = await syncNow()

                setOutcome(result.status === 'ok' ? copy.syncNowDone : describeSyncState({ last: result }, copy))
              }}
              variant="outline"
            >
              {sync.syncing ? copy.syncRunning : copy.syncNow}
            </Button>
          }
          description={describeSyncState(sync, copy)}
          hint={sync.pending ? <Pill tone="muted">{copy.syncPendingPill(sync.pending)}</Pill> : undefined}
          title={copy.syncTitle}
        />

        <ListRow
          description={copy.syncLastPullDesc(describeSyncTime(sync.last_pull_at, copy))}
          title={copy.syncLastPull}
        />

        {sync.last_error ? <ListRow description={sync.last_error} title={copy.syncLastError} /> : null}

        {outcome ? <ListRow description={outcome} title={copy.syncNow} /> : null}
      </div>
    </>
  )
}
