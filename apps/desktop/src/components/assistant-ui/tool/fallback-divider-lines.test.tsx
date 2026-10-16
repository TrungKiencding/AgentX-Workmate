import { cleanup, fireEvent, render } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FALLBACK_LOCALE, setRuntimeI18nLocale } from '@/i18n'
import { type ChatMessagePart, toChatMessages, upsertToolPart } from '@/lib/chat-messages'
import { $toolDisclosureStates } from '@/store/tool-view'

vi.mock('@assistant-ui/react', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAuiState: (select: (state: unknown) => unknown) =>
    select({ message: { id: 'msg-1', status: { type: 'complete' } }, thread: { isRunning: false } })
}))

const { ToolFallback } = await import('./fallback')

type RowProps = ComponentProps<typeof ToolFallback>
type ToolCallPart = Extract<ChatMessagePart, { type: 'tool-call' }>

/**
 * The row the running app builds: tool.start carries the gateway's preview of
 * the call (`_tool_ctx`), tool.complete the args and the result.
 */
function liveCall(toolName: string, args: Record<string, unknown>, context: string, result: unknown): ToolCallPart {
  const started = upsertToolPart([], { context, name: toolName, tool_id: 'call-1' }, 'running')

  const [part] = upsertToolPart(
    started,
    { args, duration_s: 0.21, name: toolName, result, tool_id: 'call-1' },
    'complete'
  )

  return part as ToolCallPart
}

/** The same row reloaded from the stored session: the tool's text as it was written. */
function reloadedCall(toolName: string, args: Record<string, unknown>, result: unknown): ToolCallPart {
  const messages = toChatMessages([
    { content: 'Check the release', role: 'user', timestamp: 1 },
    {
      content: '',
      role: 'assistant',
      timestamp: 2,
      tool_calls: [{ function: { arguments: JSON.stringify(args), name: toolName }, id: 'call-1' }]
    },
    {
      content: typeof result === 'string' ? result : JSON.stringify(result),
      role: 'tool',
      timestamp: 3,
      tool_call_id: 'call-1',
      tool_name: toolName
    }
  ])

  return messages.flatMap(message => message.parts).find(part => part.type === 'tool-call') as ToolCallPart
}

function renderPart({ args, result, toolCallId, toolName }: ToolCallPart) {
  const row = { args, result, toolCallId, toolName } as RowProps

  return render(<ToolFallback {...row} />).container
}

/** Opens the row, failing if it has no toggle to open. */
function expand(container: HTMLElement) {
  const toggle = container.querySelector('[aria-expanded]')

  expect(toggle).not.toBeNull()
  fireEvent.click(toggle!)
  expect(toggle?.getAttribute('aria-expanded')).toBe('true')
}

/** What the opened row painted as markdown: its headings and rules. */
function markdown(container: HTMLElement) {
  return {
    headings: Array.from(container.querySelectorAll('h1, h2'), heading => heading.textContent),
    rules: container.querySelectorAll('hr').length
  }
}

afterEach(() => {
  cleanup()
  $toolDisclosureStates.set({})
  setRuntimeI18nLocale(FALLBACK_LOCALE)
})

const UNITTEST = { command: 'python -m unittest' }

/** What `python -m unittest` printed, as the terminal tool returns it. */
const UNITTEST_OUTPUT = [
  'F.',
  '='.repeat(70),
  'FAIL: test_add (test_math.TestMath.test_add)',
  '-'.repeat(70),
  'AssertionError: 4 != 5',
  '',
  '-'.repeat(70),
  'Ran 2 tests in 0.001s',
  '',
  'FAILED (failures=1)'
].join('\n')

const UNITTEST_RESULT = { error: null, exit_code: 1, output: `${UNITTEST_OUTPUT}\n` }

const PAGES_ARGS = { urls: ['https://acme.dev/install', 'https://acme.dev/usage'] }

/** Two pages web_extract read (tools/web_tools.py), each in markdown. */
const PAGES = {
  results: [
    {
      content: 'Install\n=======\n\nRun `npm i acme`.',
      error: null,
      title: 'Install',
      url: 'https://acme.dev/install'
    },
    {
      content: '# Usage\n\nCall `acme()`.\n\n---\n\nMIT licensed.',
      error: null,
      title: 'Usage',
      url: 'https://acme.dev/usage'
    }
  ]
}

const NOTES = '## Release 1.2.3\n\n- Fixed sign-in\n\n---\n\nFull changelog in CHANGELOG.md'

// A row's detail lost every line that was only `---` or `===`: a test run's
// banners, a page's rules and heading underlines, the rule the row itself puts
// between the pages it read.
describe('opened rows keep their --- and === lines', () => {
  it('prints the banners of a test run, live and reloaded alike', () => {
    const rows = [
      liveCall('terminal', UNITTEST, UNITTEST.command, UNITTEST_RESULT),
      reloadedCall('terminal', UNITTEST, UNITTEST_RESULT)
    ]

    for (const part of rows) {
      const container = renderPart(part)

      expand(container)

      const printed = Array.from(container.querySelectorAll('pre'), pre => pre.textContent)

      expect(printed).toEqual([UNITTEST_OUTPUT])

      cleanup()
      $toolDisclosureStates.set({})
    }
  })

  it('draws the rule between the pages web_extract read, and their own headings and rules', () => {
    const container = renderPart(reloadedCall('web_extract', PAGES_ARGS, PAGES))

    expand(container)

    expect(markdown(container)).toEqual({ headings: ['Install', 'Usage'], rules: 2 })
    expect(container.textContent).not.toContain('---')
    expect(container.textContent).not.toContain('===')
  })

  it('draws the rule of an answer in markdown, live and reloaded alike', () => {
    const rows = [
      liveCall('mcp_releases', { version: '1.2.3' }, '1.2.3', NOTES),
      reloadedCall('mcp_releases', { version: '1.2.3' }, NOTES)
    ]

    for (const part of rows) {
      const container = renderPart(part)

      expand(container)

      expect(markdown(container)).toEqual({ headings: ['Release 1.2.3'], rules: 1 })
      expect(container.textContent).toContain('Full changelog in CHANGELOG.md')

      cleanup()
      $toolDisclosureStates.set({})
    }
  })

  it('reads the same in Vietnamese', () => {
    setRuntimeI18nLocale('vi')

    const pages = renderPart(reloadedCall('web_extract', PAGES_ARGS, PAGES))

    expand(pages)

    expect(markdown(pages)).toEqual({ headings: ['Install', 'Usage'], rules: 2 })
    expect(pages.querySelector('[aria-label="Sao chép nội dung"]')).not.toBeNull()

    cleanup()
    $toolDisclosureStates.set({})

    const run = renderPart(reloadedCall('terminal', UNITTEST, UNITTEST_RESULT))

    expand(run)

    expect(Array.from(run.querySelectorAll('pre'), pre => pre.textContent)).toEqual([UNITTEST_OUTPUT])
    expect(run.querySelector('[aria-label="Sao chép kết quả"]')).not.toBeNull()
  })
})
