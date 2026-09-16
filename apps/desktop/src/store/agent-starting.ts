import { atom, computed } from 'nanostores'

/**
 * The gateway's keyed notice for a deferred agent build that outlives its slow
 * threshold (`_AGENT_BUILD_SLOW_NOTICE_KEY` in `tui_gateway/server.py` — keep
 * the strings in sync). The desktop renders this state as a localized status
 * line in the transcript's waiting indicator instead of toasting the backend's
 * English text.
 */
export const AGENT_BUILD_SLOW_NOTICE_KEY = 'agent-build-slow'

// Per-session flag while the backend is still building the session's agent
// (tool discovery / model metadata / skills scan) with the user's message
// queued behind it. Per-session so a background chat's build can't put the
// label on the foreground transcript. Cleared by the gateway's matching
// notification.clear (every build exit emits one) and, belt-and-braces, by
// the session's next stream/terminal event.
const keyFor = (sessionId: string | null | undefined): string => sessionId ?? ''

export const $agentStartingSessions = atom<Record<string, true>>({})

/** Is `sessionId` waiting on its agent build? */
export function sessionAgentStarting(sessionId: null | string) {
  return computed($agentStartingSessions, sessions => keyFor(sessionId) in sessions)
}

export function setSessionAgentStarting(sessionId: string | null | undefined, active: boolean): void {
  const key = keyFor(sessionId)
  const sessions = $agentStartingSessions.get()

  if (active) {
    if (key in sessions) {
      return
    }

    $agentStartingSessions.set({ ...sessions, [key]: true })

    return
  }

  if (!(key in sessions)) {
    return
  }

  const next = { ...sessions }
  delete next[key]
  $agentStartingSessions.set(next)
}

/** Clear every session's flag — for a keyed clear that arrives without a
 *  session id (defensive; the gateway always scopes both events to one). */
export function clearAllAgentStarting(): void {
  if (Object.keys($agentStartingSessions.get()).length === 0) {
    return
  }

  $agentStartingSessions.set({})
}
