/**
 * Model-facing notes a composer middleware appends to the user's words —
 * Bot Mode's "@assistant" handoff instructions. They must reach the model
 * but are noise in the user's own bubble, so the transcript shows the text
 * before the marker. The marker is part of the plugin contract (SDK export).
 */

export const HANDOFF_NOTE_MARKER = '\n\n[@mention handoff — '

/** The user's own words: everything before an appended handoff note. */
export function stripHandoffNote(text: string): string {
  const at = text.indexOf(HANDOFF_NOTE_MARKER)

  return at < 0 ? text : text.slice(0, at)
}
