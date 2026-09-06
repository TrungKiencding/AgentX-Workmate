import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { StatusPill } from './status-pill'

// The pill is a dot and a word on a tint of ONE tone colour: every tone must
// paint from a token (never a Tailwind ramp), the dot must always be there,
// and the text must be the child — a status is a glyph and a colour, never a
// hue alone.

afterEach(() => {
  cleanup()
})

describe('StatusPill', () => {
  it('names its tone, keeps its dot, and paints from the semantic tokens', () => {
    render(<StatusPill tone="good">Đã kết nối</StatusPill>)

    const pill = screen.getByText('Đã kết nối')

    expect(pill.getAttribute('data-slot')).toBe('status-pill')
    expect(pill.getAttribute('data-tone')).toBe('good')
    expect(pill.style.getPropertyValue('--status-pill-color')).toBe('var(--ui-green)')
    expect(pill.querySelector('span[aria-hidden="true"]')).not.toBeNull()
    expect(pill.className).not.toMatch(/emerald|amber|rose|sky/)
  })

  it('maps every tone onto a token', () => {
    const tones = { bad: '--ui-red', info: '--ui-info', muted: '--ui-text-tertiary', warn: '--ui-yellow' } as const

    for (const [tone, token] of Object.entries(tones)) {
      render(<StatusPill tone={tone as keyof typeof tones}>{tone}</StatusPill>)

      expect(screen.getByText(tone).style.getPropertyValue('--status-pill-color')).toBe(`var(${token})`)
    }
  })

  it('rides the two pill heights', () => {
    render(
      <>
        <StatusPill tone="muted">small</StatusPill>
        <StatusPill size="md" tone="muted">
          medium
        </StatusPill>
      </>
    )

    expect(screen.getByText('small').className).toContain('h-(--status-pill-h-sm)')
    expect(screen.getByText('medium').className).toContain('h-(--status-pill-h-md)')
  })
})
