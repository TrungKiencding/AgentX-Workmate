import { describe, expect, it } from 'vitest'

import { lastInputModality, MODALITY_ATTR } from './input-modality'

const rootModality = () => document.documentElement.getAttribute(MODALITY_ATTR)

describe('lastInputModality', () => {
  // First test in the file on purpose: this is the only point at which "before
  // any input" is still true. The root stamp is asserted here rather than in its
  // own case for the same reason — a later test would be reading a switch.
  it('defaults to keyboard before any input, root included', () => {
    expect(lastInputModality()).toBe('keyboard')
    expect(rootModality()).toBe('keyboard')
  })

  it('tracks the device behind the last interaction', () => {
    document.dispatchEvent(new Event('pointerdown'))

    expect(lastInputModality()).toBe('pointer')

    document.dispatchEvent(new Event('keydown'))

    expect(lastInputModality()).toBe('keyboard')
  })

  it('sees events a handler stops from bubbling (capture phase)', () => {
    const target = document.createElement('button')

    document.body.append(target)
    target.addEventListener('pointerdown', event => event.stopPropagation())
    target.dispatchEvent(new Event('pointerdown', { bubbles: true }))

    expect(lastInputModality()).toBe('pointer')

    target.remove()
  })
})

// The focus-ring rule can only live in CSS, so the only thing it can read is an
// attribute — see `focus-ring.test.ts` for what the rule then does with it.
describe('the document root mirrors the modality for CSS', () => {
  it('follows every switch', () => {
    document.dispatchEvent(new Event('pointerdown'))

    expect(rootModality()).toBe('pointer')

    document.dispatchEvent(new Event('keydown'))

    expect(rootModality()).toBe('keyboard')
  })
})
