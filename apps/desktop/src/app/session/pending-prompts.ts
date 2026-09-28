import type { RpcEvent, SessionPendingPrompt } from '@/types/hermes'

/**
 * Re-raise the questions a (re)attached session is blocked on.
 *
 * `clarify.request` / `sudo.request` / `secret.request` are one-shot events. A
 * window that was disconnected — or showing another chat whose runtime was not
 * bound to it — when one fired never rendered it: the sidebar says the chat is
 * waiting on the user, the transcript keeps "thinking", and the agent sits out
 * the whole prompt timeout before carrying on without an answer. The backend
 * hands the outstanding ones back on `session.activate` / `session.resume`;
 * this feeds them through the normal event path so every surface renders them
 * exactly as it would a live one. `replayed` tells the handler not to raise a
 * second OS notification for a question the user was already alerted to.
 */
export function replayPendingPrompts(
  runtimeId: string,
  prompts: readonly SessionPendingPrompt[] | undefined,
  dispatch: (event: RpcEvent) => void
): void {
  for (const prompt of prompts ?? []) {
    dispatch({ payload: { ...prompt.payload, replayed: true }, session_id: runtimeId, type: prompt.event })
  }
}
