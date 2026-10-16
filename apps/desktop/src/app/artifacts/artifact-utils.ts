import { translateNow } from '@/i18n'
import { messageCreatedFiles, renderMediaTags } from '@/lib/chat-messages'
import { linkedFilePaths } from '@/lib/deliverables'
import { deliveredFileFromResult } from '@/lib/delivered-file'
import { readDesktopFileDataUrl } from '@/lib/desktop-fs'
import { filePathFromMediaPath, isRemoteGateway, mediaExternalUrl, mediaKind } from '@/lib/media'
import type { SessionInfo, SessionMessage } from '@/types/hermes'

export type ArtifactKind = 'image' | 'file'
export type ArtifactFilter = 'all' | ArtifactKind
export const ARTIFACT_FILTERS: readonly ArtifactFilter[] = ['all', 'image', 'file']

export interface ArtifactRecord {
  id: string
  kind: ArtifactKind
  value: string
  href: string
  label: string
  sessionId: string
  sessionTitle: string
  timestamp: number
}

// What counts as an artifact: something AgentX MADE for the user, never a
// string that merely looks like a URL or a path. The page used to regex every
// assistant reply and every raw tool output, so each link the agent cited,
// each path in an `ls -la`, even a regex literal (`/\.0$/` → ".0$") landed
// here as an "artifact" — 100+ entries the user never asked to keep. The
// signals below are the ones the backend and tools emit on purpose:
//
//  - `deliver_file` results — the agent handing a file over;
//  - `display_metadata.files_created` — documents/media a turn wrote;
//  - `MEDIA:` tags — media the agent (or a speech tool) attaches for delivery;
//  - an image tool's result — a generated picture;
//  - a markdown image whose source is a LOCAL file or inline data — a chart or
//    render the agent drew and showed (a remote image is someone else's).

/** Tools whose successful result is an image made for the user. */
const IMAGE_RESULT_TOOLS = new Set(['image_generate'])

const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\(\s*([^)\s]+)[^)]*\)/g
// A file on disk: POSIX absolute, home-relative, file://, Windows drive or UNC.
const LOCAL_PATH_RE = /^(?:file:|\/|~\/|[a-z]:[\\/]|\\\\)/i

interface Candidate {
  value: string
  /** Set when the source knows better than the extension (a generated image URL). */
  kind?: ArtifactKind
  /** Set when the source names the file (deliver_file / files_created). */
  label?: string
}

function artifactSessionTitle(session: SessionInfo): string {
  return session.title?.trim() || session.preview?.trim() || translateNow('sidebar.row.untitledPlaceholder')
}

function messageText(message: SessionMessage): string {
  if (typeof message.content === 'string' && message.content.trim()) {
    return message.content
  }

  if (typeof message.text === 'string' && message.text.trim()) {
    return message.text
  }

  return ''
}

