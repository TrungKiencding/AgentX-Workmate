import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { BRAND_MARK_PATHS, BRAND_MARK_ROUTE } from '@/lib/brand-mark-path'

import { BrandGlyph } from './brand-glyph'

const glyphOf = (container: HTMLElement) => container.querySelector('svg[data-slot="brand-glyph"]')!

// The glyph's box (Tailwind size class → CSS px) and the 0.88 inset its group draws in.
const BOX_PX = { md: 20, sm: 14 } as const
const INSET = 0.88

describe('BrandGlyph', () => {
  afterEach(cleanup)

  it('draws the plain mark as a 1.5px hairline at any size', () => {
    const { container } = render(<BrandGlyph />)
    const glyph = glyphOf(container)
    const paths = [...glyph.querySelectorAll('path')]

    expect(glyph.getAttribute('aria-hidden')).toBe('true')
    expect(glyph.hasAttribute('data-tracing')).toBe(false)
    expect(glyph.getAttribute('class')).toContain('size-5')
    expect(glyph.getAttribute('stroke-width')).toBe('1.5')
    expect(paths.map(path => path.getAttribute('d'))).toEqual([...BRAND_MARK_PATHS])
    expect(paths.every(path => path.getAttribute('vector-effect') === 'non-scaling-stroke')).toBe(true)
  })

  // While tracing, a dash is measured along the route in the route's own units
  // (pathLength 1) — a non-scaling stroke would measure it in screen pixels and
  // the pen would cover the wrong share of the mark.
  it.each(['md', 'sm'] as const)('traces the one-stroke route over a faint copy of the mark at %s', size => {
    const { container } = render(<BrandGlyph size={size} tracing />)
    const glyph = glyphOf(container)
    const ghost = glyph.querySelector('[data-slot="brand-glyph-ghost"]')!
    const ink = glyph.querySelector('[data-slot="brand-glyph-ink"]')!

    expect(glyph.getAttribute('aria-hidden')).toBe('true')
    expect(glyph.hasAttribute('data-tracing')).toBe(true)
    expect(glyph.getAttribute('class')).toContain(size === 'md' ? 'size-5' : 'size-3.5')
    expect([...ghost.querySelectorAll('path')].map(path => path.getAttribute('d'))).toEqual([...BRAND_MARK_PATHS])
    expect(ink.getAttribute('d')).toBe(BRAND_MARK_ROUTE)
    expect(ink.getAttribute('pathLength')).toBe('1')
    expect(glyph.querySelector('[vector-effect]')).toBeNull()

    // Still the 1.5px hairline once the viewBox and the inset have scaled it.
    const strokeWidth = Number(glyph.getAttribute('stroke-width'))

    expect(strokeWidth * (BOX_PX[size] / 100) * INSET).toBeCloseTo(1.5, 6)
  })

  it('rests as exactly the plain mark when tracing stops', () => {
    const { container, rerender } = render(<BrandGlyph size="sm" tracing />)

    rerender(<BrandGlyph size="sm" tracing={false} />)

    const plain = render(<BrandGlyph size="sm" />).container

    expect(glyphOf(container).outerHTML).toBe(glyphOf(plain).outerHTML)
  })
})
