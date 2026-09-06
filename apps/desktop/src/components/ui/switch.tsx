import { cva, type VariantProps } from 'class-variance-authority'
import { Switch as SwitchPrimitive } from 'radix-ui'
import * as React from 'react'

import { cn } from '@/lib/utils'

// The visual track stays compact; an invisible ::after pad extends the hit
// target to ≥ 24px on every size so the toggle is comfortable to click.
// `md` (22×38, 18px thumb — tokens in styles.css) is the default for the
// enable/disable rows of a page; `xs` stays for menus and dense rows.
const switchVariants = cva(
  "peer relative inline-flex shrink-0 items-center rounded-full border border-[color-mix(in_srgb,var(--dt-foreground)_18%,transparent)] bg-[color-mix(in_srgb,var(--dt-background)_58%,var(--dt-input))] shadow-[inset_0_0_0_0.0625rem_color-mix(in_srgb,var(--dt-foreground)_8%,transparent)] transition-colors outline-none after:absolute after:-inset-x-1 after:-inset-y-1 after:content-[''] focus-visible:border-ring focus-visible:ring-[0.1875rem] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-transparent data-[state=checked]:bg-primary",
  {
    variants: {
      size: {
        default: 'h-5 w-9',
        md: 'h-(--switch-md-track-height) w-(--switch-md-track-width)',
        xs: 'h-4 w-7'
      }
    },
    defaultVariants: {
      size: 'default'
    }
  }
)

const switchThumbVariants = cva(
  'pointer-events-none block rounded-full bg-foreground shadow-[0_0.0625rem_0.1875rem_color-mix(in_srgb,var(--dt-background)_50%,transparent)] ring-0 transition-transform data-[state=unchecked]:translate-x-0 data-[state=checked]:bg-background',
  {
    variants: {
      size: {
        default: 'size-4 data-[state=checked]:translate-x-4',
        // Track 38 − 2px border − 18px thumb = an 18px throw, i.e. one thumb width.
        md: 'size-(--switch-md-thumb) data-[state=checked]:translate-x-(--switch-md-thumb)',
        xs: 'size-3 data-[state=checked]:translate-x-3.5'
      }
    },
    defaultVariants: {
      size: 'default'
    }
  }
)

function Switch({
  className,
  size,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & VariantProps<typeof switchVariants>) {
  return (
    <SwitchPrimitive.Root className={cn(switchVariants({ size }), className)} data-slot="switch" {...props}>
      <SwitchPrimitive.Thumb className={switchThumbVariants({ size })} data-slot="switch-thumb" />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
