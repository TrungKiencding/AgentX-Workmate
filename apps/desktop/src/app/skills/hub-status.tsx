import { useStore } from '@nanostores/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { getSkillHubChanges, tickSkillHub } from '@/hermes'
import { useI18n } from '@/i18n'
import { Loader2 } from '@/lib/icons'
import { invalidateSlashCompletions } from '@/lib/slash-completion-cache'
import { cn } from '@/lib/utils'
import { $hubActions, HUB_SOURCES_KEY, UPDATE_ALL_KEY, updateHubSkills } from '@/store/hub-actions'
import { notify, notifyError } from '@/store/notifications'
import type { SkillHubChangesResponse, SkillHubInstallRow } from '@/types/hermes'

// What the hub wants on this machine, and what the backend did about it.
// Polled while the Hub tab is open (the plan's 15 s), with a tick — which
// also hands the backend a fresh bearer — on mount and every minute.
export const HUB_CHANGES_KEY = ['skill-hub-changes'] as const
const SKILLS_LIST_KEY = ['skills-list'] as const
export const HUB_CHANGES_POLL_MS = 15_000
export const HUB_TICK_MS = 60_000

function reportedTone(row: SkillHubInstallRow): string {
  if (row.reported_state === 'failed') {
    return 'bg-destructive/15 text-destructive'
  }

  if (row.reported_state === 'installed') {
    return 'bg-emerald-500/15 text-emerald-400'
  }

  if (row.reported_state === 'disabled' || row.reported_state === 'removed') {
    return 'bg-(--ui-bg-tertiary) text-(--ui-text-secondary)'
  }

  return 'bg-amber-500/15 text-amber-400'
}

function statusLine(data: SkillHubChangesResponse, h: ReturnType<typeof useI18n>['t']['skills']['hub']): string | null {
  switch (data.last?.status) {
    case 'signed_out':
      return h.signedOut

    case 'offline':
      return h.offline

    case 'reauth':
      return h.reauth

    case 'unconfigured':
      return h.unconfigured

    default:
      return data.configured ? null : h.unconfigured
  }
}

function when(value: string | null | undefined): string {
  if (!value) {
    return ''
  }

  const date = new Date(value)

  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString()
}

