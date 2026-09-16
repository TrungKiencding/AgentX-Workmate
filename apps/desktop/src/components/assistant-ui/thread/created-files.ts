// Pure derivation for the assistant message's "N files created" card: the
// deliverables the backend saw the turn produce, minus the ones the transcript
// already shows as cards. No React/DOM.

import { linkedFilePaths } from '@/lib/deliverables'
import type { DeliverableFile } from '@/store/deliverables'

interface PartLike {
  result?: unknown
  text?: unknown
  toolName?: unknown
  type?: unknown
}

/** A file record as the gateway ships it on `message.complete` / `display_metadata`. */
export interface CreatedFileRecord {
  kind?: string
  mime_type?: string
  modified_at?: number
  name?: string
  path: string
  size_bytes?: number
}

export function isCreatedFileRecord(value: unknown): value is CreatedFileRecord {
  return Boolean(value) && typeof value === 'object' && typeof (value as CreatedFileRecord).path === 'string'
}

export function createdFilesFromPayload(value: unknown): DeliverableFile[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.filter(isCreatedFileRecord).map(record => ({
    mimeType: typeof record.mime_type === 'string' ? record.mime_type : undefined,
    modifiedMs: typeof record.modified_at === 'number' ? record.modified_at * 1000 : undefined,
    name:
      typeof record.name === 'string' && record.name ? record.name : record.path.split(/[\\/]/).pop() || record.path,
    path: record.path,
    sizeBytes: typeof record.size_bytes === 'number' ? record.size_bytes : undefined
  }))
}

/** Paths a message already renders as a card: `deliver_file` results and `#media:` / `#file:` links. */
export function pathsShownInParts(parts: readonly unknown[]): Set<string> {
  const shown = new Set<string>()

  for (const raw of parts) {
    const part = (raw ?? {}) as PartLike

    if (part.type === 'tool-call' && part.toolName === 'deliver_file') {
      const result = typeof part.result === 'string' ? safeParse(part.result) : part.result
      const path = result && typeof result === 'object' ? (result as { path?: unknown }).path : undefined

      if (typeof path === 'string') {
        shown.add(path)
      }
    } else if (part.type === 'text' && typeof part.text === 'string') {
      for (const path of linkedFilePaths(part.text)) {
        shown.add(path)
      }
    }
  }

  return shown
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

/**
 * The created-files rows for a message: what the backend reported, in its
 * order (newest first), without files already on screen as a card or chip.
 */
export function deriveCreatedFiles(files: readonly DeliverableFile[], parts: readonly unknown[]): DeliverableFile[] {
  if (files.length === 0) {
    return []
  }

  const shown = pathsShownInParts(parts)
  const seen = new Set<string>()

  return files.filter(file => {
    if (shown.has(file.path) || seen.has(file.path)) {
      return false
    }

    seen.add(file.path)

    return true
  })
}
