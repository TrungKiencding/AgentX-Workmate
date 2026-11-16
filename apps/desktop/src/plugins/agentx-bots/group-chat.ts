/**
 * Group rooms: bounded round-robin over a shared room log.
 *
 * A room is ONE ordered log owned by the plugin. A user message triggers at
 * most MAX_ROUNDS serial rounds over the members — never parallel, no LLM
 * router. Who speaks is a deterministic @mention parse since the last user
 * message (mentioned members only, else everyone); whether a member actually
 * speaks is its own choice — replying "(pass)" (or nothing) is silence. A
 * round where everyone passed means the conversation settled.
 *
 * Each member answers in its OWN hidden per-room session (source `bot-room`,
 * kept out of every chat list) and only sees the room messages new to it.
 * Every RPC goes to the window backend (`host.requestPrimary`): its gateway
 * serves every local profile through `profile`, and a runtime session id only
 * lives on the gateway that minted it — so a room keeps running while the
 * user opens other chats.
 *
 * What the user sees is honest: a failed or timed-out turn leaves a short
 * notice in the room (never silently counted as a pass), a member that needs
 * permission to run something asks right in the room, and Stop really stops.
 */

import { host } from '@agentx/plugin-sdk'

import { stageAttachments, type StagedAttachments } from './group-attachments'
import { botHandle, foldForSearch } from './naming'
import { $groupChats, $groupNeedsYou, emptyRoom, persistRooms } from './state'
import type { GroupAttachment, GroupEntry, GroupMember, GroupRoom } from './types'

export const GROUP_MAX_ROUNDS = 3
export const GROUP_MAX_MESSAGES = 10
export const GROUP_HISTORY_LIMIT = 24
export const GROUP_MAX_MEMBERS = 6
/** Session source of a member's hidden room session (tui_gateway BOT_ROOM_SOURCE). */
export const BOT_ROOM_SOURCE = 'bot-room'
const GROUP_SESSION_PREFIX = 'Group: '
/** A turn that has not produced anything this long is given up on… */
const TURN_IDLE_TIMEOUT_MS = 180_000
/** …and none may run longer than this, busy or not. */
const TURN_HARD_TIMEOUT_MS = 15 * 60_000
const TURN_POLL_MS = 1_500
/** One room line handed to a member is capped (a pasted book is not a turn). */
const LINE_MAX_CHARS = 4_000

const rpc = <T>(method: string, params: Record<string, unknown> = {}) => host.requestPrimary<T>(method, params)

/** "(pass)", "pass", "pass." or an empty reply = the member stayed silent. */
export function isPassText(text: string | null | undefined): boolean {
  const trimmed = String(text || '').trim()

  return !trimmed || /^\(?\s*pass\s*\)?\.?$/i.test(trimmed)
}

/** @name / @title / @everyone / @all, case- and diacritics-insensitive. */
export function parseMentions(
  text: string,
  members: readonly GroupMember[]
): { everyone: boolean; mentioned: Set<string> } {
  const handles = new Map<string, string>()

  for (const member of members) {
    const title = foldForSearch(member.title || '')
    const name = member.name.toLowerCase()
    const forms = [name, name.replace(/[\s_-]+/g, ''), botHandle(member.name)]

    if (title) {
      forms.push(title.replace(/\s+/g, ''), title.replace(/\s+/g, '-'), title.split(/\s+/)[0])
    }

    for (const form of forms) {
      if (form) {
        handles.set(form, member.name)
      }
    }
  }

  const mentioned = new Set<string>()
  let everyone = false

  for (const match of foldForSearch(text).matchAll(/@([\p{L}\p{N}][\p{L}\p{N}._-]*)/gu)) {
    const handle = match[1].replace(/[._-]+$/, '')

    if (handle === 'everyone' || handle === 'all' || handle === 'moinguoi' || handle === 'tatca') {
      everyone = true

      continue
    }

    const resolved = handles.get(handle) || handles.get(handle.replace(/[._-]+/g, ''))

    if (resolved) {
      mentioned.add(resolved)
    }
  }

  return { everyone, mentioned }
}

