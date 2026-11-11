/**
 * Text AgentX writes into a *user* turn that the person never typed.
 *
 * The cron scheduler opens every job prompt with one bracketed paragraph of
 * delivery guidance; a live model switch is stored as a user-role bookkeeping
 * row. Shown raw they read as the plumbing — the Trợ lý page listed a run as
 * "[IMPORTANT: You are running as a scheduled cron job. DELIVER…" and opening
 * it put the whole paragraph in the user's bubble (pilot feedback 2026-11-10).
 *
 * Mirrors `strip_internal_preamble` in hermes_state_common.py; the prefixes
 * are the ones in hermes_constants.py.
 */

export const CRON_HINT_PREFIX = '[IMPORTANT: You are running as a scheduled cron job. '
export const MODEL_SWITCH_MARKER_PREFIX = '[System: The active model for this chat has changed to '

// The hint is closed by "]" and a blank line; the task follows.
const CRON_HINT_END = ']\n\n'

/** A flattened preview has lost the blank line; there the hint ends at the
 *  sentence the scheduler closes it with. */
const CRON_HINT_FLAT_END = /nothing more\.\]\s*/

/** Was this user turn written by the scheduler, not a person? */
export function isCronPrompt(text: null | string | undefined): boolean {
  return (text ?? '').trimStart().startsWith(CRON_HINT_PREFIX)
}

/**
 * `text` without AgentX's own preamble — what the person actually asked for.
 * The cron hint is cut off the front (leaving the task); a model-switch marker
 * is not a message at all and yields ''. A hint cut off mid-way (a truncated
 * preview) yields '' too: nothing of the task is in hand.
 */
export function stripInternalPreamble(text: null | string | undefined): string {
  const value = text ?? ''
  const trimmed = value.trimStart()

  if (trimmed.startsWith(MODEL_SWITCH_MARKER_PREFIX)) {
    return ''
  }

  if (!trimmed.startsWith(CRON_HINT_PREFIX)) {
    return value
  }

  const end = trimmed.indexOf(CRON_HINT_END)

  if (end >= 0) {
    return trimmed.slice(end + CRON_HINT_END.length).trimStart()
  }

  const flat = CRON_HINT_FLAT_END.exec(trimmed)

  return flat ? trimmed.slice(flat.index + flat[0].length) : ''
}
