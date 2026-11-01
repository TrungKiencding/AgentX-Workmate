import { Popover as PopoverPrimitive } from 'radix-ui'
import * as React from 'react'

import { usePopoverPortalContainer } from '@/components/ui/dialog-portal-context'
import { cn } from '@/lib/utils'

import { MENU_MOTION } from './menu-styles'

function Popover({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverAnchor({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />
}

function PopoverContent({
  align = 'center',
  // Keeps the arrow clear of the rounded corners (rounded-lg = 8px): Radix
  // clamps the arrow this far from each edge and shifts the popover to
  // compensate, so the arrow never jams into a corner on start/end alignment.
  children,
  className,
  collisionPadding = 8,
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  // Portal into the enclosing dialog when nested in one (keeps focus inside so
  // the dialog doesn't close on dismiss); document.body otherwise.
  const container = usePopoverPortalContainer()

  return (
    <PopoverPrimitive.Portal container={container}>
      <PopoverPrimitive.Content
        align={align}
        // Level-1 surface (spec §5.11), viewport-aware (Radix flips/shifts off
        // edges), the shared popper motion. No arrow — a quiet popover is
        // anchored by position, not by a pointer.
        className={cn(
          `z-50 w-72 origin-(--radix-popover-content-transform-origin) rounded-lg bg-(--bg-raised) p-3 text-(--text-primary) shadow-md outline-hidden ${MENU_MOTION}`,
          className
        )}
        collisionPadding={collisionPadding}
        data-slot="popover-content"
        sideOffset={sideOffset}
        {...props}
      >
        {children}
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  )
}

export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger }
