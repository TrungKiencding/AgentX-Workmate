import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'
import * as React from 'react'

import { Loader2 } from '@/lib/icons'
import { cn } from '@/lib/utils'

// Text+icon actions underline the label on hover, not the glyph.
const TEXT_ACTION_ICON = '[&_.codicon]:no-underline [&_svg]:no-underline'

// Quiet Tool buttons (spec §5.5). Every boxed button shares the 8px control
// radius and the --control-h-* ramp: sm 30 · md 36 (default) · lg 44. Labels
// are 15px (14px at sm), 500 only at lg. Width always follows the label —
// Vietnamese runs 20–35% longer than English, so never a fixed width.
// Transitions name their properties (never transition-all). Pressed is a fill
// (--bg-pressed), not a transform. Buttons keep the default arrow cursor; the
// keyboard ring comes from the app-wide :focus-visible rule in styles.css.
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-(--radius-control) text-base leading-5 font-normal whitespace-nowrap shadow-none transition-[background-color,border-color,color,opacity] duration-(--dur-micro) outline-none disabled:pointer-events-none disabled:text-(--text-disabled) aria-invalid:border-(--danger) [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4.5",
  {
    variants: {
      variant: {
        // Primary: the inverse fill on every skin — never the brand, never the
        // accent. One per context, rightmost in its group.
        default:
          'bg-(--bg-inverse) text-(--text-inverse) hover:opacity-88 active:opacity-80 disabled:bg-(--bg-pressed) disabled:opacity-100',
        // The final confirm of an irreversible action: danger fill, white label.
        destructive: 'bg-(--dt-destructive) text-(--dt-destructive-foreground) hover:opacity-88 active:opacity-80',
        // Secondary: transparent with a hairline — Cancel, the alternative path.
        outline:
          'border border-(--border-default) bg-transparent text-(--text-primary) hover:bg-(--bg-hover) active:bg-(--bg-pressed)',
        // Kept as the same hairline secondary (call sites predate the spec's
        // single secondary look).
        secondary:
          'border border-(--border-default) bg-transparent text-(--text-primary) hover:bg-(--bg-hover) active:bg-(--bg-pressed)',
        // Ghost: no fill, no border — icon buttons and quiet actions.
        ghost: 'text-(--text-secondary) hover:bg-(--bg-hover) hover:text-(--text-primary) active:bg-(--bg-pressed)',
        // Link: accent text, no underline until hover.
        link: `text-(--accent) underline-offset-4 decoration-current/40 hover:text-(--accent-hover) hover:underline ${TEXT_ACTION_ICON}`,
        // Boxless inline-text action ("Hủy", "Xoá bộ lọc") — secondary ink.
        text: `text-(--text-secondary) underline-offset-4 hover:text-(--text-primary) hover:underline ${TEXT_ACTION_ICON}`,
        // Emphasized inline-text action: the actionable word in a row ("Đổi", "Mở log").
        textStrong: `font-medium text-(--text-primary) underline underline-offset-4 decoration-(--border-strong) hover:decoration-current ${TEXT_ACTION_ICON}`,
        // Inline control (spec §5.5): meta text + 16px glyph, the frame shows on
        // hover only — context-bar items, in-row pickers, "Thêm" chips.
        chip: 'rounded-(--radius-control) text-sm text-(--text-secondary) hover:bg-(--bg-hover) hover:text-(--text-primary) active:bg-(--bg-pressed)',
        // An interactive card (spec §5.10): a flat hairline tile whose border
        // firms to --border-strong on hover — never a lift, never a shadow.
        card: 'rounded-(--radius-card) border border-(--border-default) bg-(--bg-app) text-(--text-primary) hover:border-(--border-strong) active:bg-(--bg-subtle)'
      },
      size: {
        default: 'h-(--control-h-md) px-3.5 has-[>svg]:px-3',
        xs: "h-6 gap-1 px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        sm: 'h-(--control-h-sm) px-2.5 text-sm has-[>svg]:px-2',
        lg: "h-(--control-h-lg) px-4.5 font-medium has-[>svg]:px-4 [&_svg:not([class*='size-'])]:size-4.5",
        // Alias of lg — the spec ramp tops out at 40px.
        xl: "h-(--control-h-xl) px-4.5 font-medium has-[>svg]:px-4 [&_svg:not([class*='size-'])]:size-4.5",
        // Flush inline text action — no box padding/height. Pair with text/link
        // variants when the button must sit inline in a heading or sentence.
        inline: 'h-auto gap-1 p-0 has-[>svg]:px-0',
        // Status-stack headers, table footers — 12px text actions beside a label.
        micro: "h-auto gap-1 px-1 py-0 text-xs has-[>svg]:px-0.5 [&_svg:not([class*='size-'])]:size-3.5",
        // Pairs with the `chip` variant: the inline control's 4×8 box.
        chip: 'h-7 gap-1.5 px-2',
        // Pairs with the `card` variant: a padded, left-aligned tile whose
        // leading glyph is the list icon size (18px).
        card: "h-auto min-h-(--intro-card-min-height) items-center justify-start gap-2.5 px-4 py-3 text-left whitespace-normal [&_svg:not([class*='size-'])]:size-4.5",
        icon: "size-(--control-h-md) [&_svg:not([class*='size-'])]:size-5",
        'icon-xs': "size-6 [&_svg:not([class*='size-'])]:size-3.5",
        'icon-sm': 'size-(--control-h-sm)',
        'icon-lg': "size-(--control-h-lg) [&_svg:not([class*='size-'])]:size-5",
        'icon-titlebar':
          'h-(--titlebar-control-height) w-(--titlebar-control-size) rounded-(--radius-control) [&_.codicon]:text-base'
      }
    },
    compoundVariants: [
      // textStrong is a boxless link — size variants still inject px-*; strip
      // inline padding so the underline sits flush with the label.
      {
        variant: 'textStrong',
        class: 'px-0 has-[>svg]:px-0'
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
            <Loader2 className="size-4 animate-spin" />
          </span>
        </>
      ) : (
        children
      )}
    </Comp>
  )
}

export { Button, buttonVariants }
