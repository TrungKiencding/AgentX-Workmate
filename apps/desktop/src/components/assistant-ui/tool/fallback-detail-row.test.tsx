import { cleanup, fireEvent, render } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FALLBACK_LOCALE, setRuntimeI18nLocale } from '@/i18n'
import { $toolDisclosureStates } from '@/store/tool-view'

vi.mock('@assistant-ui/react', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAuiState: (select: (state: unknown) => unknown) =>
    select({ message: { id: 'msg-1', status: { type: 'complete' } }, thread: { isRunning: false } })
}))

const { ToolFallback } = await import('./fallback')

type RowProps = ComponentProps<typeof ToolFallback>

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

afterEach(() => {
  cleanup()
  $toolDisclosureStates.set({})
  setRuntimeI18nLocale(FALLBACK_LOCALE)
})

const LOOKUP_RESULT = { enabled: true, name: 'deploy', success: true, total_count: 12 }

// A row's subtitle is a one-line preview of its detail, and only a file edit
// puts it on screen (as the header's tooltip). Every other row still dropped a
// detail that matched it as a duplicate, so a short result had no toggle and
// the user never saw what the tool returned.
describe('tool row without a layout of its own', () => {
  it('opens onto the summary of a short result', () => {
    const container = renderRow({ result: LOOKUP_RESULT, toolName: 'mcp_lookup' })

    expand(container)

    expect(listedLines(container)).toEqual(['Name: deploy', 'Enabled: true', 'Total Count: 12'])
  })

  it('reads the summary in the display language', () => {
    setRuntimeI18nLocale('vi')

    const container = renderRow({ result: LOOKUP_RESULT, toolName: 'mcp_lookup' })

    expand(container)

    expect(listedLines(container)).toEqual(['Tên: deploy', 'Đã bật: có', 'Tổng số: 12'])
  })

  // MCP tools hand their text back wrapped as `{ result }`.
  it('opens onto the text an MCP server sent back', () => {
    const container = renderRow({ result: { result: 'Deployed v1.2.3 to staging' }, toolName: 'mcp_deploy' })

    expand(container)

    expect(timesShown(container, 'Deployed v1.2.3 to staging')).toBe(1)
  })

  it('stays shut when the result only repeats the title', () => {
    const container = renderRow({ result: { result: 'Mcp Lookup' }, toolName: 'mcp_lookup' })

    expect(timesShown(container, 'Mcp Lookup')).toBe(1)
    expect(container.querySelector('[aria-expanded]')).toBeNull()
  })
})

// Other rows whose subtitle is a copy of their detail lost the detail the same
// way: one line of command output, a page snapshot's summary.
describe('tool row whose only text was its subtitle', () => {
  it('opens a script that printed one line onto that line', () => {
    const container = renderRow({
      args: { code: 'print(6 * 7)' },
      result: { exit_code: 0, output: '42' },
      toolName: 'execute_code'
    })

    expand(container)

    expect(timesShown(container, '42')).toBe(1)
  })

  it('shows a command that printed one line under the command', () => {
    const container = renderRow({
      args: { command: 'pwd' },
      result: { exit_code: 0, output: '/Users/kien/project\n' },
      toolName: 'terminal'
    })

    expand(container)

    expect(timesShown(container, '/Users/kien/project')).toBe(1)
    expect(timesShown(container, 'exit 0')).toBe(1)
  })

  const snapshot = [
    'button "Sign in"',
    'button "Search"',
    'link "Docs"',
    'link "Pricing"',
    'textbox "Email"',
    'textbox "Password"'
  ].join('\n')

  it('opens a page snapshot onto its summary', () => {
    const container = renderRow({ result: { snapshot }, toolName: 'browser_snapshot' })

    expand(container)

    expect(timesShown(container, 'Snapshot summary')).toBe(1)
    expect(timesShown(container, '2 buttons · 2 links · 2 inputs')).toBe(1)
    expect(timesShown(container, 'Top controls: Sign in, Search, Docs, Pricing')).toBe(1)
  })

  it('reads the snapshot summary in the display language', () => {
    setRuntimeI18nLocale('vi')

    const container = renderRow({ result: { snapshot }, toolName: 'browser_snapshot' })

    expand(container)

    expect(timesShown(container, 'Tóm tắt cấu trúc trang')).toBe(1)
    expect(timesShown(container, '2 nút · 2 liên kết · 2 ô nhập')).toBe(1)
    expect(timesShown(container, 'Điều khiển chính: Sign in, Search, Docs, Pricing')).toBe(1)
  })
})
