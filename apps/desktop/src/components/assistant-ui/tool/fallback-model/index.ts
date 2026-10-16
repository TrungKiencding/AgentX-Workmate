import { type ToolTitleKey, translateNow, translationsNow } from '@/i18n'
import { normalizeExternalUrl } from '@/lib/external-link'
import { summarizeShellCommand } from '@/lib/summarize-command'
import { capitalize, normalize } from '@/lib/text'
import { getTimeFormatLocale } from '@/lib/time'
import { extractToolErrorMessage, formatToolResultSummary } from '@/lib/tool-result-summary'

import {
  clampForDisplay,
  compactPreview,
  contextValue,
  formatDurationSeconds,
  isRecord,
  numberValue,
  parseMaybeObject,
  plainTextResult,
  unwrapToolPayload
} from './format'
import { findFirstUrl, hostnameOf, looksLikePath, looksLikeUrl } from './targets'
import type {
  CountMetric,
  MessageRunningStateSlice,
  SearchResultRow,
  ToolMeta,
  ToolMetaSpec,
  ToolPart,
  ToolStatus,
  ToolTitleAction,
  ToolTone,
  ToolView
} from './types'

export * from './format'
export * from './targets'
export * from './types'

const FILE_EDIT_TOOL_NAMES = new Set(['edit_file', 'patch', 'write_file'])

export function isFileEditTool(toolName: string): boolean {
  return FILE_EDIT_TOOL_NAMES.has(toolName)
}

export interface DiffLineStats {
  added: number
  removed: number
}

export function countDiffLineStats(diff: string): DiffLineStats {
  let added = 0
  let removed = 0

  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      added += 1
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      removed += 1
    }
  }

  return { added, removed }
}

export function fileEditPath(args: Record<string, unknown>, result: Record<string, unknown>): string {
  return (
    firstStringField(args, ['path', 'file', 'filepath']) ||
    firstStringField(result, ['path', 'file', 'filepath', 'resolved_path']) ||
    htmlPathFromInlineDiff(firstStringField(result, ['inline_diff', 'diff']))
  )
}

export function fileEditBasename(path: string): string {
  const normalized = path.replace(/\\/g, '/').trim()

  return normalized.split('/').filter(Boolean).pop() || normalized
}

function numericField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]

  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readFileLineLabel(args: Record<string, unknown>, result: Record<string, unknown>): string {
  if (numericField(args, 'offset') === undefined && numericField(args, 'limit') === undefined) {
    return ''
  }

  const content = firstStringField(result, ['content'])
  const offset = numericField(args, 'offset')
  const limit = numericField(args, 'limit')

  if (offset !== undefined && offset > 0) {
    if (limit === undefined || limit <= 1) {
      return `L${offset}`
    }

    return `L${offset}-${offset + limit - 1}`
  }

  const lines = content
    .split('\n')
    .map(line => /^(\d+)\|/.exec(line)?.[1])
    .filter((line): line is string => !!line)
    .map(Number)

  if (lines.length === 0) {
    return ''
  }

  const start = lines[0]!
  const end = lines[lines.length - 1]!

  return start === end ? `L${start}` : `L${start}-${end}`
}

function readFileDisplayTarget(args: Record<string, unknown>, result: Record<string, unknown>): string {
  const inherited = firstStringField(args, ['context', 'preview'])

  if (inherited) {
    return inherited
  }

  const path = firstStringField(args, ['path', 'file', 'filepath'])

  if (!path) {
    return ''
  }

  const lineLabel = readFileLineLabel(args, result)

  return [fileEditBasename(path), lineLabel].filter(Boolean).join(' ')
}

// A read that came back without text still carries the reader's result type
// at its zero values (ReadResult in tools/file_operations.py). "Total lines: 0"
// and "Is binary: false" are not news; what's left (a missing file's
// `similar_files`, a `hint`) is.
const EMPTY_READ_FIELDS: Record<string, unknown> = {
  content: '',
  file_size: 0,
  is_binary: false,
  is_image: false,
  total_lines: 0,
  truncated: false
}

function withoutEmptyReadFields(result: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(result).filter(
      ([key, value]) => !(Object.hasOwn(EMPTY_READ_FIELDS, key) && EMPTY_READ_FIELDS[key] === value)
    )
  )
}

/**
 * What a file search found, laid out the way the tool itself writes 5+ content
 * matches (`matches_text`, SearchResult in tools/file_operations.py): each file
 * once, its matching lines indented under it. A file-name search lists the
 * files; a count search, each file with its count.
 */
function searchFilesDetail(result: Record<string, unknown>): string {
  const grouped = firstStringField(result, ['matches_text'])

  if (grouped) {
    return grouped
  }

  const lines: string[] = []

  if (Array.isArray(result.matches)) {
    let currentPath = ''

    for (const match of result.matches) {
      const row = isRecord(match) ? match : {}
      const path = firstStringField(row, ['path'])
      const content = typeof row.content === 'string' ? row.content.trimEnd() : ''

      if (path && path !== currentPath) {
        lines.push(path)
        currentPath = path
      }

      lines.push(typeof row.line === 'number' ? `  ${row.line}: ${content}` : `  ${content}`)
    }
  } else if (Array.isArray(result.files)) {
    lines.push(...result.files.filter((file): file is string => typeof file === 'string'))
  } else if (isRecord(result.counts)) {
    for (const [path, count] of Object.entries(result.counts)) {
      lines.push(`${path}: ${String(count)}`)
    }
  }

  return lines.join('\n')
}

/** A page web_extract was given that came back without text: its URL, and why
 *  when the reader said. */
interface UnreadPage {
  error: string
  url: string
}

/**
 * What a web_extract call brought back, page by page (tools/web_tools.py): the
 * text of each page it read, and each page that came back without any. A page
 * the reader couldn't get carries its own `error`; the call itself doesn't
 * fail. Null for a result without a `results` list.
 */
function extractedPages(result: Record<string, unknown>): null | { read: string[]; unread: UnreadPage[] } {
  if (!Array.isArray(result.results)) {
    return null
  }

  const read: string[] = []
  const unread: UnreadPage[] = []

  for (const item of result.results) {
    const row = parseMaybeObject(item)
    const text = firstStringField(row, ['content', 'text', 'markdown', 'body'])

    if (text) {
      read.push(text)

      continue
    }

    // One line per page, though an extractor's exception can run over several.
    const error = extractToolErrorMessage(row).replace(/\s+/g, ' ').trim()
    const url = firstStringField(row, ['url'])

    if (error || url) {
      unread.push({ error, url })
    }
  }

  return { read, unread }
}

/** Pages a call read none of: each URL, then why. The row's title already
 *  says the read failed. */
function unreadPagesText(unread: UnreadPage[]): string {
  return unread.map(({ error, url }) => [url, error].filter(Boolean).join(' — ')).join('\n')
}

/** Pages a call didn't read, beside pages it did: each line says so. */
function unreadPagesList(unread: UnreadPage[]): string {
  const action = translateNow('assistant.tool.actions.failedToRead')

  return unread
    .map(({ error, url }) => {
      const page = url ? translateNow('assistant.tool.titleTemplates.actionTarget', action, url) : ''

      return `- ${[page, error].filter(Boolean).join(' — ')}`
    })
    .join('\n')
}

// What the skill tool puts above a SKILL.md for the model (tools/skills_tool.py):
// a plugin skill's bundle banner, a workspace skill's provenance quote.
const SKILL_NOTE_RE = /^(?:\[Bundle context:[^\]]*\]|> \[!NOTE\] WORKSPACE-SHARED SKILL[^\n]*(?:\n>[^\n]*)*)\s*/

// A SKILL.md's YAML frontmatter, found the way agent/skill_utils
// parse_frontmatter finds it: `---` opens the file (after the BOM a Windows
// editor may put first), and the next line that is only `---` closes it.
const SKILL_FRONTMATTER_RE = /^\uFEFF?---[\s\S]*?\n---[^\S\n]*(?:\n|$)/

const MARKDOWN_FILE_RE = /\.(?:markdown|md|mdx)$/i

/**
 * What a skill says: its SKILL.md past the frontmatter, which only restates the
 * name and description, and past the tool's note to the model above that. A
 * file without frontmatter is the skill's words whole.
 */
