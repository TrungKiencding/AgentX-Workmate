import { Checkbox as CheckboxPrimitive } from 'radix-ui'
import * as React from 'react'

import { Check, Minus } from '@/lib/icons'
import { cn } from '@/lib/utils'

function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      className={cn(
        // Spec §5.6 (one step up): 18×18, 6px corners, --border-input edge;
        // checked and indeterminate fill the accent with a white glyph, like
        // the platform's own checkbox.
        'group peer size-4.5 shrink-0 rounded-sm border border-(--border-input) bg-(--bg-app) outline-none transition-colors duration-(--dur-micro) disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-(--accent) data-[state=checked]:bg-(--accent) data-[state=checked]:text-white data-[state=indeterminate]:border-(--accent) data-[state=indeterminate]:bg-(--accent) data-[state=indeterminate]:text-white aria-invalid:border-(--danger)',
        className
      )}
      data-slot="checkbox"
      {...props}
    >
      <CheckboxPrimitive.Indicator
        className="flex items-center justify-center text-current"
        data-slot="checkbox-indicator"
      >
        <Check className="hidden size-3.5 stroke-[2.5] group-data-[state=checked]:block" />
        <Minus className="hidden size-3.5 stroke-[2.5] group-data-[state=indeterminate]:block" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
