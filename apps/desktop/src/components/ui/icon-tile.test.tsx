import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { skillCategoryTint } from '@/lib/skill-categories'

import { IconTile, tintFor, TINTS } from './icon-tile'

afterEach(cleanup)

describe('tintFor', () => {
  it('gives a name the same colour every time, and never graphite by chance', () => {
    for (const name of ['media', 'email', 'research', 'unknown-thing']) {
      expect(tintFor(name)).toBe(tintFor(name))
      expect(tintFor(name)).not.toBe('graphite')
      expect(TINTS).toContain(tintFor(name))
    }
  })
})

describe('skillCategoryTint', () => {
  it('uses the chosen colour for a known category, whatever its casing', () => {
    expect(skillCategoryTint('Email')).toBe('blue')
    expect(skillCategoryTint('note_taking')).toBe('yellow')
  })

  it('keeps neighbouring known shelves apart', () => {
    expect(skillCategoryTint('media')).not.toBe(skillCategoryTint('apple'))
  })
})

describe('IconTile', () => {
  it('paints its tint token, solid with a white glyph or as a soft wash', () => {
    const { container } = render(
      <>
        <IconTile tint="green" variant="solid">
          <svg />
        </IconTile>
        <IconTile tint="pink">
          <svg />
        </IconTile>
      </>
    )

    const [solid, soft] = [...container.querySelectorAll<HTMLElement>('[data-slot="icon-tile"]')]

    expect(solid!.style.getPropertyValue('--tile-tint')).toBe('var(--tint-green)')
    expect(solid!.className).toContain('text-white')
    expect(soft!.dataset.tint).toBe('pink')
    expect(soft!.className).toContain('text-(--tile-tint)')
  })
})
