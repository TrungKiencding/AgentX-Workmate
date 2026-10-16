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

const SHORT = 'https://acme.dev/install'
const LONG = 'https://docs.acme.dev/guides/deep/dive/into/the/very/long/path/of/the/page/that/goes/on-and-on'
const PATH = LONG.slice('https://'.length)
const BLOCKED = 'Blocked: URL targets a private or internal address'

/** A page browser_navigate opened (tools/browser_tool.py): where it landed, its title, a snapshot. */
const landed = (url: string) => ({
  element_count: 1,
  snapshot: '- heading "Deep dive" [level=1]\n- link "Home" [ref=e1]',
  success: true,
  title: 'Deep dive',
  url
})

/** The gateway's preview of the call (agent/display build_tool_preview): the
 *  URL, cut to 77 characters and "..." past 80. */
const gatewayPreview = (url: string) => (url.length > 80 ? `${url.slice(0, 77)}...` : url)

/**
 * The row the running app builds: tool.start carries the gateway's preview of
 * the call, tool.complete the args, the result and the stopwatch.
 */
function liveCall(url: string, result: Record<string, unknown>): ToolCallPart {
  const started = upsertToolPart(
    [],
    { context: gatewayPreview(url), name: 'browser_navigate', tool_id: 'call-1' },
    'running'
  )

  const [part] = upsertToolPart(
    started,
    { args: { url }, duration_s: 1.234, name: 'browser_navigate', result, tool_id: 'call-1' },
    'complete'
  )

  return part as ToolCallPart
}

/** The same row reloaded from the stored session: the tool's text as it was written. */
function reloadedCall(url: string, result: unknown): ToolCallPart {
  const messages = toChatMessages([
    { content: 'Open the acme docs', role: 'user', timestamp: 1 },
    {
      content: '',
      role: 'assistant',
      timestamp: 2,
      tool_calls: [{ function: { arguments: JSON.stringify({ url }), name: 'browser_navigate' }, id: 'call-1' }]
    },
    {
      content: JSON.stringify(result),
      role: 'tool',
      timestamp: 3,
      tool_call_id: 'call-1',
      tool_name: 'browser_navigate'
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
async function opened({ args, result, toolCallId, toolName }: ToolCallPart) {
  const row = { args, result, toolCallId, toolName } as RowProps
  const writeText = vi.fn().mockResolvedValue(undefined)

  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })

  const { container } = render(<ToolFallback {...row} />)

  expand(container)

  const [header, body] = Array.from(container.querySelector('[data-slot="tool-block"]')!.children)
  const copy = body.querySelector('button[aria-label]')

  const painted = {
    body: body.innerHTML,
    copy: copy?.getAttribute('aria-label'),
    // The status glyph: success is silent, a failed row says so.
    glyph: header.querySelector('svg[aria-label]')?.getAttribute('aria-label') ?? null,
    header: header.textContent,
    text: body.textContent
  }

  fireEvent.click(copy!)
  await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))

  cleanup()
  $toolDisclosureStates.set({})

  return { ...painted, copied: writeText.mock.calls[0][0] as string }
}

afterEach(() => {
  cleanup()
  $toolDisclosureStates.set({})
  setRuntimeI18nLocale(FALLBACK_LOCALE)
})