/** The `@word` being typed at `caret`, if any: where its "@" sits and what
 *  follows it. Only a fresh word counts — "mail@host" is not a mention. */
export function mentionQuery(text: string, caret: number): { query: string; start: number } | null {
  const match = /(^|\s)@([^\s@]*)$/u.exec(text.slice(0, caret))

  return match ? { query: match[2], start: caret - match[2].length - 1 } : null
}

export const EVERYONE_HANDLE = 'everyone'
export const USER_HANDLE = 'user'

/** Members (then "everyone") whose handle or title starts a word with `query`,
 *  diacritics-insensitive. An empty query lists them all. */
export function mentionOptions<T extends GroupMember>(
  members: readonly T[],
  query: string
): Array<{ handle: string; member: T | null }> {
  const needle = foldForSearch(query)

  const matches = (value: string) =>
    !needle ||
    foldForSearch(value)
      .split(/[\s_-]+/)
      .some(word => word.startsWith(needle))

  const options: Array<{ handle: string; member: T | null }> = members
    .filter(member => matches(botHandle(member.name)) || matches(member.title || ''))
    .map(member => ({ handle: botHandle(member.name), member }))

  if (members.length > 1 && (matches(EVERYONE_HANDLE) || matches('moi nguoi') || matches('ca nhom'))) {
    options.push({ handle: EVERYONE_HANDLE, member: null })
  }

  return options
}

/** Replace the `@query` that starts at `start` with `@handle ` and return
 *  the new text plus where the caret lands. */
export function insertMention(
  text: string,
  start: number,
  caret: number,
  handle: string
): { caret: number; text: string } {
  const inserted = `@${handle} `
  const rest = text.slice(caret).replace(/^\S*\s?/u, '')

  return { caret: start + inserted.length, text: text.slice(0, start) + inserted + rest }
}

/** The members the latest user message addressed by name (not @everyone). */
export function addressedMembers(log: readonly GroupEntry[], members: readonly GroupMember[]): Set<string> {
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].from.kind === 'user') {
      return parseMentions(log[i].text, members).mentioned
    }
  }

  return new Set()
}

/** Members who take a turn this round (recomputed each round so a member
 *  pulled in mid-conversation joins the next one). */
export function resolveResponders(log: readonly GroupEntry[], members: readonly GroupMember[]): GroupMember[] {
  let since: readonly GroupEntry[] = []

  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].from.kind === 'user') {
      since = log.slice(i)

      break
    }
  }

  const mentioned = new Set<string>()
  let everyone = false

  for (const entry of since) {
    if (entry.from.kind === 'notice') {
      continue
    }

    const parsed = parseMentions(entry.text, members)
    everyone ||= parsed.everyone
    parsed.mentioned.forEach(name => mentioned.add(name))
  }

  return everyone || mentioned.size === 0 ? [...members] : members.filter(member => mentioned.has(member.name))
}

/** Who a round after the first belongs to: only the members a teammate
 *  pulled in by name during the previous round (never the author itself).
 *  Without this every member got another turn just because the room was
 *  still going — and filled it with "ready when you are" small talk. */
export function handoffTargets(posted: readonly GroupEntry[], members: readonly GroupMember[]): GroupMember[] {
  const wanted = new Set<string>()
  let everyone = false

  for (const entry of posted) {
    if (entry.from.kind !== 'member') {
      continue
    }

    const parsed = parseMentions(entry.text, members)
    everyone ||= parsed.everyone
    parsed.mentioned.forEach(name => name !== entry.from.name && wanted.add(name))
  }

  return everyone ? [...members] : members.filter(member => wanted.has(member.name))
}

/** A different member leads each round. */
export function rotateSpeakers<T>(members: readonly T[], round: number): T[] {
  if (members.length < 2) {
    return [...members]
  }

  const shift = round % members.length

  return [...members.slice(shift), ...members.slice(0, shift)]
}

function clip(text: string): string {
  return text.length > LINE_MAX_CHARS ? `${text.slice(0, LINE_MAX_CHARS)}… [truncated]` : text
}

