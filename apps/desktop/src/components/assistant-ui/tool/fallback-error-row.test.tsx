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

/** The innermost element that paints `text`. */
function elementShowing(container: HTMLElement, text: string): Element | undefined {
  return Array.from(container.querySelectorAll('*'))
    .filter(element => element.textContent?.includes(text))
    .pop()
}

afterEach(() => {
  cleanup()
  $toolDisclosureStates.set({})
  setRuntimeI18nLocale(FALLBACK_LOCALE)
})

// A failed row's error used to be dropped from the expanded body as a
// duplicate of the row's subtitle, which the row never paints. A failure whose
// only text was its error got no toggle at all.
describe('failed tool row', () => {
  it('opens onto the localized fallback when the result has no error text', () => {
    const container = renderRow({ isError: true, result: '', toolName: 'vision_analyze' })

    expand(container)

    expect(timesShown(container, 'Tool returned an error.')).toBe(1)
  })

  it('says it in the display language', () => {
    setRuntimeI18nLocale('vi')

    const container = renderRow({ isError: true, result: '', toolName: 'vision_analyze' })

    expand(container)

    expect(timesShown(container, 'Công cụ báo lỗi.')).toBe(1)
  })

  it('shows a read_file error once, not restated as result fields', () => {
    const error = 'File not found: /repo/notes/missing.md'

    const container = renderRow({
      args: { path: '/repo/notes/missing.md' },
      result: { error, success: false },
      toolName: 'read_file'
    })

    expand(container)

    expect(timesShown(container, error)).toBe(1)
    expect(container.textContent).not.toMatch(/success/i)
    // `missing.md` is a file name, not the Moldovan site it looks like.
    expect(container.querySelector('a')).toBeNull()
  })

  it('keeps the rest of the result under the error', () => {
    const error = 'File not found: /repo/notes/missing.md'

    const container = renderRow({
      args: { path: '/repo/notes/missing.md' },
      result: { error, similar_files: ['/repo/docs/missing.md'] },
      toolName: 'read_file'
    })

    expand(container)

    expect(timesShown(container, error)).toBe(1)
    expect(timesShown(container, '/repo/docs/missing.md')).toBe(1)
  })

  it('prints a terminal exit code message once beside the transcript', () => {
    const container = renderRow({ args: { command: 'npm test' }, result: { exit_code: 3 }, toolName: 'terminal' })

    expand(container)

    expect(timesShown(container, 'Command failed with exit code 3.')).toBe(1)
    expect(timesShown(container, 'exit 3')).toBe(1)
  })

  it('prints the terminal exit code message in the display language', () => {
    setRuntimeI18nLocale('vi')

    const container = renderRow({ args: { command: 'npm test' }, result: { exit_code: 3 }, toolName: 'terminal' })

    expand(container)

    expect(timesShown(container, 'Lệnh thất bại với mã thoát 3.')).toBe(1)
  })

  // execute_code reports a script's stderr as its error AND folds it into its
  // output, so the output already says why it failed.
  it('does not repeat an error the output already carries', () => {
    const traceback = [
      'Traceback (most recent call last):',
      '  File "/tmp/run.py", line 2, in <module>',
      '    import missing_module',
      "ModuleNotFoundError: No module named 'missing_module'",
      '',
      'During handling of the above exception, another exception occurred:',
      '',
      'RuntimeError: setup failed'
    ].join('\n')

    const container = renderRow({
      args: { code: 'import missing_module' },
      result: {
        error: traceback,
        exit_code: 1,
        output: `starting\n--- stderr ---\n${traceback}`,
        status: 'error'
      },
      toolName: 'execute_code'
    })

    expand(container)

    expect(timesShown(container, "ModuleNotFoundError: No module named 'missing_module'")).toBe(1)
    expect(timesShown(container, 'RuntimeError: setup failed')).toBe(1)
    expect(timesShown(container, 'starting')).toBe(1)
  })
})

// A refused memory write is amber, not red, but it hid its reason the same
// way: the reason was also the row's subtitle, so the row had nothing to open.
describe('refused memory write', () => {
  const reason = 'Memory is full (2,200/2,200). Consolidate before adding more.'

  const refusedRow = (result: unknown = { error: reason, success: false }) =>
    renderRow({ args: { action: 'add', content: 'Likes candy' }, result, toolName: 'memory' })

  it('opens onto why nothing was saved, once, in amber', () => {
    const container = refusedRow()

    expect(container.textContent).toContain('Memory write noted')

    expand(container)

    expect(timesShown(container, reason)).toBe(1)

    const shown = elementShowing(container, reason)

    expect(shown?.closest('[class*="text-(--ui-yellow)"]')).not.toBeNull()
    expect(shown?.closest('[class*="text-destructive"]')).toBeNull()
    // What it tried to save would read as saved.
    expect(container.textContent).not.toContain('Likes candy')
  })

  it('leaves out the entries the model was handed to consolidate', () => {
    const overLimit =
      "Memory at 2,150/2,200 chars. Adding this entry (120 chars) would exceed the limit. Consolidate now: use 'replace' to merge overlapping entries into shorter ones or 'remove' stale or less important entries (see current_entries below), then retry this add — all in this turn."

    const container = refusedRow({
      current_entries: ['Uses npm', 'Deploys on Fridays'],
      error: overLimit,
      success: false,
      usage: '2,150/2,200'
    })

    expand(container)

    expect(timesShown(container, overLimit)).toBe(1)
    expect(container.textContent).not.toContain('Deploys on Fridays')
  })

  it('keeps its title in the display language and still says why', () => {
    setRuntimeI18nLocale('vi')

    const container = refusedRow()

    expect(container.textContent).toContain('Đã ghi nhận vào bộ nhớ')

    expand(container)

    expect(timesShown(container, reason)).toBe(1)
  })
})