function skillBody(content: string): string {
  const afterNote = content.replace(SKILL_NOTE_RE, '')
  const body = afterNote.replace(SKILL_FRONTMATTER_RE, '')

  return (body === afterNote ? content : body).trim()
}

/** A skill file a view opened that isn't markdown (a script, a template): its
 *  text shows as code, the way a file read_file opened does. */
function skillFileIsCode(result: Record<string, unknown>): boolean {
  const file = firstStringField(result, ['file'])

  return (
    Boolean(file) && typeof result.content === 'string' && result.is_binary !== true && !MARKDOWN_FILE_RE.test(file)
  )
}

/**
 * What a skill_view opens onto: the skill itself, as markdown, or the file a
 * view asked for. Summarized like any other result, it read "Name", then
 * "Description", then the file again from its frontmatter, clipped. A repeat
 * view of a skill that hasn't changed returns the tool's note instead.
 */
function skillViewDetail(result: Record<string, unknown>): string {
  const content = typeof result.content === 'string' ? result.content.trim() : ''

  if (!content) {
    return firstStringField(result, ['message'])
  }

  return skillFileIsCode(result) ? content : skillBody(content) || firstStringField(result, ['description'])
}

/** One line per skill skills_list found: its name, then what it is for. */
function skillsListDetail(result: Record<string, unknown>): string {
  const skills = Array.isArray(result.skills) ? result.skills : []

  return skills
    .map(skill => {
      const row = isRecord(skill) ? skill : {}
      const name = firstStringField(row, ['name'])
      const description = firstStringField(row, ['description']).replace(/\s+/g, ' ')

      if (!name) {
        return ''
      }

      return description ? `- ${name} — ${description}` : `- ${name}`
    })
    .filter(Boolean)
    .join('\n')
}

/**
 * The skill a skill_view or skill_manage call is on, written the way the
 * gateway previews it (agent/display build_tool_preview): its name, then the
 * file a view opened. A running call has only that preview, as `context`; the
 * args come back with the result. A row with a result but no args (a stored
 * tool message without its call) names none: its `context` is the whole text.
 */
function skillTarget(part: ToolPart, args: Record<string, unknown>): string {
  const name = firstStringField(args, ['name'])

  if (!name) {
    return part.result === undefined ? firstStringField(args, ['context']) : ''
  }

  const file = part.toolName === 'skill_view' ? firstStringField(args, ['file_path']) : ''

  return file ? `${name} → ${file}` : name
}

// The real command, preferring the actual argument over the backend's
// display preview. `context` is a *summarized* preview ("sleep 70 + 2
// commands") the gateway sends on tool.start before real args arrive — fine
// as a placeholder for the live title, wrong for the `$` transcript, which
// must show what actually ran.
function shellCommand(args: Record<string, unknown>): string {
  return (
    firstStringField(args, ['command', 'code']) || firstStringField(args, ['context', 'preview']) || contextValue(args)
  )
}

const TOOL_META: Record<ToolTitleKey, ToolMetaSpec> = {
  browser_click: {
    icon: 'globe',
    tone: 'browser'
  },
  browser_fill: {
    icon: 'globe',
    tone: 'browser'
  },
  browser_navigate: {
    icon: 'globe',
    tone: 'browser'
  },
  browser_snapshot: {
    icon: 'globe',
    tone: 'browser'
  },
  browser_take_screenshot: {
    icon: 'file-media',
    tone: 'browser'
  },
  browser_type: {
    icon: 'globe',
    tone: 'browser'
  },
  clarify: {
    icon: 'question',
    tone: 'agent'
  },
  cronjob: {
    icon: 'watch',
    tone: 'agent'
  },
  deliver_file: { icon: 'file', tone: 'file' },
  edit_file: { icon: 'edit', tone: 'file' },
  execute_code: {
    icon: 'terminal',
    tone: 'terminal'
  },
  image_generate: {
    icon: 'file-media',
    tone: 'image'
  },
  list_files: {
    icon: 'files',
    tone: 'file'
  },
  memory: {
    icon: 'brain',
    tone: 'agent'
  },
  patch: { icon: 'edit', tone: 'file' },
  read_file: { icon: 'file', tone: 'file' },
  search_files: {
    icon: 'search',
    tone: 'file'
  },
  session_search: {
    icon: 'search',
    tone: 'agent'
  },
  skill_manage: { icon: 'puzzle', tone: 'agent' },
  skill_view: { icon: 'puzzle', tone: 'agent' },
  skills_list: { icon: 'puzzle', tone: 'agent' },
  terminal: {
    icon: 'terminal',
    tone: 'terminal'
  },
  todo: { icon: 'tools', tone: 'agent' },
  vision_analyze: {
    icon: 'eye',
    tone: 'image'
  },
  web_extract: { icon: 'globe', tone: 'web' },
  web_search: { icon: 'search', tone: 'web' },
  write_file: { icon: 'edit', tone: 'file' }
}

function isToolTitleKey(name: string): name is ToolTitleKey {
  return name in TOOL_META
}

const INLINE_CODE_SPLIT_RE = /(`[^`\n]+`)/g
const CITATION_MARKER_RE = /(?<=[\p{L}\p{N})\].,!?:;"'”’])\[(?:\d+(?:\s*,\s*\d+)*)\](?!\()/gu
const BACKTICK_NOISE_RE = /`{3,}/g

export const selectMessageRunning = (state: MessageRunningStateSlice) =>
  state.thread.isRunning && state.message.status?.type === 'running'

function titleForTool(name: string): string {
  const normalized = name.replace(/^browser_/, '').replace(/^web_/, '')

  return normalized.split('_').filter(Boolean).map(capitalize).join(' ') || name
}

const PREFIX_META: { icon?: string; labelKey: string; prefix: string; tone: ToolTone }[] = [
  { prefix: 'browser_', labelKey: 'browser', icon: 'globe', tone: 'browser' },
  { prefix: 'web_', labelKey: 'web', icon: 'globe', tone: 'web' }
]

/** A known tool's title copy. skill_manage says what its `action` did to the
 *  skill; a live call's args only arrive with its result, so a running one
 *  stays generic. */
function toolTitleCopy(name: ToolTitleKey, args: Record<string, unknown>) {
  const { skillManageTitles, titles } = translationsNow().assistant.tool

  if (name === 'skill_manage' && (args.action === 'create' || args.action === 'delete')) {
    return { ...titles.skill_manage, ...skillManageTitles[args.action] }
  }

  return titles[name]
}

function toolMeta(name: string, args: Record<string, unknown>): ToolMeta {
  if (isToolTitleKey(name)) {
    const meta = TOOL_META[name]
    const { done, failed, pending, pendingAction } = toolTitleCopy(name, args)

    return { done, failed, pending, pendingAction, icon: meta.icon, tone: meta.tone }
  }

  const action = titleForTool(name)
  const prefix = PREFIX_META.find(p => name.startsWith(p.prefix))

  if (prefix) {
    const prefixLabel = translateNow(`assistant.tool.prefixes.${prefix.labelKey}`)

    return {
      done: translateNow('assistant.tool.titleTemplates.prefixedDone', prefixLabel, action),
      pending: translateNow('assistant.tool.titleTemplates.runningPrefixedTool', prefixLabel, action),
      pendingAction: translateNow('assistant.tool.actions.running'),
      icon: prefix.icon,
      tone: prefix.tone
    }
  }

  return {
    done: action,
    pending: translateNow('assistant.tool.titleTemplates.runningTool', action),
    pendingAction: translateNow('assistant.tool.actions.running'),
    tone: 'default'
  }
}

const COUNT_FIELD_KEYS = [
  'count',
  'total',
  'result_count',
  'results_count',
  'num_results',
  'match_count',
  'matches_count',
  'file_count',
  'files_count',
  'item_count',
  'items_count',
  'search_count',
  'searches_count',
  'source_count',
  'sources_count',
  'document_count',
  'documents_count',
  'updated',
  'added',
  'removed',
  'deleted',
  'created',
  'changed',
  'processed',
  'steps'
] as const

const COUNT_ARRAY_KEYS = ['results', 'items', 'matches', 'files', 'documents', 'sources', 'rows'] as const

