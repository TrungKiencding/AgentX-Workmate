/** The list column: one row per assistant, Messages-style. Pinned first, the
 *  main assistant leading the rest, then one block per group (with its room). */

import {
  Button,
  cn,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  host,
  icons,
  relativeTime,
  useValue
} from '@agentx/plugin-sdk'
import type { ReactNode } from 'react'

import { type BotMenuItem } from './actions'
import { BotAvatar } from './face'
import { plainMentions } from './group-chat'
import type { BotsText } from './i18n'
import { cleanPreview, displayName, groupRoster, isPrimary, previewSender } from './naming'
import { $groupChats } from './state'
import type { Bot, BotMetaMap } from './types'

export type Selection = { kind: 'bot'; name: string } | { kind: 'group'; name: string }

export function selectionKey(selection: Selection | null): string {
  return selection ? `${selection.kind}:${selection.name}` : ''
}

interface ListProps {
  b: BotsText
  busy: ReadonlySet<string>
  meta: BotMetaMap
  menuFor: (bot: Bot) => BotMenuItem[]
  needsYou: Record<string, boolean>
  onCreate: () => void
  onSelect: (selection: Selection) => void
  onWarm: (bot: Bot) => void
  query: string
  roster: readonly Bot[]
  selection: Selection | null
  unread: ReadonlySet<string>
}

/** Pinned · everyone else (main assistant first) · each group. */
export function listSections(roster: readonly Bot[], meta: BotMetaMap) {
  const pinned = roster.filter(bot => meta[bot.name]?.pinned)
  const rest = roster.filter(bot => !meta[bot.name]?.pinned)
  const [primary, others] = [rest.filter(bot => isPrimary(bot.name)), rest.filter(bot => !isPrimary(bot.name))]
  const grouped = groupRoster([...primary, ...others], meta)

  return {
    pinned,
    loose: grouped.find(section => section.group === null)?.bots ?? [],
    groups: grouped.filter(section => section.group !== null) as { bots: Bot[]; group: string }[]
  }
}

export function BotList(props: ListProps) {
  const { b, meta, onCreate, query, roster } = props
  const { groups, loose, pinned } = listSections(roster, meta)
  const onlyPrimary = !query && roster.length === 1 && isPrimary(roster[0]?.name)

  if (!roster.length) {
    return <p className="px-3 py-10 text-center text-sm text-(--text-tertiary)">{b.noMatch(query.trim())}</p>
  }

  return (
    <nav aria-label={b.pageTitle} className="grid gap-4">
      {pinned.length ? (
        <Section title={b.sectionPinned}>
          {pinned.map(bot => (
            <Row bot={bot} key={bot.name} {...props} />
          ))}
        </Section>
      ) : null}
      {loose.length ? (
        <Section title={pinned.length || groups.length ? b.sectionBots : undefined}>
          {loose.map(bot => (
            <Row bot={bot} key={bot.name} {...props} />
          ))}
        </Section>
      ) : null}
      {groups.map(section => (
        <Section key={section.group} title={section.group}>
          {section.bots.length >= 2 ? <GroupRow group={section.group} members={section.bots} {...props} /> : null}
          {section.bots.map(bot => (
            <Row bot={bot} key={bot.name} {...props} />
          ))}
        </Section>
      ))}
      {onlyPrimary ? (
        <div className="mx-1 grid gap-2 rounded-(--radius-card) border border-dashed border-(--border-default) p-3.5">
          <p className="text-sm font-medium text-(--text-primary)">{b.onboardTitle}</p>
          <p className="text-sm leading-5 text-(--text-secondary)">{b.onboardBody}</p>
          <Button className="justify-self-start" onClick={onCreate} size="sm" variant="outline">
            <icons.Plus className="size-4" />
            {b.create}
          </Button>
        </div>
      ) : null}
    </nav>
  )
}

function Section({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <section className="grid gap-0.5">
      {title ? <h3 className="truncate px-2.5 pb-1 text-xs font-semibold text-(--text-tertiary)">{title}</h3> : null}
      <ul className="grid gap-0.5">{children}</ul>
    </section>
  )
}

const ROW =
  'row-hover group/row flex w-full min-w-0 items-center gap-3 rounded-(--radius-control) px-2.5 py-2 text-left transition-colors duration-(--dur-micro)'

