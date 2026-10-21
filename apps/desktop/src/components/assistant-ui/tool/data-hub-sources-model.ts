// Results of the hub's Data Hub server (`agentx-data`) — the contract is the
// hub's docs/data-hub/agents.md. The desktop only sees tool names, and the
// server can be reached as its own entry or inside a hub toolset (whose tools
// are `mcp__<entry>__<alias>_<tool>`), so a result is read as Data Hub's when
// the tool's name ends in one of its passage tools AND the payload has the
// contract's shape (verdict, `rs_` result id, notice); anything else keeps
// the ordinary tool row. Display only: what may be offered or exported is the
// backend's decision.

import { translationsNow } from '@/i18n'

/** Every tool of a Data Hub server: hub server `agentx-data` becomes the
 *  `mcp_servers` entry `agentx-agentx-data` (a second one gets a numeric
 *  suffix), whose tools are `mcp__agentx_agentx_data__<tool>`. */
export const DATA_HUB_TOOL_RE = /^mcp__agentx_agentx_data(?:_\d+)?__\w+$/

/** The two tools whose results are passages, shown as source cards: of the
 *  server's own entry, or of a toolset entry that holds it. */
export const DATA_HUB_SOURCE_TOOL_RE = /^mcp__\w+?__(?:\w*_)?(?:search_knowledge|read_passage_context)$/

export const isDataHubToolName = (name: unknown): boolean => typeof name === 'string' && DATA_HUB_TOOL_RE.test(name)

export const isDataHubSourceTool = (name: unknown): boolean =>
  typeof name === 'string' && DATA_HUB_SOURCE_TOOL_RE.test(name)

export type DataHubResultKind = 'evidence' | 'knowledge_bases' | 'no_evidence'

export interface DataHubLocation {
  kind: string
  [key: string]: unknown
}

export interface DataHubPassage {
  cite: string
  document: { id: string; sourceType: string; title: string }
  flags: string[]
  knowledgeBase: { id: string; name: string; slug: string }
  location: DataHubLocation
  openUrl: string
  passageId: string
  ref: string
  version: { indexedAt: string; number: null | number; sourceUpdatedAt: string }
}

export interface DataHubResult {
  /** `knowledge_bases` results: how many stores the person can search. */
  knowledgeBaseCount: number
  passages: DataHubPassage[]
  result: DataHubResultKind
  resultId: string
}

const RESULT_KINDS: ReadonlySet<string> = new Set(['evidence', 'knowledge_bases', 'no_evidence'])

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json => Boolean(value && typeof value === 'object' && !Array.isArray(value))

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

const record = (value: unknown): Json => (isRecord(value) ? value : {})

// A stored tool row is wrapped as untrusted data by the agent
// (agent/tool_dispatch_helpers.py `_maybe_wrap_untrusted`):
//   <untrusted_tool_result source="…">\n<one sentence>\n\n{…}\n</untrusted_tool_result>
// The sentence holds no brace, and a delimiter inside the payload is
// neutralised to `untrusted-tool-result`, so the payload runs from the first
// `{` to the last `}`.
const UNTRUSTED_OPEN_RE = /^\s*<untrusted[_-]tool[_-]result\b[^>]*>/i

function stripUntrustedWrapper(value: string): string {
  if (!UNTRUSTED_OPEN_RE.test(value)) {
    return value
  }

  const start = value.indexOf('{')
  const end = value.lastIndexOf('}')

  return start >= 0 && end > start ? value.slice(start, end + 1) : value
}

function isDataHubRecord(value: Json): boolean {
  return (
    typeof value.result === 'string' &&
    RESULT_KINDS.has(value.result) &&
    typeof value.result_id === 'string' &&
    value.result_id.startsWith('rs_') &&
    typeof value.notice === 'string'
  )
}

function passageFrom(value: unknown): DataHubPassage | null {
  if (!isRecord(value)) {
    return null
  }

  const kb = record(value.knowledge_base)
  const doc = record(value.document)
  const version = record(value.version)
  const location = record(value.location)
  const versionNumber = typeof version.number === 'number' && Number.isFinite(version.number) ? version.number : null

  return {
    cite: text(value.cite),
    document: { id: text(doc.id), sourceType: text(doc.source_type), title: text(doc.title) },
    flags: Array.isArray(value.flags) ? value.flags.filter((flag): flag is string => typeof flag === 'string') : [],
    knowledgeBase: { id: text(kb.id), name: text(kb.name), slug: text(kb.slug) },
    location: { ...location, kind: text(location.kind) || 'none' },
    openUrl: text(value.open_url),
    passageId: text(value.passage_id),
    ref: text(value.ref),
    version: {
      indexedAt: text(version.indexed_at),
      number: versionNumber,
      sourceUpdatedAt: text(version.source_updated_at)
    }
  }
}

