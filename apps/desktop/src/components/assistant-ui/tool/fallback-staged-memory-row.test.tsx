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

const GATE_MESSAGE = 'Staged for approval (memory.write_approval is on). Not yet saved — review with /memory pending.'

const STAGED_RESULT = { message: GATE_MESSAGE, pending_id: '9c41d2e7', staged: true, success: true }

/** A memory row that tried to save "Likes candy". */
function renderMemoryRow(result: unknown = STAGED_RESULT) {
  const row = {
    args: { action: 'add', content: 'Likes candy', target: 'user' },
    result,
    toolCallId: 'call-memory',
    toolName: 'memory'
  } as RowProps

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

/** Any of the gold→purple chrome a landed memory write gets. */
function legendaryChrome(container: HTMLElement): Element | null {
  return container.querySelector('[class*="tool-memory-legendary"]')
}

afterEach(() => {
  cleanup()
  $toolDisclosureStates.set({})
  setRuntimeI18nLocale(FALLBACK_LOCALE)
})

// With write approval on, the memory tool stages a write and answers
// `success: true`. The row read "Saved to memory" in the gold of a landed
// write, and opened onto text that had not been saved.
describe('staged memory write', () => {
  it('keeps the gold for a write that landed', () => {
    const container = renderMemoryRow({ message: 'Entry added.', success: true })

    expect(container.textContent).toContain('Saved to memory')
    expect(legendaryChrome(container)).not.toBeNull()
  })

  it('says it is waiting for approval, in the plain row colours', () => {
    const container = renderMemoryRow()

    expect(container.textContent).toContain('Memory write awaiting approval')
    expect(container.textContent).not.toContain('Saved to memory')
    expect(legendaryChrome(container)).toBeNull()
    expect(container.querySelector('[aria-label="Awaiting approval"]')).not.toBeNull()
    // Waiting is neither a refusal nor a failure.
    expect(container.querySelector('[class*="text-(--ui-yellow)"]')).toBeNull()
    expect(container.querySelector('[class*="text-destructive"]')).toBeNull()
  })

  it('opens onto the text waiting for approval, then where to review it', () => {
    const container = renderMemoryRow()

    expand(container)

    expect(timesShown(container, 'Likes candy')).toBe(1)
    expect(timesShown(container, GATE_MESSAGE)).toBe(1)

    const painted = container.textContent ?? ''

    expect(painted.indexOf('Likes candy')).toBeLessThan(painted.indexOf(GATE_MESSAGE))
  })

  it('says it in the display language', () => {
    setRuntimeI18nLocale('vi')

    const container = renderMemoryRow()

    expect(container.textContent).toContain('Chờ phê duyệt để lưu vào bộ nhớ')
    expect(container.textContent).not.toContain('Đã lưu vào bộ nhớ')
    expect(container.querySelector('[aria-label="Đang chờ phê duyệt"]')).not.toBeNull()

    expand(container)

    expect(timesShown(container, 'Likes candy')).toBe(1)
    expect(timesShown(container, GATE_MESSAGE)).toBe(1)
  })
})