function Row({ b, bot, busy, meta, menuFor, onSelect, onWarm, selection, unread }: ListProps & { bot: Bot }) {
  const botMeta = meta[bot.name]
  const active = selection?.kind === 'bot' && selection.name === bot.name
  const working = busy.has(bot.name)
  const isUnread = unread.has(bot.name)
  const last = bot.last_session
  const sender = previewSender(last?.preview)
  const preview = cleanPreview(last?.preview) || (isPrimary(bot.name) ? b.primaryRole : bot.description || b.noMessages)
  const name = displayName(bot, botMeta, b.primaryName)
  const items = menuFor(bot)

  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            aria-current={active ? 'true' : undefined}
            className={cn(ROW, active ? 'bg-(--ui-row-active-background)' : 'hover:bg-(--bg-hover)')}
            onClick={() => onSelect({ kind: 'bot', name: bot.name })}
            onPointerEnter={() => onWarm(bot)}
            type="button"
          >
            <BotAvatar meta={botMeta} mood={working ? 'work' : 'idle'} name={bot.name} size={36} />
            <span className="grid min-w-0 flex-1 gap-0.5">
              <span className="flex min-w-0 items-baseline gap-2">
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate text-base text-(--text-primary)',
                    isUnread ? 'font-semibold' : 'font-medium'
                  )}
                >
                  {name}
                </span>
                {working ? (
                  <span className="flex shrink-0 items-center gap-1 text-xs text-(--tint-green)">
                    <span aria-hidden className="agentx-bots-live size-1.5 rounded-full bg-current" />
                    {b.working}
                  </span>
                ) : last?.last_active ? (
                  <span className="shrink-0 text-xs text-(--text-tertiary) tabular-nums">
                    {relativeTime(last.last_active * 1000)}
                  </span>
                ) : null}
              </span>
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate text-sm',
                    isUnread ? 'text-(--text-primary)' : 'text-(--text-tertiary)'
                  )}
                >
                  {sender ? <span className="text-(--accent)">{`${b.fromBot(sender)}: `}</span> : null}
                  {preview}
                </span>
                {isUnread ? (
                  <span aria-label={b.unread} className="size-2 shrink-0 rounded-full bg-(--accent)" role="img" />
                ) : null}
              </span>
            </span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {items.map(item => (
            <MenuEntry item={item} key={item.id} />
          ))}
        </ContextMenuContent>
      </ContextMenu>
    </li>
  )
}

function MenuEntry({ item }: { item: BotMenuItem }) {
  return (
    <>
      {item.separatorBefore ? <ContextMenuSeparator /> : null}
      <ContextMenuItem onSelect={item.onSelect} variant={item.destructive ? 'destructive' : undefined}>
        {item.label}
      </ContextMenuItem>
    </>
  )
}

function GroupRow({
  b,
  group,
  members,
  needsYou,
  onSelect,
  selection,
  meta
}: ListProps & { group: string; members: Bot[] }) {
  const active = selection?.kind === 'group' && selection.name === group
  const last = useValue($groupChats)[group]?.log.at(-1)

  // The room's latest line, like any conversation row; before the first
  // message, who is in it.
  const labels = {
    everyone: b.groupEveryone,
    members: members.map(bot => ({ name: bot.name, title: displayName(bot, meta[bot.name], b.primaryName) })),
    user: b.groupYou
  }

  const lastText = last ? cleanPreview(plainMentions(last.text, labels)) : ''

  const subtitle = !last
    ? members.map(bot => displayName(bot, meta[bot.name], b.primaryName)).join(', ')
    : last.from.kind === 'notice'
      ? last.text
      : `${last.from.kind === 'user' ? b.you : displayName({ name: last.from.name }, meta[last.from.name], b.primaryName)}: ${lastText || (last.attachments?.length ? last.attachments.map(item => item.name).join(', ') : '')}`

  return (
    <li>
      <button
        aria-current={active ? 'true' : undefined}
        className={cn(ROW, active ? 'bg-(--ui-row-active-background)' : 'hover:bg-(--bg-hover)')}
        onClick={() => onSelect({ kind: 'group', name: group })}
        type="button"
      >
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-(--bg-subtle) text-(--tint-indigo)">
          <icons.Users className="size-4.5" />
        </span>
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-base font-medium text-(--text-primary)">{b.groupRoom}</span>
            {needsYou[group] ? (
              <span className="shrink-0 rounded-full bg-(--accent) px-1.5 text-xs font-medium text-(--text-inverse)">
                {b.groupNeedsYou}
              </span>
            ) : null}
          </span>
          <span className="truncate text-sm text-(--text-tertiary)">{subtitle}</span>
        </span>
      </button>
    </li>
  )
}

/** Exposed for the page: warm a profile's backend on hover intent. */
export function warmBot(bot: Bot): void {
  try {
    host.warmProfile(bot.name)
  } catch {
    /* best-effort */
  }
}
