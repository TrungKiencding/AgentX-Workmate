import { cva, type VariantProps } from 'class-variance-authority'
import { Switch as SwitchPrimitive } from 'radix-ui'
import * as React from 'react'

import { cn } from '@/lib/utils'

// Quiet Tool switch (spec §5.6): a 28×16 track with a 12px thumb. Off is the
// strong border tone, on is --bg-inverse — never the accent. Only for settings
// that apply immediately; a setting that waits for "Lưu" is a checkbox. An
// invisible ::after pad extends the hit target to ≥ 24px. `default` and `md`
// are the same spec size (`md` is kept so page rows can say what they mean);
// `xs` is the dense 24×14 for menus.
const switchVariants = cva(
  "peer relative inline-flex shrink-0 items-center rounded-full bg-(--border-strong) p-0.5 transition-colors duration-(--dur-micro) outline-none after:absolute after:-inset-x-1 after:-inset-y-1.5 after:content-[''] disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-(--bg-inverse)",
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
  'pointer-events-none block rounded-full bg-(--bg-app) transition-transform duration-(--dur-micro) ease-(--ease-in-out) data-[state=unchecked]:translate-x-0 dark:data-[state=unchecked]:bg-(--text-secondary)',
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