function resultFrom(value: Json): DataHubResult {
  return {
    knowledgeBaseCount: Array.isArray(value.items) ? value.items.length : 0,
    passages: Array.isArray(value.passages)
      ? value.passages.map(passageFrom).filter((p): p is DataHubPassage => p !== null)
      : [],
    result: value.result as DataHubResultKind,
    resultId: String(value.result_id)
  }
}

function parseLayer(value: unknown, depth: number): DataHubResult | null {
  if (depth > 4) {
    return null
  }

  if (typeof value === 'string') {
    const body = stripUntrustedWrapper(value).trim()

    if (!body.startsWith('{')) {
      return null
    }

    try {
      return parseLayer(JSON.parse(body), depth + 1)
    } catch {
      return null
    }
  }

  if (!isRecord(value)) {
    return null
  }

  if (isDataHubRecord(value)) {
    return resultFrom(value)
  }

  // An MCP success is packaged as `{"result": "<the server's text>"}`; the
  // live event may add the desktop's `duration_s` beside it.
  return 'result' in value ? parseLayer(value.result, depth + 1) : null
}

/**
 * A Data Hub result out of a tool result as the desktop holds it: the live
 * event's JSON or a reloaded row's text (untrusted-data wrapper included).
 * `null` when it does not have the contract's shape.
 */
export function parseDataHubResult(value: unknown): DataHubResult | null {
  return parseLayer(value, 0)
}

/** "12/10/2026" in local time, or '' for a value that is no date. */
export function formatDayMonthYear(value: string): string {
  const date = value ? new Date(value) : null

  if (!date || Number.isNaN(date.getTime())) {
    return ''
  }

  const pad = (n: number) => String(n).padStart(2, '0')

  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`
}

const positiveInt = (value: unknown): null | number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null

function headingPath(value: unknown): string {
  return Array.isArray(value)
    ? value
        .filter((part): part is string => typeof part === 'string' && Boolean(part.trim()))
        .map(part => part.trim())
        .join(' › ')
    : ''
}

function rowRange(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim()
  }

  if (typeof value === 'number') {
    return String(value)
  }

  const bounds = Array.isArray(value)
    ? value
    : isRecord(value)
      ? [value.start ?? value.from, value.end ?? value.to]
      : []

  const [from, to] = bounds.map(positiveInt)

  if (from && to && to !== from) {
    return `${from}–${to}`
  }

  return from ? String(from) : ''
}

/** Where in its document a passage sits, in the display language. */
export function formatDataHubLocation(location: DataHubLocation): string {
  const copy = translationsNow().assistant.tool.dataHub.location

  switch (location.kind) {
    case 'page': {
      const page = positiveInt(location.page)

      if (page) {
        const end = positiveInt(location.page_end)

        return copy.page(page, end && end > page ? end : null)
      }

      break
    }

    case 'slide': {
      const slide = positiveInt(location.slide)

      if (slide) {
        return copy.slide(slide)
      }

      break
    }

    case 'sheet': {
      const sheet = text(location.sheet).trim()

      if (sheet) {
        return copy.sheet(sheet, rowRange(location.rows))
      }

      break
    }

    case 'section': {
      const path = headingPath(location.heading_path)

      if (path) {
        return copy.section(path)
      }

      break
    }

    case 'message': {
      return copy.message(text(location.author).trim(), formatDayMonthYear(text(location.sent_at)))
    }
  }

  return copy.none
}

/** "phiên bản 3 · cập nhật 12/10/2026" — the parts the passage has. */
export function formatDataHubVersion(version: DataHubPassage['version']): string {
  const copy = translationsNow().assistant.tool.dataHub
  const updated = formatDayMonthYear(version.sourceUpdatedAt) || formatDayMonthYear(version.indexedAt)

  return [version.number === null ? '' : copy.version(version.number), updated ? copy.updated(updated) : '']
    .filter(Boolean)
    .join(' · ')
}

/** A flag's badge text; a flag this build has no words for shows as sent. */
export function dataHubFlagLabel(flag: string): string {
  const labels: Record<string, string> = translationsNow().assistant.tool.dataHub.flags

  return Object.prototype.hasOwnProperty.call(labels, flag) ? labels[flag] : flag
}

/**
 * The one line a Data Hub result reads as in a tool row ("3 nguồn",
 * "Không tìm thấy trong dữ liệu"), or '' when *value* is not one.
 */
export function dataHubResultSummary(value: unknown): string {
  const parsed = parseDataHubResult(value)

  if (!parsed) {
    return ''
  }

  const copy = translationsNow().assistant.tool.dataHub

  if (parsed.result === 'knowledge_bases') {
    return copy.knowledgeBaseCount(parsed.knowledgeBaseCount)
  }

  return parsed.result === 'evidence' && parsed.passages.length
    ? copy.sourceCount(parsed.passages.length)
    : copy.noEvidence
}

/** `url` when it is an http(s) link — the only kind a source card opens. */
export function safeSourceUrl(url: string): string {
  try {
    const parsed = new URL(url)

    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : ''
  } catch {
    return ''
  }
}
