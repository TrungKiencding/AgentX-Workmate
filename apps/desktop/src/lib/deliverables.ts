/**
 * What a produced file IS, and how it travels through markdown.
 *
 * The desktop shows a file the agent produced as a card (a document, a
 * spreadsheet, an archive …) or, when the reply merely names its path, as an
 * inline chip that opens the same preview. Both need one answer to "which
 * kind is this file" — this table. Electron keeps a copy in
 * `electron/deliverables.ts` (the two TypeScript projects cannot share a
 * module) and the Python turn scanner a third in `tui_gateway/deliverables.py`;
 * `deliverables.test.ts` pins the same fixtures on each side.
 */

export type DeliverableKind =
  'archive' | 'audio' | 'data' | 'document' | 'image' | 'pdf' | 'presentation' | 'spreadsheet' | 'text' | 'video'

export const DELIVERABLE_KINDS: Record<DeliverableKind, readonly string[]> = {
  archive: ['zip', 'tar', 'gz', 'tgz', '7z', 'rar', 'dmg'],
  audio: ['mp3', 'wav', 'm4a', 'ogg', 'opus', 'flac', 'aac'],
  data: ['csv', 'tsv', 'parquet', 'ics', 'vcf'],
  document: ['doc', 'docx', 'odt', 'rtf', 'epub', 'pages'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'heic', 'tiff', 'tif'],
  pdf: ['pdf'],
  presentation: ['ppt', 'pptx', 'odp', 'key'],
  spreadsheet: ['xls', 'xlsx', 'xlsm', 'ods', 'numbers'],
  text: ['md', 'txt', 'html', 'htm'],
  video: ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v']
}

const KIND_BY_EXT = new Map<string, DeliverableKind>()

for (const [kind, exts] of Object.entries(DELIVERABLE_KINDS) as [DeliverableKind, readonly string[]][]) {
  for (const ext of exts) {
    KIND_BY_EXT.set(ext, kind)
  }
}

/** The file's extension without its dot, lowercased; '' when it has none. */
export function fileExtension(path: string): string {
  const name = fileName(path)
  const dot = name.lastIndexOf('.')

  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function fileName(path: string): string {
  const clean = path.split(/[?#]/, 1)[0] || path

  return clean.split(/[\\/]/).filter(Boolean).pop() || path
}

/** A file the agent produced, as the transcript carries it. */
export interface DeliverableFile {
  caption?: string
  mimeType?: string
  /** Epoch milliseconds. */
  modifiedMs?: number
  name: string
  path: string
  sizeBytes?: number
}

export function deliverableKind(path: string): DeliverableKind | null {
  return KIND_BY_EXT.get(fileExtension(path)) ?? null
}

export function isDeliverablePath(path: string): boolean {
  return deliverableKind(path) !== null
}

/** Kinds the preview rail renders in place; the rest open in the OS. */
export function deliverableHasInlinePreview(kind: DeliverableKind | null): boolean {
  return kind !== null && kind !== 'archive' && kind !== 'presentation'
}

// ── Markdown transport ───────────────────────────────────────────────────
//
// A path in the reply becomes `[name](#file:<encoded path>)` so the markdown
// link renderer can hand it to the inline chip, the same way `#media:` hands a
// MEDIA: tag to its card. The two are kept distinct on purpose: a MEDIA: tag
// is an explicit hand-over (a card), a mentioned path is a reference (a chip).

const FILE_HREF_PREFIX = '#file:'

export function fileMarkdownHref(path: string): string {
  return `${FILE_HREF_PREFIX}${encodeURIComponent(path)}`
}

export function filePathFromMarkdownHref(href?: string): string | null {
  if (!href?.startsWith(FILE_HREF_PREFIX)) {
    return null
  }

  try {
    return decodeURIComponent(href.slice(FILE_HREF_PREFIX.length))
  } catch {
    return null
  }
}

const EXT_ALTERNATION = [...KIND_BY_EXT.keys()].sort((a, b) => b.length - a.length).join('|')

// A bare absolute path in prose: `/…`, `~/…`, or `C:\…`. The look-behind keeps
// the tail of a URL out (`https://host/x/report.pdf` — every slash inside a
// URL follows a word character, a colon or another slash), skips paths that
// already sit in a markdown link (`](` / `(` before them) or a bracket, and
// leaves inline code alone (a backtick before the path — the caller splits
// code out, this is the belt to that suspender). A quoted path is still a
// path. A sentence-ending period after the extension is allowed; a path with
// brackets or parentheses in it is not recognised at all.
const BARE_PATH_RE = new RegExp(
  String.raw`(?<![\w:/\\.\-\[(<\x60])((?:~|/|[A-Za-z]:[\\/])[^\s"'\x60<>|*?\[\]{}()]*?\.(?:${EXT_ALTERNATION}))(?=[\s"'\x60<>|,;:)\]}]|\.(?:\s|$)|$)`,
  'gi'
)

/**
 * Turn bare deliverable paths in prose into `#file:` links. Runs on prose
 * only: the caller has already split out fenced and inline code. Paths that
 * are already link targets or link text (`[…](…)`) are left alone.
 */
export function linkifyDeliverablePaths(text: string): string {
  if (!text || !/[/\\~]/.test(text)) {
    return text
  }

  return text.replace(BARE_PATH_RE, (match: string, path: string, offset: number) => {
    // Inside an existing link's text or target: `[/tmp/a.pdf](…)` / `[x](/tmp/a.pdf)`.
    const before = text.slice(0, offset)
    const after = text.slice(offset + match.length)
    const openBracket = before.lastIndexOf('[')
    const closeBracket = before.lastIndexOf(']')

    if (openBracket > closeBracket && /^[^\]]*\]\(/.test(after)) {
      return match
    }

    const label = fileName(path).replace(/[[\]\\]/g, '\\$&')

    return `[${label}](${fileMarkdownHref(path)})`
  })
}

/** Deliverable paths a piece of text refers to through `#file:` and `#media:` links. */
export function linkedFilePaths(text: string): string[] {
  const found: string[] = []

  for (const match of text.matchAll(/\]\(\s*#(?:file|media):([^)\s]+)\s*\)/g)) {
    try {
      found.push(decodeURIComponent(match[1] || ''))
    } catch {
      // A malformed href is not a path.
    }
  }

  return found
}
