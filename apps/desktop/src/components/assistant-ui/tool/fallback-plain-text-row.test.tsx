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

/** What tool.start sent as the call's preview (tui_gateway `_tool_ctx`). */
const INPUT_PREVIEW = 'deploy web-app'

/** The row the running app builds from the gateway's tool.start and tool.complete. */
function liveCall(result: string): ToolCallPart {
  const started = upsertToolPart([], { context: INPUT_PREVIEW, name: 'mcp_deploy', tool_id: 'deploy-1' }, 'running')

  const [part] = upsertToolPart(
    started,
    { args: { app: 'web-app' }, duration_s: 0.21, name: 'mcp_deploy', result, tool_id: 'deploy-1' },
    'complete'
  )

  return part as ToolCallPart
}

/** The same row reloaded from the stored session. */
function reloadedCall(content: string): ToolCallPart {
  const messages = toChatMessages([
    { content: 'Deploy the web app', role: 'user', timestamp: 1 },
    {
      content: '',
      role: 'assistant',
      timestamp: 2,
      tool_calls: [{ function: { arguments: '{"app":"web-app"}', name: 'mcp_deploy' }, id: 'deploy-1' }]
    },
    { content, role: 'tool', timestamp: 3, tool_call_id: 'deploy-1', tool_name: 'mcp_deploy' }
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

/** How many times the row paints `text`. */
function timesShown(container: HTMLElement, text: string): number {
  return (container.textContent ?? '').split(text).length - 1
}

afterEach(() => {
  cleanup()
  $toolDisclosureStates.set({})
  setRuntimeI18nLocale(FALLBACK_LOCALE)
})

const TEXT = 'Uploaded 3 files to staging'

// The gateway passes a result it can't parse as JSON on as the text itself, and
// a reloaded row gets the stored text back. Both were read as an object, which
// came out empty: the row had no toggle and the text was never reachable.
describe('tool row whose tool answered in plain text', () => {
  it('opens a reloaded row onto the text', () => {
    const container = renderPart(reloadedCall(TEXT))

    expect(container.textContent).toContain('Mcp Deploy')
    expand(container)

    expect(timesShown(container, TEXT)).toBe(1)
  })

  it('opens the live row onto the text, not the preview of its input', () => {
    const container = renderPart(liveCall(TEXT))

    expect(container.textContent).toContain('210ms')
    expand(container)

    expect(timesShown(container, TEXT)).toBe(1)
    expect(timesShown(container, INPUT_PREVIEW)).toBe(0)
  })

  it('shows every line of a long answer, live and reloaded alike', () => {
    const lines = ['Deployed v1.2.3 to staging', ...Array.from({ length: 30 }, (_, index) => `step ${index + 1}: ok`)]

    for (const part of [liveCall(lines.join('\n')), reloadedCall(lines.join('\n'))]) {
      const container = renderPart(part)

      expand(container)

      for (const line of lines) {
        expect(timesShown(container, line)).toBe(1)
      }

      cleanup()
      $toolDisclosureStates.set({})
    }
  })

  it('counts what the text says in the header, live and reloaded alike', () => {
    for (const part of [liveCall(TEXT), reloadedCall(TEXT)]) {
      expect(timesShown(renderPart(part), '3 files')).toBe(1)

      cleanup()
    }
  })

  it('stays shut when the text only repeats the title', () => {
    const container = renderPart(reloadedCall('Mcp Deploy'))

    expect(timesShown(container, 'Mcp Deploy')).toBe(1)
    expect(container.querySelector('[aria-expanded]')).toBeNull()
  })

  it('opens onto the text in Vietnamese, live and reloaded alike', () => {
    setRuntimeI18nLocale('vi')

    for (const part of [liveCall(TEXT), reloadedCall(TEXT)]) {
      const container = renderPart(part)

      expect(container.textContent).toContain('3 tệp')
      expand(container)

      expect(timesShown(container, TEXT)).toBe(1)
      expect(container.querySelector('[aria-label="Sao chép kết quả"]')).not.toBeNull()

      cleanup()
      $toolDisclosureStates.set({})
    }
  })
})