function parseJsonObject(text: string): null | Record<string, unknown> {
  if (!text.trim().startsWith('{')) {
    return null
  }

  try {
    const value: unknown = JSON.parse(text)

    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function artifactKind(candidate: Candidate): ArtifactKind {
  if (candidate.kind) {
    return candidate.kind
  }

  return candidate.value.startsWith('data:image/') || mediaKind(candidate.value) === 'image' ? 'image' : 'file'
}

function artifactHref(value: string): string {
  return /^(?:https?|data):/i.test(value) ? value : mediaExternalUrl(value)
}

export async function artifactImageSrc(value: string, href = artifactHref(value)): Promise<string> {
  if (/^(?:https?|data):/i.test(value)) {
    return href
  }

  if (typeof window !== 'undefined' && window.agentxDesktop && isRemoteGateway()) {
    return readDesktopFileDataUrl(filePathFromMediaPath(value))
  }

  return href
}

function artifactLabel(value: string): string {
  // An inline image (a data URL) has no file name; "image.png" reads as one
  // instead of the base64 tail the URL parser would otherwise hand back.
  const inline = /^data:image\/([a-z0-9.+-]+)/i.exec(value)

  if (inline) {
    const ext = inline[1]
      .toLowerCase()
      .replace(/^svg\+xml$/, 'svg')
      .replace(/^jpeg$/, 'jpg')

    return `image.${ext}`
  }

  // Only real URLs go through the URL parser: `C:\Users\…\report.docx` would
  // parse as scheme "c:" and hand back the whole path as its "name".
  if (/^(?:https?|file):/i.test(value)) {
    try {
      const item = new URL(value).pathname.split('/').filter(Boolean).pop()

      return item ? decodeURIComponent(item) : value
    } catch {
      // Malformed URL or escape: fall through to the plain split.
    }
  }

  return value.split(/[\\/]/).filter(Boolean).pop() || value
}

/** Paths behind `MEDIA:` tags (and explicit `#file:` / `#media:` links). Bare
 *  paths in prose are NOT linkified here — a path mentioned is not a file made. */
function taggedMediaPaths(text: string): string[] {
  return /MEDIA:|#(?:file|media):/.test(text) ? linkedFilePaths(renderMediaTags(text)) : []
}

/** The image URL(s) an image tool reports: `image`, or an `images` list of
 *  URLs / `{ url }` records. */
function resultImageUrls(result: Record<string, unknown>): string[] {
  const urls: string[] = []

  const take = (value: unknown) => {
    if (typeof value === 'string' && value) {
      urls.push(value)
    } else if (value && typeof value === 'object' && typeof (value as { url?: unknown }).url === 'string') {
      urls.push((value as { url: string }).url)
    }
  }

  take(result.image)

  if (Array.isArray(result.images)) {
    result.images.forEach(take)
  }

  return urls
}

function collectFromAssistant(message: SessionMessage, push: (candidate: Candidate) => void): void {
  for (const file of messageCreatedFiles(message.display_metadata)) {
    push({ label: file.name, value: file.path })
  }

  const text = messageText(message)

  if (!text) {
    return
  }

  for (const path of taggedMediaPaths(text)) {
    push({ value: path })
  }

  for (const match of text.matchAll(MARKDOWN_IMAGE_RE)) {
    const src = match[1] || ''

    if (src.startsWith('data:image/') || LOCAL_PATH_RE.test(src)) {
      push({ kind: 'image', value: src })
    }
  }
}

function collectFromTool(message: SessionMessage, toolName: string, push: (candidate: Candidate) => void): void {
  if (toolName === 'deliver_file') {
    const delivered = deliveredFileFromResult(message.content)

    if (delivered) {
      push({ label: delivered.name, value: delivered.path })
    }

    return
  }

  const result = parseJsonObject(messageText(message))

  if (!result) {
    return
  }

  if (IMAGE_RESULT_TOOLS.has(toolName) && result.success === true) {
    for (const url of resultImageUrls(result)) {
      push({ kind: 'image', value: url })
    }
  }

  // A media-making tool (text-to-speech) tags its output for delivery.
  if (typeof result.media_tag === 'string') {
    for (const path of taggedMediaPaths(result.media_tag)) {
      push({ value: path })
    }
  }
}

/** Tool name per call id, from the assistant rows' `tool_calls` — the fallback
 *  for a stored tool row that doesn't carry its own `tool_name`. */
function toolNamesByCallId(messages: SessionMessage[]): Map<string, string> {
  const names = new Map<string, string>()

  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) {
      continue
    }

    for (const call of message.tool_calls as Array<{ function?: { name?: unknown }; id?: unknown }>) {
      if (typeof call?.id === 'string' && typeof call.function?.name === 'string') {
        names.set(call.id, call.function.name)
      }
    }
  }

  return names
}

export function collectArtifactsForSession(session: SessionInfo, messages: SessionMessage[]): ArtifactRecord[] {
  const found = new Map<string, ArtifactRecord>()
  const title = artifactSessionTitle(session)
  const callNames = toolNamesByCallId(messages)

  for (const message of messages) {
    const push = (candidate: Candidate) => {
      const value = candidate.value.trim()

      if (!value) {
        return
      }

      const key = `${session.id}:${value}`

      if (found.has(key)) {
        return
      }

      found.set(key, {
        id: key,
        kind: artifactKind({ ...candidate, value }),
        value,
        href: artifactHref(value),
        label: candidate.label || artifactLabel(value),
        sessionId: session.id,
        sessionTitle: title,
        // DB timestamps (message.timestamp, session.last_active, session.started_at)
        // are Unix epoch **seconds**. JS Date() expects **milliseconds**, so multiply by 1000.
        // Date.now() returns ms, so divide by 1000 to keep the conversion uniform.
        timestamp: (message.timestamp || session.last_active || session.started_at || Date.now() / 1000) * 1000
      })
    }

    if (message.role === 'assistant') {
      collectFromAssistant(message, push)
    } else if (message.role === 'tool') {
      const toolName = message.tool_name || (message.tool_call_id ? callNames.get(message.tool_call_id) : '') || ''

      collectFromTool(message, toolName, push)
    }
  }

  return Array.from(found.values())
}
