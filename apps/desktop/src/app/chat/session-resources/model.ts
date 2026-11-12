import remarkParse from 'remark-parse'
import { unified } from 'unified'

import { referenceRe } from '@/components/assistant-ui/reference-kinds'
import {
  extractSearchResults,
  parseMaybeObject,
  toolPreviewTarget
} from '@/components/assistant-ui/tool/fallback-model'
import { artifactContentHash, type ArtifactDetection, artifactSlug, detectArtifact } from '@/lib/artifact-detect'
import type { ChatMessage } from '@/lib/chat-messages'
import { isDeliverablePath, linkifyDeliverablePaths } from '@/lib/deliverables'
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
}

export interface SessionResources {
  outputs: SessionResource[]
  sources: SessionResource[]
}

interface CollectedMessageResources extends SessionResources {
  aliases: Array<[string, SessionResource]>
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

const OUTPUT_TOOLS = new Set([
  'write_file',
  'edit_file',
  'patch',
  'apply_patch',
  'deliver_file',
  'image_generate',
  'image_gen',
  'text_to_speech'
])

const INPUT_TOOLS = new Set([
  'read_file',
  'list_files',
  'search_files',
  'vision_analyze',
  'web_extract',
  'browser_navigate',
  'web_search'
])

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
const FILE_LIST_KEYS = new Set(['files', 'files_created', 'output_files', 'artifacts', 'images', 'paths'])

function resource(raw: string, cwd: string, label?: string): SessionResource | null {
  let target = raw.trim()
  const inlineImage = /^data:image\/([a-z0-9+.-]+);base64,[a-z0-9+/=\r\n]+$/i.exec(target)

  if (inlineImage) {
    const ext = inlineImage[1].replace('svg+xml', 'svg').replace('jpeg', 'jpg')
    const id = `image:${artifactContentHash(target)}`

    return { id, kind: 'file', label: `image.${ext}`, target: id, dataUrl: target }
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

      return {
        id: `url:${url.href}`,
        kind: 'url',
        label: label || `${url.hostname}${url.pathname === '/' ? '' : url.pathname}`,
        target: url.href
      }
    } catch {
      return null
    }
  }

  // Reject unknown schemes, while retaining Windows drive letters and UNC paths.
  if (/^[a-z][\w+.-]*:/i.test(target) && !/^(?:file:|[a-z]:[\\/])/i.test(target)) {
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

  return {
    id: `file:${id}`,
    kind: 'file',
    // A prose link's label ("Report") must not replace the actual filename.
    label: (resolved.path || target).split(/[\\/]/).filter(Boolean).pop() || target,
    target: resolved.path || target
  }
}

function plainText(node: MarkdownNode): string {
  return node.value || node.children?.map(plainText).join('') || ''
}

/** Extract from the complete message, independent of mounted transcript rows. */
function messageResources(message: ChatMessage, cwd: string): CollectedMessageResources {
  const outputs = new Map<string, SessionResource>()
  const sources = new Map<string, SessionResource>()
  const aliases: Array<[string, SessionResource]> = []

  const add = (to: Map<string, SessionResource>, target: string, label?: string) => {
    const item = resource(target, cwd, label)

    if (item && !to.has(item.id)) {
      to.set(item.id, item)
    }
  }

  const assistant = message.role === 'assistant'

  const addLink = (target: string, label?: string, explicitOutput = false, outputContext = assistant) => {
    const item = resource(target, cwd, label)

    if (item) {
      ;(outputContext && (item.kind !== 'url' || explicitOutput || isDeliverablePath(item.target))
        ? outputs
        : sources
      ).set(item.id, item)
    }
  }

  const scanText = (text: string, outputContext = assistant) => {
    for (const url of embeddedImageUrls(text)) {
      add(outputContext ? outputs : sources, url)
    }

    const link = (target: string, label?: string, explicitOutput = false) =>
      addLink(target, label, explicitOutput, outputContext)

    for (const match of text.matchAll(referenceRe())) {
      if (!['file', 'image', 'url'].includes(match[1])) {
        continue
      }

      const raw = match[2] || ''
      add(sources, /^[`"']/.test(raw) ? raw.slice(1, -1) : raw.replace(/[,.;!?]+$/, ''))
    }

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
        const detection = outputContext && !message.pending ? detectArtifact(node.lang, node.value) : null

        if (detection && node.value) {
          const id = `artifact:${artifactSlug(detection)}`
          outputs.set(id, {
            id,
            kind: 'artifact',
            label: detection.title,
            target: id,
            artifact: { content: node.value, detection }
          })
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

      if (node.type === 'text' || node.type === 'inlineCode') {
        const value = node.value || ''

        // Explicit path handoffs are not limited to known document extensions.
        if (node.type === 'inlineCode' && /^(?:\/|~\/|[a-z]:[\\/]|\\\\).+/i.test(value) && !value.includes('\n')) {
          link(value)
        }

        for (const match of value.matchAll(
          /(?:^|[\s"'])(\/(?:[^\s"'<>`]+\/)*[^\s"'<>`/]+\.[\p{L}\p{N}_-]+)(?=$|[\s"'<>`])/gu
        )) {
          link(match[1])
        }

        for (const match of value.matchAll(referenceRe())) {
          const kind = match[1]
          const raw = match[2] || ''
          const quoted = /^[`"']/.test(raw)
          const target = quoted ? raw.slice(1, -1) : raw.replace(/[,.;!?]+$/, '')

          if (['file', 'image', 'url'].includes(kind)) {
            add(sources, target)
          }
        }

        // Bare web links in prose/tool stdout; code fences are deliberately excluded.
        for (const match of value.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
          let url = match[0].replace(/[.,;!?]+$/, '')

          while (url.endsWith(')') && (url.match(/\)/g)?.length || 0) > (url.match(/\(/g)?.length || 0)) {
            url = url.slice(0, -1)
          }

          add(sources, url)
        }

        for (const match of linkifyDeliverablePaths(value).matchAll(/\]\(#file:([^)]+)\)/g)) {
          link(`#file:${match[1]}`)
        }

        for (const match of value.matchAll(/MEDIA:\s*(`[^`]+`|"[^"]+"|'[^']+'|\S+)/g)) {
          const raw = match[1]
          link(/^[`"']/.test(raw) ? raw.slice(1, -1) : raw, undefined, true)
        }
      }

      node.children?.forEach(visit)
    }

    visit(root)
  }

  for (const file of message.createdFiles || []) {
    add(outputs, file.path, file.name)
  }

  for (const ref of message.attachmentRefs || []) {
    scanText(ref, false)
  }

  for (const part of message.parts) {
    if (part.type === 'text') {
      scanText(part.text)
    } else if (part.type === 'image') {
      add(assistant ? outputs : sources, String(part.image))
    } else if (part.type === 'tool-call') {
      const args = parseMaybeObject(part.args)
      const result = parseMaybeObject(part.result)

      const failed =
        part.isError ||
        result.success === false ||
        result.ok === false ||
        Boolean(result.error) ||
        /^(?:error|failed|failure)$/.test(String(result.status))

      const produced = OUTPUT_TOOLS.has(part.toolName) && !failed && part.result !== undefined
      const destination = produced ? outputs : sources

      // The backend resolves symlinks (e.g. macOS /var -> /private/var).
      // Its successful file-operation result is authoritative over the requested
      // path; use that evidence to reconcile attachments and prose links too.
      if (!failed && ['deliver_file', 'write_file', 'edit_file', 'read_file'].includes(part.toolName)) {
        const requestedPath = [args.path, args.file_path, args.filepath, args.file].find(
          value => typeof value === 'string'
        )

        const resolvedPath = [result.path, result.file_path, result.filepath, result.file].find(
          value => typeof value === 'string'
        )

        const requested = typeof requestedPath === 'string' ? resource(requestedPath, cwd) : null
        const resolved = typeof resolvedPath === 'string' ? resource(resolvedPath, cwd) : null

        if (requested?.kind === 'file' && resolved?.kind === 'file' && requested.id !== resolved.id) {
          aliases.push([requested.id, resolved])
        }
      }

      const generatedImage =
        part.toolName === 'image_generate' && !failed ? generatedImageFromResult(part.result) : null

      if (generatedImage) {
        add(outputs, generatedImage)
      }

      if (INPUT_TOOLS.has(part.toolName) || produced) {
        for (const [key, value] of Object.entries(args)) {
          if (typeof value === 'string' && (PATH_KEYS.has(key) || URL_KEYS.has(key))) {
            add(destination, value)
          }

          if (key === 'urls' && Array.isArray(value)) {
            for (const url of value) {
              if (typeof url === 'string') {
                add(sources, url)
              }
            }
          }
        }
      }

      // Walk structured provider/plugin payloads, including JSON-encoded wrappers.
      const seen = new Set<object>()

      const walk = (value: unknown, depth = 0, fileList = false) => {
        if (depth > 12 || value == null) {
          return
        }

        if (typeof value === 'string') {
          if (fileList) {
            add(failed || INPUT_TOOLS.has(part.toolName) ? sources : outputs, value)
          } else if (/^\s*[[{]/.test(value)) {
            try {
              walk(JSON.parse(value), depth + 1)
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
          value.forEach(item => walk(item, depth + 1, fileList))

          return
        }

        const record = value as Record<string, unknown>

        const label =
          typeof record.title === 'string' ? record.title : typeof record.name === 'string' ? record.name : undefined

        for (const [key, child] of Object.entries(record)) {
          if (typeof child === 'string' && (PATH_KEYS.has(key) || URL_KEYS.has(key))) {
            add(fileList && !failed && !INPUT_TOOLS.has(part.toolName) ? outputs : destination, child, label)
          } else if (typeof child !== 'string' || FILE_LIST_KEYS.has(key) || /^\s*[[{]/.test(child)) {
            walk(child, depth + 1, FILE_LIST_KEYS.has(key) || fileList)
          }
        }
      }

      walk(part.result)

      for (const hit of extractSearchResults(part.result, Infinity)) {
        if (hit.url) {
          add(sources, hit.url, hit.title)
        }
      }

      const preview = toolPreviewTarget(part.toolName, args, result)

      if (preview) {
        add(produced ? outputs : sources, preview)
      }

      // Terminal tools often hand over files as markdown/MEDIA rather than fields.
      for (const value of [
        result.output,
        result.stdout,
        result.context,
        typeof part.result === 'string' ? part.result : null
      ]) {
        if (!failed && typeof value === 'string') {
          scanText(value, !INPUT_TOOLS.has(part.toolName))
        }
      }
    }
  }

  return { outputs: [...outputs.values()], sources: [...sources.values()], aliases }
}

/** Cache sealed messages by object identity; streaming only reparses the growing row. */
export function createSessionResourceCollector() {
  let cache = new WeakMap<ChatMessage, CollectedMessageResources>()
  let cacheCwd: string | undefined
  let previous: SessionResources = { outputs: [], sources: [] }

  return (messages: readonly ChatMessage[], cwd: string): SessionResources => {
    if (cacheCwd !== cwd) {
      cache = new WeakMap()
      cacheCwd = cwd
    }

    const outputs = new Map<string, SessionResource>()
    const sources = new Map<string, SessionResource>()
    const aliases = new Map<string, SessionResource>()

    for (const message of messages) {
      if (message.hidden || !['assistant', 'user'].includes(message.role)) {
        continue
      }

      let items = cache.get(message)

      if (!items) {
        items = messageResources(message, cwd)

        if (!message.pending) {
          cache.set(message, items)
        }
      }

      for (const item of items.outputs) {
        outputs.set(item.id, item)
      }

      for (const item of items.sources) {
        sources.set(item.id, item)
      }

      for (const [id, canonical] of items.aliases) {
        aliases.set(id, canonical)
      }
    }

    const reconcile = (items: Map<string, SessionResource>) => {
      const result = new Map<string, SessionResource>()

      for (const item of items.values()) {
        let canonical = item
        const seen = new Set<string>()

        while (aliases.has(canonical.id) && !seen.has(canonical.id)) {
          seen.add(canonical.id)
          canonical = aliases.get(canonical.id)!
        }

        result.set(canonical.id, canonical)
      }

      return [...result.values()]
    }

    const next = { outputs: reconcile(outputs), sources: reconcile(sources) }

    const same = (a: SessionResource[], b: SessionResource[]) =>
      a.length === b.length &&
      a.every((item, index) => {
        const other = b[index]

        return (
          item.id === other.id &&
          item.label === other.label &&
          item.target === other.target &&
          item.artifact?.content === other.artifact?.content
        )
      })

    if (same(next.outputs, previous.outputs) && same(next.sources, previous.sources)) {
      return previous
    }

    previous = next

    return next
  }
}
