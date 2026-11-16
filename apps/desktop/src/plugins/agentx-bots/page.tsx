/**
 * The "Trợ lý" page — Bot Mode's single home.
 *
 * One page, two columns, no tabs: the list (who) on the left, the selected
 * assistant (what it does for you) on the right. Everything an assistant
 * owns — its picture, its scheduled tasks, its conversations — lives in that
 * one detail view, so nothing is duplicated across panes. On a narrow window
 * the page becomes a list that drills into the detail.
 */

import {
  atom,
  Button,
  cn,
  ConfirmDialog,
  GlyphSpinner,
  host,
  icons,
  PageSearchShell,
  useQuery,
  useValue
} from '@agentx/plugin-sdk'
import { useEffect, useMemo, useState } from 'react'

import { botMenuItems, openBot } from './actions'
import { CreateAgentDialog, EditAgentDialog } from './agent-dialog'
import { BotDetail } from './bot-detail'
import { BotList, type Selection, warmBot } from './bot-list'
import { GroupDialog, GroupRoom } from './group-room'
import { useBots } from './i18n'
import { displayName, filterBots, sortRoster, workingBots } from './naming'
import {
  $botMeta,
  $groupChats,
  $groupNeedsYou,
  $recentlyDeleted,
  $seenActivity,
  deleteBot,
  markSeen,
  markSeenAt,
  mergeServerMeta,
  noteRoster,
  pullServerAvatars,
  ROSTER_KEY,
  settleDeleted,
  unreadBots,
  withoutDeleted
} from './state'
import type { Bot, RosterResponse } from './types'

/** Survives navigating away and back. */
export const $selection = atom<Selection | null>(null)
/** Palette / keybind "New assistant" lands here; the page opens the dialog. */
export const $createRequest = atom(0)

/** Last good roster, so a failed refresh never blanks the page. */
let lastRoster: Bot[] = []

export function useRoster() {
  const gateway = useValue(host.state.gateway)

  const query = useQuery({
    queryKey: ROSTER_KEY,
    queryFn: () => host.requestPrimary<RosterResponse>('profiles.list', {}),
    // Only while the page is open: activity previews and "working" dots.
    refetchInterval: 10_000,
    staleTime: 5_000,
    retry: 3,
    retryDelay: attempt => Math.min(10_000, 1000 * 2 ** attempt)
  })

  const { refetch } = query

  // A reconnect (boot, sleep/wake, remote gateway) refreshes right away.
  useEffect(() => {
    if (gateway === 'open') {
      void refetch()
    }
  }, [gateway, refetch])

  return query
}