function memberLabel(member: GroupMember): string {
  const handle = botHandle(member.name)

  return member.title && member.title !== handle ? `${member.title} (@${handle})` : `@${handle}`
}

function attachmentNote(attachments: readonly GroupAttachment[] | undefined): string {
  if (!attachments?.length) {
    return ''
  }

  return ` [shared ${attachments.map(item => `${item.kind === 'image' ? 'picture' : 'file'} "${item.name}"`).join(', ')}]`
}

function formatLine(entry: GroupEntry, viewer: string, members: readonly GroupMember[]): string | null {
  if (entry.from.kind === 'notice') {
    return null
  }

  if (entry.from.kind === 'user') {
    return `User: ${clip(entry.text)}${attachmentNote(entry.attachments)}`
  }

  const author = members.find(member => member.name === entry.from.name)
  const label = author ? memberLabel(author) : `@${botHandle(entry.from.name)}`

  return `${label}${entry.from.name === viewer ? ' (you)' : ''}: ${clip(entry.text)}`
}

function stagedNote(staged: StagedAttachments | null): string[] {
  if (!staged || (!staged.files.length && !staged.images.length && !staged.missing.length)) {
    return []
  }

  const lines = ['', 'Files the user shared with the room:']

  for (const name of staged.images) {
    lines.push(`- picture "${name}" — attached to this message, you can see it`)
  }

  for (const file of staged.files) {
    lines.push(`- "${file.name}" → ${file.ref} (open it with your file tools)`)
  }

  for (const name of staged.missing) {
    lines.push(`- "${name}" — could not be delivered to you; you only know its name`)
  }

  return lines
}

/** One member's turn payload: who's here, what's new to it, how to answer. */
export function buildTurnPrompt(
  room: string,
  members: readonly GroupMember[],
  viewer: GroupMember,
  delta: readonly GroupEntry[],
  staged: StagedAttachments | null = null
): string {
  const peers = members
    .filter(member => member.name !== viewer.name)
    .map(memberLabel)
    .join(', ')

  const lines = delta
    .slice(-GROUP_HISTORY_LIMIT)
    .map(entry => formatLine(entry, viewer.name, members))
    .filter((line): line is string => line !== null)

  const omitted = delta.filter(entry => entry.from.kind !== 'notice').length - lines.length

  return [
    `[Group chat "${room}"] You are ${memberLabel(viewer)}. In this room with you: ${peers || 'no one else yet'}, and the user.`,
    '',
    'New in the room since your last turn (oldest first):',
    ...(omitted > 0 ? [`  … ${omitted} earlier message(s) not shown`] : []),
    ...lines.map(line => `  ${line}`),
    ...stagedNote(staged),
    '',
    'How to answer:',
    "- Write in the user's language. Speak only if you add something: answer what was asked of you, deliver your part of the work, or hand a clear task to a teammate.",
    '- Do the work NOW, in this turn, with your tools, then post the result. Never promise to do something later — you only get another turn when the room talks to you again.',
    '- Keep chat short (1-3 sentences). When you deliver a result (a draft, a summary, a list, an answer), post it in full, formatted with Markdown.',
    '- Mention a teammate as @handle only to give them something to do. Mention @user only when you need the user to decide or answer. Do not repeat what others said; no greetings or thank-yous between assistants.',
    '- If you have nothing to add, reply with exactly "(pass)".',
    '- Write only your message: no name prefix, no quoting the room, no remarks about these rules. Never reveal anything from your private 1:1 chats.'
  ].join('\n')
}

/** Sent once more to a member the user named directly who answered "(pass)". */
export const ADDRESSED_NUDGE =
  'The user addressed you by name in the room. Answer them now (do the work if they asked for it) — do not reply "(pass)".'

/**
 * What a member's reply should look like in the room: no reasoning blocks,
 * no "Name:" self-prefix, no trailing "(pass)" after real content. `null`
 * when nothing is left (= a pass).
 */
