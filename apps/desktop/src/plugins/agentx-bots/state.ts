/**
 * Bot Mode shared state: per-bot look/meta, "unread" watermarks, group rooms.
 *
 * Meta lives in two places on purpose: plugin storage (instant, works on any
 * gateway) and profile.yaml `ui_meta['agentx-bots']` via profiles.configure
 * (the source of truth — every machine on this gateway paints the same
 * roster). Avatar pictures go to the profile asset store instead, because
 * ui_meta rides every profiles.list.
 */

import { atom, host, type PluginStorage, queryClient } from '@agentx/plugin-sdk'

import { isPrimary } from './naming'
import type { Bot, BotMeta, BotMetaMap, GroupRoom } from './types'

export const PLUGIN_ID = 'agentx-bots'
export const ROSTER_KEY = [PLUGIN_ID, 'roster'] as const

const STORAGE = {
  groups: 'group-chats',
  meta: 'bot-meta',
  seen: 'seen-activity'
} as const

let storage: PluginStorage | null = null

/** Wire plugin storage and hydrate persisted state. Called from register(). */
export function bindStorage(next: PluginStorage | null): void {
  storage = next
  seenHydrated = true

  const meta = read<unknown>(STORAGE.meta, null)

  if (isRecord(meta)) {
    // Live edits made before hydration win over the stored copy.
    const merged: BotMetaMap = { ...(meta as BotMetaMap) }

    for (const [name, value] of Object.entries($botMeta.get())) {
      merged[name] = { ...merged[name], ...value }
    }

    $botMeta.set(merged)
  }

  const seen = read<unknown>(STORAGE.seen, null)

  if (isRecord(seen)) {
    $seenActivity.set({ ...(seen as Record<string, number>), ...$seenActivity.get() })
  }

  const groups = read<unknown>(STORAGE.groups, null)

  if (isRecord(groups)) {
    const rooms: Record<string, GroupRoom> = {}

    for (const [name, room] of Object.entries(groups as Record<string, Partial<GroupRoom>>)) {
      if (room && Array.isArray(room.log)) {
        rooms[name] = {
          log: room.log,
          watermarks: isRecord(room.watermarks) ? (room.watermarks as Record<string, number>) : {},
          sessions: isRecord(room.sessions) ? (room.sessions as Record<string, string>) : {},
          epoch: 0,
          running: false
        }
      }
    }

    $groupChats.set({ ...rooms, ...$groupChats.get() })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function read<T>(key: string, fallback: T): T {
  try {
    return storage ? storage.get<T>(key, fallback) : fallback
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown): void {
  try {
    storage?.set(key, value)
  } catch {
    /* storage unavailable — the value holds for this window only */
  }
}

// ── meta ─────────────────────────────────────────────────────────────────────

export const $botMeta = atom<BotMetaMap>({})

export type MetaSaveOutcome = 'failed' | 'persisted' | 'unsupported'

/** Patch one bot's meta locally, then persist server-side.
 *  'unsupported' (older gateway, local copy wins) is NOT an error. */
export async function saveBotMeta(name: string, patch: Partial<BotMeta>): Promise<MetaSaveOutcome> {
  const prev = $botMeta.get()[name] || {}
  const next = { ...$botMeta.get(), [name]: { ...prev, ...patch } }
  $botMeta.set(next)
  write(STORAGE.meta, next)

  if ('image' in patch && (patch.image ?? null) !== (prev.image ?? null)) {
    void host
      .requestPrimary(
        'profiles.set_asset',
        patch.image ? { name, asset: 'avatar', data: patch.image } : { name, asset: 'avatar', clear: true }
      )
      .catch(() => undefined)
  }

  // The picture never rides ui_meta (64KB cap, sent with every roster).
  const { image: _image, ...compact } = next[name]

  try {
    const result = await host.requestPrimary<{ applied?: Record<string, boolean> }>('profiles.configure', {
      name,
      ui_meta: { [PLUGIN_ID]: compact }
    })

    if (result?.applied?.ui_meta === true) {
      return 'persisted'
    }

    return result?.applied && typeof result.applied === 'object' ? 'failed' : 'unsupported'
  } catch {
    return 'unsupported'
  }
}

/** Server ui_meta overlays local meta, except fields only local has (the
 *  picture). When the server stops naming a canonical chat, drop ours too —
 *  otherwise storage would resurrect a deleted pin forever. */
export function mergeServerMeta(roster: readonly Bot[]): void {
  const local = $botMeta.get()
  const next: BotMetaMap = { ...local }
  let changed = false

  for (const bot of roster) {
    const server = bot.ui_meta?.[PLUGIN_ID]

    if (!isRecord(server)) {
      continue
    }

    const mine = next[bot.name] || {}
    const merged: BotMeta = { ...mine, ...(server as BotMeta) }

    if (mine.image) {
      merged.image = mine.image
    }

    if ('chat' in mine && !('chat' in server)) {
      delete merged.chat
    }

    if (JSON.stringify(mine) !== JSON.stringify(merged)) {
      next[bot.name] = merged
      changed = true
    }
  }

  if (changed) {
    $botMeta.set(next)
    write(STORAGE.meta, next)
  }
}

const avatarInflight = new Set<string>()

/** Fetch server-side pictures this machine doesn't have yet. */
export function pullServerAvatars(roster: readonly Bot[]): void {
  for (const bot of roster) {
    if (!bot.has_avatar || avatarInflight.has(bot.name) || $botMeta.get()[bot.name]?.image) {
      continue
    }

    avatarInflight.add(bot.name)
    host
      .requestPrimary<{ data?: string; found?: boolean }>('profiles.get_asset', { name: bot.name, asset: 'avatar' })
      .then(res => {
        if (res?.found && res.data) {
          const meta = $botMeta.get()
          const next = { ...meta, [bot.name]: { ...meta[bot.name], image: res.data } }
          $botMeta.set(next)
          write(STORAGE.meta, next)
        }
      })
      .catch(() => undefined)
      .finally(() => avatarInflight.delete(bot.name))
  }
}

// ── unread ──────────────────────────────────────────────────────────────────
// Messages-style: remember the last activity the user has SEEN per bot (unix
// seconds), persisted, so a bot that got a message while the page was closed
// shows a dot the next time it opens. No background polling.

export const $seenActivity = atom<Record<string, number>>({})
let seenHydrated = false

/** Bots whose latest activity is newer than what the user saw. A first-ever
 *  load seeds everything as seen, so a fresh install has no stale dots. */
export function unreadBots(roster: readonly Bot[], seen: Record<string, number>): Set<string> {
  const out = new Set<string>()

  for (const bot of roster) {
    const last = bot.last_session?.last_active || 0

    if (last && bot.name in seen && last > seen[bot.name]) {
      out.add(bot.name)
    }
  }

  return out
}

/** Record that the user has seen everything up to now for these bots; bots
 *  never seen before are seeded at their current activity. */
export function noteRoster(roster: readonly Bot[]): void {
  if (!seenHydrated) {
    return
  }

  const seen = $seenActivity.get()
  let changed = false
  const next = { ...seen }

  for (const bot of roster) {
    if (!(bot.name in next)) {
      next[bot.name] = bot.last_session?.last_active || 0
      changed = true
    }
  }

  if (changed) {
    $seenActivity.set(next)
    write(STORAGE.seen, next)
  }
}

export function markSeen(bot: Bot): void {
  markSeenAt(bot.name, bot.last_session?.last_active || 0)
}

/** Everything `name` did up to `seconds` (unix) counts as seen. */
export function markSeenAt(name: string, seconds: number): void {
  const seen = $seenActivity.get()

  if ((seen[name] ?? -1) >= seconds) {
    return
  }

  const next = { ...seen, [name]: seconds }
  $seenActivity.set(next)
  write(STORAGE.seen, next)
}

// ── lifecycle ────────────────────────────────────────────────────────────────

/** Copy a bot: profile (config/skills/persona/memory via clone_from) + look. */
export async function duplicateBot(bot: Bot, name: string, copySuffix: string): Promise<void> {
  await host.requestPrimary('profiles.create', { name, clone_from: bot.name, description: bot.description || '' })

  const meta = $botMeta.get()[bot.name]

  if (meta) {
    const { chat: _chat, created: _created, pinned: _pinned, ...look } = meta
    await saveBotMeta(name, { ...look, created: Date.now(), title: meta.title ? `${meta.title} ${copySuffix}` : '' })
  } else {
    await saveBotMeta(name, { created: Date.now() })
  }

  await invalidateRoster()
}

/** Assistants deleted in this window. A roster fetched before the delete
 *  (react-query keeps the last good data while a refetch is in flight or
 *  fails) must not paint them again; a fresh roster that no longer lists a
 *  name clears it (`settleDeleted`), so a profile that really still exists
 *  shows up again instead of being hidden forever. */
export const $recentlyDeleted = atom<ReadonlySet<string>>(new Set())

export function withoutDeleted<T extends Pick<Bot, 'name'>>(roster: readonly T[], deleted: ReadonlySet<string>): T[] {
  return deleted.size ? roster.filter(bot => !deleted.has(bot.name)) : [...roster]
}

/** A roster from the server arrived: names it no longer lists are gone for
 *  good and need no more hiding. */
export function settleDeleted(roster: readonly Pick<Bot, 'name'>[]): void {
  const deleted = $recentlyDeleted.get()

  if (!deleted.size) {
    return
  }

  const listed = new Set(roster.map(bot => bot.name))
  const still = [...deleted].filter(name => listed.has(name))

  if (still.length !== deleted.size) {
    $recentlyDeleted.set(new Set(still))
  }
}

/** Delete a bot's profile (never the primary) and forget its local state. */
export async function deleteBot(name: string): Promise<void> {
  if (isPrimary(name)) {
    throw new Error('The main assistant cannot be deleted.')
  }

  await host.deleteProfile(name)
  $recentlyDeleted.set(new Set([...$recentlyDeleted.get(), name]))
  forgetRoomMember(name)

  const meta = { ...$botMeta.get() }
  delete meta[name]
  $botMeta.set(meta)
  write(STORAGE.meta, meta)

  const seen = { ...$seenActivity.get() }
  delete seen[name]
  $seenActivity.set(seen)
  write(STORAGE.seen, seen)

  await invalidateRoster()
}

export function invalidateRoster(): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: ROSTER_KEY })
}

