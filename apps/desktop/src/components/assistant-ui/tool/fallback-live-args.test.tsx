import { cleanup, fireEvent, render } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FALLBACK_LOCALE, setRuntimeI18nLocale } from '@/i18n'
import { $toolDisclosureStates } from '@/store/tool-view'

import { buildToolView, type ToolPart } from './fallback-model'

vi.mock('@assistant-ui/react', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAuiState: (select: (state: unknown) => unknown) =>
    select({ message: { id: 'msg-1', status: { type: 'complete' } }, thread: { isRunning: false } })
}))

const { ToolFallback } = await import('./fallback')

type RowProps = ComponentProps<typeof ToolFallback>

interface LiveCall {
  args: Record<string, unknown>
  /** What tool.start sent as the call's preview (tui_gateway `_tool_ctx`). */
  context: string
  result?: unknown
  toolName: string
}

/**
 * A tool part the way the running app builds it (lib/chat-messages): the
 * gateway's preview of the input from tool.start, then the real args from
 * tool.complete, and the result with the gateway's stopwatch on it.
 */
function liveRow({ args, context, result, toolName }: LiveCall): Partial<RowProps> & Pick<RowProps, 'toolName'> {
  return {
    args: { context, ...args },
    result: result === undefined ? undefined : { ...(result as Record<string, unknown>), duration_s: 0.21 },
    toolName
  }
}

function renderRow(props: Partial<RowProps> & Pick<RowProps, 'toolName'>) {
  const row = { args: {}, toolCallId: `call-${props.toolName}`, ...props } as RowProps

  return render(<ToolFallback {...row} />).container
}

/** Opens the row, failing if it has no toggle to open. */
function expand(container: HTMLElement) {
  const toggle = container.querySelector('[aria-expanded]')

  expect(toggle).not.toBeNull()
  fireEvent.click(toggle!)
  expect(toggle?.getAttribute('aria-expanded')).toBe('true')
}

/** How many times the row paints `text`. */
function timesShown(container: HTMLElement, text: string): number {
  return (container.textContent ?? '').split(text).length - 1
}

/** The lines of a summary the opened row paints as a list. */
function listedLines(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('li'), item => item.textContent?.trim() ?? '')
}

function view(row: Partial<RowProps> & Pick<RowProps, 'toolName'>) {
  return buildToolView({ args: {}, toolCallId: 'call-1', type: 'tool-call', ...row } as ToolPart, '')
}

afterEach(() => {
  cleanup()
  $toolDisclosureStates.set({})
  setRuntimeI18nLocale(FALLBACK_LOCALE)
})

const LOOKUP: LiveCall = {
  args: { query: 'deploy pipeline' },
  context: 'deploy pipeline',
  result: { enabled: true, name: 'deploy', success: true, total_count: 12 },
  toolName: 'mcp_lookup'
}

