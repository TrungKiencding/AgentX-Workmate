import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'
import * as React from 'react'

import { Loader2 } from '@/lib/icons'
import { cn } from '@/lib/utils'

// Text+icon actions underline the label on hover, not the glyph.
const TEXT_ACTION_ICON = '[&_.codicon]:no-underline [&_svg]:no-underline'

// Every boxed button shares the control radius and the control-height ramp
// (--control-h-*): sm 28 · md 32 (default) · lg 36 · xl 40. Boxless variants
// (text/link/inline/micro) stay padding-driven. Transitions name their
// properties — never transition-all — and press feedback is a 1px settle.
const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-(--radius-control) text-sm leading-4 font-medium whitespace-nowrap shadow-none transition-[background-color,border-color,color,box-shadow,transform] duration-(--dur-micro) outline-none focus-visible:border-ring focus-visible:ring-[0.1875rem] focus-visible:ring-ring/50 active:translate-y-px disabled:pointer-events-none disabled:cursor-default disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive:
          'bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40',
        // Quiet action — transparent fill with a 1.5px inset ring (no layout-shifting border).
        outline:
          'bg-transparent text-(--ui-text-primary) shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--ui-stroke-secondary)_50%,transparent)] hover:bg-(--chrome-action-hover) hover:text-(--ui-text-primary)',
        // Soft-fill action (the default "non-primary button" look).
        secondary:
          'bg-(--ui-bg-quaternary) text-(--ui-text-primary) hover:bg-(--chrome-action-hover) hover:text-(--ui-text-primary)',
        ghost: 'text-(--ui-text-secondary) hover:bg-(--chrome-action-hover) hover:text-(--ui-text-primary)',
        link: `text-primary underline-offset-4 decoration-current/20 hover:underline ${TEXT_ACTION_ICON}`,
        // Boxless inline-text action (no bg/border). Quiet by default — reads as
        // muted label text, underlines on hover (e.g. "Cancel", "Clear").
        text: `text-muted-foreground underline-offset-4 hover:text-foreground hover:underline ${TEXT_ACTION_ICON}`,
        // Emphasized inline-text action: bold + always-underlined link. Use for
        // the actionable affordance in a row ("Change", "Set", "Open logs", …).
        textStrong: `font-semibold text-muted-foreground underline underline-offset-4 hover:text-foreground ${TEXT_ACTION_ICON}`,
        // Pill affordance for an optional way in — the home surface's
        // quick-start row. Hairline at rest so the row stays quiet against the
        // greeting; the border firms up and the fill arrives on hover.
        chip: 'rounded-full border border-(--ui-stroke-tertiary) bg-transparent text-(--ui-text-secondary) hover:border-(--ui-stroke-secondary) hover:bg-(--chrome-action-hover) hover:text-(--ui-text-primary)'
      },
      size: {
        default: 'h-(--control-h-md) px-3.5 has-[>svg]:px-3',
        xs: "gap-1 px-2 py-0.5 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: 'h-(--control-h-sm) px-3 has-[>svg]:px-2.5',
        lg: 'h-(--control-h-lg) px-4 text-base has-[>svg]:px-3.5',
        // Hero CTA — onboarding, the primary action of a large dialog.
        xl: 'h-(--control-h-xl) px-5 text-base has-[>svg]:px-4',
        // Flush inline text action — no box padding/height. Pair with text/link
        // variants when the button must sit inline in a heading or sentence
        // (replaces ad-hoc `h-auto px-0 py-0` overrides).
        inline: 'h-auto gap-1 p-0 has-[>svg]:px-0',
        // Status-stack headers, table footers — 12px text actions beside a label.
        micro: "h-auto gap-0.5 px-1 py-0 text-xs font-normal has-[>svg]:px-0.5 [&_svg:not([class*='size-'])]:size-3",
        // Pairs with the `chip` variant: 36px pill at chrome text size, with a
        // little more air than a boxed button of the same height.
        chip: "h-(--control-h-lg) gap-2 rounded-full px-4 [&_svg:not([class*='size-'])]:size-4",
        icon: 'size-(--control-h-md)',
        'icon-xs': "size-6 [&_svg:not([class*='size-'])]:size-3",
        'icon-sm': 'size-(--control-h-sm)',
        'icon-lg': 'size-(--control-h-lg)',
        'icon-titlebar':
          'h-(--titlebar-control-height) w-(--titlebar-control-size) rounded-[4px] [&_.codicon]:text-base'
      }
    },
    compoundVariants: [
      // textStrong is a boxless link — size variants still inject px-*; strip
      // inline padding so the underline sits flush with the label.
      {
        variant: 'textStrong',
        class: 'px-0 has-[>svg]:px-0'
      },
      // OS window chrome stays inert: no press-settle on titlebar actions.
      {
        size: 'icon-titlebar',
        class: 'active:translate-y-0'
      }
    ],
    defaultVariants: {
      variant: 'default',
      size: 'default'
    }
  }
)

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  loading = false,
  disabled,
  children,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
    /**
     * Busy state: swaps the label for a centered spinner while keeping the
     * button's width (the label stays in the layout, invisible), so nothing
     * around it shifts. Ignored with `asChild` — a Slot must receive its
     * single child untouched.
     */
    loading?: boolean
  }) {
  const Comp = asChild ? Slot.Root : 'button'
  const spinning = loading && !asChild

  return (
    <Comp
      aria-busy={spinning || undefined}
      className={cn(buttonVariants({ variant, size }), spinning && 'relative', className)}
      data-size={size}
      data-slot="button"
      data-variant={variant}
      disabled={spinning ? true : disabled}
      {...props}
    >
      {spinning ? (
        <>
          <span aria-hidden className="invisible contents">
            {children}
          </span>
          <span className="absolute inset-0 grid place-items-center">
            <Loader2 className="animate-spin" />
          </span>
        </>
      ) : (
        children
      )}
    </Comp>
  )
}

export { Button, buttonVariants }
