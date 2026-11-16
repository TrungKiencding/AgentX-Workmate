import { describe, expect, it } from 'vitest'

import { HANDOFF_NOTE_MARKER, stripHandoffNote } from './handoff-note'

describe('stripHandoffNote', () => {
  it('keeps only the user’s words before an appended handoff note', () => {
    expect(stripHandoffNote(`@writer viết caption${HANDOFF_NOTE_MARKER}for each mentioned agent …]`)).toBe(
      '@writer viết caption'
    )
  })

  it('leaves ordinary messages untouched', () => {
    expect(stripHandoffNote('Hello [@mention handoff — not after a blank line')).toBe(
      'Hello [@mention handoff — not after a blank line'
    )
    expect(stripHandoffNote('')).toBe('')
  })
})
