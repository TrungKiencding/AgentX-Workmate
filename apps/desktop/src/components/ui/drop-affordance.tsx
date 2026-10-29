/**
 * Shared drag-and-drop visual language (spec §6.6 / §7 "Drag-over") — ONE
 * dashed sheet, used by every drop affordance (the composer file/session
 * overlay, the layout zone targets) so "you can drop here" reads identically
 * everywhere: a 2px dashed --border-strong edge on --bg-subtle. Flat — no blur.
 */
export const DROP_SHEET_CLASS = 'rounded-xl border-2 border-dashed border-(--border-strong) bg-(--bg-subtle)'
