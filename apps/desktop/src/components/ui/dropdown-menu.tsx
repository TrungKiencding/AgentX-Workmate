import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui'
import * as React from 'react'

import { usePopoverPortalContainer } from '@/components/ui/dialog-portal-context'
import { Check, ChevronRight } from '@/lib/icons'
import { cn } from '@/lib/utils'

import {
  MENU_INDICATOR,
  MENU_ITEM,
  MENU_LABEL,
  MENU_MOTION,
  MENU_SEPARATOR,
  MENU_SHORTCUT,
  MENU_SUB_TRIGGER,
  MENU_SURFACE
} from './menu-styles'

// Shared class tokens for edge-to-edge menus (use with `p-0` content): rows go
// full-width, square, and compact so the highlight spans the whole surface.
// Reuse these instead of re-deriving per menu so every searchable/compact menu
// reads identically.
export const dropdownMenuRow = 'h-8 gap-2 rounded-none px-3 text-base'
export const dropdownMenuSectionLabel = 'px-3 pt-2 pb-1 text-xs text-(--text-tertiary)'

// Keys that must reach Radix's menu handler (navigation/close). Everything else
// is a filter keystroke and is stopped so the menu's typeahead doesn't hijack it.
const DROPDOWN_NAV_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'Tab'])

function DropdownMenu({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />
}

function DropdownMenuPortal({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Portal>) {
  return <DropdownMenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />
}

function DropdownMenuTrigger({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />
}

/**
 * Borderless filter input for a searchable dropdown. Autofocuses, keeps the
 * menu's typeahead from eating keystrokes, and still lets arrow/enter/escape
 * drive the list. Drop it in as the first child of a `DropdownMenuContent`.
 */
function DropdownMenuSearch({
  className,
  onChange,
  onKeyDown,
  onValueChange,
  ...props
}: Omit<React.ComponentProps<'input'>, 'type'> & {
  onValueChange?: (value: string) => void
}) {
  return (
    <div className="-mx-1 -mt-1 mb-1 border-b border-(--border-subtle) px-3 py-2" data-slot="dropdown-menu-search">
      <input
        autoFocus
        className={cn(
          'h-5 w-full bg-transparent text-base text-(--text-primary) placeholder:text-(--text-tertiary) focus:outline-none',
          className
        )}
        onChange={event => {
          onChange?.(event)
          onValueChange?.(event.target.value)
        }}
        onKeyDown={event => {
          if (!DROPDOWN_NAV_KEYS.has(event.key)) {
            event.stopPropagation()
          }

          onKeyDown?.(event)
        }}
        type="text"
        {...props}
      />
    </div>
  )
}

function DropdownMenuContent({
  className,
  collisionPadding = 8,
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  // Portal into the enclosing dialog when nested in one, so dismissing the menu
  // doesn't close the dialog; document.body otherwise.
  const container = usePopoverPortalContainer()

  return (
    <DropdownMenuPrimitive.Portal container={container}>
      <DropdownMenuPrimitive.Content
        // `dt-portal-scrollbar` reproduces the thin themed scrollbar from
        // `.scrollbar-dt` for portaled overlays (Radix renders this under
        // document.body, outside #root's scope). See styles.css.
        className={cn(
          `dt-portal-scrollbar z-50 max-h-[min(60vh,var(--radix-dropdown-menu-content-available-height))] origin-(--radix-dropdown-menu-content-transform-origin) ${MENU_SURFACE} ${MENU_MOTION}`,
          className
        )}
        // Keep the menu inside the viewport: Radix flips/shifts away from edges
        // (avoidCollisions defaults on); the padding stops it kissing the edge.
        collisionPadding={collisionPadding}
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  )
}

function DropdownMenuGroup({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Group>) {
  return <DropdownMenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />
}

function DropdownMenuItem({
  className,
  inset,
  variant = 'default',
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  inset?: boolean
  variant?: 'default' | 'destructive'
}) {
  return (
    <DropdownMenuPrimitive.Item
      className={cn(MENU_ITEM, className)}
      data-inset={inset}
      data-slot="dropdown-menu-item"
      data-variant={variant}
      {...props}
    />
  )
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      checked={checked}
      className={cn(MENU_ITEM, className)}
      data-slot="dropdown-menu-checkbox-item"
      {...props}
    >
      {children}
      <DropdownMenuPrimitive.ItemIndicator className={MENU_INDICATOR}>
        <Check className="size-4" />
      </DropdownMenuPrimitive.ItemIndicator>
    </DropdownMenuPrimitive.CheckboxItem>
  )
}

function DropdownMenuRadioGroup({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>) {
  return <DropdownMenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />
}

function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem
      className={cn(MENU_ITEM, className)}
      data-slot="dropdown-menu-radio-item"
      {...props}
    >
      {children}
      <DropdownMenuPrimitive.ItemIndicator className={MENU_INDICATOR}>
        <Check className="size-4" />
      </DropdownMenuPrimitive.ItemIndicator>
    </DropdownMenuPrimitive.RadioItem>
  )
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label> & {
  inset?: boolean
}) {
  return (
    <DropdownMenuPrimitive.Label
      className={cn(MENU_LABEL, className)}
      data-inset={inset}
      data-slot="dropdown-menu-label"
      {...props}
    />
  )
}

function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      className={cn(MENU_SEPARATOR, className)}
      data-slot="dropdown-menu-separator"
      {...props}
    />
  )
}

function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<'span'>) {
  return <span className={cn(MENU_SHORTCUT, className)} data-slot="dropdown-menu-shortcut" {...props} />
}

function DropdownMenuSub({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Sub>) {
  return <DropdownMenuPrimitive.Sub data-slot="dropdown-menu-sub" {...props} />
}

function DropdownMenuSubTrigger({
  className,
  inset,
  hideChevron = false,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger> & {
  inset?: boolean
  /** Suppress the trailing caret — for triggers that own their right-side affordance. */
  hideChevron?: boolean
}) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      className={cn(MENU_SUB_TRIGGER, className)}
      data-inset={inset}
      data-slot="dropdown-menu-sub-trigger"
      {...props}
    >
      {children}
      {!hideChevron && <ChevronRight className="ml-auto size-4 text-(--icon-muted)" />}
    </DropdownMenuPrimitive.SubTrigger>
  )
}

function DropdownMenuSubContent({
  className,
  collisionPadding = 8,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  return (
    // Portal the submenu out of the parent Content so it escapes that Content's
    // `overflow` clip. Without this, a submenu opening from a scrollable menu
    // gets visually cut off at the parent's edges. Radix Popper still anchors
    // it to the SubTrigger and handles collision/flip, so portaling is safe.
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.SubContent
        // `dt-portal-scrollbar` reproduces the themed scrollbar for portaled
        // overlays (rendered under document.body). Use a fixed `max-h-80`
        // rather than the Radix available-height variable: that variable is
        // only published on Content, NOT SubContent — using it here collapses
        // the submenu to 0px height.
        className={cn(
          `dt-portal-scrollbar z-50 max-h-[60vh] origin-(--radix-dropdown-menu-content-transform-origin) ${MENU_SURFACE} ${MENU_MOTION}`,
          className
        )}
        // Flip to the other side / shift vertically when near a viewport edge
        // (e.g. the status bar menu opening from the bottom-right corner) so
        // the submenu never gets clipped.
        collisionPadding={collisionPadding}
        data-slot="dropdown-menu-sub-content"
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  )
}

export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSearch,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
}
