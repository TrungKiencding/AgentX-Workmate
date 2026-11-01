// One look for every floating list — dropdown, context menu, select, the
// popover shell and the cmdk list (Quiet Tool spec §5.11). Elevation level 1:
// `--bg-raised` under `shadow-md`, whose own 1px --border-default ring is the
// edge, so no border here. 12px corners with 4px padding hold 8px items (the
// nesting rule). Opens in 160ms (fade + 4px rise), closes in 100ms.

/** Enter/exit motion shared by every popper surface. */
export const MENU_MOTION =
  'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:duration-(--dur-short) data-[state=open]:ease-(--ease-out) data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-(--dur-short-exit) data-[state=closed]:ease-(--ease-in) data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1'

/** The floating surface itself (add z-index, max-height and origin per primitive). */
export const MENU_SURFACE =
  'min-w-56 overflow-x-hidden overflow-y-auto overscroll-contain rounded-lg bg-(--bg-raised) p-1 text-base text-(--text-primary) shadow-md outline-hidden'

/**
 * A row: 36px, 8px corners, 18px glyph in the muted icon ink, 15px label.
 * Hover/keyboard focus paints --bg-hover; a destructive row reads in --danger.
 */
export const MENU_ITEM =
  "relative flex h-9 cursor-default items-center gap-2.5 rounded-md px-2.5 text-base text-(--text-primary) outline-hidden select-none focus:bg-(--bg-hover) data-[highlighted]:bg-(--bg-hover) data-[disabled]:pointer-events-none data-[disabled]:text-(--text-disabled) data-[inset]:pl-8 data-[variant=destructive]:text-(--danger) data-[variant=destructive]:focus:bg-(--danger-bg) [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4.5 [&_svg:not([class*='text-'])]:text-(--icon-muted) data-[variant=destructive]:*:[svg]:text-(--danger)!"

/** A sub-menu trigger also keeps its fill while its sub-menu is open. */
export const MENU_SUB_TRIGGER = `${MENU_ITEM} data-[state=open]:bg-(--bg-hover)`

/** Group heading — caption size, tertiary ink, never uppercase. */
export const MENU_LABEL = 'px-2 pt-2 pb-1 text-xs text-(--text-tertiary) data-[inset]:pl-8'

export const MENU_SEPARATOR = '-mx-1 my-1 h-px bg-(--border-subtle)'

/** Right-aligned keyboard hint, read as a caption. */
export const MENU_SHORTCUT = 'ml-auto pl-4 text-xs text-(--text-tertiary)'

/** The ✓ of a selected item: right-aligned, no fill change. */
export const MENU_INDICATOR = 'ml-auto flex items-center pl-2 text-(--text-primary)'
