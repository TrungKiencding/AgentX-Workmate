/** Pure naming/identity helpers for Bot Mode — no I/O, fully unit-tested. */

import { stripInternalPreamble } from '@agentx/plugin-sdk'

import type { Bot, BotMeta, BotMetaMap, ProfileSession } from './types'

/** Profile ids the gateway accepts (`hermes_cli.profiles.validate_profile_name`). */
export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** The canonical chat title. The backend gates the teammate protocol on it and
 *  bots deliver messages with `-c "Bot Chat"` — never localize or change it. */
export const BOT_CHAT_TITLE = 'Bot Chat'

/** The primary profile's handle; the word "default" never surfaces in the UI. */
export const DEFAULT_HANDLE = 'agentx'

export const isPrimary = (name: string | null | undefined) => (name || '').trim().toLowerCase() === 'default'

/** The @handle users tag a bot with. */
export function botHandle(name: string): string {
  return isPrimary(name) ? DEFAULT_HANDLE : name
}

/** Resolve a typed handle back to a profile name against the live roster. */
export function profileForHandle(handle: string, names: readonly string[]): string | null {
  const key = handle.trim().toLowerCase().replace(/^@/, '')

  if (key === DEFAULT_HANDLE && !names.includes(DEFAULT_HANDLE) && names.includes('default')) {
    return 'default'
  }

  return names.includes(key) ? key : null
}

/** Display name: the user's title, else "AgentX" for the primary, else the
 *  profile name prettified ("inbox-triage" → "Inbox Triage"). */
export function displayName(bot: Pick<Bot, 'name'>, meta?: BotMeta | null, primaryLabel = 'AgentX'): string {
  const title = meta?.title?.trim()

  if (title) {
    return title
  }

  if (isPrimary(bot.name)) {
    return primaryLabel
  }

  return (bot.name || '')
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/\b\p{L}/gu, ch => ch.toUpperCase())
}

/** Whether the row should also show @handle (only when it adds information). */
export function showsHandle(bot: Pick<Bot, 'name'>, meta?: BotMeta | null): boolean {
  return displayName(bot, meta).toLowerCase() !== botHandle(bot.name).toLowerCase()
}

/** Turn any display name into a profile id: strips Vietnamese (and other)
 *  diacritics so "Trợ lý Kế toán" becomes "tro-ly-ke-toan", not "tr-l-k-to-n". */
export function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 64)
    .replace(/[-_]+$/g, '')
}

/** First free id for `base` against taken names: base, base-2, base-3… The
 *  base is truncated, never the suffix, so a 64-char base still gets a free slot. */
export function uniqueName(base: string, taken: readonly string[]): string | null {
  const clean = slugify(base) || 'tro-ly'
  const takenSet = new Set(taken.map(name => name.toLowerCase()))

  if (!takenSet.has(clean) && NAME_RE.test(clean)) {
    return clean
  }

  for (let n = 2; n < 100; n++) {
    const suffix = `-${n}`
    const candidate = clean.slice(0, 64 - suffix.length) + suffix

    if (!takenSet.has(candidate) && NAME_RE.test(candidate)) {
      return candidate
    }
  }

  return null
}

/** Narrow by display name or handle; never re-ranks. */
export function filterBots(roster: readonly Bot[], metaByName: BotMetaMap, query: string): Bot[] {
  const needle = foldForSearch(query).replace(/^@/, '')

  if (!needle) {
    return [...roster]
  }

  return roster.filter(bot => {
    const fields = [displayName(bot, metaByName[bot.name]), bot.name, botHandle(bot.name), bot.description || '']

    return fields.some(field => foldForSearch(field).includes(needle))
  })
}

/** Lowercase + diacritics-insensitive, so "ke toan" finds "Kế toán". */
export function foldForSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .trim()
}

/** Activity order: newest of (created, last message); pinned bots first. */
export function sortRoster(roster: readonly Bot[], metaByName: BotMetaMap): Bot[] {
  const activity = (bot: Bot) => {
    const meta = metaByName[bot.name]
    const serverMeta = bot.ui_meta?.['agentx-bots'] as BotMeta | undefined
    const created = meta?.created || serverMeta?.created || 0

    return Math.max(created, (bot.last_session?.last_active || 0) * 1000)
  }

  return roster.slice().sort((a, b) => {
    const pinned = Number(Boolean(metaByName[b.name]?.pinned)) - Number(Boolean(metaByName[a.name]?.pinned))

    return pinned || activity(b) - activity(a) || a.name.localeCompare(b.name)
  })
}

export interface RosterSection {
  /** null = ungrouped. */
  group: string | null
  bots: Bot[]
}

/** Ungrouped first, then each group alphabetically; order inside is kept.
 *  Empty groups vanish — groups are just a field on each bot. */
