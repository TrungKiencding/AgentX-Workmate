import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'
import type * as React from 'react'

import { cn } from '@/lib/utils'

const badgeVariants = cva(
  // Spec §5.14: a 16px caption badge, 500 weight, tabular figures, full
  // radius. Neutral on --bg-selected; a signal tone only ever tints its soft
  // background token, never a solid fill.
  'inline-flex w-fit shrink-0 items-center gap-1 rounded-full font-medium leading-none whitespace-nowrap tabular-nums [&_svg]:pointer-events-none',
  {
    variants: {
      variant: {
        default: 'bg-(--bg-selected) text-(--text-secondary)',
        muted: 'bg-(--bg-subtle) text-(--text-tertiary)',
        warn: 'bg-(--warning-bg) text-(--warning)',
        destructive: 'bg-(--danger-bg) text-(--danger)',
        outline: 'border border-(--border-default) text-(--text-secondary)'
      },
      size: {
        default: 'h-4 px-1.5 text-xs [&_svg]:size-3',
        xs: 'h-4 px-1 text-xs [&_svg]:size-2.5'
      }
    },
    defaultVariants: { variant: 'default', size: 'default' }
  }
)

export interface BadgeProps extends React.ComponentProps<'span'>, VariantProps<typeof badgeVariants> {
  asChild?: boolean
}

export function Badge({ asChild = false, className, size, variant, ...props }: BadgeProps) {
  const Comp = asChild ? Slot.Root : 'span'

  return <Comp className={cn(badgeVariants({ size, variant }), className)} data-slot="badge" {...props} />
}

export { badgeVariants }
