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
export const dropdownMenuRow = 'h-9 gap-2.5 rounded-none px-3 text-base'
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

// A stepped slider that lives INSIDE a menu (the composer's thinking level):
// a track with one notch per option and a thumb on the chosen one. Built from
// Radix radio items, because a menu blocks Tab — plain inputs in a menu are
// unreachable from the keyboard. Keyboard model, like a slider sitting in a
// list: the whole slider is ONE stop in the ↑/↓ order (arriving lands on the
// thumb, ↑/↓ leave), ←/→ (mirrored in RTL) step the value, Enter/Space pick
// the focused notch. Pointer: press anywhere on the track and drag.
const STEP_SELECTOR = '[data-slot="dropdown-menu-step"]:not([data-disabled])'

/** The colour at `t` (0…1) along evenly spaced `colors` — what the track's
 *  gradient paints at that point, so the thumb (and anything echoing it) can
 *  wear the exact colour under it. Mixed in OKLab so mid-points stay vivid. */
export function colorAlongSteps(colors: readonly string[], t: number): string {
  if (colors.length < 2) {
    return colors[0] ?? 'var(--accent)'
  }

  const at = Math.min(Math.max(t, 0), 1) * (colors.length - 1)
  const from = Math.min(Math.floor(at), colors.length - 2)
  const share = Math.round((1 - (at - from)) * 100)

  return `color-mix(in oklab, ${colors[from]} ${share}%, ${colors[from + 1]})`
}

export interface DropdownMenuStepOption {
  /** Accessible name of the notch (the slider shows the value elsewhere). */
  label: string
  value: string
}

/** The next/previous enabled menu item OUTSIDE `group`, in document order. */
function menuItemBeyond(group: HTMLElement, direction: 'next' | 'previous'): HTMLElement | undefined {
  const menu = group.closest('[role="menu"]')

  if (!menu) {
    return undefined
  }

  const position = direction === 'next' ? Node.DOCUMENT_POSITION_FOLLOWING : Node.DOCUMENT_POSITION_PRECEDING

  const items = [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([data-disabled])')].filter(
    item => !group.contains(item) && group.compareDocumentPosition(item) & position
  )

  return direction === 'next' ? items[0] : items.at(-1)
}

