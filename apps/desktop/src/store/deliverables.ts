import { translateNow } from '@/i18n'
import { type DeliverableFile, fileName } from '@/lib/deliverables'
import {
  copyTextToClipboard,
  isDesktopFsRemoteMode,
  quickLookDesktopFile,
  revealDesktopPath,
  saveDesktopFileCopy,
  statDesktopFile
} from '@/lib/desktop-fs'
import { openExternalLink } from '@/lib/external-link'
import { normalizeOrLocalPreviewTarget } from '@/lib/local-preview'
import { downloadGatewayMediaFile, isRemoteGateway, mediaExternalUrl } from '@/lib/media'
import { notify, notifyError } from '@/store/notifications'
import { openPreview, type PreviewRecordSource } from '@/store/preview'

/**
 * The actions behind a file the agent produced — one home for the file card,
 * the inline chip and the created-files list, so "Xem", "Tải xuống" and
 * "Hiện trong Finder" behave identically wherever the file is met.
 *
 * Every action is user-initiated (a click), never fired because a file
 * appeared: the preview rail opens on request only. Failures toast with what
 * to do next; success is silent when the result is visible on screen.
 */

export type { DeliverableFile }

/** Open the file in the preview rail (a tab per file; re-fronts an open one). */
export async function openDeliverablePreview(
  path: string,
  cwd?: null | string,
  source: PreviewRecordSource = 'tool-result'
): Promise<boolean> {
  try {
    const target = await normalizeOrLocalPreviewTarget(path, cwd || undefined)

    if (!target) {
      notify({
        kind: 'warning',
        message: translateNow('fileCard.missingBody'),
        title: translateNow('fileCard.missing')
      })

      return false
    }

    openPreview(target, source)

    return true
  } catch (error) {
    notifyError(error, translateNow('preview.unavailable'))

    return false
  }
}

/** "Save a copy": a native save dialog locally, a browser download for a gateway-side file. */
export async function saveDeliverableCopy(path: string): Promise<boolean> {
  try {
    if (isRemoteGateway()) {
      await downloadGatewayMediaFile(path)

      return true
    }

    const result = await saveDesktopFileCopy(path)

    if (!result.ok) {
      return false
    }

    notify({ kind: 'success', message: translateNow('fileCard.saved', fileName(result.path || path)) })

    return true
  } catch (error) {
    notifyError(error, translateNow('fileCard.downloadFailed'))

    return false
  }
}

/** Reveal in Finder / Explorer / the file manager. Local files only. */
export async function revealDeliverable(path: string): Promise<void> {
  try {
    await revealDesktopPath(path)
  } catch (error) {
    notifyError(error, translateNow('errors.genericFailure'))
  }
}

/** Open with the OS default application; a gateway-side file downloads instead. */
export async function openDeliverableExternally(path: string): Promise<void> {
  if (isRemoteGateway()) {
    await saveDeliverableCopy(path)

    return
  }

  openExternalLink(mediaExternalUrl(path))
}

/** macOS Quick Look; resolves false where the platform has none. */
export async function quickLookDeliverable(path: string): Promise<boolean> {
  try {
    return await quickLookDesktopFile(path)
  } catch (error) {
    notifyError(error, translateNow('errors.genericFailure'))

    return false
  }
}

export async function copyDeliverablePath(path: string): Promise<void> {
  try {
    await copyTextToClipboard(path)
    notify({ durationMs: 1500, kind: 'info', message: translateNow('fileMenu.pathCopied') })
  } catch (error) {
    notifyError(error, translateNow('common.copyFailed'))
  }
}

/** Local actions (reveal, open with, Quick Look) only make sense when the file is on this machine. */
export function deliverableIsLocal(): boolean {
  return !isDesktopFsRemoteMode()
}

export interface DeliverablePresence {
  exists: boolean
  mimeType?: string
  modifiedMs?: number
  sizeBytes?: number
}

/**
 * Whether the file is still there, and what it weighs. `null` when neither
 * transport can say (an older shell) — the caller renders without a badge.
 */
export async function probeDeliverable(path: string): Promise<DeliverablePresence | null> {
  try {
    const stat = await statDesktopFile(path)

    if (!stat) {
      return null
    }

    return {
      exists: stat.exists && stat.isFile,
      mimeType: stat.mimeType,
      modifiedMs: stat.modifiedMs || undefined,
      sizeBytes: stat.byteSize || undefined
    }
  } catch {
    return null
  }
}