// tool.start stamps the gateway's preview of the input into the live args as
// `context`. The detail read it first, so a finished row opened onto its own
// input, and only a reloaded row (args without the preview) onto its result.
describe('finished tool row, args as the live app sends them', () => {
  it('opens onto what the call returned, not the preview of its input', () => {
    const container = renderRow(liveRow(LOOKUP))

    expand(container)

    expect(listedLines(container)).toEqual(['Name: deploy', 'Enabled: true', 'Total Count: 12'])
    expect(timesShown(container, 'deploy pipeline')).toBe(0)
  })

  it('reads what it returned in the display language', () => {
    setRuntimeI18nLocale('vi')

    const container = renderRow(liveRow(LOOKUP))

    expand(container)

    expect(listedLines(container)).toEqual(['Tên: deploy', 'Đã bật: có', 'Tổng số: 12'])
    expect(timesShown(container, 'deploy pipeline')).toBe(0)
  })

  // The header shows the stopwatch; in the detail it also turned a lone message
  // into a two-line list that the same row, reloaded, never showed.
  it('opens a lone message onto the message, the duration left to the header', () => {
    const container = renderRow(liveRow({ ...LOOKUP, result: { message: 'Created issue PROJ-123', success: true } }))

    expand(container)

    expect(timesShown(container, 'Created issue PROJ-123')).toBe(1)
    expect(listedLines(container)).toEqual([])
    expect(container.textContent).toContain('210ms')
    expect(container.textContent).not.toMatch(/Duration/)
  })

  it('keeps the preview when the call returned nothing to show', () => {
    expect(view(liveRow({ ...LOOKUP, result: { success: true } })).detail).toBe('deploy pipeline')
  })

  it('keeps the preview while the call runs', () => {
    expect(view({ args: { context: 'deploy pipeline' }, toolName: 'mcp_lookup' }).detail).toBe('deploy pipeline')
  })

  // A stored tool message without its call, and a subagent's mirrored tool,
  // carry the same text as args and result. It stays the detail.
  it('keeps a result that is only its own preview', () => {
    expect(
      view({ args: { context: 'Indexed 3 files' }, result: { context: 'Indexed 3 files' }, toolName: 'tool' }).detail
    ).toBe('Indexed 3 files')
    expect(
      view({ args: { preview: 'read notes.md' }, result: { preview: 'read notes.md' }, toolName: 'read_file' }).detail
    ).toBe('read notes.md')
  })

  it('opens a script that printed nothing onto its code, not the sandbox bookkeeping', () => {
    const script = liveRow({
      args: { code: 'x = 1' },
      context: 'x = 1',
      result: { duration_seconds: 0.05, exit_code: 0, output: '', status: 'success', tool_calls_made: 0 },
      toolName: 'execute_code'
    })

    expect(view(script).detail).toBe('x = 1')
  })

  it("opens a re-read of an unchanged file onto the reader's note", () => {
    const reread = liveRow({
      args: { path: '/repo/src/vi.ts' },
      context: 'vi.ts',
      result: {
        content_returned: false,
        dedup: true,
        message: 'File unchanged since last read.',
        path: '/repo/src/vi.ts',
        status: 'unchanged'
      },
      toolName: 'read_file'
    })

    expect(view(reread).detail).toBe('File unchanged since last read.')
  })
})

// The reader's result type with no text (ReadResult in tools/file_operations.py).
const EMPTY_READ = { content: '', file_size: 0, is_binary: false, is_image: false, total_lines: 0, truncated: false }

const MISSING = 'File not found: /repo/notes/missing-notes.md'

const MISSING_READ: LiveCall = {
  args: { path: '/repo/notes/missing-notes.md' },
  context: 'missing-notes.md',
  result: {
    ...EMPTY_READ,
    error: MISSING,
    similar_files: ['/repo/notes/missing-note.md', '/repo/docs/missing-notes.md']
  },
  toolName: 'read_file'
}

describe('failed tool row, args as the live app sends them', () => {
  it('says the read failed and opens onto the files it suggests', () => {
    const container = renderRow(liveRow(MISSING_READ))

    expect(container.textContent).toContain('Failed to read missing-notes.md')
    expect(container.textContent).not.toContain('Read missing-notes.md')

    expand(container)

    expect(timesShown(container, MISSING)).toBe(1)
    expect(timesShown(container, 'Similar Files')).toBe(1)
    expect(timesShown(container, '/repo/notes/missing-note.md')).toBe(1)
    expect(timesShown(container, '/repo/docs/missing-notes.md')).toBe(1)
    // The reader's empty defaults and the stopwatch are not what went wrong.
    expect(container.textContent).not.toMatch(/Total Lines|File Size|Is Binary|Is Image|Truncated|Duration/)
  })

  it('says it in the display language', () => {
    setRuntimeI18nLocale('vi')

    const container = renderRow(liveRow(MISSING_READ))

    expect(container.textContent).toContain('Không đọc được missing-notes.md')

    expand(container)

    expect(timesShown(container, MISSING)).toBe(1)
    expect(timesShown(container, 'Tệp tương tự')).toBe(1)
    expect(timesShown(container, '/repo/docs/missing-notes.md')).toBe(1)
    expect(container.textContent).not.toMatch(/Tổng số dòng|Tệp nhị phân|Thời gian chạy/)
  })

  it('opens onto the error alone when nothing else came back', () => {
    const container = renderRow(liveRow({ ...MISSING_READ, result: { ...EMPTY_READ, error: MISSING } }))

    expand(container)

    // The title and the error; the preview no longer repeats under them.
    expect(timesShown(container, 'missing-notes.md')).toBe(2)
    expect(timesShown(container, MISSING)).toBe(1)
    expect(container.querySelector('pre')).toBeNull()
  })

  it('leaves the preview of the input out from under any error', () => {
    const container = renderRow(liveRow({ ...LOOKUP, result: { error: 'Quota exceeded' } }))

    expand(container)

    expect(timesShown(container, 'Quota exceeded')).toBe(1)
    expect(timesShown(container, 'deploy pipeline')).toBe(0)
  })

  it('says a page that failed to load was not read', () => {
    const page = liveRow({
      args: { urls: ['https://example.com/docs'] },
      context: 'https://example.com/docs',
      result: { error: 'net::ERR_NAME_NOT_RESOLVED', success: false },
      toolName: 'web_extract'
    })

    expect(view(page).title).toBe('Failed to read example.com/docs')

    setRuntimeI18nLocale('vi')
    expect(view(page).title).toBe('Không đọc được example.com/docs')
  })

  it('keeps the read title on a read that worked and on one still running', () => {
    expect(view(liveRow({ ...MISSING_READ, result: { ...EMPTY_READ, content: '1|# Notes' } })).title).toBe(
      'Read missing-notes.md'
    )
    expect(view({ args: { context: 'missing-notes.md' }, toolName: 'read_file' }).title).toBe(
      'Reading missing-notes.md'
    )
  })
})

