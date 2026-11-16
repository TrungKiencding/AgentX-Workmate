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
import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'

import { BotAvatar } from './face'
import {
  formatBytes,
  GROUP_ATTACH_MAX_BYTES,
  GROUP_ATTACH_MAX_FILES,
  readAttachments,
  releaseAttachment
} from './group-attachments'
import {
  answerApproval,
  clearGroup,
  decorateMentions,
  EVERYONE_HANDLE,
  GROUP_MAX_MEMBERS,
  insertMention,
  type MentionLabels,
  mentionOptions,
  mentionQuery,
  mentionSegments,
  pendingApproval,
  sendToGroup,
  stopGroup,
  subscribeApprovals
} from './group-chat'
import { type BotsText, useBots } from './i18n'
import { botHandle, displayName, knownGroups } from './naming'
import { $botMeta, $groupChats, $groupNeedsYou, emptyRoom, markSeenAt, saveBotMeta } from './state'
import type { Bot, BotMeta, GroupAttachment, GroupEntry, GroupMember } from './types'

/** Two lines from the same member within this window read as one turn. */
const CONTINUATION_MS = 5 * 60_000

type MentionOption = ReturnType<typeof mentionOptions<GroupMember>>[number]

export function GroupRoom({ group, members, onBack }: { group: string; members: Bot[]; onBack?: () => void }) {
  const b = useBots()
  const rooms = useValue($groupChats)
  const meta = useValue($botMeta)
  const room = rooms[group] || emptyRoom()
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState<GroupAttachment[]>([])
  const [dragging, setDragging] = useState(false)
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null)
  const [active, setActive] = useState(0)
  const scroller = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const approval = useSyncExternalStore(subscribeApprovals, () => pendingApproval(group))
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
  }, [room.log.length, room.running, room.speaker, approval])

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

  const addFiles = async (files: File[]) => {
    if (!files.length || tooFew) {
      return
    }

    const room = GROUP_ATTACH_MAX_FILES - pending.length
    const result = await readAttachments(files, room)
    const mb = Math.round(GROUP_ATTACH_MAX_BYTES / (1024 * 1024))

    result.tooLarge.forEach(name => host.notify({ kind: 'warning', message: b.groupAttachTooLarge(name, mb) }))
    result.failed.forEach(name => host.notify({ kind: 'error', message: b.groupAttachFailed(name) }))

    if (result.added.length) {
      setPending(current => [...current, ...result.added])
      input.current?.focus()
    }
  }

  const unpend = (id: string) => {
    releaseAttachment(id)
    setPending(current => current.filter(item => item.id !== id))
  }

  const send = () => {
    const text = draft.trim()

    if ((!text && !pending.length) || tooFew) {
      return
    }

    setDraft('')
    setMention(null)
    setPending([])
    sendToGroup(
      group,
      seats,
      text,
      { failed: b.groupTurnFailed, gone: b.groupMemberGone, timedOut: b.groupTurnTimedOut },
      pending
    )
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

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files]

    if (files.length) {
      event.preventDefault()
      void addFiles(files)
    }
  }

  const hasFiles = (event: DragEvent) => [...event.dataTransfer.types].includes('Files')

  const dropZone = tooFew
    ? {}
    : {
        onDragEnter: (event: DragEvent) => {
          if (hasFiles(event)) {
            event.preventDefault()
            setDragging(true)
          }
        },
        onDragOver: (event: DragEvent) => {
          if (hasFiles(event)) {
            event.preventDefault()
            event.dataTransfer.dropEffect = 'copy'
          }
        },
        onDragLeave: (event: DragEvent) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setDragging(false)
          }
        },
        onDrop: (event: DragEvent) => {
          if (hasFiles(event)) {
            event.preventDefault()
            setDragging(false)
            void addFiles([...event.dataTransfer.files])
          }
        }
      }

  const speaker = room.speaker ? roster.find(bot => bot.name === room.speaker) : undefined
  const handles: MentionLabels = { members: seats, everyone: b.groupEveryone, user: b.groupYou }

  return (
    <div className="@container relative flex h-full min-h-0 flex-col" {...dropZone}>
      {dragging ? (
        <div className="pointer-events-none absolute inset-2 z-30 grid place-items-center rounded-(--radius-card) border-2 border-dashed border-(--border-strong) bg-(--bg-app)/90">
          <p className="flex items-center gap-2 text-sm font-medium text-(--text-secondary)">
            <icons.FileText className="size-4" />
            {b.groupDropHint}
          </p>
        </div>
      ) : null}
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
                handles={handles}
                key={`${entry.at}:${index}`}
                meta={meta}
              />
            ))
          )}
          {approval ? (
            <ApprovalCard
              b={b}
              command={approval.command}
              description={approval.description}
              label={displayName({ name: approval.member }, meta[approval.member], b.primaryName)}
              onAnswer={choice => void answerApproval(group, choice)}
            />
          ) : null}
          {room.running ? (
            <RoomStatus
              b={b}
              meta={meta}
              onStop={() => stopGroup(group, b.groupStopped)}
              roster={roster}
              since={room.speakerSince ?? null}
              speaker={speaker ? { name: speaker.name, label: nameOf(speaker) } : null}
            />
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
              'rounded-(--radius-bubble) border border-(--border-default) bg-(--bg-app)',
              'transition-colors duration-(--dur-micro) focus-within:border-(--border-strong) hover:border-(--border-strong)',
              tooFew && 'opacity-60'
            )}
          >
            {pending.length ? (
              <ul aria-label={b.groupAttach} className="flex flex-wrap gap-2 px-3 pt-3">
                {pending.map(item => (
                  <li key={item.id}>
                    <AttachmentChip
                      item={item}
                      onRemove={() => unpend(item.id)}
                      removeLabel={b.groupAttachRemove(item.name)}
                    />
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="flex items-end gap-1.5 py-1.5 pr-1.5 pl-1.5">
              <Tip label={b.groupAttach}>
                <Button
                  aria-label={b.groupAttach}
                  className="mb-0.5 shrink-0"
                  disabled={tooFew || pending.length >= GROUP_ATTACH_MAX_FILES}
                  onClick={() => picker.current?.click()}
                  size="icon-sm"
                  variant="ghost"
                >
                  <icons.Plus />
                </Button>
              </Tip>
              <input
                className="hidden"
                multiple
                onChange={event => {
                  const files = [...(event.target.files ?? [])]
                  event.target.value = ''
                  void addFiles(files)
                }}
                ref={picker}
                tabIndex={-1}
                type="file"
              />
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
                onPaste={onPaste}
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
                disabled={(!draft.trim() && !pending.length) || tooFew}
                onClick={send}
                type="button"
              >
                <icons.ArrowUp className="size-4" />
              </button>
            </div>
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

/** Live "who is answering" line, with how long it has taken and a Stop. */
function RoomStatus({
  b,
  meta,
  onStop,
  roster,
  since,
  speaker
}: {
  b: BotsText
  meta: Record<string, BotMeta>
  onStop: () => void
  roster: Bot[]
  since: null | number
  speaker: { label: string; name: string } | null
}) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)

    return () => window.clearInterval(timer)
  }, [])

  const seconds = since ? Math.max(0, Math.floor((now - since) / 1000)) : 0

  return (
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
      <span className="min-w-0 flex-1 text-sm text-(--text-tertiary)">
        {speaker ? b.groupSpeaking(speaker.label) : b.groupWorking}
        {speaker && seconds >= 3 ? <span className="ml-1.5 tabular-nums">· {b.groupElapsed(seconds)}</span> : null}
      </span>
      <Button onClick={onStop} size="sm" variant="ghost">
        <icons.Square className="size-3.5" />
        {b.groupStop}
      </Button>
    </div>
  )
}

/** A member asked permission to run something mid-turn. */
function ApprovalCard({
  b,
  command,
  description,
  label,
  onAnswer
}: {
  b: BotsText
  command: string
  description: string
  label: string
  onAnswer: (choice: 'deny' | 'once') => void
}) {
  return (
    <div className="mt-6 grid gap-2.5 rounded-(--radius-card) border border-(--border-default) bg-(--bg-subtle) p-3.5">
      <p className="flex items-center gap-2 text-sm font-medium text-(--text-primary)">
        <icons.AlertTriangle className="size-4 shrink-0 text-(--tint-orange)" />
        {b.groupApprovalTitle(label)}
      </p>
      {command ? (
        <pre className="max-h-40 overflow-auto rounded-(--radius-control) bg-(--bg-app) px-3 py-2 font-mono text-xs whitespace-pre-wrap text-(--text-primary)">
          {command}
        </pre>
      ) : null}
      {description ? <p className="text-xs text-(--text-secondary)">{description}</p> : null}
      <div className="flex gap-2">
        <Button onClick={() => onAnswer('once')} size="sm">
          {b.groupApprovalAllow}
        </Button>
        <Button onClick={() => onAnswer('deny')} size="sm" variant="outline">
          {b.groupApprovalDeny}
        </Button>
      </div>
    </div>
  )
}

function AttachmentChip({
  item,
  onRemove,
  removeLabel
}: {
  item: GroupAttachment
  onRemove?: () => void
  removeLabel?: string
}) {
  return (
    <span className="group/att relative flex h-12 max-w-56 items-center gap-2 rounded-(--radius-control) border border-(--border-default) bg-(--bg-app) pr-2.5 pl-1.5">
      {item.kind === 'image' && item.thumb ? (
        <img alt="" className="size-9 shrink-0 rounded-[6px] object-cover" src={item.thumb} />
      ) : (
        <span className="grid size-9 shrink-0 place-items-center rounded-[6px] bg-(--bg-subtle) text-(--text-tertiary)">
          {item.kind === 'image' ? <icons.FileImage className="size-4" /> : <icons.FileText className="size-4" />}
        </span>
      )}
      <span className="grid min-w-0">
        <span className="truncate text-xs font-medium text-(--text-primary)">{item.name}</span>
        <span className="text-xs text-(--text-tertiary)">{formatBytes(item.size)}</span>
      </span>
      {onRemove ? (
        <button
          aria-label={removeLabel}
          className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full border border-(--border-default) bg-(--bg-raised) text-(--text-secondary) opacity-0 transition-opacity duration-(--dur-micro) group-hover/att:opacity-100 focus-visible:opacity-100 hover:text-(--text-primary)"
          onClick={onRemove}
          type="button"
        >
          <icons.X className="size-3" />
        </button>
      ) : null}
    </span>
  )
}

function continues(previous: GroupEntry | undefined, entry: GroupEntry): boolean {
  return (
    !!previous &&
    entry.from.kind === 'member' &&
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
  handles,
  meta
}: {
  b: BotsText
  continued: boolean
  entry: GroupEntry
  first: boolean
  handles: MentionLabels
  meta: Record<string, BotMeta>
}) {
  const gap = first ? '' : continued ? 'mt-2' : 'mt-6'

  if (entry.from.kind === 'notice') {
    return (
      <p className={cn('flex items-center justify-center gap-1.5 text-center text-xs text-(--text-tertiary)', gap)}>
        <icons.Info className="size-3.5 shrink-0" />
        {entry.text}
      </p>
    )
  }

  if (entry.from.kind === 'user') {
    return (
      <div className={cn('flex flex-col items-end gap-2', gap)}>
        {entry.attachments?.length ? (
          <ul aria-label={b.groupAttach} className="flex max-w-(--user-bubble-max-width) flex-wrap justify-end gap-2">
            {entry.attachments.map(item => (
              <li key={item.id}>
                {item.kind === 'image' && item.thumb ? (
                  <img
                    alt={item.name}
                    className="max-h-40 max-w-60 rounded-(--radius-control) border border-(--border-subtle) object-cover"
                    src={item.thumb}
                    title={item.name}
                  />
                ) : (
                  <AttachmentChip item={item} />
                )}
              </li>
            ))}
          </ul>
        ) : null}
        {entry.text ? (
          <div className="max-w-(--user-bubble-max-width) rounded-(--radius-bubble) border border-(--dt-user-bubble-border) bg-(--dt-user-bubble) px-3.5 py-2 text-md leading-(--conversation-prose-line-height) wrap-anywhere whitespace-pre-wrap text-(--text-primary)">
            {mentionSegments(entry.text, handles).map((segment, index) =>
              segment.mention ? (
                <strong className="font-semibold" key={index}>
                  {segment.text}
                </strong>
              ) : (
                segment.text
              )
            )}
          </div>
        ) : null}
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
          <Markdown isRunning={false} text={decorateMentions(entry.text, handles)} />
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