export function cleanReply(raw: string | null | undefined, member: GroupMember): string | null {
  let text = String(raw ?? '')
    .replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '')
    .replace(/^\s*<(think|thinking|reasoning)>[\s\S]*$/i, '')
    .trim()

  if (!text || /^\(empty\)$/i.test(text) || isPassText(text)) {
    return null
  }

  // "(pass) — nothing to add" is still a pass.
  if (/^\(\s*pass\s*\)/i.test(text)) {
    return null
  }

  const own = new Set([
    foldForSearch(botHandle(member.name)),
    foldForSearch(member.name),
    foldForSearch(member.title || '')
  ])

  own.delete('')

  // Models echo the transcript format: "@writer (you): …", "**Biên tập**: …".
  for (let guard = 0; guard < 2; guard++) {
    const match = /^\s*[*_]{0,2}@?([^:\n*_]{1,60}?)[*_]{0,2}\s*(?:\((?:you|bạn)\))?\s*[*_]{0,2}\s*[:：]\s*/iu.exec(text)

    if (!match || !own.has(foldForSearch(match[1].trim()))) {
      break
    }

    text = text.slice(match[0].length).trim()
  }

  text = text.replace(/\n+\s*\(\s*pass\s*\)\s*$/i, '').trim()

  return isPassText(text) ? null : text
}

/** Keep the retained window, shifting watermarks with it. */
export function trimRoom(room: GroupRoom, limit = GROUP_HISTORY_LIMIT * 4): GroupRoom {
  if (room.log.length <= limit) {
    return room
  }

  const drop = room.log.length - limit
  const watermarks: Record<string, number> = {}

  for (const [name, index] of Object.entries(room.watermarks)) {
    watermarks[name] = Math.max(0, index - drop)
  }

  return { ...room, log: room.log.slice(drop), watermarks }
}

function updateRoom(group: string, mutate: (room: GroupRoom) => GroupRoom): GroupRoom {
  const rooms = { ...$groupChats.get() }
  const current = rooms[group] || emptyRoom()

  const next = trimRoom(
    mutate({
      ...current,
      log: [...current.log],
      sessions: { ...current.sessions },
      watermarks: { ...current.watermarks }
    })
  )

  rooms[group] = next
  $groupChats.set(rooms)
  persistRooms(rooms)

  return next
}

function append(group: string, from: GroupEntry['from'], text: string, attachments?: GroupAttachment[]): void {
  const entry: GroupEntry = {
    from,
    text: String(text).trim(),
    at: Date.now(),
    ...(attachments?.length ? { attachments } : {})
  }

  updateRoom(group, room => ({ ...room, log: [...room.log, entry] }))

  if (from.kind === 'member' && /(^|\s)@user\b/i.test(entry.text)) {
    $groupNeedsYou.set({ ...$groupNeedsYou.get(), [group]: true })
  }
}

function notice(group: string, text: string): void {
  append(group, { kind: 'notice', name: 'room' }, text)
}

interface RpcError {
  code?: number
  message?: string
}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String((error as RpcError)?.message ?? error ?? '')

/** The named profile is gone (deleted assistant). */
function isProfileGone(error: unknown): boolean {
  return (error as RpcError)?.code === 4044 || /profile '.*' not found/i.test(errorText(error))
}

function isSessionGone(error: unknown): boolean {
  return /session not found|not in memory|unknown session|no such session/i.test(errorText(error))
}

export class MemberGoneError extends Error {}

