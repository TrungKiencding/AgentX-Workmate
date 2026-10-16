import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
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

const URL = 'https://acme.dev/install'
const REASON = "Lightpanda 'click' failed (Target closed); retried with Chrome."
const WARNING = `⚠ Lightpanda fallback: Chrome was used for this browser action. ${REASON}`

/** What tools/browser_tool.py copies onto a result Chrome produced after Lightpanda failed. */
const FELL_BACK = {
  fallback_warning: WARNING,
  browser_engine: 'chrome',
  browser_engine_fallback: { from: 'lightpanda', to: 'chrome', reason: REASON }
}

type Call = { args: Record<string, unknown>; context: string; result: Record<string, unknown>; toolName: string }

/** A page browser_navigate opened in Chrome, in the tool's key order. */
const opened: Call = {
  args: { url: URL },
  context: URL,
  result: {
    success: true,
    url: URL,
    title: 'Deep dive',
    ...FELL_BACK,
    snapshot: '- heading "Deep dive" [level=1]\n- link "Home" [ref=e1]',
    element_count: 1
  },
  toolName: 'browser_navigate'
}

/** A click Chrome couldn't make either. */
const failedClick: Call = {
  args: { ref: '@e1' },
  context: '@e1',
  result: { success: false, error: 'Element @e1 not found', ...FELL_BACK },
  toolName: 'browser_click'
}

/** The page's console, read in Chrome. */
const consoleRead: Call = {
  args: {},
  context: '',
  result: {
    success: true,
    console_messages: [
      { type: 'log', text: 'ready', source: 'console' },
      { type: 'warn', text: 'slow', source: 'console' }
    ],
    js_errors: [],
    total_messages: 2,
    total_errors: 0,
    ...FELL_BACK
  },
  toolName: 'browser_console'
}

/**
 * The row the running app builds: tool.start carries the gateway's preview of
 * the call, tool.complete the args, the result, the stopwatch and the gateway's
 * summary of the call, which for a call that fell back is the warning again
 * (tui_gateway `_tool_summary`).
 */
function liveCall({ args, context, result, toolName }: Call): ToolCallPart {
  const started = upsertToolPart([], { context, name: toolName, tool_id: 'call-1' }, 'running')

  const [part] = upsertToolPart(
    started,
    { args, duration_s: 1.234, name: toolName, result, summary: `${WARNING} in 1.2s`, tool_id: 'call-1' },
    'complete'
  )

  return part as ToolCallPart
}

/** The same row reloaded from the stored session: the tool's text as it was written. */
function reloadedCall({ args, result, toolName }: Call): ToolCallPart {
  const messages = toChatMessages([
    { content: 'Open the acme docs', role: 'user', timestamp: 1 },
    {
      content: '',
      role: 'assistant',
      timestamp: 2,
      tool_calls: [{ function: { arguments: JSON.stringify(args), name: toolName }, id: 'call-1' }]
    },
    {
      content: JSON.stringify(result),
      role: 'tool',
      timestamp: 3,
      tool_call_id: 'call-1',
      tool_name: toolName
    }
  ])

  return messages.flatMap(message => message.parts).find(part => part.type === 'tool-call') as ToolCallPart
}

/** Opens the row, failing if it has no toggle to open. */
function expand(container: HTMLElement) {
  const toggle = container.querySelector('[aria-expanded]')

  expect(toggle).not.toBeNull()
  fireEvent.click(toggle!)
  expect(toggle?.getAttribute('aria-expanded')).toBe('true')
}

/** What the opened row paints: its header line, its body, and what its Copy button hands on. */
async function painted({ args, result, toolCallId, toolName }: ToolCallPart) {
  const row = { args, result, toolCallId, toolName } as RowProps
  const writeText = vi.fn().mockResolvedValue(undefined)

  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })

  const { container } = render(<ToolFallback {...row} />)

  expand(container)

  const [header, body] = Array.from(container.querySelector('[data-slot="tool-block"]')!.children)
  const copy = body.querySelector('button[aria-label]')

  const shown = {
    body: body.innerHTML,
    copy: copy?.getAttribute('aria-label'),
    // The status glyph: success is silent, a failed row says so.
    glyph: header.querySelector('svg[aria-label]')?.getAttribute('aria-label') ?? null,
    header: header.textContent,
    text: body.textContent ?? ''
  }

  fireEvent.click(copy!)
  await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))

  cleanup()
  $toolDisclosureStates.set({})

  return { ...shown, copied: writeText.mock.calls[0][0] as string }
}

