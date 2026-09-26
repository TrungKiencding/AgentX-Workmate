import { useStore } from '@nanostores/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { StatusPill, type StatusPillTone } from '@/components/ui/status-pill'
import { getSkillHubChanges, tickSkillHub } from '@/hermes'
import { useI18n } from '@/i18n'
import { Loader2 } from '@/lib/icons'
import { invalidateSlashCompletions } from '@/lib/slash-completion-cache'
import { $gateway } from '@/store/gateway'
import {
  $hubActions,
  HUB_CATALOG_KEY,
  HUB_CHANGES_KEY,
  UPDATE_ALL_KEY,
  updateHubSkill,
  updateHubSkills
} from '@/store/hub-actions'
import { notify, notifyError } from '@/store/notifications'
import type { SkillHubChangesResponse, SkillHubInstallRow, SkillHubUpdate } from '@/types/hermes'

import { ReplaceEditedSkillDialog, type ReplaceTarget } from './replace-edited-dialog'

// What the hub wants on this machine, and what the backend did about it.
// Polled while the Hub tab is open (the plan's 15 s), with a tick — which
// also hands the backend a fresh bearer — on mount and every minute.
export { HUB_CHANGES_KEY }
const SKILLS_LIST_KEY = ['skills-list'] as const
export const HUB_CHANGES_POLL_MS = 15_000
export const HUB_TICK_MS = 60_000

