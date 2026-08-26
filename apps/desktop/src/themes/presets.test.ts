import { describe, expect, it } from 'vitest'

import { BUILTIN_THEME_LIST, DEFAULT_SERIF_DISPLAY, DEFAULT_TYPOGRAPHY, EMOJI_FALLBACK } from './presets'

// #40364: none of the UI text/mono fonts carry emoji glyphs, so every font
// stack must end with a color-emoji fallback or emoji render as tofu on
// platforms whose default font lacks them (e.g. Linux).
describe('theme typography emoji fallback (#40364)', () => {
  const stacks: Array<[string, string]> = [
    ['DEFAULT_TYPOGRAPHY.fontSans', DEFAULT_TYPOGRAPHY.fontSans],
    ['DEFAULT_TYPOGRAPHY.fontMono', DEFAULT_TYPOGRAPHY.fontMono],
    // A theme may override only fontMono (fontSans then falls back to the
    // default, which already carries the emoji stack), so skip undefined.
    ...BUILTIN_THEME_LIST.flatMap(theme =>
      (
        [
          [`${theme.name}.fontSans`, theme.typography?.fontSans],
          [`${theme.name}.fontMono`, theme.typography?.fontMono]
        ] as Array<[string, string | undefined]>
      ).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    )
  ]

  it.each(stacks)('%s includes a color-emoji font', (_label, stack) => {
    expect(stack).toMatch(/Apple Color Emoji|Segoe UI Emoji|Noto Color Emoji|(^|,\s*)emoji\b/)
  })

  it('EMOJI_FALLBACK lists the major platform emoji fonts', () => {
    expect(EMOJI_FALLBACK).toContain('Apple Color Emoji')
    expect(EMOJI_FALLBACK).toContain('Segoe UI Emoji')
    expect(EMOJI_FALLBACK).toContain('Noto Color Emoji')
  })
})

describe('bundled default typography', () => {
  it('leads with the vendored faces (no CDN fetch for the default theme)', () => {
    expect(DEFAULT_TYPOGRAPHY.fontSans).toMatch(/^"Geist"/)
    expect(DEFAULT_TYPOGRAPHY.fontMono).toMatch(/^"JetBrains Mono"/)
    // The default skin must not carry a runtime font stylesheet URL.
    expect(BUILTIN_THEME_LIST.find(theme => theme.name === 'nous')?.typography?.fontUrl).toBeUndefined()
  })

  it('ships a serif-display default; themes may omit the field', () => {
    expect(DEFAULT_TYPOGRAPHY.fontSerifDisplay).toBe(DEFAULT_SERIF_DISPLAY)
    expect(DEFAULT_SERIF_DISPLAY).toContain('Instrument Serif')

    // Pre-existing themes never declare it — the merge in applyTheme falls
    // back to the default, so old user themes keep loading unchanged.
    for (const theme of BUILTIN_THEME_LIST) {
      expect(theme.typography?.fontSerifDisplay).toBeUndefined()
    }
  })
})
