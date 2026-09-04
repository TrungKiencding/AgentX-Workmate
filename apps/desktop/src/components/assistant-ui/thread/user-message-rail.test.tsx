import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { USER_BUBBLE_BASE_CLASS, USER_BUBBLE_RAIL_CLASS } from './user-message'

/**
 * A sent prompt has to read as *spoken* — hugging its own text, parked on the
 * right of the column, painted a visible step off the transcript. Full-width
 * and card-white it read as an empty input field, and a thread of them had no
 * rhythm at all.
 *
 * jsdom resolves no Tailwind and no theme, so the guards here are on the
 * declarations themselves plus the tokens in styles.css — enough to catch the
 * three ways this regresses: the rail loses its right pull, the bubble goes
 * back to full width, or a light skin's bubble collapses onto the card rung.
 */

const styles = readFileSync(resolve(__dirname, '../../../styles.css'), 'utf-8')

describe('the user bubble rail', () => {
  it('pulls the bubble to the right of the column and caps its measure', () => {
    expect(USER_BUBBLE_RAIL_CLASS).toContain('ml-auto')
    expect(USER_BUBBLE_RAIL_CLASS).toContain('max-w-(--user-bubble-max-width)')
    expect(styles).toMatch(/--user-bubble-max-width:\s*min\(/)
  })

  it('leaves the bubble no reserved gutter — its actions live outside the fill', () => {
    // `pr-9` used to hold a well for the restore glyph, so "ok" rendered as a
    // pill two thirds empty. The actions hang off the rail instead now.
    expect(USER_BUBBLE_BASE_CLASS).not.toMatch(/\bpr-\d/)
  })

  it('paints the skin its own bubble colour in both bands', () => {
    // 0% in light collapsed every skin's bubble onto --theme-neutral-card: a
    // white box on near-white paper. Both rungs mix at 100% now, and the
    // inline knobs in themes/context.tsx must say the same thing.
    const context = readFileSync(resolve(__dirname, '../../../themes/context.tsx'), 'utf-8')

    expect(styles.match(/--theme-mix-bubble:\s*([^;]+);/g)).toEqual([
      '--theme-mix-bubble: 100%;',
      '--theme-mix-bubble: 100%;'
    ])
    expect(context).toMatch(/'--theme-mix-bubble':\s*'100%'/)
  })
})
