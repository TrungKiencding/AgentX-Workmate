import * as React from 'react'

import { Codicon, type CodiconProps } from '@/components/ui/codicon'
import { cn } from '@/lib/utils'

/**
 * Rounded surface for fenced code (and any equivalent: diffs, raw payloads,
 * etc.) sized for the conversation column. Fill only, no border — a code block
 * reads as a tinted slab of the reply rather than an attached artifact.
 *
 * A fence adds `CodeCardHeader`: one thin row naming the language and holding
 * the copy control. No divider under it — the padding is the separation
 * (flat, not boxed).
 */
function CodeCard({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'group/code relative min-w-0 max-w-full overflow-hidden rounded-(--radius-card) bg-(--ui-bg-editor) [--expandable-fade-from:var(--ui-bg-editor)] text-[length:var(--conversation-tool-font-size)] text-muted-foreground',
        className
      )}
      data-slot="code-card"
      {...props}
    />
  )
}

function CodeCardIcon({ className, ...props }: CodiconProps) {
  return (
    <Codicon
      className={cn('shrink-0 text-base leading-none text-muted-foreground', className)}
      data-slot="code-card-icon"
      {...props}
    />
  )
}

/**
 * The fence's header row: what language this is on the left, the copy control
 * on the right. 28px so an `icon-sm` button fits without inflating the block;
 * the language is a proper name, so it keeps its own casing and gets no
 * tracked-out uppercase.
 */
function CodeCardHeader({ children, className, label, ...props }: React.ComponentProps<'div'> & { label?: string }) {
  return (
    <div
      className={cn('flex h-7 items-center justify-between gap-2 pr-1 pl-3', className)}
      data-slot="code-card-header"
      {...props}
    >
      <span className="min-w-0 truncate font-mono text-2xs text-(--ui-text-tertiary)">{label}</span>
      {children}
    </div>
  )
}

function CodeCardBody({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'font-mono text-[length:var(--conversation-code-font-size)] leading-(--conversation-code-line-height) text-foreground/90 [&_pre]:m-0 [&_pre]:overflow-x-auto [&_pre]:scrollbar-overlay [&_pre]:bg-transparent! [&_pre]:px-2 [&_pre]:py-1.5 [&_pre]:font-mono [&_pre]:leading-(--conversation-code-line-height)',
        className
      )}
      data-slot="code-card-body"
      {...props}
    />
  )
}

export { CodeCard, CodeCardBody, CodeCardHeader, CodeCardIcon }