function DropdownMenuStepSlider({
  className,
  colors = ['var(--accent)'],
  onValueChange,
  options,
  value,
  ...props
}: Omit<React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>, 'children' | 'onValueChange' | 'value'> & {
  /** The filled run's colours, start → end (a gradient when more than one);
   *  the thumb takes the colour under it. */
  colors?: readonly string[]
  onValueChange: (value: string) => void
  options: readonly DropdownMenuStepOption[]
  value: string
}) {
  const trackRef = React.useRef<HTMLDivElement>(null)
  const dragging = React.useRef(false)
  const selected = options.findIndex(option => option.value === value)
  const last = Math.max(options.length - 1, 1)
  const at = (index: number) => `${(index / last) * 100}%`
  const thumbColor = colorAlongSteps(colors, Math.max(selected, 0) / last)

  // The notch nearest the pointer, along the track (mirrored in RTL).
  const pickAt = (clientX: number) => {
    const track = trackRef.current
    const rect = track?.getBoundingClientRect()

    if (!track || !rect || rect.width === 0) {
      return
    }

    const rtl = getComputedStyle(track).direction === 'rtl'
    const ratio = Math.min(Math.max((rtl ? rect.right - clientX : clientX - rect.left) / rect.width, 0), 1)
    const option = options[Math.round(ratio * last)]

    if (option && option.value !== value) {
      onValueChange(option.value)
    }
  }

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = false

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  return (
    <DropdownMenuPrimitive.RadioGroup
      className={cn('group/slider touch-none px-2.5 select-none', className)}
      data-slot="dropdown-menu-step-slider"
      onKeyDown={event => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
          return
        }

        const steps = [...event.currentTarget.querySelectorAll<HTMLElement>(STEP_SELECTOR)]
        const from = steps.indexOf(event.target as HTMLElement)

        if (from < 0) {
          return
        }

        event.preventDefault()

        const rtl = getComputedStyle(event.currentTarget).direction === 'rtl'
        const next = steps[from + ((event.key === 'ArrowRight') !== rtl ? 1 : -1)]

        if (!next) {
          return
        }

        next.focus()

        if (next.dataset.value !== undefined) {
          onValueChange(next.dataset.value)
        }
      }}
      // Capture phase: Radix's roving focus would otherwise walk ↑/↓ through
      // every notch, one by one, before ever leaving the slider.
      onKeyDownCapture={event => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
          return
        }

        event.preventDefault()
        event.stopPropagation()
        menuItemBeyond(event.currentTarget, event.key === 'ArrowDown' ? 'next' : 'previous')?.focus()
      }}
      onPointerCancel={endDrag}
      onPointerDown={event => {
        if (event.button !== 0) {
          return
        }

        dragging.current = true
        event.currentTarget.setPointerCapture(event.pointerId)
        pickAt(event.clientX)
      }}
      onPointerMove={event => {
        if (dragging.current) {
          pickAt(event.clientX)
        }
      }}
      onPointerUp={endDrag}
      onValueChange={onValueChange}
      value={value}
      {...props}
    >
      <div className="relative h-7" ref={trackRef}>
        {/* Two layers: the full gradient, and a grey cover sliding off it from
            the thumb onward — so the colour under any point never changes,
            the run just reveals more of it. The bar runs a few px past the
            end notches, so the first and last stops sit ON the track. */}
        <div
          className="absolute -inset-x-1 top-1/2 h-1.5 -translate-y-1/2 rounded-full rtl:-scale-x-100"
          style={{
            backgroundImage: `linear-gradient(to right, ${(colors.length > 1 ? colors : [colors[0], colors[0]]).join(', ')})`
          }}
        />
        <div
          className="absolute -end-1 top-1/2 h-1.5 -translate-y-1/2 rounded-e-full bg-(--border-default) transition-[inset-inline-start] duration-(--dur-long) ease-(--ease-out) motion-reduce:transition-none"
          style={{ insetInlineStart: at(Math.max(selected, 0)) }}
        />
        {options.map((option, index) => (
          <DropdownMenuPrimitive.RadioItem
            aria-label={option.label}
            className="group/step absolute top-1/2 grid size-7 -translate-x-1/2 -translate-y-1/2 cursor-default place-items-center rounded-full outline-hidden rtl:translate-x-1/2"
            data-slot="dropdown-menu-step"
            data-value={option.value}
            key={option.value}
            onFocus={event => {
              const group = event.currentTarget.closest<HTMLElement>('[data-slot="dropdown-menu-step-slider"]')
              const from = event.relatedTarget

              // Arriving from outside by KEYBOARD lands on the thumb, the way
              // Tab lands on a radio group's checked radio. Hover focuses the
              // notch under the pointer as usual (it has a pointer to blame).
              if (
                !group ||
                event.currentTarget.dataset.state === 'checked' ||
                (from instanceof Node && group.contains(from)) ||
                group.matches(':hover')
              ) {
                return
              }

              group.querySelector<HTMLElement>(`${STEP_SELECTOR}[data-state="checked"]`)?.focus()
            }}
            // A notch is a setting you adjust while looking at the menu, not a
            // command: picking it never closes the menu.
            onSelect={event => event.preventDefault()}
            style={{ insetInlineStart: at(index) }}
            value={option.value}
          >
            {/* Notches: a pinprick of surface inside the coloured run, a darker
                tick past it; the one under the pointer or keyboard grows. The
                chosen notch hides under the thumb. */}
            <span
              className={cn(
                'block rounded-full transition-[width,height,background-color] duration-(--dur-micro) ease-(--ease-out)',
                index === selected
                  ? 'size-0'
                  : index < selected
                    ? 'size-1 bg-(--bg-raised)/85 group-data-[highlighted]/step:size-2'
                    : 'size-1.5 bg-(--border-strong) group-data-[highlighted]/step:size-2.5 group-data-[highlighted]/step:bg-(--text-tertiary)'
              )}
            />
          </DropdownMenuPrimitive.RadioItem>
        ))}
        {/* The thumb is its own layer so it GLIDES between notches (and takes
            the colour under it on the way) instead of blinking from one to the
            next. Hover or focus wraps it in a soft halo of that colour; a
            press squeezes it slightly. */}
        <span
          aria-hidden
          className="pointer-events-none absolute top-1/2 size-[1.125rem] -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] bg-(--bg-app) shadow-sm transition-[inset-inline-start,border-color,box-shadow,scale] duration-(--dur-long) ease-(--ease-out) group-focus-within/slider:shadow-[0_0_0_5px_var(--thumb-halo)] group-hover/slider:shadow-[0_0_0_5px_var(--thumb-halo)] group-active/slider:scale-90 motion-reduce:transition-none rtl:translate-x-1/2"
          style={
            {
              '--thumb-halo': `color-mix(in srgb, ${thumbColor} 22%, transparent)`,
              borderColor: thumbColor,
              insetInlineStart: at(Math.max(selected, 0))
            } as React.CSSProperties
          }
        />
      </div>
    </DropdownMenuPrimitive.RadioGroup>
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
  DropdownMenuStepSlider,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
}