export function BotsPage() {
  const b = useBots()
  const { data, error, isLoading, refetch } = useRoster()
  const meta = useValue($botMeta)
  const seen = useValue($seenActivity)
  const needsYou = useValue($groupNeedsYou)
  const selection = useValue($selection)
  const gateway = useValue(host.state.gateway)
  const activeProfile = useValue(host.state.profile)
  const narrow = useValue(host.state.viewport).narrow
  const createRequest = useValue($createRequest)
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<Bot | null>(null)
  const [grouping, setGrouping] = useState<Bot | null>(null)
  const [deleting, setDeleting] = useState<Bot | null>(null)

  const deleted = useValue($recentlyDeleted)
  const live = Array.isArray(data?.profiles) ? data.profiles : null

  const source = useMemo(() => withoutDeleted(live ?? (error ? lastRoster : []), deleted), [live, error, deleted])

  useEffect(() => {
    if (live) {
      lastRoster = live
      mergeServerMeta(live)
      pullServerAvatars(live)
      noteRoster(live)
      settleDeleted(live)
    }
  }, [live])

  // Arriving here from an assistant's chat: what it said while you were
  // reading it is not "new" — only other assistants' activity is.
  useEffect(() => {
    markSeenAt((host.state.profile.get() || 'default').trim() || 'default', Math.floor(Date.now() / 1000))
  }, [])

  useEffect(() => {
    if (createRequest > 0) {
      setCreating(true)
    }
  }, [createRequest])

  const roster = useMemo(() => sortRoster(source, meta), [source, meta])
  const visible = useMemo(() => filterBots(roster, meta, query), [roster, meta, query])
  const unread = useMemo(() => unreadBots(roster, seen), [roster, seen])

  const rooms = useValue($groupChats)

  const busy = useMemo(() => {
    // A busy gateway means the live profile is answering; a room's speaker is
    // answering in the room. Nothing else counts as "working".
    const busyProfile = gateway === 'busy' ? (activeProfile || 'default').trim() || 'default' : null

    return workingBots(
      busyProfile,
      Object.values(rooms).map(room => (room.running ? room.speaker : null))
    )
  }, [gateway, activeProfile, rooms])

  // Default selection: the main assistant (or the first one) on wide windows.
  const resolved: Selection | null = useMemo(() => {
    if (selection?.kind === 'bot' && roster.some(bot => bot.name === selection.name)) {
      return selection
    }

    if (selection?.kind === 'group' && roster.some(bot => (meta[bot.name]?.group || '').trim() === selection.name)) {
      return selection
    }

    if (narrow || !roster.length) {
      return null
    }

    return { kind: 'bot', name: roster.find(bot => bot.is_default)?.name ?? roster[0].name }
  }, [selection, roster, meta, narrow])

  const handlers = {
    onDelete: setDeleting,
    onDuplicated: (name: string) => $selection.set({ kind: 'bot', name }),
    onEdit: setEditing,
    onGroup: setGrouping
  }

  const menuFor = (bot: Bot) => botMenuItems(bot, roster, b, handlers)
  const selectedBot = resolved?.kind === 'bot' ? roster.find(bot => bot.name === resolved.name) : undefined

  const groupMembers =
    resolved?.kind === 'group' ? roster.filter(bot => (meta[bot.name]?.group || '').trim() === resolved.name) : []

  const select = (next: Selection) => {
    $selection.set(next)

    if (next.kind === 'bot') {
      const bot = roster.find(row => row.name === next.name)

      // Opening the detail is enough to clear the dot.
      if (bot) {
        markSeen(bot)
      }
    }
  }

  const back = narrow ? () => $selection.set(null) : undefined
  const showList = !narrow || !resolved
  const showDetail = !narrow || Boolean(resolved)

  const body =
    isLoading && !source.length ? (
      <div className="grid h-full place-items-center">
        <div className="flex items-center gap-2 text-sm text-(--text-tertiary)">
          <GlyphSpinner spinner="breathe" />
          {b.loading}
        </div>
      </div>
    ) : error && !source.length ? (
      <div className="grid h-full place-items-center px-6 text-center">
        <div className="grid justify-items-center gap-3">
          <p className="text-sm text-(--text-secondary)">{gateway === 'open' ? b.loadError : b.waitingGateway}</p>
          <Button onClick={() => void refetch()} size="sm" variant="outline">
            <icons.RefreshCw className="size-4" />
            {b.retry}
          </Button>
        </div>
      </div>
    ) : (
      <div
        className={cn(
          'grid h-full min-h-0 grid-cols-1',
          // Two columns only when both are on screen; a narrow window drills in.
          showList && showDetail && 'grid-cols-[19rem_minmax(0,1fr)]'
        )}
      >
        {showList ? (
          <aside className="flex min-h-0 flex-col border-(--border-subtle) sm:border-r">
            {error && live === null ? (
              <p className="mx-3 mt-1 mb-2 rounded-(--radius-control) bg-(--bg-subtle) px-3 py-2 text-xs text-(--text-secondary)">
                {b.staleNotice}
              </p>
            ) : null}
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pt-1 pb-4 [scrollbar-gutter:stable]">
              <BotList
                b={b}
                busy={busy}
                menuFor={menuFor}
                meta={meta}
                needsYou={needsYou}
                onCreate={() => setCreating(true)}
                onSelect={select}
                onWarm={warmBot}
                query={query}
                roster={visible}
                selection={resolved}
                unread={unread}
              />
            </div>
          </aside>
        ) : null}
        {showDetail ? (
          <main className="min-h-0 overflow-hidden">
            {selectedBot ? (
              <div className="h-full overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
                <BotDetail
                  b={b}
                  bot={selectedBot}
                  key={selectedBot.name}
                  menu={menuFor(selectedBot)}
                  onBack={back}
                  onEdit={() => setEditing(selectedBot)}
                  onMessage={() => void openBot(selectedBot, b)}
                  showMentionTip={roster.length > 1}
                  working={busy.has(selectedBot.name)}
                />
              </div>
            ) : resolved?.kind === 'group' ? (
              <GroupRoom group={resolved.name} key={resolved.name} members={groupMembers} onBack={back} />
            ) : null}
          </main>
        ) : null}
      </div>
    )

  return (
    <PageSearchShell
      description={b.pageDescription}
      onSearchChange={setQuery}
      searchPlaceholder={b.search}
      searchTrailingAction={
        <Button onClick={() => setCreating(true)} size="sm">
          <icons.Plus className="size-4" />
          {b.create}
        </Button>
      }
      searchValue={query}
      title={b.pageTitle}
    >
      {body}
      <CreateAgentDialog
        onClose={() => setCreating(false)}
        onCreated={name => {
          // Stay here: the new assistant is selected, its "Message" button is
          // one click away. Nothing is sent on the user's behalf.
          setCreating(false)
          $selection.set({ kind: 'bot', name })
        }}
        open={creating}
        roster={roster}
      />
      <EditAgentDialog bot={editing} onClose={() => setEditing(null)} />
      <GroupDialog bot={grouping} onClose={() => setGrouping(null)} />
      <ConfirmDialog
        busyLabel={b.deleting}
        confirmLabel={b.deleteConfirm}
        description={b.deleteBody}
        destructive
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) {
            return
          }

          const label = displayName(deleting, meta[deleting.name], b.primaryName)
          const selected = $selection.get()

          // Unmount its detail first: its polls name the profile being removed.
          if (selected?.kind === 'bot' && selected.name === deleting.name) {
            $selection.set(null)
          }

          await deleteBot(deleting.name)

          host.notify({ kind: 'success', message: b.deleted(label) })
        }}
        open={Boolean(deleting)}
        title={deleting ? b.deleteTitle(displayName(deleting, meta[deleting.name], b.primaryName)) : ''}
      />
    </PageSearchShell>
  )
}
