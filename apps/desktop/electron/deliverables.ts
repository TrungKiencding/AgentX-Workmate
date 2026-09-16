import path from 'node:path'

/**
 * What a produced file IS, for the chat's file cards and the preview rail.
 *
 * The renderer keeps the same table in `src/lib/deliverables.ts` (the two
 * TypeScript projects cannot share a module); `deliverables.test.ts` on each
 * side pins the same fixtures so the lists cannot drift apart silently. The
 * Python turn scanner (`tui_gateway/deliverables.py`) is the third copy — a
 * new extension is added to all three or none.
 */

export type DeliverableKind =
  'archive' | 'audio' | 'data' | 'document' | 'image' | 'pdf' | 'presentation' | 'spreadsheet' | 'text' | 'video'

export const DELIVERABLE_KINDS: Record<DeliverableKind, readonly string[]> = {
  archive: ['.zip', '.tar', '.gz', '.tgz', '.7z', '.rar', '.dmg'],
  audio: ['.mp3', '.wav', '.m4a', '.ogg', '.opus', '.flac', '.aac'],
  data: ['.csv', '.tsv', '.parquet', '.ics', '.vcf'],
  document: ['.doc', '.docx', '.odt', '.rtf', '.epub', '.pages'],
  image: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.heic', '.tiff', '.tif'],
  pdf: ['.pdf'],
  presentation: ['.ppt', '.pptx', '.odp', '.key'],
  spreadsheet: ['.xls', '.xlsx', '.xlsm', '.ods', '.numbers'],
  text: ['.md', '.txt', '.html', '.htm'],
  video: ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v']
}

const KIND_BY_EXT = new Map<string, DeliverableKind>()

for (const [kind, exts] of Object.entries(DELIVERABLE_KINDS) as [DeliverableKind, readonly string[]][]) {
  for (const ext of exts) {
    KIND_BY_EXT.set(ext, kind)
  }
}

/** MIME types for the document/archive/data extensions the media table lacks. */
export const DOCUMENT_MIME_TYPES: Record<string, string> = {
  '.7z': 'application/x-7z-compressed',
  '.csv': 'text/csv',
  '.dmg': 'application/x-apple-diskimage',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.epub': 'application/epub+zip',
  '.gz': 'application/gzip',
  '.heic': 'image/heic',
  '.htm': 'text/html',
  '.html': 'text/html',
  '.ics': 'text/calendar',
  '.md': 'text/markdown',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.pdf': 'application/pdf',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.rar': 'application/vnd.rar',
  '.rtf': 'application/rtf',
  '.tar': 'application/x-tar',
  '.tgz': 'application/gzip',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.tsv': 'text/tab-separated-values',
  '.txt': 'text/plain',
  '.vcf': 'text/vcard',
  '.xls': 'application/vnd.ms-excel',
  '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip'
}

export function deliverableKind(filePath: string): DeliverableKind | null {
  return KIND_BY_EXT.get(path.extname(filePath || '').toLowerCase()) ?? null
}

/**
 * How the preview rail shows a local file. `pdf`, `document` and `media` are
 * rendered by dedicated viewers; `binary` is what is left when a file is
 * neither text nor something a viewer exists for.
 */
export type FilePreviewKind = 'binary' | 'document' | 'html' | 'image' | 'media' | 'pdf' | 'text'

const OFFICE_EXTS = new Set([
  ...DELIVERABLE_KINDS.document,
  ...DELIVERABLE_KINDS.spreadsheet,
  ...DELIVERABLE_KINDS.presentation
])

export function previewKindForFile(input: { binary?: boolean; ext: string; mimeType?: string }): FilePreviewKind {
  const ext = (input.ext || '').toLowerCase()
  const mimeType = (input.mimeType || '').toLowerCase()

  if (ext === '.html' || ext === '.htm') {
    return 'html'
  }

  if (mimeType.startsWith('image/')) {
    return 'image'
  }

  if (ext === '.pdf') {
    return 'pdf'
  }

  if (OFFICE_EXTS.has(ext)) {
    return 'document'
  }

  if (mimeType.startsWith('audio/') || mimeType.startsWith('video/')) {
    return 'media'
  }

  return input.binary ? 'binary' : 'text'
}

export interface FileStatResult {
  byteSize: number
  exists: boolean
  isFile: boolean
  mimeType: string
  /** Epoch milliseconds; 0 when the file does not exist. */
  modifiedMs: number
  path: string
}