export function HubStatus() {
  const { t } = useI18n()
  const h = t.skills.hub
  const queryClient = useQueryClient()
  const actions = useStore($hubActions)
  const [ticking, setTicking] = useState(false)
  // The backend revision we last acted on; a change means files moved.
  const [seenRevision, setSeenRevision] = useState<number | null>(null)

  const changes = useQuery({
    queryKey: HUB_CHANGES_KEY,
    queryFn: getSkillHubChanges,
    refetchInterval: HUB_CHANGES_POLL_MS,
    staleTime: 5_000
  })

  const tick = useCallback(
    async (announce: boolean) => {
      setTicking(true)

      try {
        const outcome = await tickSkillHub()

        if (announce && outcome.status !== 'ok') {
          notify({ kind: 'success', title: h.fromHub, message: outcome.detail || outcome.status })
        }
      } catch (err) {
        if (announce) {
          notifyError(err, h.loadFailed)
        }
      } finally {
        setTicking(false)
        void queryClient.invalidateQueries({ queryKey: HUB_CHANGES_KEY })
      }
    },
    [h, queryClient]
  )

  // A tick on mount hands the backend this session's bearer and reconciles
  // at once; the interval keeps the credential fresh while the tab is open.
  useEffect(() => {
    void tick(false)
    const timer = setInterval(() => void tick(false), HUB_TICK_MS)

    return () => clearInterval(timer)
  }, [tick])

  // The backend changed something on disk: the Skills tab, the installed map
  // and the composer's `/` list are stale.
  const revision = changes.data?.revision
  useEffect(() => {
    if (revision === undefined) {
      return
    }

    if (seenRevision !== null && seenRevision !== revision) {
      void queryClient.invalidateQueries({ queryKey: SKILLS_LIST_KEY })
      void queryClient.invalidateQueries({ queryKey: HUB_SOURCES_KEY })
      invalidateSlashCompletions()
    }

    if (seenRevision !== revision) {
      setSeenRevision(revision)
    }
  }, [queryClient, revision, seenRevision])

  const updateAll = () => {
    notify({ kind: 'success', title: h.updateStarted, message: h.actionLog })
    void updateHubSkills().catch(err => notifyError(err, h.actionFailed))
  }

  const data = changes.data
  const installs = data?.installs ?? []
  const updates = data?.updates ?? []
  const history = (data?.history ?? []).slice(0, 5)
  const line = data ? statusLine(data, h) : null
  const updating = actions[UPDATE_ALL_KEY]?.running ?? false

  return (
    <section
      className="mb-4 rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-quinary) p-3"
      data-testid="hub-status"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-foreground/85">{h.fromHub}</span>
        {data && (
          <span
            className={cn(
              'rounded px-1.5 py-0.5 text-2xs',
              data.stream === 'connected'
                ? 'bg-emerald-500/15 text-emerald-400'
                : 'bg-(--ui-bg-tertiary) text-(--ui-text-secondary)'
            )}
            data-testid="hub-stream"
          >
            {h.hubStatus[data.stream] ?? data.stream}
          </span>
        )}
        {data?.last?.at && (
          <span className="text-2xs text-(--ui-text-quaternary)">{h.lastSync(when(data.last.at))}</span>
        )}
        <span className="ml-auto flex items-center gap-1">
          {data?.base_url && (
            <a
              className="text-2xs text-muted-foreground underline-offset-4 hover:underline"
              href={data.base_url}
              rel="noreferrer"
              target="_blank"
            >
              {h.openHub}
            </a>
          )}
          <Button disabled={ticking} onClick={() => void tick(true)} size="xs" variant="textStrong">
            {ticking && <Loader2 className="size-3 animate-spin" />}
            {ticking ? h.syncing : h.syncNow}
          </Button>
        </span>
      </div>

      {line && (
        <p className="mt-1.5 text-2xs text-amber-400" data-testid="hub-status-line">
          {line}
        </p>
      )}

      {updates.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-2xs" data-testid="hub-updates">
          <span className="font-medium text-foreground/85">{h.updatesAvailable(updates.length)}</span>
          {updates.map(update => (
            <span
              className="rounded bg-(--ui-bg-tertiary) px-1.5 py-0.5 text-(--ui-text-secondary)"
              key={update.install_id}
            >
              {update.name || update.slug} {h.updateOne(update.current ?? '?', update.latest ?? '?')}
            </span>
          ))}
          <Button className="ml-auto" disabled={updating} onClick={updateAll} size="xs" variant="textStrong">
            {updating && <Loader2 className="size-3 animate-spin" />}
            {updating ? h.updating : h.updateAll}
          </Button>
        </div>
      )}

      {changes.isLoading ? (
        <p className="mt-2 text-2xs text-(--ui-text-tertiary)">{h.searching}</p>
      ) : installs.length === 0 ? (
        <p className="mt-2 text-2xs text-(--ui-text-tertiary)">{h.noInstalls}</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1" data-testid="hub-installs">
          {installs.map(row => (
            <li className="flex flex-wrap items-center gap-1.5 text-2xs" data-testid="hub-install" key={row.id}>
              <span className="font-medium text-foreground/85">{row.name || row.slug}</span>
              <span className="text-(--ui-text-quaternary)">{row.version ?? row.latest_version ?? ''}</span>
              <span className="rounded bg-(--ui-bg-tertiary) px-1.5 py-0.5 text-(--ui-text-secondary)">
                {h.desired[row.desired_state] ?? row.desired_state}
              </span>
              <span className={cn('rounded px-1.5 py-0.5', reportedTone(row))} data-testid="hub-reported">
                {h.reported[row.reported_state] ?? row.reported_state}
              </span>
              {row.local?.installed && !row.local.enabled && (
                <span className="text-(--ui-text-quaternary)">{h.localDisabled}</span>
              )}
              {row.reason && <span className="text-(--ui-text-quaternary)">— {row.reason}</span>}
              {row.error && <span className="text-destructive">{row.error}</span>}
            </li>
          ))}
        </ul>
      )}

      {data?.org && data.org.skills.length > 0 && (
        <p className="mt-2 text-2xs text-(--ui-text-tertiary)">{h.orgSkills(data.org.skills.length)}</p>
      )}

      {history.length > 0 && (
        <div className="mt-2 text-2xs text-(--ui-text-tertiary)" data-testid="hub-history">
          <span className="mb-0.5 block">{h.history}</span>
          {history.map(entry => (
            <div key={`${entry.at}-${entry.slug}-${entry.action}`}>
              {when(entry.at)} · {entry.slug}
              {entry.version ? `@${entry.version}` : ''} {h.historyAction[entry.action] ?? entry.action}
              {entry.detail ? ` — ${entry.detail}` : ''}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