const SEARCH: LiveCall = {
  args: { query: 'agentx release' },
  context: 'agentx release',
  result: {
    // The gateway's search: hits under `data.web`, Perplexity's cited answer beside them.
    data: {
      answer: 'Version 1.1 ships the new tool rows[1].',
      web: [{ description: 'What changed', position: 1, title: 'Release notes', url: 'https://example.com/notes' }]
    },
    success: true,
    summary: 'Did 1 search in 1.2s'
  },
  toolName: 'web_search'
}

describe('search rows, args as the live app sends them', () => {
  it("opens a web search onto the hits and the gateway's answer", () => {
    const container = renderRow(liveRow(SEARCH))

    expand(container)

    expect(timesShown(container, 'Release notes')).toBe(1)
    expect(timesShown(container, 'Version 1.1 ships the new tool rows.')).toBe(1)
    // The query: in the title and over the hits, not a third time as the detail.
    expect(timesShown(container, 'agentx release')).toBe(2)
    expect(container.textContent).not.toMatch(/Did 1 search|\[1\]/)
  })

  it('adds nothing under the hits when there is no answer', () => {
    const { data } = SEARCH.result as { data: { web: unknown[] } }
    const container = renderRow(liveRow({ ...SEARCH, result: { data: { web: data.web }, success: true } }))

    expand(container)

    expect(timesShown(container, 'Release notes')).toBe(1)
    expect(timesShown(container, 'Details')).toBe(0)
    expect(timesShown(container, 'agentx release')).toBe(2)
  })

  const FILE_SEARCH: LiveCall = {
    args: { path: 'src', pattern: 'translateNow' },
    context: 'translateNow',
    result: {
      matches: [
        { content: "translateNow('a')", line: 3, path: 'src/a.ts' },
        { content: "translateNow('b')", line: 9, path: 'src/a.ts' },
        { content: "translateNow('c')", line: 1, path: 'src/b.ts' }
      ],
      total_count: 3
    },
    toolName: 'search_files'
  }

  it('opens a file search onto its matches, each file once', () => {
    const container = renderRow(liveRow(FILE_SEARCH))

    expand(container)

    expect(container.querySelector('pre')?.textContent).toBe(
      "src/a.ts\n  3: translateNow('a')\n  9: translateNow('b')\nsrc/b.ts\n  1: translateNow('c')"
    )
  })

  it('opens a long file search onto the grouped matches the tool wrote', () => {
    const grouped = "src/a.ts\n  3: translateNow('a')\nsrc/b.ts\n  1: translateNow('c')"

    const detail = view(
      liveRow({
        ...FILE_SEARCH,
        result: {
          matches_format: 'path-grouped: each file path on its own line',
          matches_text: grouped,
          total_count: 6
        }
      })
    ).detail

    expect(detail).toBe(grouped)
  })

  it('lists the files a file-name search found', () => {
    const detail = view(liveRow({ ...FILE_SEARCH, result: { files: ['src/a.ts', 'src/b.ts'], total_count: 2 } })).detail

    expect(detail).toBe('src/a.ts\nsrc/b.ts')
  })

  it('keeps the pattern for a search that found nothing, not under its error', () => {
    expect(view(liveRow({ ...FILE_SEARCH, result: { total_count: 0 } })).detail).toBe('translateNow')
    expect(view(liveRow({ ...FILE_SEARCH, result: { error: 'Invalid regex', total_count: 0 } })).detail).toBe('')
  })
})