function reportedTone(row: SkillHubInstallRow): StatusPillTone {
  if (row.reported_state === 'failed') {
    return 'bad'
  }

  if (row.reported_state === 'installed') {
    return 'good'
  }

  if (row.reported_state === 'disabled' || row.reported_state === 'removed') {
    return 'muted'
  }

  return 'warn'
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

/** `hideWhenIdle`: render nothing while the hub has asked this machine for
 *  nothing (no installs, updates or history). Browsing the store needs no
 *  account, so an empty "sign in to sync" panel is noise above the cards —
 *  the panel appears the moment the hub actually wants something here. The
 *  polling/tick effects still run either way. */
export function HubStatus({ hideWhenIdle = false }: { hideWhenIdle?: boolean } = {}) {
  const { t } = useI18n()
  const h = t.skills.hub
  const queryClient = useQueryClient()
  const actions = useStore($hubActions)
  const [ticking, setTicking] = useState(false)
  // The backend revision we last acted on; a change means files moved.
  const [seenRevision, setSeenRevision] = useState<number | null>(null)
  // The same for MCP servers the sync installed, removed or switched here.
  const [seenMcpRevision, setSeenMcpRevision] = useState<number | null>(null)
  const [replace, setReplace] = useState<null | ReplaceTarget>(null)

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
      void queryClient.invalidateQueries({ queryKey: HUB_CATALOG_KEY })
      invalidateSlashCompletions()
    }

    if (seenRevision !== revision) {
      setSeenRevision(revision)
    }
  }, [queryClient, revision, seenRevision])

  // The sync changed an MCP server here (an AgentX Hub server installed,
  // switched off from the hub, removed, its tool list re-approved): live
  // sessions reload MCP and the MCP tab's catalog is stale.
  const mcpRevision = changes.data?.mcp_revision
  useEffect(() => {
    if (mcpRevision === undefined) {
      return
    }

    if (seenMcpRevision !== null && seenMcpRevision !== mcpRevision) {
      void queryClient.invalidateQueries({ queryKey: ['mcp-catalog'] })
      void $gateway
        .get()
        ?.request('reload.mcp', { confirm: true })
        .catch(() => undefined)
    }

    if (seenMcpRevision !== mcpRevision) {
      setSeenMcpRevision(mcpRevision)
    }
  }, [mcpRevision, queryClient, seenMcpRevision])

  const updateAll = () => {
    notify({ kind: 'success', title: h.updateStarted, message: h.actionLog })
    void updateHubSkills().catch(err => notifyError(err, h.actionFailed))
  }

  // One row: the installed name is what `agentx skills update` takes; a copy
  // edited here is replaced only after the confirmation (hub decision §8 #20).
  const updateOne = (update: SkillHubUpdate) => {
    const identifier = `agentx-hub/${update.slug}`
    const name = update.name || update.slug.split('/').pop() || update.slug

    if (update.modified) {
      setReplace({ identifier, name, version: update.latest ?? '?' })

      return
    }

    notify({ kind: 'success', title: h.updateOneStarted(name), message: h.actionLog })
    void updateHubSkill(identifier, name).catch(err => notifyError(err, h.actionFailed))
  }

  const data = changes.data
  const installs = data?.installs ?? []
  const updates = data?.updates ?? []
  const history = (data?.history ?? []).slice(0, 5)
  const line = data ? statusLine(data, h) : null
  const updating = actions[UPDATE_ALL_KEY]?.running ?? false
  const editedUpdates = updates.filter(update => update.modified).length

  if (hideWhenIdle && installs.length === 0 && updates.length === 0 && history.length === 0) {
    return null
  }

  return (
    <section
      className="mb-4 rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-quinary) p-3"
      data-testid="hub-status"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-foreground/85">{h.fromHub}</span>
        {data && (
          <StatusPill data-testid="hub-stream" tone={data.stream === 'connected' ? 'good' : 'muted'}>
            {h.hubStatus[data.stream] ?? data.stream}
          </StatusPill>
        )}
        {data?.last?.at && (
          <span className="text-xs text-(--ui-text-quaternary)">{h.lastSync(when(data.last.at))}</span>
        )}
        <span className="ml-auto flex items-center gap-1">
          {data?.base_url && (
            <a
              className="inline-flex min-h-6 items-center text-xs text-muted-foreground underline-offset-4 hover:underline"
              href={data.base_url}
              rel="noreferrer"
              target="_blank"
            >
              {h.openHub}
            </a>
          )}
          <Button disabled={ticking} onClick={() => void tick(true)} size="sm" variant="outline">
            {ticking && <Loader2 className="size-3 animate-spin" />}
            {ticking ? h.syncing : h.syncNow}
          </Button>
        </span>
      </div>

      {line && (
        <p className="mt-1.5 text-sm text-(--ui-yellow)" data-testid="hub-status-line">
          {line}
        </p>
      )}

      {updates.length > 0 && (
        <div className="mt-2 text-xs" data-testid="hub-updates">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-foreground/85">{h.updatesAvailable(updates.length)}</span>
            <Button
              className="ml-auto"
              disabled={updating || editedUpdates === updates.length}
              onClick={updateAll}
              size="sm"
              variant="secondary"
            >
              {updating && <Loader2 className="size-3 animate-spin" />}
              {updating ? h.updating : h.updateAll}
            </Button>
          </div>
          <ul className="mt-1 flex flex-col gap-1">
            {updates.map(update => {
              const running = actions[`agentx-hub/${update.slug}`]?.running ?? false

              return (
                <li
                  className="flex flex-wrap items-center gap-1.5"
                  data-modified={update.modified ? 'true' : 'false'}
                  data-testid="hub-update"
                  key={update.install_id}
                >
                  <span className="font-medium text-foreground/85">{update.name || update.slug}</span>
                  <span className="text-(--ui-text-tertiary)">
                    {h.updateOne(update.current ?? '?', update.latest ?? '?')}
                  </span>
                  {update.modified && <StatusPill tone="muted">{h.editedHere}</StatusPill>}
                  <Button
                    className="ml-auto"
                    data-testid="hub-update-one"
                    disabled={running || updating}
                    onClick={() => updateOne(update)}
                    size="sm"
                    variant={update.modified ? 'outline' : 'text'}
                  >
                    {running && <Loader2 className="size-3 animate-spin" />}
                    {update.modified ? h.replaceWithHub : h.updateThis}
                  </Button>
                </li>
              )
            })}
          </ul>
          {editedUpdates > 0 && (
            <p className="mt-1 text-(--ui-text-tertiary)" data-testid="hub-updates-kept">
              {h.keptOnUpdateAll(editedUpdates)}
            </p>
          )}
        </div>
      )}

      {changes.isLoading ? (
        <p className="mt-2 text-sm text-(--ui-text-tertiary)">{h.searching}</p>
      ) : installs.length === 0 ? (
        <p className="mt-2 text-sm text-(--ui-text-tertiary)">{h.noInstalls}</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1" data-testid="hub-installs">
          {installs.map(row => (
            <li className="flex flex-wrap items-center gap-1.5 text-xs" data-testid="hub-install" key={row.id}>
              <span className="font-medium text-foreground/85">{row.name || row.slug}</span>
              <span className="text-(--ui-text-quaternary)">{row.version ?? row.latest_version ?? ''}</span>
              <span className="rounded bg-(--ui-bg-tertiary) px-1.5 py-0.5 text-(--ui-text-secondary)">
                {h.desired[row.desired_state] ?? row.desired_state}
              </span>
              <StatusPill data-testid="hub-reported" tone={reportedTone(row)}>
                {h.reported[row.reported_state] ?? row.reported_state}
              </StatusPill>
              {row.local?.installed && !row.local.enabled && (
                <span className="text-(--ui-text-quaternary)">{h.localDisabled}</span>
              )}
              {row.reason && <span className="text-(--ui-text-quaternary)">— {row.reason}</span>}
              {row.error && <span className="text-destructive">{row.error}</span>}
            </li>
          ))}
        </ul>
      )}

      {data && data.workspaces.length > 0 && (
        <p className="mt-2 text-sm text-(--ui-text-tertiary)" data-testid="hub-workspaces">
          {h.workspaceSkills(
            data.workspaces.reduce((n, w) => n + w.skills.length, 0),
            data.workspaces.length
          )}
        </p>
      )}

      <ReplaceEditedSkillDialog onClose={() => setReplace(null)} target={replace} />

      {history.length > 0 && (
        <div className="mt-2 text-xs text-(--ui-text-tertiary)" data-testid="hub-history">
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
