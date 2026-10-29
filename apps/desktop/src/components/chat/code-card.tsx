import * as React from 'react'

import { Codicon, type CodiconProps } from '@/components/ui/codicon'
import { cn } from '@/lib/utils'

/**
 * The code block (spec §5.19) for fenced code (and any equivalent: diffs, raw
 * payloads, etc.) sized for the conversation column: --bg-subtle under a
 * --border-subtle hairline, 12px corners, 13/20 mono, 12×16 padding, scrolling
 * sideways inside the block.
 *
 * A fence adds `CodeCardHeader`: one 32px row naming the language and holding
 * the copy control (which turns into ✓ "Đã chép" for 2s). No divider under it
 * — the padding is the separation.
 */
function CodeCard({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'group/code relative min-w-0 max-w-full overflow-hidden rounded-lg border border-(--border-subtle) bg-(--bg-subtle) [--expandable-fade-from:var(--bg-subtle)] text-sm text-(--text-secondary)',
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
      className={cn('shrink-0 text-base leading-none text-(--icon-muted)', className)}
      data-slot="code-card-icon"
      {...props}
    />
  )
}

/**
 * The fence's header row: what language this is on the left (a caption in the
 * UI face), the copy control on the right. 32px; the language is a proper
 * name, so it keeps its own casing.
 */
function CodeCardHeader({ children, className, label, ...props }: React.ComponentProps<'div'> & { label?: string }) {
  return (
    <div
      className={cn('flex h-8 items-center justify-between gap-2 pr-1.5 pl-4', className)}
      data-slot="code-card-header"
      {...props}
    >
      <span className="min-w-0 truncate text-xs text-(--text-tertiary)">{label}</span>
      {children}
    </div>
  )
}

function CodeCardBody({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'font-mono text-[length:var(--conversation-code-font-size)] leading-(--conversation-code-line-height) text-(--text-primary) [&_pre]:m-0 [&_pre]:overflow-x-auto [&_pre]:scrollbar-overlay [&_pre]:bg-transparent! [&_pre]:px-4 [&_pre]:py-3 [&_pre]:font-mono [&_pre]:leading-(--conversation-code-line-height) [[data-slot=code-card-header]+&_pre]:pt-0.5',
        className
      )}
      data-slot="code-card-body"
      {...props}
    />
  )
}

export { CodeCard, CodeCardBody, CodeCardHeader, CodeCardIcon }