/** A live runtime id for the member's room session (resume, else create). */
async function ensureMemberSession(group: string, member: string): Promise<{ runtime: string; stored: string | null }> {
  const title = `${GROUP_SESSION_PREFIX}${group}`
  const known = $groupChats.get()[group]?.sessions[member] || null

  for (const target of [known, title]) {
    if (!target) {
      continue
    }

    try {
      const res = await rpc<{ session_id?: string; session_key?: string }>('session.resume', {
        session_id: target,
        profile: member,
        omit_messages: true
      })

      if (res?.session_id) {
        const stored = res.session_key || known

        if (stored && stored !== known) {
          updateRoom(group, room => ({ ...room, sessions: { ...room.sessions, [member]: stored } }))
        }

        return { runtime: res.session_id, stored }
      }
    } catch {
      /* not there (yet) — fall through to create */
    }
  }

  let created: { session_id?: string; stored_session_id?: string } | null

  try {
    created = await rpc('session.create', {
      profile: member,
      title,
      source: BOT_ROOM_SOURCE,
      strict_profile: true
    })
  } catch (error) {
    if (isProfileGone(error)) {
      throw new MemberGoneError(member)
    }

    throw error
  }

  const stored = created?.stored_session_id || null

  if (stored) {
    updateRoom(group, room => ({ ...room, sessions: { ...room.sessions, [member]: stored } }))
  }

  if (!created?.session_id) {
    throw new Error('session.create returned no session')
  }

  return { runtime: created.session_id, stored }
}

interface ResumeMessage {
  content?: unknown
  role?: string
  text?: string
}

interface ResumeState {
  inflight?: { error?: string; status?: string } | null
  message_count?: number
  messages?: ResumeMessage[]
  running?: boolean
  status?: string
}

function messageText(message: ResumeMessage): string {
  const { content } = message

  if (typeof content === 'string') {
    return content
  }

  if (Array.isArray(content)) {
    return content.map(part => (typeof part === 'string' ? part : (part as { text?: string })?.text || '')).join('')
  }

  return message.text || ''
}

/** The member's answer among the assistant rows a turn added: the newest
 *  real reply (a trailing "(pass)" never hides an earlier answer). */
export function pickReply(messages: readonly ResumeMessage[], member: GroupMember): string | null {
  const replies = messages.filter(message => message?.role === 'assistant')

  for (let i = replies.length - 1; i >= 0; i--) {
    const clean = cleanReply(messageText(replies[i]), member)

    if (clean) {
      return clean
    }
  }

  return null
}

export type TurnOutcome =
  | { kind: 'failed'; error: string }
  | { kind: 'pass' }
  | { kind: 'reply'; text: string }
  | { kind: 'stopped' }
  | { kind: 'timeout' }

/** A permission request a member raised mid-turn, shown in the room. */
export interface PendingApproval {
  command: string
  description: string
  member: string
  requestId?: string
  sessionId: string
}

const approvals = new Map<string, PendingApproval>()
type ApprovalListener = () => void
const approvalListeners = new Set<ApprovalListener>()

export function subscribeApprovals(listener: ApprovalListener): () => void {
  approvalListeners.add(listener)

  return () => approvalListeners.delete(listener)
}

function setApproval(group: string, approval: PendingApproval | null): void {
  if (approval) {
    approvals.set(group, approval)
  } else {
    approvals.delete(group)
  }

  approvalListeners.forEach(listener => listener())
}

export function pendingApproval(group: string): PendingApproval | null {
  return approvals.get(group) ?? null
}

/** The user's answer to a member's permission request. */
export async function answerApproval(group: string, choice: 'deny' | 'once'): Promise<void> {
  const approval = pendingApproval(group)

  if (!approval) {
    return
  }

  setApproval(group, null)
  await rpc('approval.respond', {
    session_id: approval.sessionId,
    choice,
    ...(approval.requestId ? { request_id: approval.requestId } : {})
  }).catch(() => undefined)
}

const CLARIFY_IN_ROOM =
  'The user is in a group room and cannot answer side questions. Make a reasonable assumption, or ask in your room reply (mention @user).'

