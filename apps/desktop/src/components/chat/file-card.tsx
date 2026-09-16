import { useEffect, useState } from 'react'

import { DeliverableContextMenu, useDeliverableActions } from '@/components/chat/deliverable-menu'
import { WIDGET_SHELL_CLASS } from '@/components/chat/widget-shell'
import { Button } from '@/components/ui/button'
import { FileTypeIcon } from '@/components/ui/file-type-icon'
import { useI18n } from '@/i18n'
import { deliverableKind, fileName } from '@/lib/deliverables'
import { formatByteSize } from '@/lib/format'
import { AlertTriangle, Download } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { type DeliverableFile, probeDeliverable } from '@/store/deliverables'

/**
 * A file the agent produced, in the transcript: the way Claude desktop or
 * Codex show a finished document — one glanceable row (type icon, name,
 * kind · size, an optional caption) that opens the preview rail, with the
 * two everyday actions as real buttons under it and everything else on the
 * right-click menu.
 *
 * Wears `WIDGET_SHELL_CLASS` like the other inline widgets; its actions sit
 * outside the panel on the control ramp (design.md § Chat). Opening the rail
 * is strictly click-driven — a card arriving never steals the pane.
 *
 * The card checks the file is still there once on mount (a stat, no bytes)
 * and says so instead of failing on click when it isn't.
 */
export function FileCard({ className, file }: { className?: string; file: DeliverableFile }) {
  const { t } = useI18n()
  const copy = t.fileCard
  const actions = useDeliverableActions(file.path)
  const [presence, setPresence] = useState<{ exists: boolean; sizeBytes?: number } | null>(null)

  useEffect(() => {
    let cancelled = false
    setPresence(null)

    void probeDeliverable(file.path).then(result => {
      if (!cancelled && result) {
        setPresence({ exists: result.exists, sizeBytes: result.sizeBytes })
      }
    })

    return () => {
      cancelled = true
    }
  }, [file.path])

  const missing = presence?.exists === false
  const kind = deliverableKind(file.path)
  const kindLabel = copy.kinds[kind ?? 'file']
  const size = formatByteSize(presence?.sizeBytes ?? file.sizeBytes)
  const name = file.name || fileName(file.path)
  const meta = missing ? copy.missing : [kindLabel, size].filter(Boolean).join(' · ')

  return (
    <div className={cn('my-1.5 w-full max-w-md', className)} data-slot="aui_file-card">
      <DeliverableContextMenu actions={actions}>
        <button
          aria-label={`${copy.open}: ${name}`}
          className={cn(
            WIDGET_SHELL_CLASS,
            'group/file flex w-full cursor-pointer items-center gap-3 overflow-hidden text-left',
            missing && 'cursor-default'
          )}
          disabled={missing}
          onClick={actions.openPreview}
          type="button"
        >
          <span className="grid size-8 shrink-0 place-items-center rounded-(--radius-control) bg-muted/55 text-muted-foreground">
            <FileTypeIcon path={file.path} size="1rem" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-foreground">{name}</span>
            <span
              className={cn(
                'flex items-center gap-1 truncate text-[length:var(--conversation-tool-font-size)] text-(--ui-text-tertiary)',
                missing && 'text-(--ui-yellow)'
              )}
            >
              {missing && <AlertTriangle aria-hidden className="size-3 shrink-0" />}
              <span className="truncate">{meta}</span>
            </span>
            {file.caption && (
              <span className="block truncate text-[length:var(--conversation-caption-font-size)] text-(--ui-text-secondary)">
                {file.caption}
              </span>
            )}
          </span>
          {!missing && (
            <span className="shrink-0 text-[length:var(--conversation-tool-font-size)] font-medium text-muted-foreground opacity-0 transition-opacity duration-(--dur-short) group-hover/file:opacity-100">
              {copy.open}
            </span>
          )}
        </button>
      </DeliverableContextMenu>
      {!missing && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <Button onClick={actions.download} size="sm" variant="secondary">
            <Download />
            {copy.download}
          </Button>
          {actions.local && (
            <Button onClick={actions.reveal} size="sm" variant="ghost">
              {actions.revealLabel}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
