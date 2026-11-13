/**
 * What a conversation produced and what it drew on, read from its messages.
 *
 * Every row needs evidence — a path that is merely *mentioned* (in prose, in
 * inline code, in a command's output, in a search listing) proves nothing and
 * is left out. The list is only worth opening if what it shows is real.
 *
 * An OUTPUT is something the conversation made:
 *   - a file the backend verified (`createdFiles`: it exists and was written
 *     during the turn — this also covers a script that printed "Saved to …"),
 *   - the target of a successful call to a tool that writes,
 *   - an explicit hand-over in the reply: a link or image pointing at a file,
 *     a `MEDIA:` tag, an artifact fence.
 *
 * A SOURCE is something the conversation read or cited:
 *   - what the user attached, referenced (`@file:`), linked or named,
 *   - the target of a successful call to a tool that reads,
 *   - web search hits, and the web links a reply cites.
 *
 * A file that is both (read, then edited) is listed once, as an output.
 * Newest first, so the result of the last turn is the first row.
 */

import remarkParse from 'remark-parse'
import { unified } from 'unified'

import { referenceRe } from '@/components/assistant-ui/reference-kinds'
import {
  extractSearchResults,
  isFileEditTool,
  parseMaybeObject,
  toolPreviewTarget
} from '@/components/assistant-ui/tool/fallback-model'
import { artifactContentHash, type ArtifactDetection, artifactSlug, detectArtifact } from '@/lib/artifact-detect'
import type { ChatMessage, ChatMessagePart } from '@/lib/chat-messages'
import { isDeliverablePath, linkedFilePaths, linkifyDeliverablePaths } from '@/lib/deliverables'
import { embeddedImageUrls } from '@/lib/embedded-images'
import { generatedImageFromResult } from '@/lib/generated-images'
import { localPreviewTarget } from '@/lib/local-preview'
import { previewTargetFromMarkdownHref } from '@/lib/preview-targets'

export interface SessionResource {
  id: string
  kind: 'artifact' | 'file' | 'url'
  label: string
  target: string
  artifact?: { content: string; detection: ArtifactDetection }
  dataUrl?: string
  /** Set when another row has the same label: the folder that tells them apart. */
  folder?: string
}

export interface SessionResources {
  outputs: SessionResource[]
  sources: SessionResource[]
}

/** One budgeted pass over a transcript: what is known so far, and whether
 *  every message has been read. */
export interface SessionResourceProgress {
  complete: boolean
  resources: SessionResources
}

export interface SessionResourceCollector {
  /** Read the whole transcript now. */
  (messages: readonly ChatMessage[], cwd: string): SessionResources
  /** Read for at most `budgetMs` (newest messages first), keeping what was
   *  read for the next call. Call again until `complete`. */
  step(messages: readonly ChatMessage[], cwd: string, budgetMs: number): SessionResourceProgress
}

type ToolCallPart = Extract<ChatMessagePart, { type: 'tool-call' }>

/** One piece of evidence. `titled` — the label is a human title (link text, a
 *  search hit's title), which beats a label derived from the address. `order`
 *  — the message part it came from, so a turn lists its newest step first. */
interface Found {
  item: SessionResource
  order: number
  titled: boolean
}

interface MessageEvidence {
  aliases: Array<[string, SessionResource]>
  outputs: Found[]
  sources: Found[]
}

interface MarkdownNode {
  type: string
  children?: MarkdownNode[]
  value?: string
  url?: string
  title?: string
  alt?: string
  identifier?: string
  lang?: string
}

const parser = unified().use(remarkParse)

// ── What a tool call proves ──────────────────────────────────────────────

type ToolRole = 'reads' | 'searches' | 'writes'

// File edits come from the transcript's own table (isFileEditTool); these are
// the writers that are not edits.
const WRITE_TOOLS = new Set(['apply_patch', 'deliver_file', 'image_gen', 'image_generate', 'text_to_speech'])
const READ_TOOLS = new Set(['browser_navigate', 'read_file', 'vision_analyze', 'web_extract'])

// Tools whose path arguments are relative to the session's folder.
const WORKSPACE_FILE_TOOLS = new Set(['apply_patch', 'deliver_file', 'read_file'])

function toolRole(toolName: string): null | ToolRole {
  if (isFileEditTool(toolName) || WRITE_TOOLS.has(toolName)) {
    return 'writes'
  }

  if (READ_TOOLS.has(toolName)) {
    return 'reads'
  }

  return toolName === 'web_search' ? 'searches' : null
}

const PATH_KEYS = new Set([
  'path',
  'file',
  'filepath',
  'file_path',
  'output_path',
  'image_path',
  'audio_path',
  'video_path'
])

const URL_KEYS = new Set(['url', 'href', 'link', 'image_url', 'download_url', 'preview'])

// Result lists that say "these were produced", whichever tool returns them.
const DECLARED_OUTPUT_KEYS = new Set(['artifacts', 'files_created', 'files_modified', 'images', 'output_files'])
// Lists only a writing tool's result can be trusted to mean that by.
const WRITER_LIST_KEYS = new Set(['files', 'paths'])

const MACOS_PRIVATE_ROOT_RE = /^file:\/\/\/private\/(var|tmp|etc)\//
const ABSOLUTE_PATH_RE = /^(?:\/(?!\/)|~\/|[a-z]:[\\/]|\\\\|file:\/\/)/i
const WEB_URL_RE = /^(?:https?:\/\/|www\.)/i
const MEDIA_TAG_RE = /MEDIA:\s*(`[^`]+`|"[^"]+"|'[^']+'|\S+)/g
const BARE_URL_RE = /https?:\/\/[^\s<>"'`]+/gi
// Worth a markdown parse: links, images, reference definitions, fences,
// indented code. Prose without any of them is read with the patterns alone.
const MARKDOWN_STRUCTURE_RE = /\]\(|\]:|!\[|```|~~~|(?:^|\n)(?: {4}|\t)/

const unquote = (raw: string) => (/^[`"']/.test(raw) ? raw.slice(1, -1) : raw.replace(/[,.;!?]+$/, ''))

function toolFailed(part: ToolCallPart, result: Record<string, unknown>): boolean {
  return (
    Boolean(part.isError) ||
    result.success === false ||
    result.ok === false ||
    Boolean(result.error) ||
    /^(?:error|failed|failure)$/.test(String(result.status)) ||
    (typeof result.exit_code === 'number' && result.exit_code !== 0)
  )
}

// ── One address → one resource ───────────────────────────────────────────

interface ResourceOptions {
  /** Refuse a path that is not absolute — for evidence whose base folder is
   *  unknown (an arbitrary tool's result is not relative to the session). */
  absoluteOnly?: boolean
  label?: string
}

function resource(raw: string, cwd: string, { absoluteOnly = false, label }: ResourceOptions = {}): Found | null {
  let target = raw.trim()
  const inlineImage = /^data:image\/([a-z0-9+.-]+);base64,[a-z0-9+/=\r\n]+$/i.exec(target)

  if (inlineImage) {
    const ext = inlineImage[1].replace('svg+xml', 'svg').replace('jpeg', 'jpg')
    const id = `image:${artifactContentHash(target)}`

    return found({ id, kind: 'file', label: `image.${ext}`, target: id, dataUrl: target })
  }

  if (/^www\./i.test(target)) {
    target = `https://${target}`
  }

  if (!target || /^(?:data:|blob:|javascript:|mailto:|agentx:)/i.test(target)) {
    return null
  }

  if (/^#(?:file|media):/.test(target)) {
    try {
      target = decodeURIComponent(target.slice(target.indexOf(':') + 1))
    } catch {
      return null
    }
  } else if (target.startsWith('#preview')) {
    target = previewTargetFromMarkdownHref(target) || ''
  }

  if (!target || target.startsWith('#') || target.startsWith('//')) {
    return null
  }

  if (/^https?:\/\//i.test(target)) {
    try {
      const url = new URL(target)

      if (url.username || url.password) {
        return null
      }

      return found(
        {
          id: `url:${url.href}`,
          kind: 'url',
          label: label || `${url.hostname}${url.pathname === '/' ? '' : url.pathname}`,
          target: url.href
        },
        Boolean(label)
      )
    } catch {
      return null
    }
  }

  // Reject unknown schemes, while retaining Windows drive letters and UNC paths.
  if (/^[a-z][\w+.-]*:/i.test(target) && !/^(?:file:|[a-z]:[\\/])/i.test(target)) {
    return null
  }

  if (absoluteOnly && !ABSOLUTE_PATH_RE.test(target)) {
    return null
  }

  const resolved = localPreviewTarget(target, cwd)

  if (!resolved) {
    return null
  }

  // Canonicalize dot segments/percent encoding for links to the same local file.
  let id = resolved.url

  try {
    id = new URL(id).href
  } catch {
    /* Native path fallback stays usable. */
  }

  // macOS keeps /var, /tmp and /etc under /private; a reply says "/tmp/a.pdf"
  // where the backend, having resolved it, says "/private/tmp/a.pdf".
  id = id.replace(MACOS_PRIVATE_ROOT_RE, 'file:///$1/')

  return found({
    id: `file:${id}`,
    kind: 'file',
    // A prose link's label ("Report") must not replace the actual filename.
    label: (resolved.path || target).split(/[\\/]/).filter(Boolean).pop() || target,
    target: resolved.path || target
  })
}

const found = (item: SessionResource, titled = false): Found => ({ item, order: 0, titled })

function plainText(node: MarkdownNode): string {
  return node.value || node.children?.map(plainText).join('') || ''
}

/** A human title beats an address-derived label; otherwise the first wins. */
function keep(list: Map<string, Found>, entry: Found | null, order: number) {
  if (!entry) {
    return
  }

  const existing = list.get(entry.item.id)

  if (!existing) {
    list.set(entry.item.id, { ...entry, order })
  } else if (entry.titled && !existing.titled) {
    list.set(entry.item.id, { ...entry, order: existing.order })
  }
}

// ── One message → its evidence ───────────────────────────────────────────

/** Read one complete message, independent of which transcript rows are mounted. */
function messageEvidence(message: ChatMessage, cwd: string): MessageEvidence {
  const outputs = new Map<string, Found>()
  const sources = new Map<string, Found>()
  const aliases: Array<[string, SessionResource]> = []
  const assistant = message.role === 'assistant'
  let order = 0

  const output = (target: string, options?: ResourceOptions) => keep(outputs, resource(target, cwd, options), order)
  const source = (target: string, options?: ResourceOptions) => keep(sources, resource(target, cwd, options), order)

  /** A link the message makes on purpose. The user's are what they brought;
   *  the reply's hand over a file, or cite a page. */
  const link = (target: string, label: string | undefined, handover: boolean) => {
    const entry = resource(target, cwd, { label })

    if (!entry) {
      return
    }

    const made = assistant && (entry.item.kind !== 'url' || handover || isDeliverablePath(entry.item.target))

    keep(made ? outputs : sources, entry, order)
  }

  const scanUrls = (value: string) => {
    for (const match of value.matchAll(BARE_URL_RE)) {
      let url = match[0].replace(/[.,;!?]+$/, '')

      while (url.endsWith(')') && (url.match(/\)/g)?.length || 0) > (url.match(/\(/g)?.length || 0)) {
        url = url.slice(0, -1)
      }

      source(url)
    }
  }

  // A file the user names is one they are pointing at. The same path in a
  // reply is only a mention: what the turn really wrote arrives verified, as
  // `createdFiles`. (The path pattern leaves inline code alone by itself.)
  const scanNamedFiles = (value: string) => {
    if (!assistant) {
      for (const path of linkedFilePaths(linkifyDeliverablePaths(value))) {
        source(path)
      }
    }
  }

  const scanMarkdown = (text: string) => {
    const root = parser.parse(text) as MarkdownNode
    const definitions = new Map<string, MarkdownNode>()

    const collectDefinitions = (node: MarkdownNode) => {
      if (node.type === 'definition' && node.identifier) {
        definitions.set(node.identifier.toLowerCase(), node)
      }

      node.children?.forEach(collectDefinitions)
    }

    collectDefinitions(root)

    const visit = (node: MarkdownNode) => {
      if (node.type === 'code') {
        const detection = assistant && !message.pending ? detectArtifact(node.lang, node.value) : null

        if (detection && node.value) {
          const id = `artifact:${artifactSlug(detection)}`

          keep(
            outputs,
            found({
              id,
              kind: 'artifact',
              label: detection.title,
              target: id,
              artifact: { content: node.value, detection }
            }),
            order
          )
        }

        return
      }

      if (node.type === 'link' || node.type === 'image') {
        if (node.url) {
          link(
            node.url,
            node.title || node.alt || plainText(node),
            node.type === 'image' || node.url.startsWith('#preview')
          )
        }

        return
      }

      if (node.type === 'linkReference' || node.type === 'imageReference') {
        const definition = definitions.get(node.identifier?.toLowerCase() || '')

        if (definition?.url) {
          link(definition.url, node.alt || plainText(node), node.type === 'imageReference')
        }

        return
      }

      // Fenced code is skipped above; a URL in inline code is still a URL.
      if (node.type === 'text' || node.type === 'inlineCode') {
        scanUrls(node.value || '')
      }

      if (node.type === 'text') {
        scanNamedFiles(node.value || '')
      }

      node.children?.forEach(visit)
    }

    visit(root)
  }

  const scanText = (text: string) => {
    for (const url of embeddedImageUrls(text)) {
      keep(assistant ? outputs : sources, resource(url, cwd), order)
    }

    // Read off the raw text: a quoted reference or tag (`@file:\`a b.docx\``)
    // spans markdown nodes.
    for (const match of text.matchAll(referenceRe())) {
      if (['file', 'image', 'url'].includes(match[1])) {
        source(unquote(match[2] || ''))
      }
    }

    for (const match of text.matchAll(MEDIA_TAG_RE)) {
      keep(assistant ? outputs : sources, resource(unquote(match[1]), cwd), order)
    }

    if (MARKDOWN_STRUCTURE_RE.test(text)) {
      scanMarkdown(text)
    } else {
      scanUrls(text)
      scanNamedFiles(text)
    }
  }

  const scanToolCall = (part: ToolCallPart) => {
    // A call that is still running, or failed, proves nothing yet.
    if (part.result === undefined) {
      return
    }

    const args = parseMaybeObject(part.args)
    const result = parseMaybeObject(part.result)

    if (toolFailed(part, result)) {
      return
    }

    const role = toolRole(part.toolName)

    // MEDIA: is the gateway's explicit hand-over, whichever tool printed it.
    for (const text of [result.output, result.stdout, typeof part.result === 'string' ? part.result : null]) {
      if (typeof text === 'string') {
        for (const match of text.matchAll(MEDIA_TAG_RE)) {
          output(unquote(match[1]))
        }
      }
    }

    // Search hits, from web_search or any tool that answers in the same shape.
    if (role === 'searches' || !role) {
      for (const hit of extractSearchResults(part.result, Infinity)) {
        if (WEB_URL_RE.test(hit.url)) {
          source(hit.url, { label: hit.title })
        }
      }
    }

    if (role === 'searches') {
      return
    }

    // Only the session's own file tools take paths relative to its folder.
    const absoluteOnly = !(isFileEditTool(part.toolName) || WORKSPACE_FILE_TOOLS.has(part.toolName))

    for (const declared of declaredOutputs(part.result, role === 'writes')) {
      output(declared.target, { absoluteOnly, label: declared.label })
    }

    if (!role) {
      for (const [key, value] of Object.entries(args)) {
        if (typeof value === 'string' && URL_KEYS.has(key) && WEB_URL_RE.test(value)) {
          source(value)
        }
      }

      return
    }

    const add = role === 'writes' ? output : source

    // The backend resolves symlinks (e.g. macOS /var -> /private/var). Its
    // result is authoritative over the requested path; use that evidence to
    // reconcile attachments and prose links to the same file too.
    const requested = pathField(args)
    const resolved = pathField(result, 'resolved_path')
    const requestedFile = requested ? resource(requested, cwd, { absoluteOnly }) : null
    const resolvedFile = resolved ? resource(resolved, cwd, { absoluteOnly }) : null

    if (requestedFile?.item.kind === 'file' && resolvedFile?.item.kind === 'file') {
      // Also when both spell one id (/var vs /private/var): the row then
      // carries the path the backend actually used.
      if (requestedFile.item.id !== resolvedFile.item.id || requestedFile.item.target !== resolvedFile.item.target) {
        aliases.push([requestedFile.item.id, resolvedFile.item])
      }
    }

    if (role === 'writes') {
      const generated = generatedImageFromResult(part.result)

      if (generated) {
        output(generated)
      }
    }

    for (const [key, value] of Object.entries(args)) {
      if (typeof value === 'string' && (PATH_KEYS.has(key) || (URL_KEYS.has(key) && isAddress(value)))) {
        add(value, { absoluteOnly })
      } else if (key === 'urls' && Array.isArray(value)) {
        for (const url of value) {
          if (typeof url === 'string' && WEB_URL_RE.test(url)) {
            source(url)
          }
        }
      }
    }

    if (resolved) {
      add(resolved, { absoluteOnly })
    }

    const preview = toolPreviewTarget(part.toolName, args, result)

    if (preview && isAddress(preview)) {
      add(preview, { absoluteOnly })
    }
  }

  for (const ref of message.attachmentRefs || []) {
    scanText(ref)
  }

  for (const part of message.parts) {
    order += 1

    if (part.type === 'text') {
      scanText(part.text)
    } else if (part.type === 'image') {
      keep(assistant ? outputs : sources, resource(String(part.image), cwd), order)
    } else if (part.type === 'tool-call' && assistant) {
      scanToolCall(part)
    }
  }

  // The backend's verified list is the turn's last word.
  order += 1

  for (const file of message.createdFiles || []) {
    output(file.path, { label: file.name })
  }

  // Newest step first; a step's own rows stay in the order it gave them.
  const newestFirst = (list: Map<string, Found>) => [...list.values()].sort((a, b) => b.order - a.order)

  return { aliases, outputs: newestFirst(outputs), sources: newestFirst(sources) }
}

/** A URL, or a path that names its own root — not a bare word or host. */
function isAddress(value: string): boolean {
  return WEB_URL_RE.test(value) || ABSOLUTE_PATH_RE.test(value.trim())
}

function pathField(record: Record<string, unknown>, first?: string): string | undefined {
  return [first ? record[first] : undefined, record.path, record.file_path, record.filepath, record.file].find(
    (value): value is string => typeof value === 'string' && Boolean(value.trim())
  )
}

/** Files a result lists as produced, through JSON-encoded wrappers too. */
function declaredOutputs(result: unknown, writer: boolean): Array<{ label?: string; target: string }> {
  const out: Array<{ label?: string; target: string }> = []
  const seen = new Set<object>()

  const walk = (value: unknown, depth: number, listed: boolean) => {
    if (depth > 8 || value == null) {
      return
    }

    if (typeof value === 'string') {
      if (listed) {
        // patch reports a rename as "old -> new".
        out.push({ target: value.split(' -> ').pop() || value })
      } else if (/^\s*[[{]/.test(value)) {
        try {
          walk(JSON.parse(value), depth + 1, false)
        } catch {
          /* Not JSON. */
        }
      }

      return
    }

    if (typeof value !== 'object' || seen.has(value)) {
      return
    }

    seen.add(value)

    if (Array.isArray(value)) {
      value.forEach(item => walk(item, depth + 1, listed))

      return
    }

    const record = value as Record<string, unknown>

    const label =
      typeof record.title === 'string' ? record.title : typeof record.name === 'string' ? record.name : undefined

    for (const [key, child] of Object.entries(record)) {
      const lists = DECLARED_OUTPUT_KEYS.has(key) || (writer && WRITER_LIST_KEYS.has(key))

      if (typeof child === 'string' && listed && (PATH_KEYS.has(key) || URL_KEYS.has(key))) {
        out.push({ label, target: child })
      } else if (typeof child !== 'string' || lists || /^\s*[[{]/.test(child)) {
        walk(child, depth + 1, lists || listed)
      }
    }
  }

  walk(result, 0, false)

  return out
}

// ── Messages → the two lists ─────────────────────────────────────────────

/** Two files of the same name read as one row repeated; say which folder.
 *  Beside the name, not in it — the name is what gets read (and truncated) first. */
function distinguish(items: SessionResource[]): SessionResource[] {
  const count = new Map<string, number>()

  for (const item of items) {
    count.set(item.label, (count.get(item.label) || 0) + 1)
  }

  return items.map(item => {
    if (item.kind !== 'file' || item.dataUrl || (count.get(item.label) || 0) < 2) {
      return item
    }

    const folder = item.target.split(/[\\/]/).filter(Boolean).at(-2)

    return folder ? { ...item, folder } : item
  })
}

const sameList = (a: SessionResource[], b: SessionResource[]) =>
  a.length === b.length &&
  a.every((item, index) => {
    const other = b[index]

    return (
      item.id === other.id &&
      item.label === other.label &&
      item.folder === other.folder &&
      item.target === other.target &&
      item.artifact?.content === other.artifact?.content
    )
  })

/** Sealed messages are read once (by object identity); streaming only rereads
 *  the growing row. */
export function createSessionResourceCollector(): SessionResourceCollector {
  let cache = new WeakMap<ChatMessage, MessageEvidence>()
  let cacheCwd: string | undefined
  let previous: SessionResources = { outputs: [], sources: [] }

  const step = (messages: readonly ChatMessage[], cwd: string, budgetMs: number): SessionResourceProgress => {
    if (cacheCwd !== cwd) {
      cache = new WeakMap()
      cacheCwd = cwd
    }

    const deadline = performance.now() + budgetMs
    const evidence: MessageEvidence[] = []
    let read = 0
    let complete = true

    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]

      if (message.hidden || !['assistant', 'user'].includes(message.role)) {
        continue
      }

      let items = cache.get(message)

      if (!items) {
        if (message.pending) {
          // The growing row is reread every time and never kept.
          items = messageEvidence(message, cwd)
        } else if (read === 0 || performance.now() < deadline) {
          // Always at least one, so every call makes progress.
          items = messageEvidence(message, cwd)
          cache.set(message, items)
          read += 1
        } else {
          complete = false

          continue
        }
      }

      evidence.push(items)
    }

    const aliases = new Map<string, SessionResource>()

    // Oldest first, so the latest resolution of a path wins.
    for (let index = evidence.length - 1; index >= 0; index -= 1) {
      for (const [id, canonical] of evidence[index].aliases) {
        aliases.set(id, canonical)
      }
    }

    const canonical = (item: SessionResource): SessionResource => {
      const seen = new Set<string>()
      let current = item

      while (aliases.has(current.id) && !seen.has(current.id)) {
        seen.add(current.id)
        current = aliases.get(current.id)!
      }

      return current
    }

    const merge = (pick: (items: MessageEvidence) => Found[]) => {
      const merged = new Map<string, Found>()

      for (const items of evidence) {
        for (const entry of pick(items)) {
          const item = canonical(entry.item)

          keep(merged, item === entry.item ? entry : { ...entry, item }, 0)
        }
      }

      return merged
    }

    const outputs = merge(items => items.outputs)
    const sources = merge(items => items.sources)

    const next: SessionResources = {
      outputs: distinguish([...outputs.values()].map(entry => entry.item)),
      sources: distinguish([...sources.values()].filter(entry => !outputs.has(entry.item.id)).map(entry => entry.item))
    }

    if (!sameList(next.outputs, previous.outputs) || !sameList(next.sources, previous.sources)) {
      previous = next
    }

    return { complete, resources: previous }
  }

  return Object.assign(
    (messages: readonly ChatMessage[], cwd: string) => step(messages, cwd, Number.POSITIVE_INFINITY).resources,
    { step }
  )
}
