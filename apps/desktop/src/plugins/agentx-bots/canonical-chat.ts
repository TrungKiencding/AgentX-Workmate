/**
 * Each assistant has ONE ongoing conversation (its "Bot Chat"), pinned by
 * stored session id in bot meta (synced through ui_meta, so it follows the
 * profile to every machine). Opening an assistant always lands there — never
 * on "the most recent session", which drifts whenever the profile is used
 * elsewhere.
 *
 *  - first open of an assistant that already has a Bot Chat adopts it;
 *  - otherwise the conversation is created EMPTY (`session.create` with
 *    `persist_only`: a titled DB row, no runtime, no agent) — the user's own
 *    first message starts it. Nothing is ever sent on the user's behalf;
 *  - a pin whose session vanished is re-pointed at the newest Bot Chat.
 *
 * The main assistant is different: it IS the app's ordinary chat, so
 * "Message" there is simply a new chat at home (see `openBot`).
 *
 * Every read/create goes to the window backend (`host.requestPrimary` with a
 * `profile` param): nothing here depends on which profile happens to be live.
 * Only the final `host.openSession` moves the app onto the assistant.
 */

import { host } from '@agentx/plugin-sdk'

import { BOT_CHAT_TITLE } from './naming'
import { $botMeta, saveBotMeta } from './state'
import type { ProfileSession } from './types'

const creations = new Map<string, Promise<string | null>>()

/** Create the assistant's (empty) main conversation and pin it. Single-flight
 *  per assistant so a double click can't create two. Resolves the stored id. */
export function createCanonicalChat(name: string): Promise<string | null> {
  const inflight = creations.get(name)

  if (inflight) {
    return inflight
  }

  const run = (async () => {
    const res = await host.requestPrimary<{ stored_session_id?: string }>('session.create', {
      profile: name,
      title: BOT_CHAT_TITLE,
      persist_only: true,
      strict_profile: true
    })

    const stored = res?.stored_session_id || null

    if (stored) {
      await saveBotMeta(name, { chat: stored })
    }

    return stored
  })().finally(() => creations.delete(name))

  creations.set(name, run)

  return run
}

/** The stored id of the assistant's main conversation, creating it on first
 *  use (and healing a pin whose session is gone). */
export async function resolveCanonicalChat(name: string): Promise<string | null> {
  const pinned = $botMeta.get()[name]?.chat || null
  let rows: ProfileSession[]

  try {
    const res = await host.requestPrimary<{ sessions?: ProfileSession[] }>('session.list', {
      profile: name,
      limit: 200,
      strict_profile: true
    })

    rows = res?.sessions ?? []
  } catch {
    // Gateway hiccup: trust the pin; with none, creating is still safe (a
    // second Bot Chat would only happen if the list lied).
    return pinned ?? createCanonicalChat(name)
  }

  if (pinned && rows.some(row => row.id === pinned)) {
    return pinned
  }

  // No pin (first open on this machine) or a stale one (deleted, rewritten by
  // compaction): follow the newest Bot Chat, else start one.
  const existing = rows.find(row => (row.title || '').trim() === BOT_CHAT_TITLE)

  if (existing) {
    await saveBotMeta(name, { chat: existing.id })

    return existing.id
  }

  if (pinned) {
    await saveBotMeta(name, { chat: null })
  }

  return createCanonicalChat(name)
}

/** Open the assistant's ongoing chat, creating it on first use. */
export async function openCanonicalChat(name: string): Promise<string | null> {
  const id = await resolveCanonicalChat(name)

  if (!id) {
    return null
  }

  try {
    await host.openSession(id, { profile: name })

    return id
  } catch {
    // The row vanished between list and open: start over once.
    await saveBotMeta(name, { chat: null })
    const fresh = await createCanonicalChat(name)

    if (fresh) {
      await host.openSession(fresh, { profile: name })
    }

    return fresh
  }
}

/** Test-only. */
export function resetCanonicalChats(): void {
  creations.clear()
}