/** Run one member's turn and wait for its outcome. */
async function runMemberTurn(
  group: string,
  member: GroupMember,
  delta: readonly GroupEntry[],
  members: readonly GroupMember[],
  stillCurrent: () => boolean,
  nudge = false
): Promise<TurnOutcome> {
  let session = await ensureMemberSession(group, member.name)
  let before = 0

  try {
    const pre = await rpc<ResumeState>('session.resume', {
      session_id: session.stored || session.runtime,
      profile: member.name,
      omit_messages: true
    })

    before = pre?.message_count || 0
  } catch {
    /* lazy session — zero messages */
  }

  let prompt: string

  if (nudge) {
    prompt = ADDRESSED_NUDGE
  } else {
    const shared = delta.flatMap(entry => (entry.from.kind === 'user' ? (entry.attachments ?? []) : []))
    const staged = shared.length ? await stageAttachments(rpc, session.runtime, shared) : null
    prompt = buildTurnPrompt(group, members, member, delta, staged)
  }

  const submit = () => rpc('prompt.submit', { session_id: session.runtime, text: prompt })

  try {
    await submit()
  } catch (error) {
    if (!isSessionGone(error)) {
      throw error
    }

    // The runtime was reaped between resume and submit: rebind once.
    session = await ensureMemberSession(group, member.name)
    await submit()
  }

  const sid = session.runtime
  let wake: (() => void) | null = null
  let lastProgress = Date.now()

  // Questions a hidden session would otherwise wait out in silence.
  const offs = [
    host.onEvent('approval.request', event => {
      if (event.session_id !== sid) {
        return
      }

      const payload = (event.payload ?? {}) as Record<string, unknown>
      lastProgress = Date.now()
      setApproval(group, {
        command: String(payload.command ?? ''),
        description: String(payload.description ?? ''),
        member: member.name,
        requestId: typeof payload.request_id === 'string' ? payload.request_id : undefined,
        sessionId: sid
      })
    }),
    host.onEvent('clarify.request', event => {
      const payload = (event.payload ?? {}) as Record<string, unknown>

      if (event.session_id === sid && typeof payload.request_id === 'string') {
        void rpc('clarify.respond', { request_id: payload.request_id, answer: CLARIFY_IN_ROOM }).catch(() => undefined)
      }
    }),
    ...['message.delta', 'tool.start', 'tool.complete', 'message.complete', 'error'].map(type =>
      host.onEvent(type, event => {
        if (event.session_id === sid) {
          lastProgress = Date.now()
          wake?.()
        }
      })
    )
  ]

  const started = Date.now()

  try {
    for (;;) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, TURN_POLL_MS)

        wake = () => {
          clearTimeout(timer)
          resolve()
        }
      })
      wake = null

      if (!stillCurrent()) {
        await rpc('session.interrupt', { session_id: sid }).catch(() => undefined)

        return { kind: 'stopped' }
      }

      let state: ResumeState | null

      try {
        state = await rpc<ResumeState>('session.resume', {
          session_id: session.stored || sid,
          profile: member.name,
          omit_messages: true
        })
      } catch {
        state = null
      }

      const waitingOnUser = Boolean(pendingApproval(group)?.sessionId === sid)

      if (state) {
        const failed = state.inflight?.status === 'error'
        const busy = Boolean(state.running) || (Boolean(state.inflight) && !failed)

        if (failed && !state.running) {
          return { kind: 'failed', error: String(state.inflight?.error || '') }
        }

        if (!busy && (state.message_count || 0) > before) {
          const full = await rpc<ResumeState>('session.resume', {
            session_id: session.stored || sid,
            profile: member.name
          })

          const added = (full?.messages ?? []).slice(before)
          const text = pickReply(added, member)

          return text ? { kind: 'reply', text } : { kind: 'pass' }
        }

        if (busy) {
          // Still working — not idle, however long the tools take.
          lastProgress = Math.max(lastProgress, Date.now() - TURN_POLL_MS)
        }
      }

      const now = Date.now()

      if (now - started > TURN_HARD_TIMEOUT_MS || (!waitingOnUser && now - lastProgress > TURN_IDLE_TIMEOUT_MS)) {
        await rpc('session.interrupt', { session_id: sid }).catch(() => undefined)

        return { kind: 'timeout' }
      }
    }
  } finally {
    offs.forEach(off => off())

    if (pendingApproval(group)?.sessionId === sid) {
      setApproval(group, null)
    }
  }
}

/** Display text for the room status: who is answering, since when. */
export function memberTitle(members: readonly GroupMember[], name: string): string {
  return members.find(member => member.name === name)?.title || botHandle(name)
}

export interface RoundCopy {
  failed: (name: string) => string
  gone: (name: string) => string
  timedOut: (name: string) => string
}

