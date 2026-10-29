// Shared chrome for the floating HUDs (command palette + session switcher),
// the spec's command-palette geometry (§5.12): centred, 20vh from the top,
// elevation level 2 (--bg-raised under shadow-nous, whose 1px ring is the
// edge), 16px corners. Each caller layers on its own z-index, width and
// overflow.
export const HUD_POSITION = 'fixed left-1/2 top-[20vh] -translate-x-1/2'

// `no-drag`: a HUD can overlap the titlebar's `[-webkit-app-region:drag]` band
// on a short window, which wins hit-testing over DOM regardless of z-index —
// without it the search input would swallow clicks.
export const HUD_SURFACE = 'rounded-(--radius-dialog) bg-(--bg-raised) shadow-nous [-webkit-app-region:no-drag]'

// One row/text size for both HUDs — text-body (15px). A palette is something
// you read at speed under a moving selection; it gets no discount.
export const HUD_TEXT = 'text-base'

// Shared item layout for both HUDs: a 36px row, the Linear/Raycast pitch — big
// enough to aim at, tight enough that a dozen fit on screen. A FLOOR, not a
// fixed height, so the two-line rows on the pet/theme sub-pages still grow.
// Overrides the `CommandItem` default.
export const HUD_ITEM = 'min-h-10 gap-2 px-2.5 py-1'

// Group headings (spec §5.12): a caption in tertiary ink, its own casing —
// plain text, no sticky chrome bar. Targets the cmdk group heading via the
// universal-descendant variant.
export const HUD_HEADING =
  '**:[[cmdk-group-heading]]:static **:[[cmdk-group-heading]]:bg-transparent **:[[cmdk-group-heading]]:px-2.5 **:[[cmdk-group-heading]]:pb-1 **:[[cmdk-group-heading]]:pt-2.5 **:[[cmdk-group-heading]]:text-xs **:[[cmdk-group-heading]]:text-(--text-tertiary)'

// A short note trailing a row's label — a version, a count, a live state. Sits
// closer than the row's icon-to-label `gap-2` because it reads as a suffix of
// the label, not as another item in the row.
export const HUD_NOTE = '-ml-1'

// `state` marks a note the row will CHANGE (a toggle's on/off) rather than a
// passive fact. It keeps the label's own color so the pair reads as one phrase,
// and earns its separation from a faint underline instead of going muted.
//
// That underline needs room, so `state` skips `truncate`: flex items are
// blockified, which makes its `overflow: hidden` bite, and the app's global
// 0.25rem underline offset (styles.css) already sits at the bottom edge of a
// `text-xs` line box — together they clip the rule away entirely. Pulling the
// offset to 2px keeps it inside the box; dropping truncate costs nothing
// because these notes are one word.
export const HUD_NOTE_VARIANT = {
  muted: 'truncate text-muted-foreground/80',
  state: 'shrink-0 underline decoration-current/50 underline-offset-2'
} as const
