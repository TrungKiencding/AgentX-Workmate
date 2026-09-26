import { type RefObject, useEffect, useState } from 'react'

import type { CodeEditorApi } from '@/components/chat/code-editor'
import { JsonDocumentEditor } from '@/components/chat/json-document-editor'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useI18n } from '@/i18n'
import { notifyError } from '@/store/notifications'

import type { ServerBlock } from './mcp-model'

// The whole mcp.json, for whoever needs it: paste a README's snippet ("Thêm
// thủ công" opens this with a starter entry), edit a server's command or
// keys, remove one by hand. The draft is the MCP segment's (so a sign-in or
// an install landing mid-edit patches it instead of being lost); this dialog
// is only its view. Closing with unsaved edits asks first, in the footer —
// the edits are either saved or discarded, never left hidden behind a
// closed dialog for the next whole-map save to write by surprise.
export function McpConfigDialog({
  apiRef,
  dirty,
  docVersion,
  draft,
  highlight,
  onChange,
  onClose,
  onCursorChange,
  onDiscard,
  onSave,
  open,
  saving
}: {
  apiRef: RefObject<CodeEditorApi | null>
  dirty: boolean
  docVersion: number
  draft: string
  highlight: null | ServerBlock
  onChange: (next: string) => void
  onClose: () => void
  onCursorChange: (pos: number) => void
  onDiscard: () => void
  onSave: () => void
  open: boolean
  saving: boolean
}) {
  const { t } = useI18n()
  const m = t.settings.mcp
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)

  useEffect(() => {
    if (open) {
      setConfirmingDiscard(false)
    }
  }, [open])

  const requestClose = () => {
    if (dirty) {
      setConfirmingDiscard(true)
    } else {
      onClose()
    }
  }

  return (
    <Dialog onOpenChange={next => !next && requestClose()} open={open}>
      <DialogContent className="flex h-[min(44rem,85vh)] max-w-3xl flex-col" data-testid="mcp-config-dialog">
        <DialogHeader>
          <DialogTitle>{m.advancedConfig}</DialogTitle>
          <DialogDescription>{m.configHint}</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-(--radius-card) border border-(--ui-stroke-tertiary)">
          <JsonDocumentEditor
            apiRef={apiRef}
            disabled={saving}
            filePath="mcp.json"
            header={
              <span className="flex items-center gap-1.5 font-mono">
                mcp.json
                {dirty && <span aria-hidden className="size-1.5 rounded-full bg-current/60" />}
              </span>
            }
            highlight={highlight ? { from: highlight.from, to: highlight.to } : null}
            initialValue={draft}
            onChange={onChange}
            onCursorChange={onCursorChange}
            onFormatJsonError={error => notifyError(new Error(error), m.invalidJson)}
            onSave={onSave}
            remountKey={docVersion}
          />
        </div>
        <DialogFooter className="items-center">
          {confirmingDiscard ? (
            <>
              <span
                className="mr-auto text-sm text-(--ui-text-secondary)"
                data-testid="mcp-config-discard"
                role="status"
              >
                {m.discardPrompt}
              </span>
              <Button onClick={() => setConfirmingDiscard(false)} variant="ghost">
                {m.keepEditing}
              </Button>
              <Button onClick={onDiscard} variant="destructive">
                {m.discardChanges}
              </Button>
            </>
          ) : (
            <>
              <Button onClick={requestClose} variant="ghost">
                {t.common.cancel}
              </Button>
              <Button disabled={saving || !dirty} loading={saving} onClick={onSave}>
                {saving ? t.common.saving : t.common.save}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
