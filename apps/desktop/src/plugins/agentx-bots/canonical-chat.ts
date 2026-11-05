/**
 * Each bot has ONE ongoing conversation (its "Bot Chat"), pinned by stored
 * session id in bot meta (synced through ui_meta, so it follows the profile
 * to every machine). Opening a bot always lands there — never on "the most
 * recent session", which drifts whenever the profile is used elsewhere.
 *
 *  - first open of a bot with history adopts its newest session;
 *  - a fresh bot gets a new session that opens with a short kickoff message
 *    (the gateway prunes sessions that never got a message);
 *  - a pin whose session vanished is re-pointed at the newest one.
 */

import { host } from '@agentx/plugin-sdk'

import { BOT_CHAT_TITLE } from './naming'
import { $botMeta, saveBotMeta } from './state'
import type { ProfileSession } from './types'

const creations = new Map<string, Promise<string | null>>()

/** Mint the bot's chat, open it, then send the kickoff. Single-flight per bot
 *  so a double click can't create two. Resolves the stored session id. */
export function createCanonicalChat(name: string, kickoff: string): Promise<string | null> {
  const inflight = creations.get(name)

  if (inflight) {
    return inflight
  }

  const run = (async () => {
    // Create, open and kick off on the assistant's OWN backend: a runtime
    // session id only exists on the gateway that minted it, and opening the
    // chat switches to that profile's backend anyway.
    await host.activateProfile(name)

    const res = await host.request<{ session_id?: string; stored_session_id?: string }>('session.create', {
      profile: name,
      title: BOT_CHAT_TITLE
    })

    const stored = res?.stored_session_id || null
    const runtime = res?.session_id || null

    if (stored) {
      await saveBotMeta(name, { chat: stored })
    }

    // Mount the chat FIRST so the kickoff reply streams into a visible view.
    let opened = false

    if (stored) {
      try {
        await host.openSession(stored, { profile: name })
        opened = true
      } catch {
        // The stored row may only exist once the kickoff persists it.
      }
    }

    if (runtime) {
      try {
        await host.request('prompt.submit', { session_id: runtime, text: kickoff })

        if (!opened && stored) {
          await host.openSession(stored, { profile: name })
        }
      } catch (error) {
        if (stored) {
          await saveBotMeta(name, { chat: null })
        }

        throw error
      }
    }

    return stored
  })().finally(() => creations.delete(name))

  creations.set(name, run)

  return run
}

/** Open the bot's ongoing chat, creating it on first use. */
export async function openCanonicalChat(name: string, kickoff: string): Promise<string | null> {
  let id = $botMeta.get()[name]?.chat || null

  try {
    const res = await host.request<{ sessions?: ProfileSession[] }>('session.list', { profile: name, limit: 100 })
    const rows = res?.sessions ?? []

    if (!id) {
      // Grandfather: a bot that already talks somewhere keeps that thread
      // only if it IS a Bot Chat; otherwise start the canonical one fresh.
      const existing = rows.find(row => (row.title || '').trim() === BOT_CHAT_TITLE)

      if (!existing) {
        return createCanonicalChat(name, kickoff)
      }

      id = existing.id
      await saveBotMeta(name, { chat: id })
    } else if (!rows.some(row => row.id === id)) {
      // The pinned session is gone (deleted, or rewritten by compaction):
      // follow the newest Bot Chat, else start over.
      const replacement = rows.find(row => (row.title || '').trim() === BOT_CHAT_TITLE)

      if (!replacement) {
        await saveBotMeta(name, { chat: null })

        return createCanonicalChat(name, kickoff)
      }

      id = replacement.id
      await saveBotMeta(name, { chat: id })
    }
  } catch {
    // Gateway hiccup — try the pin as-is, or create when there is none.
    if (!id) {
      return createCanonicalChat(name, kickoff)
    }
  }

  try {
    await host.openSession(id, { profile: name })

    return id
  } catch {
    await saveBotMeta(name, { chat: null })

    return createCanonicalChat(name, kickoff)
  }
}

/** Test-only. */
export function resetCanonicalChats(): void {
  creations.clear()
}
