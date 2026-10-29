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
  'desktop-input-chrome w-full min-w-0 rounded-(--radius-control) border text-base leading-5 text-(--text-primary) outline-none placeholder:text-(--text-tertiary) disabled:pointer-events-none disabled:cursor-not-allowed disabled:text-(--text-disabled)',
  {
    // Spec §5.6: 32px (lg 40px), 10px inline padding, 14px text.
    variants: {
      size: {
        xs: 'h-6 px-2 text-xs',
        sm: 'h-(--control-h-sm) px-2.5 text-sm',
        default: 'h-(--control-h-md) px-2.5',
        lg: 'h-(--control-h-lg) px-3'
      }
    },
    defaultVariants: {
      size: 'default'
    }
  }
)

export type ControlVariantProps = VariantProps<typeof controlVariants>
