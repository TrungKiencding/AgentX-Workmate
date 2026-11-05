/** Group room (a shared conversation for a group's assistants) and the
 *  "Add to a group" dialog. */

import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  host,
  icons,
  Input,
  isImeComposing,
  Markdown,
  relativeTime,
  Tip,
  useValue
} from '@agentx/plugin-sdk'
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { BotAvatar } from './face'
import {
  clearGroup,
  EVERYONE_HANDLE,
  GROUP_MAX_MEMBERS,
  insertMention,
  mentionOptions,
  mentionQuery,
  sendToGroup
} from './group-chat'
import { type BotsText, useBots } from './i18n'
import { botHandle, displayName, knownGroups } from './naming'
import { $botMeta, $groupChats, $groupNeedsYou, emptyRoom, markSeenAt, saveBotMeta } from './state'
import type { Bot, BotMeta, GroupEntry, GroupMember } from './types'

/** Two lines from the same member within this window read as one turn. */
const CONTINUATION_MS = 5 * 60_000

type MentionOption = ReturnType<typeof mentionOptions<GroupMember>>[number]

export function GroupRoom({ group, members, onBack }: { group: string; members: Bot[]; onBack?: () => void }) {
  const b = useBots()
  const rooms = useValue($groupChats)
  const meta = useValue($botMeta)
  const room = rooms[group] || emptyRoom()
  const [draft, setDraft] = useState('')
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null)
  const [active, setActive] = useState(0)
  const scroller = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const roster = members.slice(0, GROUP_MAX_MEMBERS)
  const benched = members.slice(GROUP_MAX_MEMBERS)
  const tooFew = members.length < 2
  // Stable across re-renders (the page re-filters members on every poll).
  const memberKey = members.map(bot => bot.name).join(',')
  const nameOf = (bot: Pick<Bot, 'name'>) => displayName(bot, meta[bot.name], b.primaryName)

  const seats: GroupMember[] = roster.map(bot => ({ name: bot.name, title: meta[bot.name]?.title || nameOf(bot) }))
  const options = mention && !tooFew ? mentionOptions(seats, mention.query) : []
  const activeIndex = Math.min(active, Math.max(0, options.length - 1))

  // What members say here is read here: it must not light their "new
  // activity" dot in the list.
  useEffect(() => {
    if ($groupNeedsYou.get()[group]) {
      $groupNeedsYou.set({ ...$groupNeedsYou.get(), [group]: false })
    }

    const now = Math.floor(Date.now() / 1000)
    memberKey.split(',').forEach(name => name && markSeenAt(name, now))
  }, [group, memberKey, room.log.length])

  // Keep the newest message in view as the room fills.
  useLayoutEffect(() => {
    const node = scroller.current

    if (node) {
      node.scrollTop = node.scrollHeight
    }
  }, [room.log.length, room.running, room.speaker])

  /** Put `text` in the composer and the caret at `caret` (default: the end). */
  const fill = (text: string, caret = text.length) => {
    setDraft(text)
    setMention(null)
    requestAnimationFrame(() => {
      const node = input.current

      if (node) {
        node.focus()
        node.setSelectionRange(caret, caret)
      }
    })
  }

  // Typing, clicking and caret moves all re-read the word at the caret
  // (Chromium fires selectionchange on the textarea, not the document, so
  // onSelect alone misses typed input).
  const syncMention = (node: HTMLTextAreaElement) => {
    const next = mentionQuery(node.value, node.selectionStart ?? node.value.length)

    if (next?.query !== mention?.query || next?.start !== mention?.start) {
      setMention(next)
      setActive(0)
    }
  }

  const pick = (option: MentionOption) => {
    if (!mention) {
      return
    }

    const caret = input.current?.selectionStart ?? draft.length
    const next = insertMention(draft, mention.start, caret, option.handle)
    fill(next.text, next.caret)
  }

  /** A click on a member's face in the header: address them by name. */
  const addressMember = (handle: string) => {
    const base = draft.replace(/\s+$/, '')
    fill(`${base ? `${base} ` : ''}@${handle} `)
  }

  const send = () => {
    const text = draft.trim()

    if (!text || tooFew) {
      return
    }

    setDraft('')
    setMention(null)
    sendToGroup(group, seats, text)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isImeComposing(event)) {
      return
    }

    if (options.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const step = event.key === 'ArrowDown' ? 1 : -1
        setActive((activeIndex + step + options.length) % options.length)

        return
      }

      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        event.preventDefault()
        pick(options[activeIndex])

        return
      }

      if (event.key === 'Escape') {
        event.preventDefault()
        setMention(null)

        return
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      send()
    }
  }

  const speaker = room.speaker ? roster.find(bot => bot.name === room.speaker) : undefined

  return (
    <div className="@container flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-(--border-subtle) px-5 py-3">
        {onBack ? (
          <Button aria-label={b.back} onClick={onBack} size="icon-sm" variant="ghost">
            <icons.ChevronLeft />
          </Button>
        ) : null}
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-(--bg-subtle) text-(--tint-indigo)">
          <icons.Users className="size-4.5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold text-(--text-primary)">{b.groupRoomTitle(group)}</h2>
          <p className="truncate text-sm text-(--text-tertiary)">{b.groupMembers(members.length)}</p>
        </div>
        <ul aria-label={b.groupMentionList} className="hidden items-center @xl:flex">
          {members.map(bot => {
            const out = benched.includes(bot)
            const label = nameOf(bot)

            return (
              <li key={bot.name}>
                <Tip label={out ? b.groupOutOfRoom(label) : b.groupMention(label)}>
                  <button
                    aria-disabled={out || tooFew || undefined}
                    aria-label={out ? b.groupOutOfRoom(label) : b.groupMention(label)}
                    className={cn(
                      'grid size-8 place-items-center rounded-full transition-[background-color,opacity] duration-(--dur-micro)',
                      out || tooFew ? 'cursor-default opacity-35' : 'hover:bg-(--bg-hover)'
                    )}
                    onClick={() => !out && !tooFew && addressMember(botHandle(bot.name))}
                    type="button"
                  >
                    <BotAvatar meta={meta[bot.name]} name={bot.name} size={24} />
                  </button>
                </Tip>
              </li>
            )
          })}
        </ul>
        {room.log.length ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button aria-label={b.moreActions} size="icon-sm" variant="ghost">
                <icons.MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => clearGroup(group)}>{b.clearRoom}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6" ref={scroller}>
        <div className="mx-auto flex min-h-full w-full max-w-(--composer-width) flex-col py-6">
          {room.log.length === 0 ? (
            <RoomWelcome b={b} group={group} meta={meta} onStarter={fill} roster={roster} tooFew={tooFew} />
          ) : (
            room.log.map((entry, index) => (
              <RoomEntry
                b={b}
                continued={continues(room.log[index - 1], entry)}
                entry={entry}
                first={index === 0}
                key={`${entry.at}:${index}`}
                meta={meta}
              />
            ))
          )}
          {room.running ? (
            <div aria-live="polite" className="mt-6 flex items-center gap-3" role="status">
              {speaker ? (
                <BotAvatar meta={meta[speaker.name]} mood="work" name={speaker.name} size={28} />
              ) : (
                <span className="flex -space-x-1.5">
                  {roster.slice(0, 3).map(bot => (
                    <BotAvatar key={bot.name} meta={meta[bot.name]} mood="work" name={bot.name} size={22} />
                  ))}
                </span>
              )}
              <span className="text-sm text-(--text-tertiary)">
                {speaker ? b.groupSpeaking(nameOf(speaker)) : b.groupWorking}
              </span>
            </div>
          ) : null}
        </div>
      </div>

      <div className="shrink-0 px-6 pt-2 pb-5">
        <div className="relative mx-auto max-w-(--composer-width)">
          {options.length ? (
            <MentionMenu active={activeIndex} b={b} meta={meta} onHover={setActive} onPick={pick} options={options} />
          ) : null}
          <div
            className={cn(
              'flex items-end gap-2 rounded-(--radius-bubble) border border-(--border-default) bg-(--bg-app) py-1.5 pr-1.5 pl-4',
              'transition-colors duration-(--dur-micro) focus-within:border-(--border-strong) hover:border-(--border-strong)',
              tooFew && 'opacity-60'
            )}
          >
            <textarea
              aria-autocomplete="list"
              aria-expanded={options.length > 0}
              aria-label={b.groupComposer(group)}
              className="field-sizing-content max-h-(--composer-input-max-height) min-h-9 flex-1 resize-none bg-transparent py-1.5 text-md leading-normal text-(--text-primary) outline-none placeholder:text-(--text-tertiary) disabled:cursor-not-allowed"
              disabled={tooFew}
              onBlur={() => setMention(null)}
              onChange={event => {
                setDraft(event.target.value)
                syncMention(event.target)
              }}
              onClick={event => syncMention(event.currentTarget)}
              onKeyDown={onKeyDown}
              onSelect={event => syncMention(event.currentTarget)}
              placeholder={b.groupComposer(group)}
              ref={input}
              role="combobox"
              rows={1}
              value={draft}
            />
            <button
              aria-label={b.groupSend}
              className="mb-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-(--bg-inverse) text-(--text-inverse) transition-opacity duration-(--dur-micro) hover:opacity-88 disabled:bg-transparent disabled:text-(--icon-muted)"
              disabled={!draft.trim() || tooFew}
              onClick={send}
              type="button"
            >
              <icons.ArrowUp className="size-4" />
            </button>
          </div>
          {benched.length ? (
            <p className="mt-2 px-1 text-xs text-(--text-tertiary)">
              {b.groupTooMany(GROUP_MAX_MEMBERS, benched.map(nameOf).join(', '))}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function continues(previous: GroupEntry | undefined, entry: GroupEntry): boolean {
  return (
    !!previous &&
    previous.from.kind === entry.from.kind &&
    previous.from.name === entry.from.name &&
    entry.at - previous.at < CONTINUATION_MS
  )
}

function RoomWelcome({
  b,
  group,
  meta,
  onStarter,
  roster,
  tooFew
}: {
  b: BotsText
  group: string
  meta: Record<string, BotMeta>
  onStarter: (text: string) => void
  roster: Bot[]
  tooFew: boolean
}) {
  return (
    <div className="m-auto flex max-w-md flex-col items-center py-10 text-center">
      <div className="flex items-center gap-1.5">
        {roster.map(bot => (
          <BotAvatar key={bot.name} meta={meta[bot.name]} name={bot.name} size={40} />
        ))}
      </div>
      <h3 className="mt-5 text-xl font-semibold text-balance text-(--text-primary)">{b.groupEmptyTitle(group)}</h3>
      <p className="mt-1.5 text-sm text-pretty text-(--text-secondary)">{tooFew ? b.groupTooFew : b.groupEmpty}</p>
      {tooFew ? null : (
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          {Object.values(b.groupStarters).map(starter => (
            <button
              className="inline-flex h-9 items-center rounded-full border border-(--border-default) px-3.5 text-sm text-(--text-secondary) transition-colors duration-(--dur-micro) hover:border-(--border-strong) hover:bg-(--bg-hover) hover:text-(--text-primary)"
              key={starter}
              onClick={() => onStarter(starter)}
              type="button"
            >
              {starter}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function RoomEntry({
  b,
  continued,
  entry,
  first,
  meta
}: {
  b: BotsText
  continued: boolean
  entry: GroupEntry
  first: boolean
  meta: Record<string, BotMeta>
}) {
  const gap = first ? '' : continued ? 'mt-2' : 'mt-6'

  if (entry.from.kind === 'user') {
    return (
      <div className={cn('flex justify-end', gap)}>
        <div className="max-w-(--user-bubble-max-width) rounded-(--radius-bubble) border border-(--dt-user-bubble-border) bg-(--dt-user-bubble) px-3.5 py-2 text-md leading-(--conversation-prose-line-height) wrap-anywhere whitespace-pre-wrap text-(--text-primary)">
          {entry.text}
        </div>
      </div>
    )
  }

  const name = entry.from.name

  return (
    <div className={cn('flex gap-3', gap)}>
      <div className="w-7 shrink-0">{continued ? null : <BotAvatar meta={meta[name]} name={name} size={28} />}</div>
      <div className="min-w-0 flex-1">
        {continued ? null : (
          <div className="flex h-7 items-baseline gap-2 pt-1">
            <span className="truncate text-sm font-semibold text-(--text-primary)">
              {displayName({ name }, meta[name], b.primaryName)}
            </span>
            <span className="shrink-0 text-xs text-(--text-tertiary)">{relativeTime(entry.at)}</span>
          </div>
        )}
        <div className="text-md text-(--text-primary)">
          <Markdown isRunning={false} text={entry.text} />
        </div>
      </div>
    </div>
  )
}

function MentionMenu({
  active,
  b,
  meta,
  onHover,
  onPick,
  options
}: {
  active: number
  b: BotsText
  meta: Record<string, BotMeta>
  onHover: (index: number) => void
  onPick: (option: MentionOption) => void
  options: MentionOption[]
}) {
  return (
    <ul
      aria-label={b.groupMentionList}
      className="absolute inset-x-0 bottom-full z-20 mb-2 max-h-72 overflow-y-auto rounded-(--radius-card) border border-(--border-default) bg-(--bg-raised) p-1 shadow-(--shadow-md)"
      role="listbox"
    >
      {options.map((option, index) => (
        <li
          aria-selected={index === active}
          className={cn(
            'flex h-10 cursor-pointer items-center gap-2.5 rounded-md px-2.5',
            index === active && 'bg-(--bg-hover)'
          )}
          key={option.handle}
          // mousedown, not click: the textarea must keep focus (its blur
          // closes this menu before a click could land).
          onMouseDown={event => {
            event.preventDefault()
            onPick(option)
          }}
          onMouseEnter={() => onHover(index)}
          role="option"
        >
          {option.member ? (
            <BotAvatar meta={meta[option.member.name]} name={option.member.name} size={24} />
          ) : (
            <span className="grid size-6 place-items-center rounded-full bg-(--bg-subtle) text-(--tint-indigo)">
              <icons.Users className="size-3.5" />
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-sm text-(--text-primary)">
            {option.member ? option.member.title || option.handle : b.groupEveryone}
          </span>
          <span className="shrink-0 text-xs text-(--text-tertiary)">
            @{option.handle === EVERYONE_HANDLE ? EVERYONE_HANDLE : option.handle}
          </span>
        </li>
      ))}
    </ul>
  )
}

export function GroupDialog({ bot, onClose }: { bot: Bot | null; onClose: () => void }) {
  const b = useBots()
  const meta = useValue($botMeta)
  const [name, setName] = useState('')
  const current = bot ? (meta[bot.name]?.group || '').trim() : ''
  const groups = knownGroups(meta)

  useEffect(() => setName(''), [bot])

  if (!bot) {
    return null
  }

  const label = displayName(bot, meta[bot.name], b.primaryName)

  const assign = (group: string | null) => {
    void saveBotMeta(bot.name, { group })
    host.notify({ kind: 'success', message: group ? b.movedToGroup(label, group) : b.removedFromGroup(label) })
    onClose()
  }

  return (
    <Dialog onOpenChange={value => !value && onClose()} open>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{b.groupDialogTitle}</DialogTitle>
          <DialogDescription>{b.groupDialogDescription}</DialogDescription>
        </DialogHeader>
        {groups.length ? (
          <div className="flex flex-wrap gap-1.5">
            {groups.map(group => (
              <button
                aria-pressed={group === current}
                className={cn(
                  'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-sm transition-colors duration-(--dur-micro)',
                  group === current
                    ? 'border-(--border-strong) bg-(--bg-selected) text-(--text-primary)'
                    : 'border-(--border-default) text-(--text-secondary) hover:bg-(--bg-hover) hover:text-(--text-primary)'
                )}
                key={group}
                onClick={() => assign(group)}
                type="button"
              >
                <icons.Users className="size-3.5" />
                {group}
              </button>
            ))}
          </div>
        ) : null}
        <form
          className="flex items-center gap-2"
          onSubmit={event => {
            event.preventDefault()

            if (name.trim()) {
              assign(name.trim().slice(0, 40))
            }
          }}
        >
          <Input
            autoFocus
            maxLength={40}
            onChange={event => setName(event.target.value)}
            placeholder={b.groupNewPlaceholder}
            value={name}
          />
          <Button disabled={!name.trim()} type="submit">
            {b.groupCreate}
          </Button>
        </form>
        {current ? (
          <Button className="justify-self-start" onClick={() => assign(null)} size="sm" variant="text">
            {b.groupRemove(current)}
          </Button>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
