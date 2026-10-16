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

const URLS = ['https://acme.dev/install', 'https://acme.dev/usage']

/** Two pages web_extract read (tools/web_tools.py), each in markdown. */
const PAGES = {
  results: [
    { content: '# Install\n\nRun `npm i acme`.', error: null, title: 'Install', url: URLS[0] },
    { content: '# Usage\n\nCall `acme()`.', error: null, title: 'Usage', url: URLS[1] }
  ]
}

/** The gateway's preview of the call (agent/display build_tool_preview): the
 *  first URL, cut to 77 characters and "..." past 80. */
const gatewayPreview = (url: string) => (url.length > 80 ? `${url.slice(0, 77)}...` : url)

/**
 * The row the running app builds: tool.start carries the gateway's preview of
 * the call, tool.complete the args, the result, the stopwatch and the
 * gateway's tally of the pages (tui_gateway `_tool_summary`).
 */
function liveCall(urls: string[], result: { results: unknown[] }): ToolCallPart {
  const started = upsertToolPart(
    [],
    { context: gatewayPreview(urls[0]), name: 'web_extract', tool_id: 'call-1' },
    'running'
  )

  const pages = result.results.length

  const [part] = upsertToolPart(
    started,
    {
      args: { urls },
      duration_s: 1.234,
      name: 'web_extract',
      result,
      summary: `Extracted ${pages} ${pages === 1 ? 'page' : 'pages'} in 1.2s`,
      tool_id: 'call-1'
    },
    'complete'
  )

  return part as ToolCallPart
}