const COUNT_EXCLUDED_KEYS = new Set(['duration_s', 'exit_code', 'status_code'])

// Bytes are a size, not things the call found: execute_code's
// `stdout_bytes_total` is how much its script printed, so `print("12 rows")`
// showed "8 stdout_bytes" ("8 mục" in Vietnamese).
const BYTE_SIZE_KEY_RE = /bytes?_/i

const COUNT_NOUN_BY_FIELD: Partial<Record<(typeof COUNT_FIELD_KEYS)[number], string>> = {
  count: '',
  total: '',
  result_count: 'result',
  results_count: 'result',
  num_results: 'result',
  match_count: 'match',
  matches_count: 'match',
  file_count: 'file',
  files_count: 'file',
  item_count: 'item',
  items_count: 'item',
  search_count: 'search',
  searches_count: 'search',
  source_count: 'source',
  sources_count: 'source',
  document_count: 'document',
  documents_count: 'document',
  updated: 'item',
  added: 'item',
  removed: 'item',
  deleted: 'item',
  created: 'item',
  changed: 'item',
  processed: 'item',
  steps: 'step'
}

const COUNT_NOUN_BY_ARRAY: Record<(typeof COUNT_ARRAY_KEYS)[number], string> = {
  documents: 'document',
  files: 'file',
  items: 'item',
  matches: 'match',
  results: 'result',
  rows: 'row',
  sources: 'source'
}

// search_files names its array (`files`, `matches`) until 5+ matches get
// densified into `matches_text`; then only `total_count` is left, and it
// still counts matches.
const DEFAULT_COUNT_NOUN_BY_TOOL: Record<string, string> = {
  browser_snapshot: 'item',
  list_files: 'file',
  search_files: 'match',
  session_search: 'result',
  skills_list: 'skill',
  todo: 'todo',
  web_search: 'result'
}

function countFromUnknown(value: unknown): null | number {
  if (Array.isArray(value)) {
    return value.length > 0 ? value.length : null
  }

  const n = numberValue(value)

  if (n === null || n <= 0) {
    return null
  }

  return Math.round(n)
}

function singularizeNoun(noun: string): string {
  const normalized = normalize(noun)

  if (!normalized) {
    return ''
  }

  if (normalized.endsWith('ies') && normalized.length > 3) {
    return `${normalized.slice(0, -3)}y`
  }

  if (/(xes|zes|ches|shes|sses)$/.test(normalized) && normalized.length > 3) {
    return normalized.slice(0, -2)
  }

  if (normalized.endsWith('s') && normalized.length > 2 && !normalized.endsWith('ss')) {
    return normalized.slice(0, -1)
  }

  return normalized
}

function pluralizeNoun(noun: string, count: number): string {
  if (count === 1) {
    return noun
  }

  if (noun === 'search') {
    return 'searches'
  }

  if (noun.endsWith('y') && noun.length > 1 && !/[aeiou]y$/i.test(noun)) {
    return `${noun.slice(0, -1)}ies`
  }

  if (/(s|x|z|ch|sh)$/i.test(noun)) {
    return `${noun}es`
  }

  return `${noun}s`
}

// The noun comes off the result's English keys. A known one is counted in the
// locale's own grammar; any other gets an English plural that only English
// shows — the rest print a neutral "N mục" instead.
function formatCountLabel({ count, noun }: CountMetric): string {
  const { countGeneric, countNouns } = translationsNow().assistant.tool

  return Object.hasOwn(countNouns, noun)
    ? countNouns[noun as keyof typeof countNouns](count)
    : countGeneric(count, pluralizeNoun(noun, count))
}

function countMetric(count: number, noun: string): CountMetric {
  return { count, noun: singularizeNoun(noun) || 'item' }
}

function normalizeMetricForTool(toolName: string, metric: CountMetric): CountMetric {
  if (toolName === 'web_search') {
    return countMetric(metric.count, 'result')
  }

  return metric
}

function fallbackCountNoun(toolName: string): string {
  return DEFAULT_COUNT_NOUN_BY_TOOL[toolName] || 'item'
}

function dynamicCountNounFromKey(key: string, fallbackNoun: string): string {
  const stripped = key
    .toLowerCase()
    .replace(/_(count|total)$/i, '')
    .replace(/^num_/, '')

  // `total_count` says how many, not of what — read as a noun it gave "12 totals".
  if (stripped === 'count' || stripped === 'total') {
    return fallbackNoun
  }

  return singularizeNoun(stripped) || fallbackNoun
}

function countFromRecord(record: Record<string, unknown>, fallbackNoun: string): CountMetric | null {
  for (const key of COUNT_FIELD_KEYS) {
    const value = record[key]
    const count = countFromUnknown(value)

    if (count !== null) {
      return countMetric(count, COUNT_NOUN_BY_FIELD[key] || fallbackNoun)
    }
  }

  for (const key of COUNT_ARRAY_KEYS) {
    const value = record[key]
    const count = countFromUnknown(value)

    if (count !== null) {
      return countMetric(count, COUNT_NOUN_BY_ARRAY[key] || fallbackNoun)
    }
  }

  for (const [key, value] of Object.entries(record)) {
    if (COUNT_EXCLUDED_KEYS.has(key) || BYTE_SIZE_KEY_RE.test(key)) {
      continue
    }

    if (!/_count$|_total$/i.test(key)) {
      continue
    }

    const count = countFromUnknown(value)

    if (count !== null) {
      return countMetric(count, dynamicCountNounFromKey(key, fallbackNoun))
    }
  }

  return null
}

function countFromText(value: string, fallbackNoun: string): CountMetric | null {
  const text = value.trim()

  if (!text) {
    return null
  }

  const unitMatch =
    text.match(/\b(\d+)\s+(results?|items?|files?|matches?|documents?|sources?|searches?|steps?|rows?)\b/i) ||
    text.match(/\b(?:did|found|returned|listed|searched|matched|updated|created|deleted|processed)\s+(\d+)\b/i)

  if (unitMatch?.[1]) {
    const n = Number(unitMatch[1])
    const noun = unitMatch[2] ? singularizeNoun(unitMatch[2]) : fallbackNoun

    return Number.isFinite(n) && n > 0 ? countMetric(Math.round(n), noun) : null
  }

  return null
}

function toolResultCount(part: ToolPart, resultRecord: Record<string, unknown>): CountMetric | null {
  if (part.result === undefined) {
    return null
  }

  const fallbackNounByTool = fallbackCountNoun(part.toolName)

  if (part.toolName === 'web_search') {
    const hits = collectResultItems(part.result)

    if (hits.length) {
      return countMetric(hits.length, 'result')
    }
  }

  // A memory write's `entry_count` is the size of the WHOLE store, not what
  // this call saved — "Saved to memory · 5 entries" read as five new memories.
  // The row shows the saved text instead (toolDetailText), so no count here.
  if (part.toolName === 'memory') {
    return null
  }

  // A skill view is one skill. Its numbers are words of the skill ("Runs 3
  // steps"), which a reloaded row counted while the count read its summary.
  if (part.toolName === 'skill_view') {
    return null
  }

  const directCount = countFromRecord(resultRecord, fallbackNounByTool)

  if (directCount !== null) {
    return normalizeMetricForTool(part.toolName, directCount)
  }

  const payload = unwrapToolPayload(part.result)

  if (isRecord(payload)) {
    const payloadCount = countFromRecord(payload, fallbackNounByTool)

    if (payloadCount !== null) {
      return normalizeMetricForTool(part.toolName, payloadCount)
    }
  }

  // Words that may hold a count ("Did 3 searches", "Uploaded 3 files"): the
  // result's own, the same text in every language. Not the summary the row
  // formats from the result: it's in the display language and only English
  // reads as a count, so an English row counted its "2 items" (the length of
  // whichever list it printed first) where Vietnamese counted nothing. Nor the
  // call's args, which say what it was asked: tool.start's preview of them
  // (live rows only) read `head -n 20 results.json` as "20 results" until the
  // row was reloaded, and delegate_task's `context` is a subagent's brief.
  const summaryText = firstStringField(resultRecord, ['summary', 'message', 'detail']) || contextValue(resultRecord)

  const textMetric = countFromText(summaryText, fallbackNounByTool)

  return textMetric ? normalizeMetricForTool(part.toolName, textMetric) : null
}

