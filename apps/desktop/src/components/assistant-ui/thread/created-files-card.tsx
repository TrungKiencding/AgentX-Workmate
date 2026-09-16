import { type FC, useMemo } from 'react'

import { deriveCreatedFiles } from '@/components/assistant-ui/thread/created-files'
import { DeliverableContextMenu, useDeliverableActions } from '@/components/chat/deliverable-menu'
import { WIDGET_SHELL_CLASS } from '@/components/chat/widget-shell'
import { Button } from '@/components/ui/button'
import { FadeScroll } from '@/components/ui/fade-scroll'
import { FileTypeIcon } from '@/components/ui/file-type-icon'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { deliverableKind } from '@/lib/deliverables'
import { formatByteSize } from '@/lib/format'
import { Download } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { DeliverableFile } from '@/store/deliverables'

// ~5 rows, like the changed-files card: a turn that produced twenty files
// still reads as one card the user scrolls inside.
const MAX_ROWS_HEIGHT = '9.375rem'

const CreatedFileRow: FC<{ file: DeliverableFile }> = ({ file }) => {
  const { t } = useI18n()
  const actions = useDeliverableActions(file.path)
  const kind = deliverableKind(file.path)
  const meta = [t.fileCard.kinds[kind ?? 'file'], formatByteSize(file.sizeBytes)].filter(Boolean).join(' · ')

  return (
    <DeliverableContextMenu actions={actions}>
      <div className="group/row row-hover flex w-full shrink-0 items-center gap-2 rounded-md px-1.5 py-1">
        <Tip label={file.path}>
          <button
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
            onClick={actions.openPreview}
            type="button"
          >
            <FileTypeIcon className="shrink-0 text-(--ui-text-tertiary)" path={file.path} size="0.875rem" />
            <span className="min-w-0 flex-1 truncate text-(--ui-text-secondary)">{file.name}</span>
            <span className="shrink-0 tabular-nums text-(--ui-text-tertiary)">{meta}</span>
          </button>
        </Tip>
        <Button
          aria-label={`${t.fileCard.download}: ${file.name}`}
          className="opacity-0 focus-visible:opacity-100 group-hover/row:opacity-100"
          onClick={actions.download}
          size="icon-xs"
          variant="ghost"
        >
          <Download />
        </Button>
      </div>
    </DeliverableContextMenu>
  )
}

/**
 * "N files created in this turn": the deliverables the backend saw the turn
 * produce (a script wrote a spreadsheet, pandoc emitted a PDF …) that the
 * reply did not already hand over as a card. One row per file — open on
 * click, save on the hover control, everything else on right-click — so a
 * file that only ever appeared in a tool's stdout is still one click away.
 */
export const CreatedFilesCard: FC<{ files: readonly DeliverableFile[]; parts: readonly unknown[] }> = ({
  files,
  parts
}) => {
  const { t } = useI18n()
  const rows = useMemo(() => deriveCreatedFiles(files, parts), [files, parts])

  if (rows.length === 0) {
    return null
  }

  return (
    <div
      className={cn(WIDGET_SHELL_CLASS, 'mt-1.5 text-[length:var(--conversation-tool-font-size)]')}
      data-slot="aui_created-files"
    >
      <div className="truncate text-(--ui-text-primary)">{t.assistant.thread.createdFiles(rows.length)}</div>
      <FadeScroll className="-mx-1.5 mt-1.5 flex flex-col px-1.5" maxHeight={MAX_ROWS_HEIGHT}>
        {rows.map(file => (
          <CreatedFileRow file={file} key={file.path} />
        ))}
      </FadeScroll>
    </div>
  )
}
