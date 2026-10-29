import { ContextMenu as ContextMenuPrimitive } from 'radix-ui'
import * as React from 'react'

import { Check, ChevronRight } from '@/lib/icons'
import { cn } from '@/lib/utils'

import {
  MENU_INDICATOR,
  MENU_ITEM,
  MENU_LABEL,
  MENU_MOTION,
  MENU_SEPARATOR,
  MENU_SUB_TRIGGER,
  MENU_SURFACE
} from './menu-styles'

function ContextMenu({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Root>) {
  return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />
}

function ContextMenuPortal({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Portal>) {
  return <ContextMenuPrimitive.Portal data-slot="context-menu-portal" {...props} />
}

function ContextMenuTrigger({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Trigger>) {
  return <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />
}

function ContextMenuGroup({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Group>) {
  return <ContextMenuPrimitive.Group data-slot="context-menu-group" {...props} />
}

function ContextMenuContent({ className, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Content>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        className={cn(
          `z-50 max-h-[min(60vh,var(--radix-context-menu-content-available-height))] origin-(--radix-context-menu-content-transform-origin) ${MENU_SURFACE} ${MENU_MOTION}`,
          className
        )}
        data-slot="context-menu-content"
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  )
}

function ContextMenuItem({
  className,
  inset,
  variant = 'default',
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item> & {
  inset?: boolean
  variant?: 'default' | 'destructive'
}) {
  return (
    <ContextMenuPrimitive.Item
      className={cn(
        MENU_ITEM,
        className
      )}
      data-inset={inset}
      data-slot="context-menu-item"
      data-variant={variant}
      {...props}
    />
  )
}

function ContextMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.CheckboxItem>) {
  return (
    <ContextMenuPrimitive.CheckboxItem
      checked={checked}
      className={cn(
        MENU_ITEM,
        className
      )}
      data-slot="context-menu-checkbox-item"
      {...props}
    >
      {children}
      <ContextMenuPrimitive.ItemIndicator className={MENU_INDICATOR}>
        <Check className="size-4" />
      </ContextMenuPrimitive.ItemIndicator>
    </ContextMenuPrimitive.CheckboxItem>
  )
}

function ContextMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Label> & {
  inset?: boolean
}) {
  return (
    <ContextMenuPrimitive.Label
      className={cn(MENU_LABEL, className)}
      data-inset={inset}
      data-slot="context-menu-label"
      {...props}
    />
  )
}

function ContextMenuSeparator({ className, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Separator>) {
  return (
    <ContextMenuPrimitive.Separator
      className={cn(MENU_SEPARATOR, className)}
      data-slot="context-menu-separator"
      {...props}
    />
  )
}

function ContextMenuSub({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Sub>) {
  return <ContextMenuPrimitive.Sub data-slot="context-menu-sub" {...props} />
}

function ContextMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubTrigger> & {
  inset?: boolean
}) {
  return (
    <ContextMenuPrimitive.SubTrigger
      className={cn(
        MENU_SUB_TRIGGER,
        className
      )}
      data-inset={inset}
      data-slot="context-menu-sub-trigger"
      {...props}
    >
      {children}
      <ChevronRight className="ml-auto size-4 text-(--icon-muted)" />
    </ContextMenuPrimitive.SubTrigger>
  )
}

function ContextMenuSubContent({
  className,
  collisionPadding = 8,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubContent>) {
  return (
    // Portal the submenu out of the parent Content so it escapes that Content's
    // `overflow` clip — without this a submenu opening from a scrollable /
    // overflow-hidden menu gets visually cut off at the parent's edges. Radix
    // Popper still anchors it to the SubTrigger, so portaling is safe. Mirrors
    // DropdownMenuSubContent.
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.SubContent
        className={cn(
          // `max-h-80` (not the Radix available-height var, which is published
          // only on Content) so a long submenu scrolls instead of collapsing.
          `dt-portal-scrollbar z-50 max-h-[60vh] origin-(--radix-context-menu-content-transform-origin) ${MENU_SURFACE} ${MENU_MOTION}`,
          className
        )}
        collisionPadding={collisionPadding}
        data-slot="context-menu-sub-content"
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  )
}

export {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuPortal,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
}
