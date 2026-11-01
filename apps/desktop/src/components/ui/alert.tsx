import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'

import { cn } from '@/lib/utils'

// Banner (spec §5.16): an in-flow notice tied to a region — connection lost,
// a quota running out, an update. Flat: no border, no shadow; the fill is the
// signal's soft background (neutral = --bg-subtle), the glyph carries the hue.
// One banner per region.
const alertVariants = cva(
  'relative grid w-full grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2.5 gap-y-0.5 rounded-lg px-3 py-2.5 text-base text-(--text-primary) [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-(--bg-subtle) [&>svg]:text-(--icon-muted)',
        destructive: 'bg-(--danger-bg) [&>svg]:text-(--danger)',
        warning: 'bg-(--warning-bg) [&>svg]:text-(--warning)',
        success: 'bg-(--bg-subtle) [&>svg]:text-(--success)'
      }
    },
    defaultVariants: {
      variant: 'default'
    }
  }
)

function Alert({ className, variant, ...props }: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return <div className={cn(alertVariants({ variant }), className)} data-slot="alert" role="alert" {...props} />
}

function AlertTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('col-start-2 line-clamp-1 min-h-5 font-medium text-(--text-primary)', className)}
      data-slot="alert-title"
      {...props}
    />
  )
}

function AlertDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'col-start-2 grid justify-items-start gap-1 text-(--text-secondary) [&_p]:leading-relaxed',
        className
      )}
      data-slot="alert-description"
      {...props}
    />
  )
}

export { Alert, AlertDescription, AlertTitle }