export function groupRoster(roster: readonly Bot[], metaByName: BotMetaMap): RosterSection[] {
  const ungrouped: Bot[] = []
  const byGroup = new Map<string, Bot[]>()

  for (const bot of roster) {
    const group = (metaByName[bot.name]?.group || '').trim()

    if (!group) {
      ungrouped.push(bot)

      continue
    }

    byGroup.set(group, [...(byGroup.get(group) ?? []), bot])
  }

  const sections: RosterSection[] = ungrouped.length ? [{ group: null, bots: ungrouped }] : []

  for (const group of [...byGroup.keys()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))) {
    sections.push({ group, bots: byGroup.get(group)! })
  }

  return sections
}

export function knownGroups(metaByName: BotMetaMap): string[] {
  const names = new Set<string>()

  for (const meta of Object.values(metaByName)) {
    const group = (meta?.group || '').trim()

    if (group) {
      names.add(group)
    }
  }

  return [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
}

// ── previews ────────────────────────────────────────────────────────────────

/** Bot-to-bot delivery prefix: "Message from 🤖 Display Name (@handle): …"
 *  (the handle is authoritative — names have spaces), else the older
 *  "Message from 🤖 handle" / "Message from agent 'name'" shapes. */
const A2A_HANDLE_RE = /^Message from 🤖[^(\n]*\(@([a-z0-9][a-z0-9_-]*)\)/i
const A2A_RE = /^Message from (?:agent '([^']+)'|🤖\s*([^\s(@]+))/i
const A2A_PREFIX_RE = /^Message from (?:agent '[^']+'|🤖[^:]+):\s*/i

/** Who sent the latest message (their @handle), when it was another bot. */
export function previewSender(preview: string | null | undefined): string | null {
  const text = (preview || '').trim()
  const handle = text.match(A2A_HANDLE_RE)

  if (handle) {
    return handle[1].toLowerCase()
  }

  const match = text.match(A2A_RE)

  return match ? (match[1] || match[2] || '').trim().toLowerCase() || null : null
}

/** A preview that reads like a message, not a delivery log line or raw
 *  markdown ("Chào bạn! Mình là **AgentX**…" → "Chào bạn! Mình là AgentX…"). */
export function cleanPreview(preview: string | null | undefined): string {
  // The scheduler's delivery hint and model-switch bookkeeping are AgentX's own
  // text in a user turn — never show them as the conversation (older backends
  // still send them in previews).
  const text = stripInternalPreamble(preview)
    .trim()
    .replace(A2A_PREFIX_RE, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|`+)/g, '')
    .replace(/(^|\s)[*_](\S[^*_]*\S|\S)[*_](?=\s|$|[.,!?;:])/g, '$1$2')
    .replace(/^\s*(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()

  // A group-room "(pass)" is silence, not something anyone said.
  return /^\(?\s*pass\s*\)?\.?$/i.test(text) ? '' : text
}

/** A scheduled run's session: one prompt (the routine's task) and one report.
 *  Not a conversation the person holds, so it is listed apart from the chats. */
export function isRoutineRun(session: Pick<ProfileSession, 'id' | 'source'>): boolean {
  return (session.source || '').trim().toLowerCase() === 'cron' || session.id.startsWith('cron_')
}

/** The routine's name from a run's stored title. The scheduler titles a run
 *  "<name> · <when it ran>" (the stamp keeps titles unique); the row shows its
 *  own localized time, so only the name is kept. */
export function routineRunName(session: Pick<ProfileSession, 'title'>, fallback: string): string {
  const title = (session.title || '').trim()
  const cut = title.lastIndexOf(' · ')

  return (cut > 0 ? title.slice(0, cut) : title).trim() || fallback
}

const GENERIC_TITLES = new Set(['', 'bot chat', 'new chat', 'new conversation', 'conversation', 'chat', 'untitled'])

/** A session title worth showing: the real title, else the first words of
 *  its latest message, else `fallback`. */
export function sessionLabel(session: Pick<ProfileSession, 'preview' | 'title'>, fallback: string): string {
  const raw = (session.title || '').trim()

  if (!GENERIC_TITLES.has(raw.toLowerCase())) {
    return raw
  }

  const words = cleanPreview(session.preview)
    .split(/\s+/)
    .slice(0, 6)
    .join(' ')
    .replace(/[,;:.]+$/, '')

  if (!words) {
    return fallback
  }

  return words.length > 42 ? `${words.slice(0, 41)}…` : words
}

/** Who is answering right now — only real signals, never "spoke recently":
 *  the live profile while its gateway streams (unless a group room is the one
 *  driving turns through it), plus every room's current speaker. */
export function workingBots(
  busyProfile: string | null,
  speakers: ReadonlyArray<null | string | undefined>
): Set<string> {
  const out = new Set<string>()

  if (busyProfile) {
    out.add(busyProfile)
  }

  for (const speaker of speakers) {
    if (speaker) {
      out.add(speaker)
    }
  }

  return out
}