async function runRounds(group: string, members: readonly GroupMember[], copy: RoundCopy): Promise<void> {
  const epoch = $groupChats.get()[group]?.epoch || 0
  const current = () => ($groupChats.get()[group]?.epoch || 0) === epoch
  const addressed = addressedMembers($groupChats.get()[group]?.log || [], members)
  const nudged = new Set<string>()
  const gone = new Set<string>()
  let posted = 0

  try {
    let speakers = resolveResponders($groupChats.get()[group]?.log || [], members)

    for (let round = 0; round < GROUP_MAX_ROUNDS && speakers.length; round++) {
      const roundStart = ($groupChats.get()[group]?.log || []).length
      let spoke = 0

      for (const member of rotateSpeakers(speakers, round)) {
        if (!current() || posted >= GROUP_MAX_MESSAGES) {
          return
        }

        if (gone.has(member.name)) {
          continue
        }

        const room = $groupChats.get()[group] || emptyRoom()
        const delta = room.log.slice(room.watermarks[member.name] || 0)

        if (!delta.some(entry => entry.from.kind !== 'notice')) {
          continue
        }

        updateRoom(group, r => ({ ...r, speaker: member.name, speakerSince: Date.now() }))
        let outcome: TurnOutcome

        try {
          outcome = await runMemberTurn(group, member, delta, members, current)

          // Named directly and still silent: ask once more, plainly.
          if (outcome.kind === 'pass' && addressed.has(member.name) && !nudged.has(member.name) && current()) {
            nudged.add(member.name)
            outcome = await runMemberTurn(group, member, [], members, current, true)
          }
        } catch (error) {
          if (error instanceof MemberGoneError) {
            gone.add(member.name)
            outcome = { kind: 'failed', error: 'gone' }
          } else {
            outcome = { kind: 'failed', error: errorText(error) }
          }
        }

        if (!current() || outcome.kind === 'stopped') {
          return
        }

        updateRoom(group, r => ({
          ...r,
          speaker: null,
          speakerSince: null,
          watermarks: { ...r.watermarks, [member.name]: r.log.length }
        }))

        const label = memberTitle(members, member.name)

        if (outcome.kind === 'reply') {
          append(group, { kind: 'member', name: member.name }, outcome.text)
          updateRoom(group, r => ({ ...r, watermarks: { ...r.watermarks, [member.name]: r.log.length } }))
          posted += 1
          spoke += 1
        } else if (outcome.kind === 'failed') {
          notice(group, gone.has(member.name) ? copy.gone(label) : copy.failed(label))
          updateRoom(group, r => ({ ...r, watermarks: { ...r.watermarks, [member.name]: r.log.length } }))
        } else if (outcome.kind === 'timeout') {
          notice(group, copy.timedOut(label))
          updateRoom(group, r => ({ ...r, watermarks: { ...r.watermarks, [member.name]: r.log.length } }))
        }
      }

      if (spoke === 0) {
        return // everyone passed — the conversation settled
      }

      // Later rounds: only who a teammate handed something to.
      speakers = handoffTargets(($groupChats.get()[group]?.log || []).slice(roundStart), members)
    }
  } finally {
    if (current()) {
      updateRoom(group, room => ({ ...room, running: false, speaker: null, speakerSince: null }))
    }
  }
}

/** A user message into a room. Bumps the epoch so a running drive stops at
 *  once (its in-flight turn is interrupted); the newest message's drive
 *  takes over. */
export function sendToGroup(
  group: string,
  members: readonly GroupMember[],
  text: string,
  copy: RoundCopy,
  attachments: GroupAttachment[] = []
): void {
  const trimmed = String(text || '').trim()

  if ((!trimmed && !attachments.length) || !members.length) {
    return
  }

  $groupNeedsYou.set({ ...$groupNeedsYou.get(), [group]: false })
  append(group, { kind: 'user', name: USER_HANDLE }, trimmed, attachments)

  const wasRunning = $groupChats.get()[group]?.running === true
  updateRoom(group, room => ({ ...room, epoch: room.epoch + 1, running: true, speaker: null, speakerSince: null }))

  const drive = () =>
    void runRounds(group, members, copy).catch(() =>
      updateRoom(group, room => ({ ...room, running: false, speaker: null, speakerSince: null }))
    )

  if (wasRunning) {
    // Let the previous drive notice the new epoch and interrupt its turn.
    setTimeout(drive, TURN_POLL_MS + 250)
  } else {
    drive()
  }
}

