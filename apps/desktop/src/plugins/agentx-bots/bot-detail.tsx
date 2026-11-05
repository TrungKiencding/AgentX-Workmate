/** The detail column for one assistant: who it is, one primary verb
 *  ("Message"), then its scheduled tasks and its conversations. */

import {
  Button,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  host,
  icons,
  relativeTime,
  Skeleton,
  StatusDot,
  Switch,
  Tip,
  useQuery,
  useValue
} from '@agentx/plugin-sdk'
import { type ReactNode, useState } from 'react'

import type { BotMenuItem } from './actions'
import { BotAvatar } from './face'
import type { BotsText } from './i18n'
import { BOT_CHAT_TITLE, botHandle, cleanPreview, displayName, isPrimary, sessionLabel } from './naming'
import { RoutineDialog } from './routine-dialog'
import { describeSchedule, routineAction, routineActive, routineTitle, useRoutines } from './routines'
import { $botMeta, PLUGIN_ID } from './state'
import type { Bot, CronJob, ProfileSession } from './types'

export function BotDetail({
  b,
  bot,
  menu,
  onBack,
  onEdit,
  onMessage,
  showMentionTip,
  working
}: {
  b: BotsText
  bot: Bot
  menu: BotMenuItem[]
  onBack?: () => void
  onEdit: () => void
  onMessage: () => void
  showMentionTip: boolean
  working: boolean
}) {
  const meta = useValue($botMeta)[bot.name]
  const name = displayName(bot, meta, b.primaryName)
  const lastActive = bot.last_session?.last_active

  return (
    <div className="mx-auto grid max-w-2xl gap-8 px-6 pt-5 pb-10">
      <header className="grid gap-4">
        {onBack ? (
          <Button className="-ml-2 justify-self-start" onClick={onBack} size="sm" variant="ghost">
            <icons.ChevronLeft className="size-4" />
            {b.back}
          </Button>
        ) : null}
        <div className="flex items-start gap-4">
          <BotAvatar meta={meta} mood={working ? 'work' : 'idle'} name={bot.name} size={64} />
          <div className="grid min-w-0 flex-1 gap-1 pt-1">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <h2 className="min-w-0 truncate text-xl font-semibold tracking-tight text-(--text-primary)">{name}</h2>
              <span className="text-sm text-(--text-tertiary)">@{botHandle(bot.name)}</span>
              {isPrimary(bot.name) ? (
                <span className="rounded-full bg-(--bg-subtle) px-2 py-0.5 text-xs font-medium text-(--text-secondary)">
                  {b.primaryRole}
                </span>
              ) : null}
            </div>
            <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-(--text-secondary)">
              <StatusDot tone={working ? 'good' : 'muted'} />
              <span>
                {working ? b.working : lastActive ? b.lastActive(relativeTime(lastActive * 1000)) : b.neverActive}
              </span>
              <span aria-hidden className="text-(--text-tertiary)">
                ·
              </span>
              <span className="truncate">{bot.model || b.modelDefault}</span>
              {bot.skill_count ? (
                <>
                  <span aria-hidden className="text-(--text-tertiary)">
                    ·
                  </span>
                  <span>{b.skillCount(bot.skill_count)}</span>
                </>
              ) : null}
            </p>
          </div>
        </div>
        {bot.description?.trim() ? (
          <p className="max-w-prose text-[0.9375rem] leading-relaxed text-pretty text-(--text-primary)">
            {bot.description}
          </p>
        ) : (
          <button
            className="max-w-prose text-left text-sm leading-relaxed text-(--text-tertiary) hover:text-(--text-secondary)"
            onClick={onEdit}
            type="button"
          >
            {b.noDescription}
          </button>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={onMessage}>
            <icons.MessageCircle className="size-4" />
            {b.message}
          </Button>
          <Button onClick={onEdit} variant="outline">
            <icons.Pencil className="size-4" />
            {b.edit}
          </Button>
          <DropdownMenu>
            <Tip label={b.moreActions}>
              <DropdownMenuTrigger asChild>
                <Button aria-label={b.moreActions} size="icon" variant="ghost">
                  <icons.MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
            </Tip>
            <DropdownMenuContent align="start">
              {menu
                .filter(item => item.id !== 'edit')
                .map(item => (
                  <MenuEntry item={item} key={item.id} />
                ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {showMentionTip ? (
          <p className="flex items-center gap-2 text-sm text-(--text-tertiary)">
            <icons.AtSign className="size-4 shrink-0" />
            {b.mentionTip(botHandle(bot.name))}
          </p>
        ) : null}
      </header>

      <RoutinesSection b={b} botLabel={name} profile={bot.name} />
      <ChatsSection b={b} bot={bot} onMessage={onMessage} />
    </div>
  )
}

function MenuEntry({ item }: { item: BotMenuItem }) {
  return (
    <>
      {item.separatorBefore ? <DropdownMenuSeparator /> : null}
      <DropdownMenuItem onSelect={item.onSelect} variant={item.destructive ? 'destructive' : undefined}>
        {item.label}
      </DropdownMenuItem>
    </>
  )
}

function SectionHeader({ action, description, title }: { action?: ReactNode; description: string; title: string }) {
  return (
    <div className="flex items-end justify-between gap-4">
      <div className="min-w-0">
        <h3 className="text-md font-semibold text-(--text-primary)">{title}</h3>
        <p className="text-sm text-(--text-tertiary)">{description}</p>
      </div>
      {action}
    </div>
  )
}

const CARD = 'overflow-hidden rounded-(--radius-card) border border-(--border-default)'

// ── scheduled tasks ──────────────────────────────────────────────────────────

function RoutinesSection({ b, botLabel, profile }: { b: BotsText; botLabel: string; profile: string }) {
  const { data, error, isLoading, refetch } = useRoutines(profile)
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<CronJob | null>(null)
  const jobs = data ?? []

  return (
    <section className="grid gap-3">
      <SectionHeader
        action={
          <Button onClick={() => setAdding(true)} size="sm" variant="outline">
            <icons.Plus className="size-4" />
            {b.addRoutine}
          </Button>
        }
        description={b.routinesDescription}
        title={b.routinesTitle}
      />
      {isLoading ? (
        <Skeleton className="h-16 w-full rounded-(--radius-card)" />
      ) : error && !data ? (
        <div className={`${CARD} flex items-center justify-between gap-3 px-4 py-3`}>
          <span className="text-sm text-(--text-secondary)">{b.routinesLoadError}</span>
          <Button onClick={() => void refetch()} size="sm" variant="text">
            {b.retry}
          </Button>
        </div>
      ) : jobs.length === 0 ? (
        <button
          className={`${CARD} flex items-center gap-3 border-dashed px-4 py-4 text-left text-sm text-(--text-tertiary) hover:bg-(--bg-hover)`}
          onClick={() => setAdding(true)}
          type="button"
        >
          <icons.Clock className="size-5 shrink-0 text-(--tint-orange)" />
          {b.routinesEmpty}
        </button>
      ) : (
        <ul className={`${CARD} divide-y divide-(--border-subtle)`}>
          {jobs.map(job => (
            <RoutineRow b={b} job={job} key={job.job_id} onRemove={() => setRemoving(job)} profile={profile} />
          ))}
        </ul>
      )}
      <RoutineDialog botLabel={botLabel} onClose={() => setAdding(false)} open={adding} profile={profile} />
      <ConfirmDialog
        busyLabel={b.deleting}
        confirmLabel={b.deleteRoutine}
        description={b.deleteRoutineBody}
        destructive
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          if (removing) {
            await routineAction(profile, removing.job_id, 'remove')
          }
        }}
        open={Boolean(removing)}
        title={removing ? b.deleteRoutineTitle(routineTitle(removing, b.routineUntitled)) : ''}
      />
    </section>
  )
}

function RoutineRow({
  b,
  job,
  onRemove,
  profile
}: {
  b: BotsText
  job: CronJob
  onRemove: () => void
  profile: string
}) {
  const [pending, setPending] = useState<boolean | null>(null)
  const serverActive = routineActive(job)
  const active = pending ?? serverActive
  const failed = job.last_status && job.last_status !== 'ok'

  const toggle = async (next: boolean) => {
    setPending(next)

    try {
      await routineAction(profile, job.job_id, next ? 'resume' : 'pause')
    } catch (error) {
      host.notifyError(error, b.routineUpdateFailed)
    } finally {
      setPending(null)
    }
  }

  const when = active ? (job.next_run_at ? b.nextRun(relativeTime(new Date(job.next_run_at).getTime())) : '') : b.paused

  return (
    <li className="group/routine flex items-center gap-3 px-4 py-3">
      <span className="grid size-8 shrink-0 place-items-center rounded-(--radius-control) bg-(--bg-subtle)">
        <icons.Clock className={active ? 'size-4 text-(--tint-orange)' : 'size-4 text-(--text-tertiary)'} />
      </span>
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span
          className={
            active
              ? 'truncate text-sm font-medium text-(--text-primary)'
              : 'truncate text-sm font-medium text-(--text-tertiary)'
          }
        >
          {routineTitle(job, b.routineUntitled)}
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-(--text-tertiary)">
          <span>{describeSchedule(job.schedule, b)}</span>
          {when ? (
            <>
              <span aria-hidden>·</span>
              <span>{when}</span>
            </>
          ) : null}
          {failed ? (
            <>
              <span aria-hidden>·</span>
              <span className="text-(--danger)">{b.lastFailed}</span>
            </>
          ) : null}
        </span>
      </span>
      <Tip label={active ? b.pauseRoutine : b.resumeRoutine}>
        <span>
          <Switch
            aria-label={active ? b.pauseRoutine : b.resumeRoutine}
            checked={active}
            disabled={pending !== null}
            onCheckedChange={value => void toggle(value)}
          />
        </span>
      </Tip>
      <Tip label={b.deleteRoutine}>
        <Button
          aria-label={b.deleteRoutine}
          className="opacity-0 transition-opacity group-hover/routine:opacity-100 focus-visible:opacity-100"
          onClick={onRemove}
          size="icon-xs"
          variant="ghost"
        >
          <icons.Trash2 />
        </Button>
      </Tip>
    </li>
  )
}

// ── conversations ───────────────────────────────────────────────────────────

const CHAT_PREVIEW_COUNT = 5

function useProfileSessions(profile: string) {
  return useQuery({
    queryKey: [PLUGIN_ID, 'sessions', profile],
    queryFn: async () =>
      (await host.request<{ sessions?: ProfileSession[] }>('session.list', { profile, limit: 100 }))?.sessions ?? [],
    refetchInterval: 30_000,
    staleTime: 10_000
  })
}

function ChatsSection({ b, bot, onMessage }: { b: BotsText; bot: Bot; onMessage: () => void }) {
  const { data, isLoading } = useProfileSessions(bot.name)
  const [expanded, setExpanded] = useState(false)
  const pinned = useValue($botMeta)[bot.name]?.chat || null
  const sessions = (data ?? []).filter(session => !(session.title || '').startsWith('Group: '))

  const isMain = (session: ProfileSession) =>
    session.id === pinned || (!pinned && (session.title || '').trim() === BOT_CHAT_TITLE)

  // The main conversation leads; the rest keep their recency order.
  const ordered = [...sessions.filter(isMain), ...sessions.filter(session => !isMain(session))]
  const visible = expanded ? ordered : ordered.slice(0, CHAT_PREVIEW_COUNT)

  const open = (session: ProfileSession) => {
    if (isMain(session)) {
      onMessage()

      return
    }

    host.openSession(session.id, { profile: bot.name }).catch(error => host.notifyError(error, b.openFailed))
  }

  return (
    <section className="grid gap-3">
      <SectionHeader description={b.chatsDescription} title={b.chatsTitle} />
      {isLoading ? (
        <Skeleton className="h-28 w-full rounded-(--radius-card)" />
      ) : ordered.length === 0 ? (
        <p className={`${CARD} px-4 py-4 text-sm text-(--text-tertiary)`}>{b.chatsEmpty}</p>
      ) : (
        <>
          <ul className={`${CARD} divide-y divide-(--border-subtle)`}>
            {visible.map(session => {
              const main = isMain(session)
              const preview = cleanPreview(session.preview)

              return (
                <li key={session.id}>
                  <button
                    className="flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left hover:bg-(--bg-hover)"
                    onClick={() => open(session)}
                    type="button"
                  >
                    <span className="grid size-8 shrink-0 place-items-center rounded-(--radius-control) bg-(--bg-subtle)">
                      {main ? (
                        <icons.MessageCircle className="size-4 text-(--tint-blue)" />
                      ) : (
                        <icons.MessageSquareText className="size-4 text-(--text-tertiary)" />
                      )}
                    </span>
                    <span className="grid min-w-0 flex-1 gap-0.5">
                      <span className="truncate text-sm font-medium text-(--text-primary)">
                        {main ? b.mainChat : sessionLabel(session, b.untitledChat)}
                      </span>
                      {preview ? <span className="truncate text-xs text-(--text-tertiary)">{preview}</span> : null}
                    </span>
                    {session.last_active ? (
                      <span className="shrink-0 text-xs text-(--text-tertiary) tabular-nums">
                        {relativeTime(session.last_active * 1000)}
                      </span>
                    ) : null}
                  </button>
                </li>
              )
            })}
          </ul>
          {ordered.length > CHAT_PREVIEW_COUNT ? (
            <Button
              className="justify-self-start"
              onClick={() => setExpanded(value => !value)}
              size="sm"
              variant="text"
            >
              {expanded ? b.showFewerChats : b.showAllChats(ordered.length)}
            </Button>
          ) : null}
        </>
      )}
    </section>
  )
}