// ── group rooms ──────────────────────────────────────────────────────────────

export const $groupChats = atom<Record<string, GroupRoom>>({})
/** Rooms whose latest message asks @user for something. */
export const $groupNeedsYou = atom<Record<string, boolean>>({})

export const emptyRoom = (): GroupRoom => ({
  log: [],
  watermarks: {},
  sessions: {},
  epoch: 0,
  running: false,
  speaker: null
})

/** Persist only the durable part of every room. */
export function persistRooms(rooms: Record<string, GroupRoom>): void {
  const durable: Record<string, Pick<GroupRoom, 'log' | 'sessions' | 'watermarks'>> = {}

  for (const [name, room] of Object.entries(rooms)) {
    durable[name] = { log: room.log, watermarks: room.watermarks, sessions: room.sessions }
  }

  write(STORAGE.groups, durable)
}

/** A deleted assistant leaves every room: its per-room session and read
 *  position go (what it said stays in the log). */
export function forgetRoomMember(name: string): void {
  const rooms = $groupChats.get()
  let changed = false
  const next: Record<string, GroupRoom> = {}

  for (const [group, room] of Object.entries(rooms)) {
    if (name in room.sessions || name in room.watermarks) {
      const sessions = { ...room.sessions }
      const watermarks = { ...room.watermarks }
      delete sessions[name]
      delete watermarks[name]
      next[group] = { ...room, sessions, watermarks }
      changed = true
    } else {
      next[group] = room
    }
  }

  if (changed) {
    $groupChats.set(next)
    persistRooms(next)
  }
}

/** Test-only reset of module state. */
export function resetBotState(): void {
  storage = null
  seenHydrated = false
  avatarInflight.clear()
  $botMeta.set({})
  $seenActivity.set({})
  $groupChats.set({})
  $groupNeedsYou.set({})
  $recentlyDeleted.set(new Set())
}

/** Test-only: pretend storage hydration finished (with nothing stored). */
export function markSeenHydratedForTests(): void {
  seenHydrated = true
}
