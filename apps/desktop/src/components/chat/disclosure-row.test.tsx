import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { DisclosureRow } from './disclosure-row'

afterEach(cleanup)

describe('DisclosureRow', () => {
  it('keeps the trailing timer in flow so a long title truncates instead of running under it', () => {
    render(
      <DisclosureRow onToggle={() => undefined} open={false} trailing={<span>34s</span>}>
        <span className="truncate">Đang chạy mcp webmate webmate với một cái tên rất dài để kiểm tra</span>
      </DisclosureRow>
    )

    const timer = screen.getByText('34s')
    const slot = timer.parentElement as HTMLElement
    const group = slot.parentElement as HTMLElement

    // The old overlay reserved no room for itself — that is the bug.
    expect(slot.className).not.toContain('absolute')
    expect(group.className).not.toContain('absolute')
    expect(group.className).toContain('ml-auto')
    expect(group.className).toContain('shrink-0')
    // Non-interactive: the timer must never take a click from the caret.
    expect(slot.className).toContain('pointer-events-none')
  })

  it('renders no right-hand group when there is nothing to put in it', () => {
    const { container } = render(
      <DisclosureRow open={false}>
        <span>Thought for 3s</span>
      </DisclosureRow>
    )

    expect(container.querySelector('.ml-auto')).toBeNull()
  })
})