/** Stop the room: the member answering now is interrupted, nobody else
 *  speaks until the user writes again. */
export function stopGroup(group: string, stoppedText: string): void {
  const room = $groupChats.get()[group]

  if (!room?.running) {
    return
  }

  updateRoom(group, r => ({ ...r, epoch: r.epoch + 1, running: false, speaker: null, speakerSince: null }))
  setApproval(group, null)
  notice(group, stoppedText)
}

/** Forget a room's history (members keep their own per-room sessions). */
export function clearGroup(group: string): void {
  const rooms = { ...$groupChats.get() }
  delete rooms[group]
  $groupChats.set(rooms)
  persistRooms(rooms)
  setApproval(group, null)
}

/** Test-only. */
export function resetGroupRuntime(): void {
  approvals.clear()
  approvalListeners.clear()
}

export interface MentionLabels {
  everyone: string
  members: readonly GroupMember[]
  user: string
}

/**
 * Room text for display: every @handle that names someone in the room
 * becomes their display name in bold ("@bien-tap-noi-dung" → "**@Biên tập nội
 * dung**", "@user" → "**@bạn**"), so replies read like a conversation, not a
 * list of slugs. Code (fenced or inline) and unknown handles are untouched.
 */
function mentionLabelMap(labels: MentionLabels): Map<string, string> {
  const byHandle = new Map<string, string>()

  for (const member of labels.members) {
    byHandle.set(botHandle(member.name).toLowerCase(), member.title || botHandle(member.name))
    byHandle.set(member.name.toLowerCase(), member.title || botHandle(member.name))
  }

  byHandle.set(USER_HANDLE, labels.user)
  byHandle.set(EVERYONE_HANDLE, labels.everyone)
  byHandle.set('all', labels.everyone)

  return byHandle
}

export function decorateMentions(text: string, labels: MentionLabels): string {
  const byHandle = mentionLabelMap(labels)

  return text
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part.replace(
            /(^|[\s(["'“])@([a-z0-9][a-z0-9._-]*[a-z0-9]|[a-z0-9])/gi,
            (match, lead: string, handle: string) => {
              const label = byHandle.get(handle.toLowerCase())

              return label ? `${lead}**@${label.replace(/([*_`[\]])/g, '\\$1')}**` : match
            }
          )
    )
    .join('')
}

export type MentionSegment = { mention: false; text: string } | { mention: true; text: string }

/** Plain text split into words and resolved @mentions ("@thu-ky" →
 *  "@Thư ký"), for surfaces that are not Markdown (the user's own bubble, a
 *  one-line preview). Unknown handles stay ordinary text. */
export function mentionSegments(text: string, labels: MentionLabels): MentionSegment[] {
  const byHandle = mentionLabelMap(labels)
  const out: MentionSegment[] = []
  const pattern = /(^|[\s(["'“])@([a-z0-9][a-z0-9._-]*[a-z0-9]|[a-z0-9])/gi
  let last = 0

  for (const match of text.matchAll(pattern)) {
    const label = byHandle.get(match[2].toLowerCase())

    if (!label) {
      continue
    }

    const at = (match.index ?? 0) + match[1].length

    if (at > last) {
      out.push({ mention: false, text: text.slice(last, at) })
    }

    out.push({ mention: true, text: `@${label}` })
    last = at + 1 + match[2].length
  }

  if (last < text.length) {
    out.push({ mention: false, text: text.slice(last) })
  }

  return out
}

/** One-line preview text with mentions resolved. */
export function plainMentions(text: string, labels: MentionLabels): string {
  return mentionSegments(text, labels)
    .map(segment => segment.text)
    .join('')
}
