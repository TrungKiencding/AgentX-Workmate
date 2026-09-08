import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * How the transcript ends — at the top, and against the composer.
 *
 * A scroller's own edge is a guillotine. Left alone it cuts a line of prose
 * through the middle of its glyphs and parks it there, half-rendered, for as
 * long as it takes to scroll clear — which is what the top of every
 * conversation used to look like. Two pieces fix that, and they only work
 * together, so both are pinned here.
 *
 * 1. The pinned-prompt mask has a HARD top edge: the text behind it must not
 *    ghost through, so it cannot fade there. A hard edge is only invisible
 *    where something already clips — which is why the mask parks at 0, exactly
 *    on the scroller's own edge. The shipped bug was a 0.23rem offset: a ~4px
 *    slot above the mask through which the previous turn scrolled past, sliced.
 * 2. Everything that ISN'T a pinned prompt dissolves into `aui_thread-edge-fade`
 *    instead — which means the thread's top padding has to hold that fade's
 *    whole depth open, or the first turn of a conversation comes to rest inside
 *    it and reads as a half-painted message.
 *
 * The composer end has the same cut for the same reason (the dock is opaque and
 * the transcript runs on behind it) and gets the same dissolve, mirrored.
 *
 * jsdom resolves neither Tailwind nor a theme, so the guards are on the
 * declarations themselves.
 */

const styles = readFileSync(resolve(__dirname, '../../../styles.css'), 'utf-8')
const list = readFileSync(resolve(__dirname, 'list.tsx'), 'utf-8')
const userMessage = readFileSync(resolve(__dirname, 'user-message.tsx'), 'utf-8')
const composer = readFileSync(resolve(__dirname, '../../../app/chat/composer/index.tsx'), 'utf-8')

const rem = (token: string): number => {
  const match = new RegExp(`--${token}:\\s*([0-9.]+)rem`).exec(styles)

  expect(match, `styles.css should declare --${token} in rem`).toBeTruthy()

  return Number((match as RegExpExecArray)[1])
}

describe('the transcript edges', () => {
  it('parks the prompt mask on the scroller edge, where its hard top is already clipped', () => {
    expect(rem('sticky-human-top')).toBe(0)
  })

  it('keeps the mask fade inside its own padding, so at rest it changes nothing', () => {
    const rule = /\[data-slot='aui_user-message-root'\] \{([\s\S]*?)\}/.exec(styles)?.[1] ?? ''
    const paddingBottom = /padding-bottom:\s*var\(--sticky-human-fade\)/.test(rule)

    // Equal, not merely "enough": a fade shorter than the padding leaves a
    // solid lip that cuts, and one longer spills onto the reply below and
    // washes out its first line while nothing is even pinned.
    expect(paddingBottom, `mask padding-bottom must be --sticky-human-fade: "${rule}"`).toBe(true)
    expect(rule).toContain('calc(100% - var(--sticky-human-fade))')
  })

  it('renders the edge fade between the transcript and the pinned prompt', () => {
    expect(list).toContain(`data-slot="aui_thread-edge-fade"`)

    const fade = /\[data-slot='aui_thread-edge-fade'\] \{([\s\S]*?)\}/.exec(styles)?.[1] ?? ''
    const fadeZ = Number(/z-index:\s*(\d+)/.exec(fade)?.[1])

    // Above the in-flow transcript (no z-index of its own), below the mask —
    // invert either and the fade either does nothing or washes the pinned
    // prompt it is supposed to leave crisp.
    expect(fadeZ).toBeGreaterThan(0)
    expect(fadeZ).toBeLessThan(40)
    expect(userMessage).toContain('sticky z-40')
  })

  it('holds the thread top padding open by at least the fade depth', () => {
    // Both branches (main window and the secondary windows, which start their
    // fade below a titlebar strip) have to clear it — see threadContentTopPad.
    expect(list).toContain('pt-[max(var(--transcript-edge-fade),calc(var(--titlebar-height)-0.5rem))]')
    expect(list).toContain('pt-[calc(var(--titlebar-height)+0.75rem+var(--transcript-edge-fade))]')
  })

  it('mirrors the dissolve at the composer end, glued to the dock rather than to a number', () => {
    expect(composer).toContain(`data-slot="composer-edge-fade"`)
    // Out of flow and anchored to the dock's own top: the dock is measured for
    // the thread's bottom clearance, so an in-flow strip here would push the
    // whole transcript up, and any fixed offset would drift the moment the
    // status stack or the action strip put something above the composer.
    const fade = /\[data-slot='composer-edge-fade'\] \{([\s\S]*?)\}/.exec(styles)?.[1] ?? ''

    expect(fade).toContain('position: absolute')
    expect(fade).toContain('bottom: 100%')
    expect(fade).toContain('height: var(--transcript-edge-fade)')
  })

  it('lands the secondary-window fade exactly where that window parks its mask', () => {
    // The mask sits at titlebar + 0.75rem there, so the fade stays opaque for
    // that same 0.75rem below the drag strip. Any daylight between the two is
    // the sliced-text slot again.
    expect(list).toContain(`'--sticky-human-top': secondaryTitlebarGap`)
    expect(list).toContain(`'--thread-edge-fade-top': 'var(--titlebar-height)'`)
    expect(list).toContain(`'--thread-edge-fade-solid': '0.75rem'`)
    expect(list).toContain(`const secondaryTitlebarGap = 'calc(var(--titlebar-height) + 0.75rem)'`)
  })
})
