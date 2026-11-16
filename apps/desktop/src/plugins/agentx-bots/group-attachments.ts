/**
 * Files the user shares in a group room.
 *
 * The picker, paste and drag-and-drop all go through `readAttachments`. The
 * bytes stay in memory (a room log is persisted to plugin storage, which is no
 * place for megabytes); the log entry keeps the name, size and — for a
 * picture — a small thumbnail so the room still shows it after a restart.
 *
 * Each member gets the files in ITS turn, staged into its own room session
 * just before `prompt.submit`: pictures through `image.attach_bytes` (the
 * model sees them), anything else through `file.attach`, whose `@file:` ref is
 * appended to the turn so the member's file tools can open it. Both RPCs take
 * bytes, so this works the same against a local or a remote gateway.
 */

import type { GroupAttachment } from './types'

/** Per file; `image.attach_bytes` / `file.attach` cap uploads at 25 MB. */
export const GROUP_ATTACH_MAX_BYTES = 15 * 1024 * 1024
export const GROUP_ATTACH_MAX_FILES = 8
const THUMB_EDGE = 320
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp)$/i

interface Held {
  attachment: GroupAttachment
  dataUrl: string
}

const held = new Map<string, Held>()

let counter = 0

const newId = () => `att-${Date.now().toString(36)}-${(counter++).toString(36)}`

export function isImageFile(name: string, mime = ''): boolean {
  return mime.startsWith('image/') ? !/svg/i.test(mime) : IMAGE_EXTENSIONS.test(name)
}

/** The bytes of a shared file, if this window still holds them. */
export function attachmentData(id: string): string | null {
  return held.get(id)?.dataUrl ?? null
}

/** Keep the bytes of a file being shared (also used by tests). */
export function holdAttachment(attachment: GroupAttachment, dataUrl: string): void {
  held.set(attachment.id, { attachment, dataUrl })
}

export function releaseAttachment(id: string): void {
  held.delete(id)
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(file)
  })
}

async function thumbnail(file: Blob): Promise<string | undefined> {
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, THUMB_EDGE / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()

    return canvas.toDataURL('image/jpeg', 0.72)
  } catch {
    return undefined
  }
}

export interface ReadResult {
  added: GroupAttachment[]
  failed: string[]
  tooLarge: string[]
}

/** Read picked / pasted / dropped files into held attachments. */
export async function readAttachments(files: Iterable<File>, room = GROUP_ATTACH_MAX_FILES): Promise<ReadResult> {
  const result: ReadResult = { added: [], failed: [], tooLarge: [] }

  for (const file of files) {
    if (result.added.length >= room) {
      break
    }

    if (file.size > GROUP_ATTACH_MAX_BYTES) {
      result.tooLarge.push(file.name)

      continue
    }

    try {
      const dataUrl = await readAsDataUrl(file)
      const image = isImageFile(file.name, file.type)

      const attachment: GroupAttachment = {
        id: newId(),
        name: file.name || (image ? 'image.png' : 'file'),
        kind: image ? 'image' : 'file',
        size: file.size,
        ...(file.type ? { mime: file.type } : {}),
        ...(image ? { thumb: await thumbnail(file) } : {})
      }

      holdAttachment(attachment, dataUrl)
      result.added.push(attachment)
    } catch {
      result.failed.push(file.name)
    }
  }

  return result
}

type Rpc = <T>(method: string, params: Record<string, unknown>) => Promise<T>

export interface StagedAttachments {
  /** `name → @file:ref` lines for files the member can open. */
  files: Array<{ name: string; ref: string }>
  /** Pictures queued on the session (the next prompt.submit carries them). */
  images: string[]
  /** Shared files this member could not receive (bytes gone or upload failed). */
  missing: string[]
}

/** Stage `attachments` into a member's live room session. Never throws: a
 *  file that can't be staged is reported by name instead. */
export async function stageAttachments(
  rpc: Rpc,
  sessionId: string,
  attachments: readonly GroupAttachment[]
): Promise<StagedAttachments> {
  const staged: StagedAttachments = { files: [], images: [], missing: [] }

  for (const attachment of attachments) {
    const dataUrl = attachmentData(attachment.id)

    if (!dataUrl) {
      staged.missing.push(attachment.name)

      continue
    }

    try {
      if (attachment.kind === 'image') {
        const res = await rpc<{ attached?: boolean }>('image.attach_bytes', {
          session_id: sessionId,
          content_base64: dataUrl,
          filename: attachment.name
        })

        if (res?.attached === false) {
          throw new Error('not attached')
        }

        staged.images.push(attachment.name)
      } else {
        const res = await rpc<{ attached?: boolean; ref_text?: string }>('file.attach', {
          session_id: sessionId,
          data_url: dataUrl,
          name: attachment.name
        })

        if (!res?.ref_text) {
          throw new Error('not attached')
        }

        staged.files.push({ name: attachment.name, ref: res.ref_text })
      }
    } catch {
      staged.missing.push(attachment.name)
    }
  }

  return staged
}

/** Human size, for chips ("2.4 MB", "830 KB"). */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`
  }

  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** Test-only. */
export function resetAttachments(): void {
  held.clear()
  counter = 0
}
