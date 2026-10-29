import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { TurnDoneAnnouncer } from './turn-announcer'

afterEach(cleanup)

// One polite announcement per finished turn — never the streamed tokens.
describe('TurnDoneAnnouncer', () => {
  it('stays silent while a turn runs and speaks once when it ends', () => {
    const { rerender } = render(<TurnDoneAnnouncer busy={false} />)
    const region = screen.getByRole('status')

    expect(region.getAttribute('aria-live')).toBe('polite')
    expect(region.textContent).toBe('')

    rerender(<TurnDoneAnnouncer busy />)
    expect(region.textContent).toBe('')

    rerender(<TurnDoneAnnouncer busy={false} />)
    expect(region.textContent).toBe('AgentX has finished replying')

    // The next turn clears it, so the same words are announced again.
    rerender(<TurnDoneAnnouncer busy />)
    expect(region.textContent).toBe('')
  })
})
