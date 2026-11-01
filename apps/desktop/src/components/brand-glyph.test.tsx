import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { BRAND_MARK_PATHS } from '@/lib/brand-mark-path'

import { BrandGlyph } from './brand-glyph'

const glyphOf = (container: HTMLElement) => container.querySelector('svg[data-slot="brand-glyph"]')!

describe('BrandGlyph', () => {
  afterEach(cleanup)

  it('draws the plain mark as a 1.5px hairline at any size', () => {
    const { container } = render(<BrandGlyph />)
    const glyph = glyphOf(container)
    const paths = [...glyph.querySelectorAll('path')]

    expect(glyph.getAttribute('aria-hidden')).toBe('true')
    expect(glyph.getAttribute('class')).toContain('size-5')
    expect(glyph.getAttribute('stroke-width')).toBe('1.5')
    expect(paths.map(path => path.getAttribute('d'))).toEqual([...BRAND_MARK_PATHS])
    expect(paths.every(path => path.getAttribute('vector-effect') === 'non-scaling-stroke')).toBe(true)
  })
})
