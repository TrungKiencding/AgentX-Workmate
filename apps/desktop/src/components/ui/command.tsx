import { Command as CommandPrimitive } from 'cmdk'
import * as React from 'react'

import { usePointerQuiet } from '@/components/ui/keyboard-first'
import { SearchIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'

function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      className={cn(
        'flex h-full w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground',
        className
      )}
      data-slot="command"
      {...props}
    />
  )
}

interface CommandInputProps extends React.ComponentProps<typeof CommandPrimitive.Input> {
  /** Inline trailing slot, rendered on the right of the search row. */
  right?: React.ReactNode
}

function CommandInput({ className, right, ...props }: CommandInputProps) {
  return (
    <div className="flex h-11 items-center gap-2 border-b border-border px-3" data-slot="command-input-wrapper">
      <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
      <CommandPrimitive.Input
        className={cn(
          'flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
          className
        )}
        data-slot="command-input"
        {...props}
      />
      {right}
    </div>
  )
}

/**
 * The sliding selection highlight for a command list — one element that moves to
 * whatever row is currently selected, instead of each row painting its own
 * background. Drop it inside a `CommandList` whose rows opt out of
 * `data-[selected=true]:bg-accent`.
 *
 * It never touches React state: a MutationObserver on the list's
 * `data-selected` attribute moves the element imperatively, so arrowing through
 * a hundred rows re-renders nothing. Selection itself is unaffected — this is a
 * paint that follows the state, and the global reduced-motion rule collapses
 * the slide to an instant move.
 */
function CommandSelectionIndicator({ className }: { className?: string }) {
  const ref = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const node = ref.current
    const list = node?.closest<HTMLElement>('[data-slot="command-list"]')

    if (!node || !list) {
      return
    }

    let frame = 0

    const place = () => {
      frame = 0

      const row = list.querySelector<HTMLElement>('[data-slot="command-item"][data-selected="true"]')

      if (!row) {
        node.style.opacity = '0'

        return
      }

      // Measured against the list box (plus its scroll offset) rather than
      // offsetTop, so an extra wrapper or a positioned group can't shift it.
      const listBox = list.getBoundingClientRect()
      const rowBox = row.getBoundingClientRect()

      node.style.height = `${rowBox.height}px`
      node.style.width = `${rowBox.width}px`
      node.style.transform = `translate3d(${rowBox.left - listBox.left + list.scrollLeft}px, ${rowBox.top - listBox.top + list.scrollTop}px, 0)`
      node.style.opacity = '1'
    }

    // Coalesce a burst of attribute flips (cmdk clears the old row and marks
    // the new one) into a single placement per frame.
    const schedule = () => {
      frame ||= requestAnimationFrame(place)
    }

    place()

    const observer = new MutationObserver(schedule)
    observer.observe(list, { attributeFilter: ['data-selected'], attributes: true, childList: true, subtree: true })
    list.addEventListener('scroll', schedule, { passive: true })

    return () => {
      observer.disconnect()
      list.removeEventListener('scroll', schedule)

      if (frame) {
        cancelAnimationFrame(frame)
      }
    }
  }, [])

  return (
    <div
      aria-hidden
      className={cn(
        // No z-index: it is the list's FIRST child, so the positioned rows after
        // it paint on top in DOM order. A negative z would drop it behind the
        // HUD surface and disappear.
        'pointer-events-none absolute left-0 top-0 rounded-(--radius-control) bg-accent opacity-0 transition-[transform,opacity] duration-(--dur-micro) ease-out',
        className
      )}
      data-slot="command-selection-indicator"
      ref={ref}
    />
  )
}

function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
  // cmdk selects on pointer-enter, so a list that opens under a parked cursor —
  // or re-flows under one as the query narrows — hands the selection to
  // whatever row slid beneath the mouse, and Enter commits THAT. Inert until
  // the pointer actually moves (see usePointerQuiet).
  const pointerQuiet = usePointerQuiet()

  return (
    <CommandPrimitive.List
      className={cn(
        // `relative` + a positioned sizer: the containing block for
        // CommandSelectionIndicator, which measures against this box.
        'relative max-h-100 overflow-y-auto overflow-x-hidden [&_[cmdk-list-sizer]]:relative',
        pointerQuiet && 'pointer-events-none',
        className
      )}
      data-slot="command-list"
      {...props}
    />
  )
}

function CommandEmpty({ ...props }: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      className="py-6 text-center text-sm text-muted-foreground"
      data-slot="command-empty"
      {...props}
    />
  )
}

function CommandGroup({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      className={cn(
        'overflow-hidden p-1 text-foreground **:[[cmdk-group-heading]]:sticky **:[[cmdk-group-heading]]:top-0 **:[[cmdk-group-heading]]:z-10 **:[[cmdk-group-heading]]:bg-popover **:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:py-1.5 **:[[cmdk-group-heading]]:text-xs **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:text-muted-foreground',
        className
      )}
      data-slot="command-group"
      {...props}
    />
  )
}

function CommandSeparator({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      className={cn('-mx-1 h-px bg-border', className)}
      data-slot="command-separator"
      {...props}
    />
  )
}

function CommandItem({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      className={cn(
        'relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[disabled=true]:pointer-events-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:opacity-50',
        className
      )}
      data-slot="command-item"
      {...props}
    />
  )
}

function CommandShortcut({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      className={cn('ml-auto text-xs tracking-widest text-muted-foreground', className)}
      data-slot="command-shortcut"
      {...props}
    />
  )
}

export {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSelectionIndicator,
  CommandSeparator,
  CommandShortcut
}
