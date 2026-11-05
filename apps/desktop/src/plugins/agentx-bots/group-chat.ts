/**
 * Group rooms: bounded round-robin over a shared room log.
 *
 * A room is ONE ordered log owned by the plugin. A user message triggers at
 * most MAX_ROUNDS serial rounds over the members — never parallel, no LLM
 * router. Who speaks is a deterministic @mention parse since the last user
 * message (mentioned members only, else everyone); whether a member actually
 * speaks is its own choice — replying "(pass)" (or nothing, or failing) is
 * silence. A round where everyone passed means the conversation settled.
 * Each member answers in its OWN per-room session and only sees the room
 * messages that are new to it.
 */

import { host } from '@agentx/plugin-sdk'

import { botHandle, foldForSearch } from './naming'
import { $groupChats, $groupNeedsYou, emptyRoom, persistRooms } from './state'
import type { GroupEntry, GroupMember, GroupRoom } from './types'

export const GROUP_MAX_ROUNDS = 3
export const GROUP_MAX_MESSAGES = 10
export const GROUP_HISTORY_LIMIT = 24
export const GROUP_MAX_MEMBERS = 6
const TURN_TIMEOUT_MS = 180_000
const TURN_POLL_MS = 2_000

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
    const parsed = parseMentions(entry.text, members)
    everyone ||= parsed.everyone
    parsed.mentioned.forEach(name => mentioned.add(name))
  }

  return everyone || mentioned.size === 0 ? [...members] : members.filter(member => mentioned.has(member.name))
}

/** A different member leads each round. */
export function rotateSpeakers<T>(members: readonly T[], round: number): T[] {
  if (members.length < 2) {
    return [...members]
  }

  const shift = round % members.length

  return [...members.slice(shift), ...members.slice(0, shift)]
}

function formatLine(entry: GroupEntry, viewer: string): string {
  if (entry.from.kind === 'user') {
    return `User: ${entry.text}`
  }

  return `@${entry.from.name}${entry.from.name === viewer ? ' (you)' : ''}: ${entry.text}`
}

/** One member's turn payload: room rules + the messages new to it. */
export function buildTurnPrompt(
  room: string,
  members: readonly GroupMember[],
  viewer: GroupMember,
  delta: readonly GroupEntry[]
): string {
  const peers = members
    .filter(member => member.name !== viewer.name)
    .map(member => (member.title ? `${member.title} (@${member.name})` : `@${member.name}`))
    .join(', ')

  return [
    `[Group chat: "${room}"] You are @${viewer.name}, one participant in a group chat with ${peers || 'no one else yet'} and the user.`,
    '',
    'New messages in the room since your last turn (oldest first):',
    ...delta.slice(-GROUP_HISTORY_LIMIT).map(entry => `  ${formatLine(entry, viewer.name)}`),
    '',
    'Rules for this room:',
    "- Reply with ONE short conversational message (1-3 sentences) in the user's language ONLY if you have something new worth adding: build on what was just said, claim or hand off work, answer a question aimed at you, or report a real result.",
    '- If you have nothing new to add, reply with exactly "(pass)". Passing is good — it lets the conversation settle.',
    '- Mention a teammate as @name to pull them in; mention @user only for a judgment call or a result the user needs. Do not repeat points already made.',
    '- Never reveal content from your private 1:1 chats. Your reply goes to the room verbatim — no preamble, no meta-commentary.'
  ].join('\n')
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

function append(group: string, from: GroupEntry['from'], text: string): void {
  const entry: GroupEntry = { from, text: String(text).trim(), at: Date.now() }
  updateRoom(group, room => ({ ...room, log: [...room.log, entry] }))

  if (from.kind === 'member' && /@user\b/i.test(entry.text)) {
    $groupNeedsYou.set({ ...$groupNeedsYou.get(), [group]: true })
  }
}

/** A live runtime id for the member's room session (resume, else create). */
async function ensureMemberSession(
  group: string,
  member: string
): Promise<{ runtime: string | null; stored: string | null }> {
  const title = `Group: ${group}`
  const known = $groupChats.get()[group]?.sessions[member] || null

  for (const target of [known, title]) {
    if (!target) {
      continue
    }

    try {
      const res = await host.request<{ session_id?: string; session_key?: string }>('session.resume', {
        session_id: target,
        profile: member,
        omit_messages: true
      })

      if (res?.session_id) {
        return { runtime: res.session_id, stored: res.session_key || known }
      }
    } catch {
      /* fall through to create */
    }
  }

  const created = await host.request<{ session_id?: string; stored_session_id?: string }>('session.create', {
    profile: member,
    title
  })

  const stored = created?.stored_session_id || null

  if (stored) {
    updateRoom(group, room => ({ ...room, sessions: { ...room.sessions, [member]: stored } }))
  }

  return { runtime: created?.session_id || null, stored }
}

interface ResumeState {
  inflight?: unknown
  message_count?: number
  messages?: Array<{ content?: unknown; role?: string; text?: string }>
  running?: boolean
}

function messageText(message: { content?: unknown; text?: string }): string {
  const { content } = message

  if (typeof content === 'string') {
    return content
  }

  if (Array.isArray(content)) {
    return content.map(part => (typeof part === 'string' ? part : (part as { text?: string })?.text || '')).join('')
  }

  return message.text || ''
}

async function runMemberTurn(group: string, member: GroupMember, prompt: string): Promise<string | null> {
  const { runtime, stored } = await ensureMemberSession(group, member.name)

  if (!runtime) {
    return null
  }

  let before = 0

  try {
    const pre = await host.request<ResumeState>('session.resume', {
      session_id: stored || runtime,
      profile: member.name
    })

    before = Array.isArray(pre?.messages) ? pre.messages.length : pre?.message_count || 0
  } catch {
    /* lazy session — zero messages */
  }

  await host.request('prompt.submit', { session_id: runtime, text: prompt })

  const deadline = Date.now() + TURN_TIMEOUT_MS

  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, TURN_POLL_MS))

    let state: ResumeState | null = null

    try {
      state = await host.request<ResumeState>('session.resume', { session_id: stored || runtime, profile: member.name })
    } catch {
      continue
    }

    const messages = Array.isArray(state?.messages) ? state.messages : []

    if (messages.length > before && !state?.inflight && !state?.running) {
      const reply = [...messages].reverse().find(message => message?.role === 'assistant')

      return reply ? messageText(reply).trim() : null
    }
  }

  return null // timed out — reads as a pass
}

async function runRounds(group: string, members: readonly GroupMember[]): Promise<void> {
  const epoch = $groupChats.get()[group]?.epoch || 0
  // Runtime session ids belong to the gateway that minted them: if the user
  // switches profile mid-drive, stop at the next member boundary.
  const profile = host.state.profile.get()
  const current = () => ($groupChats.get()[group]?.epoch || 0) === epoch && host.state.profile.get() === profile
  let posted = 0

  try {
    for (let round = 0; round < GROUP_MAX_ROUNDS; round++) {
      const log = $groupChats.get()[group]?.log || []
      let spoke = 0

      for (const member of rotateSpeakers(resolveResponders(log, members), round)) {
        if (!current() || posted >= GROUP_MAX_MESSAGES) {
          return
        }

        const room = $groupChats.get()[group] || emptyRoom()
        const delta = room.log.slice(room.watermarks[member.name] || 0)

        if (!delta.length) {
          continue
        }

        let reply: string | null = null
        updateRoom(group, r => ({ ...r, speaker: member.name }))

        try {
          reply = await runMemberTurn(group, member, buildTurnPrompt(group, members, member, delta))
        } catch {
          reply = null // a failed turn is a pass, never a room error
        }

        updateRoom(group, r => ({
          ...r,
          speaker: r.speaker === member.name ? null : r.speaker,
          watermarks: { ...r.watermarks, [member.name]: r.log.length }
        }))

        if (reply !== null && !isPassText(reply)) {
          append(group, { kind: 'member', name: member.name }, reply)
          updateRoom(group, r => ({ ...r, watermarks: { ...r.watermarks, [member.name]: r.log.length } }))
          posted += 1
          spoke += 1
        }
      }

      if (spoke === 0) {
        return // everyone passed — the conversation settled
      }
    }
  } finally {
    if (current()) {
      updateRoom(group, room => ({ ...room, running: false, speaker: null }))
    }
  }
}

/** A user message into a room. Bumps the epoch so a running drive bails at its
 *  next member boundary; the newest message's drive takes over. */
export function sendToGroup(group: string, members: readonly GroupMember[], text: string): void {
  const trimmed = String(text || '').trim()

  if (!trimmed || !members.length) {
    return
  }

  $groupNeedsYou.set({ ...$groupNeedsYou.get(), [group]: false })
  append(group, { kind: 'user', name: 'user' }, trimmed)

  const wasRunning = $groupChats.get()[group]?.running === true
  updateRoom(group, room => ({ ...room, epoch: room.epoch + 1, running: true }))

  const drive = () =>
    void runRounds(group, members).catch(() => updateRoom(group, room => ({ ...room, running: false, speaker: null })))

  if (wasRunning) {
    setTimeout(drive, 250)
  } else {
    drive()
  }
}

/** Forget a room's history (members keep their own per-room sessions). */
export function clearGroup(group: string): void {
  const rooms = { ...$groupChats.get() }
  delete rooms[group]
  $groupChats.set(rooms)
  persistRooms(rooms)
}