// Case and line wrapping aside: the same words re-wrapped or re-indented are
// the same text.
const squashText = (input: string) => input.toLowerCase().replace(/\s+/g, ' ').trim()

export function looksRedundant(title: string, detail: string): boolean {
  if (!detail) {
    return true
  }

  return squashText(title) === squashText(detail)
}

function includesText(text: string, phrase: string): boolean {
  const needle = squashText(phrase)

  return Boolean(needle) && squashText(text).includes(needle)
}

export function cleanVisibleText(text: string): string {
  return text
    .split(INLINE_CODE_SPLIT_RE)
    .map(part =>
      part.startsWith('`')
        ? part
        : part
            .replace(BACKTICK_NOISE_RE, '')
            .replace(CITATION_MARKER_RE, '')
            .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label: string, href: string) => {
              const normalized = normalizeExternalUrl(href)

              return `${label} ${normalized}`
            })
    )
    .join('')
}

function summarizeBrowserSnapshot(snapshot: string): string {
  const { snapshotSummary } = translationsNow().assistant.tool
  const count = (re: RegExp) => snapshot.match(re)?.length ?? 0

  const stats = snapshotSummary.counts(
    count(/button\s+"[^"]+"/g),
    count(/link\s+"[^"]+"/g),
    count(/(?:textbox|combobox|searchbox)\s+"[^"]+"/g)
  )

  const labels = Array.from(snapshot.matchAll(/(?:button|link|combobox|textbox)\s+"([^"]+)"/g))
    .map(m => m[1].trim())
    .filter(Boolean)
    .slice(0, 4)

  return labels.length ? `${stats}\n${snapshotSummary.topControls(labels)}` : stats
}

export function firstStringField(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key]

    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }

  return ''
}

function collectResultItems(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value
  }

  const record = parseMaybeObject(value)

  for (const key of [
    'web',
    'results',
    'search_results',
    'sources',
    'web_sources',
    'items',
    'organic_results',
    'organic',
    'matches',
    'documents'
  ]) {
    const candidate = record[key]

    if (Array.isArray(candidate)) {
      return candidate
    }

    if (isRecord(candidate)) {
      const nested = collectResultItems(candidate)

      if (nested.length) {
        return nested
      }
    }
  }

  const payload = unwrapToolPayload(record)

  return payload === record ? [] : collectResultItems(payload)
}

function extractSearchResults(result: unknown, limit = 6): SearchResultRow[] {
  const list = collectResultItems(result)

  return list
    .map(item => {
      const r = parseMaybeObject(item)

      return {
        title: cleanVisibleText(firstStringField(r, ['title', 'name'])),
        url: firstStringField(r, ['url', 'href', 'link']),
        snippet: cleanVisibleText(firstStringField(r, ['snippet', 'description', 'body']))
      }
    })
    .filter(hit => hit.title || hit.url)
    .slice(0, limit)
}

const FAILED_STATUS_RE = /\b(error|failed|failure)\b/i

function toolErrorText(part: ToolPart, result: Record<string, unknown>): string {
  const { errorFallbacks } = translationsNow().assistant.tool
  const extractedError = extractToolErrorMessage(part.result)

  if (part.isError) {
    return extractedError || (typeof part.result === 'string' && part.result.trim()) || errorFallbacks.generic
  }

  if (typeof result.error === 'string' && result.error.trim()) {
    return result.error.trim()
  }

  if (extractedError) {
    return extractedError
  }

  // web_extract tells why it couldn't read a page on that page, not as the
  // call's error. A call that got no text from any page read nothing.
  if (part.toolName === 'web_extract') {
    const pages = extractedPages(result)

    if (pages && !pages.read.length && pages.unread.length) {
      return unreadPagesText(pages.unread)
    }
  }

  if (result.success === false || result.ok === false) {
    return firstStringField(result, ['message', 'reason', 'detail']) || errorFallbacks.notSuccessful
  }

  if (typeof result.status === 'string' && FAILED_STATUS_RE.test(result.status)) {
    return firstStringField(result, ['message', 'reason', 'detail']) || errorFallbacks.status(result.status)
  }

  // A non-zero exit code alone is a weak failure signal: grep returns 1 on
  // no-match, diff returns 1 on differences, piped commands surface the last
  // stage's code, etc. — all routinely produce useful output and aren't
  // failures. Only treat it as an error when the command produced no real
  // output to show; otherwise render the output normally (not red).
  // `output_preview` counts as output: background-process polls report their
  // text under that name, so omitting it painted healthy `process` rows red.
  const exit = numberValue(result.exit_code)

  if (exit !== null && exit !== 0) {
    const hasOutput = Boolean(firstStringField(result, ['output', 'stdout', 'stderr', 'output_preview'])?.trim())

    return hasOutput ? '' : errorFallbacks.exitCode(exit)
  }

  return ''
}

/**
 * A failed result minus what its row already opens with: the field the error
 * was read from (verbatim, or clipped to a trailing "…" by the extractor) and
 * the flags that only declare the failure. Left in, the generic summary below
 * the error says it again as "- Error: …" and "- Success: false".
 */
function withoutFailureFields(result: Record<string, unknown>, error: string): Record<string, unknown> {
  const clippedFrom = error.endsWith('…') ? error.slice(0, -1) : ''

  const carriesError = (value: unknown) =>
    typeof value === 'string' &&
    (value.trim() === error || Boolean(clippedFrom && value.trim().startsWith(clippedFrom)))

  return Object.fromEntries(
    Object.entries(result).filter(
      ([key, value]) =>
        !carriesError(value) &&
        !((key === 'success' || key === 'ok') && value === false) &&
        !(key === 'status' && typeof value === 'string' && FAILED_STATUS_RE.test(value))
    )
  )
}

/**
 * What a failed row or a refused memory write shows when opened: its error,
 * then the rest of what the call returned. A rest that is just the error again
 * is dropped; a rest that already carries the error where the row paints it
 * (execute_code folds a script's stderr into its output) keeps it, and the row
 * doesn't lead with it.
 */
function failedRowDetail(error: string, body: string): { detail: string; errorLead: string } {
  const detail = looksRedundant(error, body) ? '' : body

  return {
    detail,
    errorLead: includesText(clampForDisplay(detail), error) ? '' : error
  }
}

function toolStatus(part: ToolPart, resultRecord: Record<string, unknown>): ToolStatus {
  if (part.result === undefined) {
    return 'running'
  }

  // With write approval on, the memory tool and skill_manage stage a write
  // instead of saving it. Their `success: true` only says the staging worked.
  if ((part.toolName === 'memory' || part.toolName === 'skill_manage') && resultRecord.staged === true) {
    return 'awaiting'
  }

  // Explicit success wins over isError / nested-error heuristics. Memory writes
  // return `{ success: true }` when the batch landed; a stale outer `isError`
  // envelope must not paint a real save amber.
  if (resultRecord.success === true || resultRecord.ok === true) {
    return 'success'
  }

  if (!toolErrorText(part, resultRecord)) {
    return 'success'
  }

  // A rejected memory write is a budget negotiation, not a failure: the store
  // refuses an over-limit batch and the agent retries smaller. Soft warning —
  // never destructive-red beside routine bookkeeping.
  return part.toolName === 'memory' ? 'warning' : 'error'
}

function durationLabel(resultRecord: Record<string, unknown>): string | undefined {
  const seconds = numberValue(resultRecord.duration_s)

  if (seconds === null || seconds < 0) {
    return undefined
  }

  return formatDurationSeconds(seconds)
}

/**
 * The page a web_extract call reads first, from its own args: `urls`, else
 * `url`. tool.start puts the gateway's preview of the call in the live args as
 * `context`, and past 80 characters that preview is the URL cut to 77 and "..."
 * (agent/display build_tool_preview). Read first, it named a live row's page
 * by a URL the reloaded row shows whole. A running call has only the preview.
 */
function webExtractUrl(args: Record<string, unknown>, result: Record<string, unknown>): string {
  return findFirstUrl(args.urls, args.url) || findFirstUrl(args, result)
}

