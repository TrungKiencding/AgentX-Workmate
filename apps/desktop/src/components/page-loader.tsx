import type { ComponentProps } from 'react'

import { Loader } from '@/components/ui/loader'
import { cn } from '@/lib/utils'

interface PageLoaderProps extends Omit<ComponentProps<'div'>, 'children'> {
  label?: string
}

export function PageLoader({
  'aria-label': ariaLabel,
  className,
  label = 'Loading',
  role = 'status',
  ...props
}: PageLoaderProps) {
  return (
    <div
      {...props}
      aria-label={ariaLabel ?? label}
      className={cn('grid h-full place-items-center', className)}
      role={role}
    >
      {/* A page that is loading shows a plain ring, not a math curve: the
          curve stays in the transcript, where thinking is the point. */}
      <Loader aria-hidden="true" role="presentation" variant="ring" />
    </div>
  )
}