// The live args keep tool.start's preview of the URL, cut to 77 characters.
// The live row was titled from it; the reloaded row, whose args are only the
// call's own, named the page whole.
describe('a live browser_navigate row names its page the way the reloaded one does', () => {
  it('names the page by its whole URL, however long', async () => {
    const live = await opened(liveCall(LONG, landed(LONG)))
    const reloaded = await opened(reloadedCall(LONG, landed(LONG)))

    expect(live.body).toBe(reloaded.body)
    expect(live).toMatchObject({ copied: LONG, copy: 'Copy URL', glyph: null })
    // Only the stopwatch tells them apart.
    expect(reloaded.header).toBe(`Opened ${PATH}1 element`)
    expect(live.header).toBe(`${reloaded.header}1.2s`)
  })

  it('names a page it couldn’t open by its whole URL', async () => {
    const live = await opened(liveCall(LONG, { error: BLOCKED, success: false }))
    const reloaded = await opened(reloadedCall(LONG, { error: BLOCKED, success: false }))

    expect(live.body).toBe(reloaded.body)
    expect(live).toMatchObject({ copied: LONG, copy: 'Copy URL', glyph: 'Error' })
    expect(live.text).toContain(BLOCKED)
    expect(reloaded.header).toBe(`Failed to open ${PATH}`)
    expect(live.header).toBe(`${reloaded.header}1.2s`)
  })

  it('names a short URL as it always did', async () => {
    const live = await opened(liveCall(SHORT, landed(SHORT)))
    const reloaded = await opened(reloadedCall(SHORT, landed(SHORT)))

    expect(live.body).toBe(reloaded.body)
    expect(live.copied).toBe(SHORT)
    expect(reloaded.header).toBe('Opened acme.dev/install1 element')
    expect(live.header).toBe(`${reloaded.header}1.2s`)
  })

  it('reads the same in Vietnamese', async () => {
    setRuntimeI18nLocale('vi')

    const live = await opened(liveCall(LONG, landed(LONG)))
    const reloaded = await opened(reloadedCall(LONG, landed(LONG)))

    expect(live.body).toBe(reloaded.body)
    expect(live).toMatchObject({ copied: LONG, copy: 'Sao chép URL', glyph: null })
    expect(reloaded.header).toBe(`Đã mở ${PATH}1 phần tử`)
    expect(live.header).toBe(`${reloaded.header}1.2s`)

    const failedLive = await opened(liveCall(LONG, { error: BLOCKED, success: false }))
    const failedReloaded = await opened(reloadedCall(LONG, { error: BLOCKED, success: false }))

    expect(failedLive.body).toBe(failedReloaded.body)
    expect(failedLive).toMatchObject({ copied: LONG, copy: 'Sao chép URL', glyph: 'Lỗi' })
    expect(failedReloaded.header).toBe(`Không mở được ${PATH}`)
    expect(failedLive.header).toBe(`${failedReloaded.header}1.2s`)
  })
})

// A url typed without a scheme holds no URL to name, and a cloud browser
// refuses it as a private address in an error that names none either. Red,
// the row read "Opened page", live and reloaded.
describe('a browser_navigate row that couldn’t open its page never reads as opened', () => {
  const BARE = 'acme.dev/guides/install'
  const REFUSED = { error: BLOCKED, success: false }

  it('names a bare host it couldn’t open', async () => {
    const live = await opened(liveCall(BARE, REFUSED))
    const reloaded = await opened(reloadedCall(BARE, REFUSED))

    expect(live.body).toBe(reloaded.body)
    expect(live).toMatchObject({ copied: BARE, copy: 'Copy URL', glyph: 'Error' })
    expect(live.text).toContain(BLOCKED)
    expect(reloaded.header).toBe(`Failed to open ${BARE}`)
    expect(live.header).toBe(`${reloaded.header}1.2s`)
  })

  it('says it failed when there is no page to name', async () => {
    const live = await opened(liveCall('about:blank', REFUSED))
    const reloaded = await opened(reloadedCall('about:blank', REFUSED))

    expect(live.body).toBe(reloaded.body)
    expect(live).toMatchObject({ copied: 'about:blank', copy: 'Copy URL', glyph: 'Error' })
    expect(reloaded.header).toBe('Failed to open page')
    expect(live.header).toBe(`${reloaded.header}1.2s`)
  })

  it('names a bare host it opened as it always did', async () => {
    const live = await opened(liveCall(BARE, landed(`https://${BARE}`)))
    const reloaded = await opened(reloadedCall(BARE, landed(`https://${BARE}`)))

    expect(live.body).toBe(reloaded.body)
    expect(live).toMatchObject({ copied: BARE, glyph: null })
    expect(reloaded.header).toBe(`Opened ${BARE}1 element`)
    expect(live.header).toBe(`${reloaded.header}1.2s`)
  })

  it('reads the same in Vietnamese', async () => {
    setRuntimeI18nLocale('vi')

    const live = await opened(liveCall(BARE, REFUSED))
    const reloaded = await opened(reloadedCall(BARE, REFUSED))

    expect(live.body).toBe(reloaded.body)
    expect(live).toMatchObject({ copied: BARE, copy: 'Sao chép URL', glyph: 'Lỗi' })
    expect(reloaded.header).toBe(`Không mở được ${BARE}`)
    expect(live.header).toBe(`${reloaded.header}1.2s`)

    const nothingLive = await opened(liveCall('about:blank', REFUSED))
    const nothingReloaded = await opened(reloadedCall('about:blank', REFUSED))

    expect(nothingLive.body).toBe(nothingReloaded.body)
    expect(nothingReloaded.header).toBe('Không mở được trang')
    expect(nothingLive.header).toBe(`${nothingReloaded.header}1.2s`)
  })
})