/** The same row reloaded from the stored session: the tool's text as it was written. */
function reloadedCall(urls: string[], result: unknown): ToolCallPart {
  const messages = toChatMessages([
    { content: 'Read the acme docs', role: 'user', timestamp: 1 },
    {
      content: '',
      role: 'assistant',
      timestamp: 2,
      tool_calls: [{ function: { arguments: JSON.stringify({ urls }), name: 'web_extract' }, id: 'call-1' }]
    },
    { content: JSON.stringify(result), role: 'tool', timestamp: 3, tool_call_id: 'call-1', tool_name: 'web_extract' }
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

/** What the opened row paints: its header line, then its body and what Copy is called. */
function opened({ args, result, toolCallId, toolName }: ToolCallPart) {
  const row = { args, result, toolCallId, toolName } as RowProps
  const { container } = render(<ToolFallback {...row} />)

  expand(container)

  const [header, body] = Array.from(container.querySelector('[data-slot="tool-block"]')!.children)

  const painted = {
    body: body.innerHTML,
    copy: body.querySelector('button[aria-label]')?.getAttribute('aria-label'),
    // The status glyph: success is silent, a failed row says so.
    glyph: header.querySelector('svg[aria-label]')?.getAttribute('aria-label') ?? null,
    header: header.textContent,
    headings: Array.from(body.querySelectorAll('h1, h2'), heading => heading.textContent),
    items: Array.from(body.querySelectorAll('li'), item => item.textContent),
    links: Array.from(body.querySelectorAll('a[href]'), link => link.getAttribute('href')),
    rules: body.querySelectorAll('hr').length,
    text: body.textContent
  }

  cleanup()
  $toolDisclosureStates.set({})

  return painted
}

afterEach(() => {
  cleanup()
  $toolDisclosureStates.set({})
  setRuntimeI18nLocale(FALLBACK_LOCALE)
})

// The gateway's tally ("Extracted 2 pages in 1.2s") rides on the live result
// only, and the live row opened onto it. Reloaded, the row opened onto the pages.
describe('a live web_extract row opens the way the reloaded one does', () => {
  it('opens onto the pages, not the gateway’s tally of them', () => {
    const live = opened(liveCall(URLS, PAGES))
    const reloaded = opened(reloadedCall(URLS, PAGES))

    expect(live.body).toBe(reloaded.body)
    expect(live).toMatchObject({ copy: 'Copy content', headings: ['Install', 'Usage'], rules: 1 })
    expect(live.text).toContain('Call acme().')
    expect(live.text).not.toContain('Extracted')
    // Only the stopwatch tells them apart.
    expect(reloaded.header).toBe('Read acme.dev/install2 results')
    expect(live.header).toBe(`${reloaded.header}1.2s`)
  })

  it('copies the one page it read, not its URL', () => {
    const one = { results: PAGES.results.slice(0, 1) }
    const live = opened(liveCall(URLS.slice(0, 1), one))
    const reloaded = opened(reloadedCall(URLS.slice(0, 1), one))

    expect(live.body).toBe(reloaded.body)
    expect(live).toMatchObject({ copy: 'Copy content', headings: ['Install'], rules: 0 })
  })

  it('opens onto the same thing when the pages brought back no text', () => {
    const blocked = {
      results: [
        {
          content: '',
          error: 'Blocked: URL targets a private or internal network address',
          title: '',
          url: 'http://10.0.0.1/admin'
        }
      ]
    }

    const live = opened(liveCall(['http://10.0.0.1/admin'], blocked))
    const reloaded = opened(reloadedCall(['http://10.0.0.1/admin'], blocked))

    expect(live.body).toBe(reloaded.body)
    expect(live.text).not.toContain('Extracted')
  })

  it('reads the same in Vietnamese', () => {
    setRuntimeI18nLocale('vi')

    const live = opened(liveCall(URLS, PAGES))
    const reloaded = opened(reloadedCall(URLS, PAGES))

    expect(live.body).toBe(reloaded.body)
    expect(live).toMatchObject({ copy: 'Sao chép nội dung', headings: ['Install', 'Usage'], rules: 1 })
    expect(live.text).not.toContain('Extracted')
    expect(reloaded.header).toBe('Đã đọc acme.dev/install2 kết quả')
    expect(live.header).toBe(`${reloaded.header}1.2s`)
  })
})

// A page web_extract couldn't read comes back among its results with an
// `error` and no text; the call itself doesn't fail. The row was green, counted
// it and opened onto "- Results: 1 item (4 fields)".
describe('a web_extract row names the pages it couldn’t read, live as reloaded', () => {
  const BLOCKED = 'Blocked: URL targets a private or internal network address'
  const POLICY = "Blocked by website policy: 'acme.dev' matched rule 'acme.dev' from config"
  const LONG = 'https://docs.acme.dev/guides/deep/dive/into/the/very/long/path/of/the/page/that/goes/on-and-on'

  const unread = (url: string, error: string) => ({ content: '', error, title: '', url })

  it('fails a read that got no text, naming each page and why', () => {
    const urls = ['http://10.0.0.1/admin', 'https://acme.dev/usage']
    const result = { results: [unread(urls[0], BLOCKED), unread(urls[1], POLICY)] }
    const live = opened(liveCall(urls, result))
    const reloaded = opened(reloadedCall(urls, result))

    expect(live.body).toBe(reloaded.body)
    expect(live).toMatchObject({ copy: 'Copy content', glyph: 'Error', links: urls })
    expect(live.text).toContain(` — ${BLOCKED}`)
    expect(live.text).toContain(` — ${POLICY}`)
    expect(live.text).not.toContain('Results')
    expect(reloaded.header).toBe('Failed to read 10.0.0.1/admin')
    expect(live.header).toBe(`${reloaded.header}1.2s`)
  })

  it('keeps the pages it read, under a line for each one it couldn’t', () => {
    const result = { results: [PAGES.results[0], unread(URLS[1], POLICY)] }
    const live = opened(liveCall(URLS, result))
    const reloaded = opened(reloadedCall(URLS, result))

    expect(live.body).toBe(reloaded.body)

    expect(live).toMatchObject({
      copy: 'Copy content',
      glyph: null,
      headings: ['Install'],
      items: [`Failed to read ${URLS[1]} — ${POLICY}`],
      links: [URLS[1]],
      rules: 1
    })
    expect(reloaded.header).toBe('Read acme.dev/install2 results')
    expect(live.header).toBe(`${reloaded.header}1.2s`)
  })

  // The live args keep tool.start's preview of the URL, cut to 77 characters.
  it('names a page by its whole URL, however long', () => {
    const read = { results: [{ content: '# Deep dive\n\nAll of it.', error: null, title: '', url: LONG }] }
    const live = opened(liveCall([LONG], read))
    const reloaded = opened(reloadedCall([LONG], read))

    expect(reloaded.header).toBe(`Read ${LONG.slice('https://'.length)}1 result`)
    expect(live.header).toBe(`${reloaded.header}1.2s`)

    const blocked = { results: [unread(LONG, BLOCKED)] }
    const failedLive = opened(liveCall([LONG], blocked))
    const failedReloaded = opened(reloadedCall([LONG], blocked))

    expect(failedLive.body).toBe(failedReloaded.body)
    expect(failedLive.links).toEqual([LONG])
    expect(failedReloaded.header).toBe(`Failed to read ${LONG.slice('https://'.length)}`)
    expect(failedLive.header).toBe(`${failedReloaded.header}1.2s`)
  })

  it('reads the same in Vietnamese', () => {
    setRuntimeI18nLocale('vi')

    const failed = { results: [unread('http://10.0.0.1/admin', BLOCKED)] }
    const failedLive = opened(liveCall(['http://10.0.0.1/admin'], failed))
    const failedReloaded = opened(reloadedCall(['http://10.0.0.1/admin'], failed))

    expect(failedLive.body).toBe(failedReloaded.body)
    expect(failedLive).toMatchObject({ copy: 'Sao chép nội dung', glyph: 'Lỗi', links: ['http://10.0.0.1/admin'] })
    expect(failedLive.text).toContain(` — ${BLOCKED}`)
    expect(failedReloaded.header).toBe('Không đọc được 10.0.0.1/admin')
    expect(failedLive.header).toBe(`${failedReloaded.header}1.2s`)

    const some = { results: [PAGES.results[0], unread(URLS[1], POLICY)] }
    const live = opened(liveCall(URLS, some))
    const reloaded = opened(reloadedCall(URLS, some))

    expect(live.body).toBe(reloaded.body)
    expect(live).toMatchObject({ items: [`Không đọc được ${URLS[1]} — ${POLICY}`], links: [URLS[1]] })
    expect(reloaded.header).toBe('Đã đọc acme.dev/install2 kết quả')

    const read = { results: [{ content: '# Deep dive', error: null, title: '', url: LONG }] }

    expect(opened(liveCall([LONG], read)).header).toBe(`Đã đọc ${LONG.slice('https://'.length)}1 kết quả1.2s`)
  })
})
