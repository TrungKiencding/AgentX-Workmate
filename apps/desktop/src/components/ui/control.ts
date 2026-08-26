import { cva, type VariantProps } from 'class-variance-authority'

// Single source of truth for non-composer form-control chrome — Input,
// Textarea, and SelectTrigger all consume this. Mirrors `buttonVariants`:
// the shared control radius and the --control-h-* height ramp, so an input
// and a button on the same row are always the same height. The border is a
// fixed 1px in every state (focus arrives as an outline — no layout shift).
// The visual chrome (background, border tint, hover, focus outline, invalid
// state) comes from the `desktop-input-chrome` CSS so every control shares
// one exact look.
export const controlVariants = cva(
  'desktop-input-chrome w-full min-w-0 rounded-(--radius-control) border text-sm leading-4 text-foreground outline-none placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      size: {
        xs: 'px-2 py-0.5 text-xs',
        sm: 'h-(--control-h-sm) px-2.5',
        default: 'h-(--control-h-md) px-3',
        lg: 'h-(--control-h-lg) px-3.5 text-base'
      }
    },
    defaultVariants: {
      size: 'default'
    }
  }
)

export type ControlVariantProps = VariantProps<typeof controlVariants>
