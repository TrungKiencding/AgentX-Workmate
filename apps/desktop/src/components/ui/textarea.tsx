import * as React from 'react'

import { cn } from '@/lib/utils'

import { type ControlVariantProps, controlVariants } from './control'

function Textarea({ className, size, ...props }: React.ComponentProps<'textarea'> & ControlVariantProps) {
  return (
    <textarea
      // Off by default for every consumer — these are code/config/prompt fields,
      // not prose. Callers can re-enable per-instance by passing the prop.
      autoCapitalize="off"
      autoComplete="off"
      autoCorrect="off"
      // Multi-line: the control ramp's fixed height gives way to a min-height
      // so the field can grow; vertical padding restores the inset the
      // height-centered single-line controls get for free.
      className={cn(controlVariants({ size }), 'h-auto min-h-16 py-1.5', className)}
      data-slot="textarea"
      spellCheck={false}
      {...props}
    />
  )
}

export { Textarea }
