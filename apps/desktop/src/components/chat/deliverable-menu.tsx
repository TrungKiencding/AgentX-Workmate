import { useStore } from '@nanostores/react'
import { type ReactNode, useCallback, useMemo } from 'react'

import { useSessionView } from '@/app/chat/session-view'
import { pickRevealLabel } from '@/app/right-sidebar/file-actions'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { useI18n } from '@/i18n'
import { IS_MAC } from '@/lib/keybinds/combo'
import {
  copyDeliverablePath,
  deliverableIsLocal,
  openDeliverableExternally,
  openDeliverablePreview,
  quickLookDeliverable,
  revealDeliverable,
  saveDeliverableCopy
} from '@/store/deliverables'

/**
 * The one set of things you can do with a file the agent produced, shared by
 * the file card, the inline chip and the created-files rows: open in the
 * preview rail, save a copy, reveal, open with the OS app, Quick Look, copy
 * the path. `local` hides what only makes sense when the file is on this
 * machine (a remote gateway keeps download and copy-path).
 */
export interface DeliverableActions {
  copyPath: () => void
  download: () => void
  local: boolean
  openExternally: () => void
  openPreview: () => void
  quickLook: () => void
  quickLookAvailable: boolean
  reveal: () => void
  revealLabel: string
}

export function useDeliverableActions(path: string): DeliverableActions {
  const { t } = useI18n()
  // The file belongs to the session whose transcript shows it; a relative
  // path resolves against THAT cwd, not the primary chat's.
  const cwd = useStore(useSessionView().$cwd)
  const local = deliverableIsLocal()
  const revealLabel = pickRevealLabel(t.fileMenu.revealFinder, t.fileMenu.revealExplorer, t.fileMenu.revealFileManager)

  const openPreview = useCallback(() => {
    void openDeliverablePreview(path, cwd)
  }, [cwd, path])

  return useMemo(
    () => ({
      copyPath: () => void copyDeliverablePath(path),
      download: () => void saveDeliverableCopy(path),
      local,
      openExternally: () => void openDeliverableExternally(path),
      openPreview,
      quickLook: () => void quickLookDeliverable(path),
      quickLookAvailable: local && IS_MAC,
      reveal: () => void revealDeliverable(path),
      revealLabel
    }),
    [local, openPreview, path, revealLabel]
  )
}

/** Right-click menu with every deliverable action, wrapping any trigger. */
export function DeliverableContextMenu({ actions, children }: { actions: DeliverableActions; children: ReactNode }) {
  const { t } = useI18n()
  const copy = t.fileCard

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={actions.openPreview}>{copy.open}</ContextMenuItem>
        <ContextMenuItem onSelect={actions.download}>{copy.download}</ContextMenuItem>
        {actions.local && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={actions.reveal}>{actions.revealLabel}</ContextMenuItem>
            <ContextMenuItem onSelect={actions.openExternally}>{copy.openWith}</ContextMenuItem>
            {actions.quickLookAvailable && (
              <ContextMenuItem onSelect={actions.quickLook}>{copy.quickLook}</ContextMenuItem>
            )}
          </>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={actions.copyPath}>{t.fileMenu.copyPath}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