/** A host and maybe a port, then a path or nothing: "acme.dev/docs", "10.0.0.1",
 *  "web_app:3000". Not a path, an email, nor anything with a scheme ("about:blank"). */
const SCHEMELESS_URL_RE = /^[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*(?::\d+)?(?:[/?#]|$)/u

/**
 * A `url` typed without a scheme ("acme.dev/docs"), completed with https the
 * way the browser opens it. A call the browser never got through holds no
 * other URL to name its page by: a cloud browser refuses a bare host as a
 * private address (tools/url_safety is_safe_url), and the red row read
 * "Opened page".
 */
function schemelessUrl(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : ''

  if (!SCHEMELESS_URL_RE.test(text)) {
    return ''
  }

  try {
    return new URL(`https://${text}`).href
  } catch {
    return ''
  }
}

/**
 * The page a browser_navigate call opens: its `url` arg, before the preview the
 * live args carry as `context` (see webExtractUrl). Read first, that preview
 * titled a live row by the URL cut to 77 characters. A running call has only it.
 * A url typed without a scheme names its page too, before a URL in its query
 * ("google.com/url?q=https://…" opens google.com).
 */
function browserNavigateUrl(args: Record<string, unknown>, result: Record<string, unknown>): string {
  return schemelessUrl(args.url) || findFirstUrl(args.url) || findFirstUrl(args, result)
}

function toolPreviewTarget(toolName: string, args: Record<string, unknown>, result: Record<string, unknown>): string {
  const direct =
    firstStringField(result, ['preview', 'url', 'target']) ||
    firstStringField(args, ['preview', 'url', 'target', 'path', 'file', 'filepath']) ||
    firstStringField(result, ['path', 'file', 'filepath'])

  if (direct && (looksLikeUrl(direct) || looksLikePath(direct))) {
    return direct
  }

  if (toolName === 'browser_navigate' || toolName === 'web_extract' || toolName === 'web_search') {
    const explicit = firstStringField(args, ['url', 'search_term', 'query']) || firstStringField(result, ['url'])

    if (looksLikeUrl(explicit)) {
      return explicit
    }

    return toolName === 'web_extract' ? webExtractUrl(args, result) : findFirstUrl(args, result)
  }

  if (isFileEditTool(toolName)) {
    return htmlPathFromInlineDiff(firstStringField(result, ['inline_diff', 'diff']))
  }

  return ''
}

function toolImageUrl(args: Record<string, unknown>, result: Record<string, unknown>): string {
  const candidate =
    firstStringField(result, ['image_url', 'url', 'path', 'image_path']) ||
    firstStringField(args, ['image_url', 'url', 'path'])

  if (!candidate) {
    return ''
  }

  // Only inline-render images the renderer can actually fetch: data URLs or
  // remote http(s). A bare filesystem path (e.g. vision_analyze's input image)
  // resolves against the dev-server origin and 404s — fall back to the tool's
  // codicon instead of a broken <img>.
  const isDataImage = candidate.toLowerCase().startsWith('data:image/')
  const isRemoteImage = /^https?:\/\//i.test(candidate) && /\.(png|jpe?g|gif|webp|bmp|svg)(\?|#|$)/i.test(candidate)

  return isDataImage || isRemoteImage ? candidate : ''
}

function stripAnsi(value: string): string {
  return value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')
}

export function stripInlineDiffChrome(value: string): string {
  return value
    ? stripAnsi(value)
        .replace(/^\s*┊\s*review diff\s*\n/i, '')
        .trim()
    : ''
}

function htmlPathFromInlineDiff(value: string): string {
  const cleaned = stripInlineDiffChrome(value)

  for (const match of cleaned.matchAll(/(?:^|\s)(?:[ab]\/)?([^\s]+\.html?)(?=\s|$)/gi)) {
    const candidate = match[1]?.trim()

    if (candidate) {
      return candidate
    }
  }

  return ''
}

export function inlineDiffFromResult(result: unknown): string {
  const record = parseMaybeObject(result)

  for (const key of ['inline_diff', 'diff']) {
    const value = record[key]

    if (typeof value === 'string' && value.trim()) {
      return stripInlineDiffChrome(value)
    }
  }

  return ''
}

// Falls back to a string only when there's something concrete to render —
// counts of opaque items/fields are noise, not signal.
function minimalValueSummary(value: unknown): string {
  if (value == null) {
    return ''
  }

  if (typeof value === 'string') {
    return value
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }

  return ''
}

// `duration_s` is the gateway's stopwatch (lib/chat-messages stamps it on every
// live result) and the row's header already shows it. It is not something the
// call returned: alone it says nothing, and beside a message it turned the
// message into a list a reloaded row, which has no stopwatch, never shows.
function returnedSummary(result: unknown): string {
  if (!isRecord(result)) {
    return result === undefined ? '' : formatToolResultSummary(result) || minimalValueSummary(result)
  }

  const { duration_s: _stopwatch, ...returned } = result

  return formatToolResultSummary(returned)
}

/**
 * What a row without a layout of its own shows when opened: what the call
 * returned. tool.start stamps the gateway's preview of the call's input into
 * the live args as `context`, and reading that first showed a finished row its
 * own input where its result belonged (a reloaded row, whose args carry no
 * preview, showed the result). The preview still stands in while the call
 * runs, and for a finished call that returned nothing to show — but not under
 * a failure, whose error already says what happened.
 */
function fallbackDetailText(args: unknown, result: unknown, failed = false): string {
  const returned = contextValue(result) || returnedSummary(result)

  if (returned || failed) {
    return returned
  }

  if (result !== undefined) {
    return contextValue(args)
  }

  return contextValue(args) || formatToolResultSummary(args) || minimalValueSummary(args)
}

function cronScalar(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim()
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }

  return ''
}

function formatCronTime(iso: string): string {
  const ts = Date.parse(iso)

  if (Number.isNaN(ts)) {
    return iso
  }

  // The display language's month names, not the OS's (lib/time).
  return new Date(ts).toLocaleString(getTimeFormatLocale(), {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function cronjobSubtitle(argsRecord: Record<string, unknown>, resultRecord: Record<string, unknown>): string {
  const { cron } = translationsNow().assistant.tool
  const jobs = Array.isArray(resultRecord.jobs) ? resultRecord.jobs : null

  if (jobs) {
    return jobs.length ? cron.jobs(jobs.length) : cron.noJobs
  }

  const message = firstStringField(resultRecord, ['message'])

  if (message) {
    return message
  }

  const action = firstStringField(argsRecord, ['action']) || 'manage'
  const name = firstStringField(resultRecord, ['name']) || firstStringField(argsRecord, ['name', 'job_id'])
  const label = capitalize(action)

  return name ? `${label} ${name}` : `Cron ${action}`
}

function cronjobDetail(
  argsRecord: Record<string, unknown>,
  resultRecord: Record<string, unknown>,
  failed: boolean
): string {
  const { cron } = translationsNow().assistant.tool
  const jobs = Array.isArray(resultRecord.jobs) ? resultRecord.jobs : null

  if (jobs) {
    if (!jobs.length) {
      return cron.noJobsScheduled
    }

    return jobs
      .slice(0, 20)
      .map(job => {
        const row = isRecord(job) ? job : {}
        const name = firstStringField(row, ['name', 'id']) || 'job'
        const sched = firstStringField(row, ['schedule_display', 'schedule'])

        return sched ? `- ${name} · ${sched}` : `- ${name}`
      })
      .join('\n')
  }

  const nextRun = cronScalar(resultRecord.next_run_at)

  const rows: [string, string][] = [
    [cron.schedule, cronScalar(resultRecord.schedule)],
    [cron.repeat, cronScalar(resultRecord.repeat)],
    [cron.delivery, cronScalar(resultRecord.deliver)],
    [cron.nextRun, nextRun ? formatCronTime(nextRun) : '']
  ]

  const lines = rows.filter(([, value]) => value).map(([key, value]) => `${key}: ${value}`)

  return lines.length ? lines.join('\n') : fallbackDetailText(argsRecord, resultRecord, failed)
}

function toolSubtitle(
  part: ToolPart,
  argsRecord: Record<string, unknown>,
  resultRecord: Record<string, unknown>
): string {
  const toolName = part.toolName
  const { subtitles } = translationsNow().assistant.tool

  if (toolName === 'browser_navigate') {
    const url =
      firstStringField(argsRecord, ['url', 'target']) ||
      firstStringField(resultRecord, ['url']) ||
      findFirstUrl(argsRecord, resultRecord)

    return url ? hostnameOf(url) : subtitles.browserNavigated
  }

  if (toolName === 'browser_snapshot') {
    const snapshot = firstStringField(resultRecord, ['snapshot'])

    return snapshot ? summarizeBrowserSnapshot(snapshot) : subtitles.browserSnapshot
  }

  if (toolName === 'browser_click') {
    const clicked = firstStringField(resultRecord, ['clicked']) || firstStringField(argsRecord, ['ref', 'target'])

    if (!clicked) {
      return subtitles.clickedOnPage
    }

    return clicked.startsWith('@') ? subtitles.clickedRef(clicked) : subtitles.clicked(clicked)
  }

  if (toolName === 'browser_fill' || toolName === 'browser_type') {
    const field = firstStringField(argsRecord, ['label', 'field', 'ref', 'target'])
    const value = firstStringField(argsRecord, ['value', 'text'])

    return (
      [field && `${subtitles.fieldLabel}: ${field}`, value && `${subtitles.valueLabel}: ${compactPreview(value, 42)}`]
        .filter(Boolean)
        .join(' · ') || subtitles.filledInput
    )
  }

  if (toolName === 'web_search') {
    const query = firstStringField(argsRecord, ['search_term', 'query']) || contextValue(argsRecord)

    return query ? `${subtitles.queryLabel}: ${query}` : subtitles.queriedWeb
  }

  if (toolName === 'terminal' || toolName === 'execute_code') {
    const output = firstStringField(resultRecord, ['output', 'stdout', 'stderr'])

    const lines = Array.isArray(resultRecord.lines)
      ? resultRecord.lines.filter((line): line is string => typeof line === 'string').join('\n')
      : ''

    const previewSource = (output || lines).trim()

    if (previewSource) {
      const firstMeaningfulLine = previewSource
        .split('\n')
        .map(line => line.trim())
        .find(line => line.length > 0)

      if (firstMeaningfulLine) {
        return compactPreview(firstMeaningfulLine, 160)
      }
    }

    const command = firstStringField(argsRecord, ['context', 'preview', 'command', 'code']) || contextValue(argsRecord)

    return command ? '' : subtitles.executedCommand
  }

  if (toolName === 'read_file' || isFileEditTool(toolName)) {
    const isEdit = isFileEditTool(toolName)

    const path = isEdit
      ? fileEditPath(argsRecord, resultRecord)
      : firstStringField(argsRecord, ['path', 'file', 'filepath'])

    if (path) {
      return path
    }

    if (!isEdit) {
      return fallbackDetailText(argsRecord, resultRecord)
    }

    return inlineDiffFromResult(resultRecord) ? subtitles.changedFile : ''
  }

  if (toolName === 'web_extract') {
    const url =
      firstStringField(argsRecord, ['url']) ||
      firstStringField(resultRecord, ['url']) ||
      webExtractUrl(argsRecord, resultRecord)

    return url ? hostnameOf(url) : subtitles.fetchedWebpage
  }

  if (toolName === 'memory') {
    // The raw payload is bookkeeping the user never needs: usage counters, a
    // note telling the model not to retry, and the full operations array. The
    // human-readable line is the only part worth showing.
    return firstStringField(resultRecord, ['message', 'error'])
  }

  if (toolName === 'cronjob') {
    return cronjobSubtitle(argsRecord, resultRecord)
  }

  return (
    compactPreview(formatToolResultSummary(part.result), 120) ||
    compactPreview(resultRecord, 120) ||
    compactPreview(argsRecord, 120) ||
    fallbackDetailText(argsRecord, resultRecord)
  )
}

/** The title of a write the approval gate staged: what waits on the user. */
function awaitingTitle(toolName: string): string {
  return toolName === 'skill_manage'
    ? translateNow('assistant.tool.skillChangeAwaitingApproval')
    : translateNow('assistant.tool.memoryWriteAwaitingApproval')
}

function toolDetailLabel(toolName: string, failed: boolean): string {
  const { detailLabels } = translationsNow().assistant.tool

  if (failed) {
    return detailLabels.error
  }

  if (toolName === 'web_search') {
    return detailLabels.details
  }

  if (toolName === 'browser_snapshot') {
    return detailLabels.snapshot
  }

  return ''
}

/** The text a memory call wrote, one paragraph per operation: the new text
 *  for add / replace, the old text marked "−" for a removal. Batch calls carry
 *  `operations`; single calls the same fields at the top level (`new_text` is
 *  the tool's alias for `content`). */
export function memoryWriteText(args: Record<string, unknown>): string {
  const operations = Array.isArray(args.operations) ? args.operations : [args]
  const lines: string[] = []

  for (const operation of operations) {
    if (!operation || typeof operation !== 'object') {
      continue
    }

    const op = operation as Record<string, unknown>

    if (op.action === 'remove') {
      const removed = firstStringField(op, ['old_text'])

      if (removed) {
        lines.push(`− ${removed}`)
      }

      continue
    }

    const written = firstStringField(op, ['content', 'new_text'])

    if (written) {
      lines.push(written)
    }
  }

  return lines.join('\n\n')
}

function toolDetailText(
  part: ToolPart,
  argsRecord: Record<string, unknown>,
  resultRecord: Record<string, unknown>,
  failed = false
): string {
  if (part.toolName === 'browser_snapshot') {
    const snapshot = firstStringField(resultRecord, ['snapshot'])

    return snapshot ? summarizeBrowserSnapshot(snapshot) : fallbackDetailText(argsRecord, resultRecord, failed)
  }

  if (part.toolName === 'web_search' && !failed) {
    // The gateway's search (plugins/web/agentx_gateway) writes a cited answer
    // beside its hits, and that answer is the detail; its `[1]` markers point
    // into a list the row doesn't number. The hits the row lists already, so
    // without an answer a summary of them ("Web: 5 items (…)") only said them
    // again. With none, the gateway's English `summary` ("Did 0 searches in
    // 1.2s") is no news either.
    const answer = firstStringField(parseMaybeObject(unwrapToolPayload(resultRecord)), ['answer'])

    if (answer || extractSearchResults(part.result).length) {
      return answer.replace(CITATION_MARKER_RE, '')
    }

    const { summary: _tally, ...returned } = resultRecord

    return fallbackDetailText(argsRecord, returned)
  }

  if (part.toolName === 'terminal' || part.toolName === 'execute_code') {
    // Streams are split out into ToolView.stdout / ToolView.stderr by
    // buildToolView so the renderer can label them separately. The merged
    // fallback here is only used when the backend doesn't expose either
    // stream individually.
    const output = firstStringField(resultRecord, ['output', 'stdout', 'stderr'])

    const lines = Array.isArray(resultRecord.lines)
      ? resultRecord.lines.filter((line): line is string => typeof line === 'string').join('\n')
      : ''

    if (output || lines) {
      return [output, lines].filter(Boolean).join('\n')
    }

    // A terminal row with no output already shows its command in the `$`
    // transcript above; the generic fallback would print the same string a
    // second time. `execute_code` has no transcript, so it keeps the preview of
    // its code: the rest of what it returns (`status`, `exit_code`,
    // `tool_calls_made`, `duration_seconds`) is the sandbox's bookkeeping.
    return part.toolName === 'terminal' || failed ? '' : contextValue(argsRecord)
  }

  if (part.toolName === 'web_extract') {
    // Beside the pages, `summary` is the gateway's tally of them ("Extracted 2
    // pages in 1.2s", tui_gateway `_tool_summary`), on the live result only.
    // Read first, it opened the live row onto the tally, where the reloaded row
    // opens onto the pages. The header already counts them and times the call.
    const { summary: _tally, ...returned } = resultRecord
    const record = Array.isArray(resultRecord.results) ? returned : resultRecord
    const direct = firstStringField(record, ['content', 'text', 'markdown', 'body', 'summary', 'message'])

    if (direct) {
      return direct.replace(/\s*in\s+\d+(?:\.\d+)?s\s*$/i, '').trim()
    }

    const pages = extractedPages(resultRecord)

    // A page it couldn't read says so, and why, above the pages it did: those
    // can run past what the row paints.
    if (pages?.read.length) {
      return [unreadPagesList(pages.unread), ...pages.read].filter(Boolean).join('\n\n---\n\n')
    }

    // It read none: the error the failed row leads with (toolErrorText).
    // Summarized like any result, that read "Results: 1 item (4 fields)".
    if (pages?.unread.length) {
      return unreadPagesText(pages.unread)
    }

    return fallbackDetailText(argsRecord, record, failed)
  }

  if (part.toolName === 'read_file' && part.result !== undefined) {
    const content = firstStringField(resultRecord, ['content', 'text', 'data', 'body'])

    if (content) {
      return content
    }

    // No text: the reader's own note says why (a re-read of a file that hasn't
    // changed), else whatever it returned past its empty defaults.
    return (
      firstStringField(resultRecord, ['message']) ||
      fallbackDetailText(argsRecord, withoutEmptyReadFields(resultRecord), failed)
    )
  }

  if (part.toolName === 'search_files' && part.result !== undefined) {
    // What the search found. Summarized like any other result it read
    // "Matches: 2 items (3 fields)", or quoted the result's note to the model
    // on how to read its matches.
    return searchFilesDetail(resultRecord) || (failed ? '' : contextValue(argsRecord))
  }

  if (part.toolName === 'memory') {
    // What was saved IS the detail. The result is bookkeeping (a usage counter,
    // a "don't retry" note, the store total), so the row had nothing to open
    // and the user could not see what had been remembered. A staged write shows
    // the text waiting for approval the same way; a refused write keeps its
    // explanation instead.
    const saved = resultRecord.success === false ? '' : memoryWriteText(argsRecord)

    return saved || firstStringField(resultRecord, ['message', 'error'])
  }

  // The title names the skill (dynamicTitle). While the call runs, the gateway's
  // preview of its args is that name and nothing more.
  if ((part.toolName === 'skill_view' || part.toolName === 'skill_manage') && part.result === undefined) {
    return ''
  }

  // A watch window's row has no result of its own, only the call's preview
  // (lib/chat-messages): it opens onto that, as a call that returned nothing to
  // show does (fallbackDetailText), not onto the skill layouts below.
  const returnedNothing = isRecord(part.result) && !Object.keys(part.result).length

  // The skill itself. A stored tool message without its call has only its text,
  // as `context` (lib/chat-messages storedToolMessagePart), and that stays what
  // it opens onto.
  if (part.toolName === 'skill_view' && !failed && !returnedNothing) {
    return skillViewDetail(resultRecord) || contextValue(resultRecord)
  }

  if (part.toolName === 'skills_list' && part.result !== undefined && !failed && !returnedNothing) {
    // Summarized, the list read "Skills: 1 item (1 field)" under keys the
    // display language has no words for. An empty one keeps the tool's note
    // ("No skills found…").
    return skillsListDetail(resultRecord) || firstStringField(resultRecord, ['message']) || contextValue(resultRecord)
  }

  if (part.toolName === 'skill_manage' && resultRecord.staged === true) {
    // A staged skill change opens on the gate's one-line gist of it ("patch
    // 'deploy' SKILL.md (+3/-1 lines)"). The rest of the result is the gate's
    // bookkeeping: summarized, it read "Staged: true" and the pending id.
    return firstStringField(resultRecord, ['gist', 'message'])
  }

  if (isFileEditTool(part.toolName)) {
    if (inlineDiffFromResult(part.result)) {
      return ''
    }

    const summary = firstStringField(resultRecord, ['message', 'summary'])

    if (summary) {
      return summary
    }

    if (fileEditPath(argsRecord, resultRecord)) {
      return ''
    }

    return fallbackDetailText(argsRecord, resultRecord, failed)
  }

  if (part.toolName === 'cronjob') {
    return cronjobDetail(argsRecord, resultRecord, failed)
  }

  return fallbackDetailText(argsRecord, resultRecord, failed)
}

export function toolCopyPayload(part: ToolPart, view: ToolView): { label: string; text: string } {
  const copy = {
    command: translateNow('assistant.tool.copyCommand'),
    content: translateNow('assistant.tool.copyContent'),
    file: translateNow('assistant.tool.copyFile'),
    output: translateNow('assistant.tool.copyOutput'),
    path: translateNow('assistant.tool.copyPath'),
    query: translateNow('assistant.tool.copyQuery'),
    results: translateNow('assistant.tool.copyResults'),
    url: translateNow('assistant.tool.copyUrl'),
    generic: translateNow('common.copy')
  }

  const args = parseMaybeObject(part.args)
  const result = parseMaybeObject(part.result)
  // A failed row's error sits above its detail; a copy carries both.
  const detail = [view.errorLead, view.detail].filter(Boolean).join('\n\n').trim()
  const hasSubstantialOutput = detail.length > 16

  if (part.toolName === 'terminal' || part.toolName === 'execute_code') {
    if (hasSubstantialOutput) {
      return { label: copy.output, text: detail }
    }

    const command = firstStringField(args, ['command', 'code']) || contextValue(args)

    if (command) {
      return { label: copy.command, text: command }
    }
  }

  if (part.toolName === 'web_extract') {
    if (hasSubstantialOutput) {
      return { label: copy.content, text: detail }
    }

    const url = firstStringField(args, ['url', 'target']) || webExtractUrl(args, result)

    if (url) {
      return { label: copy.url, text: url }
    }
  }

  if (part.toolName === 'browser_navigate') {
    const url = firstStringField(args, ['url', 'target']) || findFirstUrl(args, result)

    if (url) {
      return { label: copy.url, text: url }
    }
  }

  if (part.toolName === 'web_search') {
    if (view.searchHits?.length) {
      const text = view.searchHits.map(hit => [hit.title, hit.url, hit.snippet].filter(Boolean).join('\n')).join('\n\n')

      return { label: copy.results, text }
    }

    const query = firstStringField(args, ['search_term', 'query']) || contextValue(args)

    if (query) {
      return { label: copy.query, text: query }
    }
  }

  if (part.toolName === 'read_file' && part.result !== undefined) {
    if (hasSubstantialOutput) {
      return { label: copy.file, text: detail }
    }

    const path = firstStringField(args, ['path', 'file', 'filepath'])

    if (path) {
      return { label: copy.path, text: path }
    }
  }

  if (isFileEditTool(part.toolName)) {
    if (view.inlineDiff.trim()) {
      return { label: copy.file, text: view.inlineDiff }
    }

    const path = fileEditPath(args, result)

    if (path) {
      return { label: copy.path, text: path }
    }
  }

  if (detail) {
    return { label: copy.output, text: detail }
  }

  return { label: copy.generic, text: view.title }
}

interface ToolTitleParts {
  action?: ToolTitleAction
  title: string
}

function titlePartsFromAction(title: string, action?: string): ToolTitleParts {
  if (!action) {
    return { title }
  }

  const actionStart = title.indexOf(action)

  if (actionStart < 0) {
    return { title }
  }

  return {
    action: {
      prefix: title.slice(0, actionStart),
      suffix: title.slice(actionStart + action.length),
      text: action
    },
    title
  }
}

function dynamicTitle(
  part: ToolPart,
  args: Record<string, unknown>,
  result: Record<string, unknown>,
  fallback: ToolTitleParts,
  failed: boolean
): ToolTitleParts {
  const verb = (gerund: string, past: string) => (part.result === undefined ? gerund : past)

  const titledAction = (action: string, title: string): ToolTitleParts =>
    titlePartsFromAction(title, part.result === undefined ? action : undefined)

  // A read that failed read nothing; "Read notes.md" above "File not found"
  // said it had.
  const readAction = () =>
    failed
      ? translateNow('assistant.tool.actions.failedToRead')
      : verb(translateNow('assistant.tool.actions.reading'), translateNow('assistant.tool.actions.read'))

  if (part.toolName === 'web_extract') {
    const url = webExtractUrl(args, result)
    const action = readAction()

    return url
      ? titledAction(action, translateNow('assistant.tool.titleTemplates.actionTarget', action, hostnameOf(url)))
      : fallback
  }

  if (part.toolName === 'browser_navigate') {
    const url = browserNavigateUrl(args, result)

    if (!url) {
      return fallback
    }

    // Failed as the row's glyph says, the way the title without a page reads
    // it: an `error` beside `success: true` didn't stop the page opening.
    if (failed) {
      const failAction = translateNow('assistant.tool.actions.failedToOpen')

      return titledAction(
        failAction,
        translateNow('assistant.tool.titleTemplates.actionTarget', failAction, hostnameOf(url))
      )
    }

    const action = verb(translateNow('assistant.tool.actions.opening'), translateNow('assistant.tool.actions.opened'))

    return titledAction(action, translateNow('assistant.tool.titleTemplates.actionTarget', action, hostnameOf(url)))
  }

  if (part.toolName === 'web_search') {
    const query = firstStringField(args, ['search_term', 'query']) || contextValue(args)

    const action = verb(
      translateNow('assistant.tool.actions.searching'),
      translateNow('assistant.tool.actions.searched')
    )

    return query
      ? titledAction(
          action,
          translateNow('assistant.tool.titleTemplates.actionQuoted', action, compactPreview(query, 48))
        )
      : fallback
  }

  if (part.toolName === 'read_file') {
    const target = readFileDisplayTarget(args, result)
    const action = readAction()

    return target
      ? titledAction(action, translateNow('assistant.tool.titleTemplates.actionTarget', action, target))
      : fallback
  }

  if (part.toolName === 'terminal' || part.toolName === 'execute_code') {
    const command = shellCommand(args)

    if (command) {
      const action =
        part.toolName === 'execute_code'
          ? verb(translateNow('assistant.tool.actions.runningCode'), translateNow('assistant.tool.actions.ranCode'))
          : verb(translateNow('assistant.tool.actions.running'), translateNow('assistant.tool.actions.ran'))

      return titledAction(
        action,
        translateNow(
          'assistant.tool.titleTemplates.actionCommand',
          action,
          compactPreview(summarizeShellCommand(command), 160)
        )
      )
    }
  }

  if (isFileEditTool(part.toolName)) {
    const path = fileEditPath(args, result)

    if (path) {
      return { title: fileEditBasename(path) }
    }
  }

  if (part.toolName === 'skill_view' || part.toolName === 'skill_manage') {
    const skill = skillTarget(part, args)

    // A staged change keeps the title of what waits for approval; its gist
    // names the skill.
    if (skill && result.staged !== true) {
      return titlePartsFromAction(
        translateNow('assistant.tool.titleTemplates.skillNamed', fallback.title, skill),
        fallback.action?.text
      )
    }
  }

  return fallback
}

export function buildToolView(part: ToolPart, inlineDiff: string): ToolView {
  const argsRecord = parseMaybeObject(part.args)
  // A tool that answered in plain text reads the way the live row keeps that
  // text (lib/chat-messages): as the row's own text, `{ context }`. Parsed as
  // an object it was empty, so a reloaded row had nothing to open.
  const plainText = plainTextResult(part.result)
  const resultRecord: Record<string, unknown> = plainText ? { context: plainText } : parseMaybeObject(part.result)
  const meta = toolMeta(part.toolName, argsRecord)
  const status = toolStatus(part, resultRecord)
  // Skip residual error-heuristic text once status is success or awaiting
  // (stale isError envelope over a landed or staged write would otherwise
  // foul the subtitle).
  const error = status === 'success' || status === 'awaiting' ? '' : toolErrorText(part, resultRecord)
  // Over-budget memory refusals stay amber — don't claim "Saved". Neither does
  // a staged write, which has its own title, nor a failed call whose tool has
  // a title for that.
  const memoryMissed = part.toolName === 'memory' && status === 'warning'

  const baseTitle =
    part.result === undefined
      ? meta.pending
      : status === 'awaiting'
        ? awaitingTitle(part.toolName)
        : memoryMissed
          ? translateNow('assistant.tool.memoryWriteNoted')
          : (status === 'error' && meta.failed) || meta.done

  const titleParts = dynamicTitle(
    part,
    argsRecord,
    resultRecord,
    titlePartsFromAction(baseTitle, part.result === undefined ? meta.pendingAction : undefined),
    status === 'error'
  )

  const title = titleParts.title
  const titleEnriched = title !== baseTitle
  const baseSubtitle = error || toolSubtitle(part, argsRecord, resultRecord)

  const keepSubtitleWithTitle =
    part.toolName === 'terminal' ||
    part.toolName === 'execute_code' ||
    (isFileEditTool(part.toolName) && Boolean(baseSubtitle.trim()))

  const subtitle = titleEnriched && !error && !keepSubtitleWithTitle ? '' : baseSubtitle
  const failed = status === 'error'

  const detailText = toolDetailText(
    part,
    argsRecord,
    failed ? withoutFailureFields(resultRecord, error) : resultRecord,
    failed
  )

  // Lines that are only `---` or `===` stay. No tool writes them as chrome:
  // they are a YAML file's document separators, a page's rules and heading
  // underlines, a test runner's banners, and Copy hands them on.
  const detailBody = detailText.trim()

  // A refused memory write (amber) opens on its reason the way a failed row
  // does. It keeps its whole result: `success: false` is what stops the memory
  // detail offering the refused text as if it had been saved.
  const failure = failed || status === 'warning' ? failedRowDetail(error, detailBody) : undefined
  const detail = failure ? failure.detail : detailBody
  // A staged write opens on what waits for approval: the memory text, or a
  // skill change's gist. The gate's own line goes under it, unless it only
  // repeats the title or that.
  const gateNote = status === 'awaiting' ? firstStringField(resultRecord, ['message']) : ''
  const detailNote = looksRedundant(title, gateNote) || includesText(detail, gateNote) ? undefined : gateNote

  const searchHits =
    part.toolName === 'web_search' && status !== 'error' ? extractSearchResults(part.result) : undefined

  const searchQuery =
    part.toolName === 'web_search'
      ? firstStringField(argsRecord, ['search_term', 'query']) || contextValue(argsRecord)
      : ''

  const resultCount = status === 'error' ? null : toolResultCount(part, resultRecord)

  // For shell/code tools we surface stdout and stderr as separate labeled
  // streams in the renderer. Many CLIs use stderr for informational
  // messages (npm progress, git hints), so we deliberately don't paint
  // stderr destructively even though it's tagged.
  const rendersAnsi = part.toolName === 'terminal' || part.toolName === 'execute_code'
  const stdout = rendersAnsi ? firstStringField(resultRecord, ['stdout']) : ''
  const stderrRaw = rendersAnsi ? firstStringField(resultRecord, ['stderr']) : ''
  // Only attach stderr when the backend actually returned it as its own
  // field — otherwise the merged `detail` already covers it and double-
  // rendering would duplicate output.
  const hasSplitStreams = rendersAnsi && (Boolean(stdout) || Boolean(stderrRaw))
  const terminalCommand = part.toolName === 'terminal' ? shellCommand(argsRecord) : undefined
  const terminalExitCode = part.toolName === 'terminal' ? numericField(resultRecord, 'exit_code') : undefined

  return {
    countLabel: resultCount ? formatCountLabel(resultCount) : undefined,
    detail,
    detailIsCode: (part.toolName === 'skill_view' && !failed && skillFileIsCode(resultRecord)) || undefined,
    detailLabel: toolDetailLabel(part.toolName, Boolean(error)),
    detailNote,
    durationLabel: durationLabel(resultRecord),
    errorLead: failure?.errorLead,
    icon: meta.icon,
    imageUrl: toolImageUrl(argsRecord, resultRecord),
    inlineDiff,
    previewTarget: toolPreviewTarget(part.toolName, argsRecord, resultRecord),
    rendersAnsi: rendersAnsi || undefined,
    searchQuery: searchQuery || undefined,
    searchHits: searchHits?.length ? searchHits : undefined,
    stderr: hasSplitStreams ? stderrRaw || undefined : undefined,
    terminalCommand,
    terminalExitCode,
    stdout: hasSplitStreams ? stdout || undefined : undefined,
    status,
    subtitle,
    title,
    titleAction: titleParts.action,
    tone: meta.tone
  }
}
