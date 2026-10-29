import { cva, type VariantProps } from 'class-variance-authority'
import { Switch as SwitchPrimitive } from 'radix-ui'
import * as React from 'react'

import { cn } from '@/lib/utils'

// Switch: a 32×18 track with a 14px thumb (spec §5.6, one step up). Off is
// the strong border tone; on is the accent blue, the way the platform's own
// settings switch reads (review: an all-black UI read heavy). Only for settings
// that apply immediately; a setting that waits for "Lưu" is a checkbox. An
// invisible ::after pad extends the hit target to ≥ 24px. `default` and `md`
// are the same spec size (`md` is kept so page rows can say what they mean);
// `xs` is the dense 24×14 for menus.
const switchVariants = cva(
  "peer relative inline-flex shrink-0 items-center rounded-full bg-(--border-strong) p-0.5 transition-colors duration-(--dur-micro) outline-none after:absolute after:-inset-x-1 after:-inset-y-1.5 after:content-[''] disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-(--accent)",
  {
    variants: {
      size: {
        default: 'h-(--switch-md-track-height) w-(--switch-md-track-width)',
        md: 'h-(--switch-md-track-height) w-(--switch-md-track-width)',
        xs: 'h-3.5 w-6'
      }
    },
    defaultVariants: {
      size: 'default'
    }
  }
)

const switchThumbVariants = cva(
  'pointer-events-none block rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.2)] transition-transform duration-(--dur-micro) ease-(--ease-in-out) data-[state=unchecked]:translate-x-0',
  {
    variants: {
      size: {
        // Track 28 − 2×2px inset − 12px thumb = a 12px throw.
        default: 'size-(--switch-md-thumb) data-[state=checked]:translate-x-(--switch-md-thumb)',
        md: 'size-(--switch-md-thumb) data-[state=checked]:translate-x-(--switch-md-thumb)',
        xs: 'size-2.5 data-[state=checked]:translate-x-2.5'
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