/** The live row and the reloaded one, opened. */
async function bothOf(call: Call) {
  return { live: await painted(liveCall(call)), reloaded: await painted(reloadedCall(call)) }
}

const timesIn = (text: string, phrase: string) => text.split(phrase).length - 1

afterEach(() => {
  cleanup()
  $toolDisclosureStates.set({})
  setRuntimeI18nLocale(FALLBACK_LOCALE)
})

// The live result carried the gateway's summary, the warning again: the live
// row opened onto "Summary: <warning> in 1.2s" above "Fallback Warning:
// <warning>", where the reloaded row lists the warning once.
describe('a live browser row that fell back to Chrome opens the way the reloaded one does', () => {
  it('lists the warning once', async () => {
    const { live, reloaded } = await bothOf(opened)

    expect(live.body).toBe(reloaded.body)
    expect(live).toMatchObject({ copied: URL, copy: 'Copy URL', glyph: null })
    expect(timesIn(live.text, WARNING)).toBe(1)
    expect(live.text).not.toContain('Summary')
    // Only the stopwatch tells them apart.
    expect(reloaded.header).toBe('Opened acme.dev/install1 element')
    expect(live.header).toBe(`${reloaded.header}1.2s`)
  })

  it('opens a call Chrome failed too onto its error, then the warning once', async () => {
    const { live, reloaded } = await bothOf(failedClick)

    expect(live.body).toBe(reloaded.body)
    expect(live.copied).toBe(reloaded.copied)
    expect(live).toMatchObject({ copy: 'Copy output', glyph: 'Error' })
    expect(live.copied).toBe(
      `Element @e1 not found\n\n- Fallback Warning: ${WARNING}\n- Browser Engine: chrome\n- Browser Engine Fallback: From: lightpanda · To: chrome`
    )
    expect(timesIn(live.text, WARNING)).toBe(1)
    expect(live.header).toBe(`${reloaded.header}1.2s`)
  })

  // Read first for a count's words, the summary stood in the way of the ones
  // the reloaded row counted: "2 items", the length of the first list the
  // row's own summary printed, and only in English. Neither counts now.
  it('counts what it read, as the reloaded row does', async () => {
    const { live, reloaded } = await bothOf(consoleRead)

    expect(live.body).toBe(reloaded.body)
    expect(live.copied).toBe(reloaded.copied)
    expect(reloaded.header).not.toMatch(/\d/)
    expect(live.header).toBe(`${reloaded.header}1.2s`)
    expect(timesIn(live.text, WARNING)).toBe(1)
  })

  it('reads the same in Vietnamese', async () => {
    setRuntimeI18nLocale('vi')

    const page = await bothOf(opened)

    expect(page.live.body).toBe(page.reloaded.body)
    expect(page.live).toMatchObject({ copied: URL, copy: 'Sao chép URL', glyph: null })
    expect(timesIn(page.live.text, WARNING)).toBe(1)
    expect(page.live.text).not.toContain('Tóm tắt')
    expect(page.reloaded.header).toBe('Đã mở acme.dev/install1 phần tử')
    expect(page.live.header).toBe(`${page.reloaded.header}1.2s`)

    const click = await bothOf(failedClick)

    expect(click.live.body).toBe(click.reloaded.body)
    expect(click.live.copied).toBe(click.reloaded.copied)
    expect(click.live).toMatchObject({ copy: 'Sao chép kết quả', glyph: 'Lỗi' })
    expect(timesIn(click.live.text, WARNING)).toBe(1)
    expect(click.live.header).toBe(`${click.reloaded.header}1.2s`)

    const read = await bothOf(consoleRead)

    expect(read.live.body).toBe(read.reloaded.body)
    expect(read.live.header).toBe(`${read.reloaded.header}1.2s`)
  })
})
