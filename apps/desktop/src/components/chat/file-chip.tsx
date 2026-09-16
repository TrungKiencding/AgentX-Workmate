import { DeliverableContextMenu, useDeliverableActions } from '@/components/chat/deliverable-menu'
import { FileTypeIcon } from '@/components/ui/file-type-icon'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { fileName } from '@/lib/deliverables'
import { cn } from '@/lib/utils'

/**
 * A file the reply merely names — "I saved it to /…/report.docx" — as an
 * inline reference instead of a dead path: the file's icon and name, in the
 * sentence, opening the preview rail on click and the full action set on
 * right-click. Prose keeps its flow; the hover tells where the file lives.
 */
export function FileChip({ className, path }: { className?: string; path: string }) {
  const { t } = useI18n()
  const actions = useDeliverableActions(path)
  const name = fileName(path)

  return (
    <DeliverableContextMenu actions={actions}>
      <Tip label={path}>
        <button
          aria-label={`${t.fileCard.open}: ${name}`}
          className={cn(
            'ref inline-flex max-w-full cursor-pointer items-center gap-1 align-baseline wrap-anywhere',
            className
          )}
          data-slot="aui_file-chip"
          onClick={actions.openPreview}
          type="button"
        >
          <FileTypeIcon className="shrink-0 opacity-80" path={path} size="0.875em" />
          <span className="truncate">{name}</span>
        </button>
      </Tip>
    </DeliverableContextMenu>
  )
}
