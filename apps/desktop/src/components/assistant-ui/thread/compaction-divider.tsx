import { MessagePrimitive } from '@assistant-ui/react'
import { type CSSProperties, type FC, useId, useState } from 'react'

import { MarkdownTextContent } from '@/components/assistant-ui/markdown-text'
import { Codicon } from '@/components/ui/codicon'
import { DisclosureCaret } from '@/components/ui/disclosure-caret'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { cn } from '@/lib/utils'

const SUMMARY_TYPE = {
  '--conversation-text-font-size': '0.875rem',
  '--conversation-prose-line-height': '1.55',
  '--conversation-h1-font-size': '0.875rem',
  '--conversation-h2-font-size': '0.875rem',
  '--conversation-h3-font-size': '0.875rem',
  '--conversation-h4-font-size': '0.8125rem'
} as CSSProperties

// Where the agent's context was summarized. The turns above stay readable in
// full; the agent itself continues from the summary, which the disclosure
// reveals. A hairline-and-label divider, not a bubble: it is a moment in the
// thread, not something anyone said.
export const CompactionDivider: FC<{ summary: string }> = ({ summary }) => {
  const { t } = useI18n()
  const copy = t.assistant.thread
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const hasSummary = summary.trim().length > 0

  return (
    <MessagePrimitive.Root
      className="flex w-full min-w-0 flex-col self-stretch py-2"
      data-role="system"
      data-slot="aui_compaction-divider"
    >
      <div className="flex items-center gap-3">
        <span aria-hidden className="h-px flex-1 bg-(--ui-stroke-tertiary)" />
        <button
          aria-controls={hasSummary ? panelId : undefined}
          aria-expanded={hasSummary ? open : undefined}
          className={cn(
            'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs text-(--ui-text-tertiary) transition-colors duration-(--dur-micro)',
            hasSummary
              ? 'cursor-pointer hover:bg-(--ui-row-hover-background) hover:text-(--ui-text-secondary)'
              : 'cursor-default'
          )}
          disabled={!hasSummary}
          onClick={() => {
            triggerHaptic('selection')
            setOpen(value => !value)
          }}
          type="button"
        >
          <Codicon name="history" size="0.8125rem" />
          <span>{copy.compactionLabel}</span>
          {hasSummary && <DisclosureCaret className="opacity-70" open={open} />}
        </button>
        <span aria-hidden className="h-px flex-1 bg-(--ui-stroke-tertiary)" />
      </div>
      {open && hasSummary && (
        <div
          className="mx-auto mt-2 w-full max-w-[44rem] rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-widget-surface-background) px-4 py-3"
          data-slot="aui_compaction-summary"
          id={panelId}
        >
          <p className="mb-2 text-xs leading-5 text-(--ui-text-tertiary)">{copy.compactionNote}</p>
          {/* Background reading, not a reply: one step under the transcript's
              reading size, headings at body size, and a bounded height so a
              long handoff never pushes the conversation off screen. */}
          <div className="max-h-[22rem] overflow-y-auto pr-1" style={SUMMARY_TYPE}>
            <MarkdownTextContent disableArtifacts isRunning={false} text={summary} />
          </div>
        </div>
      )}
    </MessagePrimitive.Root>
  )
}
