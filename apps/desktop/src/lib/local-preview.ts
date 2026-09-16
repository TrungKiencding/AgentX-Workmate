import { DELIVERABLE_KINDS, deliverableKind } from '@/lib/deliverables'
import { isDesktopFsRemoteMode, readDesktopFileText } from '@/lib/desktop-fs'
import type { PreviewTarget } from '@/store/preview'

const HTML_EXTENSIONS = new Set(['.htm', '.html'])
const IMAGE_EXTENSIONS = new Set(['.bmp', '.gif', '.jpeg', '.jpg', '.png', '.svg', '.webp'])

const OFFICE_EXTENSIONS = new Set(
  [...DELIVERABLE_KINDS.document, ...DELIVERABLE_KINDS.spreadsheet, ...DELIVERABLE_KINDS.presentation].map(
    ext => `.${ext}`
  )
)

const LANGUAGE_BY_EXT: Record<string, string> = {
  '.c': 'c',
  '.conf': 'ini',
  '.cpp': 'cpp',
  '.css': 'css',
  '.csv': 'csv',
  '.go': 'go',
  '.graphql': 'graphql',
  '.h': 'c',
  '.hpp': 'cpp',
  '.html': 'html',
  '.java': 'java',
  '.js': 'javascript',
  '.json': 'json',
  '.jsx': 'jsx',
  '.log': 'text',
  '.lua': 'lua',
  '.md': 'markdown',
  '.mjs': 'javascript',
  '.py': 'python',
  '.rb': 'ruby',
  '.rs': 'rust',
  '.sh': 'shell',
  '.sql': 'sql',
  '.svg': 'xml',
  '.toml': 'toml',
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.txt': 'text',
  '.xml': 'xml',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.zsh': 'shell'
}

function basename(value: string) {
  return value.split(/[\\/]/).filter(Boolean).pop() || value
}

function extension(value: string) {
  const clean = value.split(/[?#]/, 1)[0] || value
  const idx = clean.lastIndexOf('.')

  return idx >= 0 ? clean.slice(idx).toLowerCase() : ''
}

function joinPath(base: string, rel: string) {
  if (!base) {
    return rel
  }

  return `${base.replace(/\/+$/, '')}/${rel.replace(/^\.?\//, '')}`
}

function pathToFileUrl(path: string) {
  const encoded = path
    .split('/')
    .map(part => encodeURIComponent(part))
    .join('/')

  return `file://${encoded.startsWith('/') ? encoded : `/${encoded}`}`
}

export function localPreviewTarget(rawTarget: string, cwd?: string | null): PreviewTarget | null {
  const raw = rawTarget.trim().replace(/^`|`$/g, '')

  if (!raw) {
    return null
  }

  if (/^https?:\/\//i.test(raw)) {
    return { kind: 'url', label: basename(raw), source: raw, url: raw }
  }

  let path = raw

  if (/^file:\/\//i.test(raw)) {
    try {
      path = decodeURIComponent(new URL(raw).pathname)
    } catch {
      path = raw.replace(/^file:\/\//i, '')
    }
  } else if (!raw.startsWith('/') && cwd) {
    path = joinPath(cwd, raw)
  }

  const ext = extension(path)

  return {
    kind: 'file',
    label: basename(path),
    language: LANGUAGE_BY_EXT[ext] || 'text',
    path,
    // Renderer fallback can't stat/sniff without reading; classify by the
    // extension alone (the same routing Electron's normalizer applies) and
    // assume text otherwise. LocalFilePreview still guards binary/large files
    // when readFileText/readFileDataUrl returns metadata.
    previewKind: previewKindForExtension(ext),
    source: raw,
    url: pathToFileUrl(path)
  }
}

/** Mirrors `previewKindForFile` in electron/deliverables.ts, minus the byte sniff. */
export function previewKindForExtension(ext: string): NonNullable<PreviewTarget['previewKind']> {
  if (HTML_EXTENSIONS.has(ext)) {
    return 'html'
  }

  if (IMAGE_EXTENSIONS.has(ext)) {
    return 'image'
  }

  if (ext === '.pdf') {
    return 'pdf'
  }

  if (OFFICE_EXTENSIONS.has(ext)) {
    return 'document'
  }

  const kind = deliverableKind(`x${ext}`)

  if (kind === 'audio' || kind === 'video') {
    return 'media'
  }

  return 'text'
}

// Viewer kinds carry their own bytes path (data URL / stream); only text-ish
// targets need the remote read-text probe for binary/size metadata.
const SELF_LOADING_PREVIEW_KINDS = new Set<PreviewTarget['previewKind']>(['document', 'image', 'media', 'pdf'])

async function enrichPreviewTarget(target: PreviewTarget | null): Promise<PreviewTarget | null> {
  if (
    !isDesktopFsRemoteMode() ||
    !target ||
    target.kind !== 'file' ||
    SELF_LOADING_PREVIEW_KINDS.has(target.previewKind)
  ) {
    return target
  }

  try {
    const result = await readDesktopFileText(target.path || target.source)

    return {
      ...target,
      binary: result.binary,
      byteSize: result.byteSize,
      language: result.language || target.language,
      large: (result.byteSize ?? 0) > 512 * 1024,
      mimeType: result.mimeType
    }
  } catch {
    return target
  }
}

export async function normalizeOrLocalPreviewTarget(
  rawTarget: string,
  cwd?: string | null
): Promise<PreviewTarget | null> {
  try {
    const normalized = await window.agentxDesktop?.normalizePreviewTarget?.(rawTarget, cwd || undefined)

    if (normalized) {
      return enrichPreviewTarget(normalized)
    }
  } catch {
    // Running Electron may still have the old HTML-only preview IPC. Fall
    // through to renderer-side local classification so text/images still open.
  }

  return enrichPreviewTarget(localPreviewTarget(rawTarget, cwd))
}
