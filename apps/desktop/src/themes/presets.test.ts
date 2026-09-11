import { describe, expect, it } from 'vitest'

import { baseColorsFor, contrastRatio } from './color'
import {
  ACCENT_SKIN_NAME,
  BUILTIN_THEME_LIST,
  BUILTIN_THEMES,
  DEFAULT_SERIF_DISPLAY,
  DEFAULT_SKIN_NAME,
  DEFAULT_TYPOGRAPHY,
  EMOJI_FALLBACK,
  nightOwlTheme,
  nousClassicTheme,
  nousTheme
} from './presets'

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
    expect(BUILTIN_THEMES[DEFAULT_SKIN_NAME].typography?.fontUrl).toBeUndefined()
  })

  it('ships a serif-display default; themes may omit the field', () => {
    expect(DEFAULT_TYPOGRAPHY.fontSerifDisplay).toBe(DEFAULT_SERIF_DISPLAY)
    expect(DEFAULT_SERIF_DISPLAY).toContain('Newsreader')

    // Pre-existing themes never declare it — the merge in applyTheme falls
    // back to the default, so old user themes keep loading unchanged.
    for (const theme of BUILTIN_THEME_LIST) {
      expect(theme.typography?.fontSerifDisplay).toBeUndefined()
    }
  })
})

// Phase 2 of the UI uplift moved the default dark band from royal blue to
// Graphite and kept the old palette whole as its own preset. Both halves of
// that promise are load-bearing: the ladder is what makes elevation readable,
// and the preset is what stops anyone losing the palette they chose.
describe('default bands', () => {
  const band = (colors: Record<string, string>) => [
    colors.sidebarBackground,
    colors.background,
    colors.card,
    colors.popover
  ]

  it('paints Graphite as the default dark band, one rung per surface', () => {
    expect(band(nousTheme.darkColors as unknown as Record<string, string>)).toEqual([
      '#080b10',
      '#0d0f15',
      '#13161c',
      '#1a1d23'
    ])
  })

  it('keeps every dark rung distinct and monotonically lighter', () => {
    const rungs = band(nousTheme.darkColors as unknown as Record<string, string>)

    expect(new Set(rungs).size).toBe(rungs.length)

    // Contrast against pure black rises with lightness — a cheap monotonicity
    // check that needs no OKLCH implementation in the test.
    const steps = rungs.map(hex => contrastRatio(hex, '#000000'))

    expect(steps).toEqual([...steps].sort((a, b) => a - b))
  })

  it('reads text and the accent against the graphite page', () => {
    const dark = nousTheme.darkColors as unknown as Record<string, string>

    expect(contrastRatio(dark.foreground, dark.background)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(dark.mutedForeground, dark.background)).toBeGreaterThanOrEqual(4.5)
    // The focus ring is a non-text boundary: 3:1 against the page behind it.
    expect(contrastRatio(dark.ring, dark.background)).toBeGreaterThanOrEqual(3)
    // A filled button has to carry its own label.
    expect(contrastRatio(dark.primaryForeground, dark.primary)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(dark.destructiveForeground, dark.destructive)).toBeGreaterThanOrEqual(4.5)
  })

  it('reads text and the accent against the paper page', () => {
    const light = nousTheme.colors as unknown as Record<string, string>

    expect(contrastRatio(light.foreground, light.background)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(light.mutedForeground, light.background)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(light.ring, light.background)).toBeGreaterThanOrEqual(3)
    expect(contrastRatio(light.primaryForeground, light.primary)).toBeGreaterThanOrEqual(4.5)
  })

  // Phase 8: the full matrix (every preset × both variants × every pair) is
  // gated by `scripts/check-theme-contrast.mjs` in `npm run check`. These unit
  // cases pin the two guarantees that script relies on from the code side.
  it('keeps the synthesised light variant of dark-only presets readable', () => {
    for (const theme of BUILTIN_THEME_LIST.filter(entry => !entry.darkColors)) {
      const light = baseColorsFor(theme, 'light')

      // Body text floors (UI-REDESIGN-PLAN §5.30): muted text and the filled
      // primary's label — `readableOn`'s threshold used to coin-flip both.
      expect(
        contrastRatio(light.mutedForeground, light.background),
        `${theme.name} mutedForeground`
      ).toBeGreaterThanOrEqual(4.5)
      expect(
        contrastRatio(light.primaryForeground, light.primary),
        `${theme.name} primary label`
      ).toBeGreaterThanOrEqual(4.5)
      // The focus ring is a boundary: 3:1 against the page (neon-green and
      // mid-grey accents fell to 1.4–2.9:1 before the ensureContrast guard).
      expect(contrastRatio(light.ring, light.background), `${theme.name} ring`).toBeGreaterThanOrEqual(3)
    }
  })

  it('keeps the fun skins legible where the plan named failures', () => {
    const cyberpunk = BUILTIN_THEMES.cyberpunk.colors

    // §Phase 8: cyberpunk mutedForeground was #1a8a30 at 4.53:1 — the lift
    // must keep real margin, not sit on the floor.
    expect(contrastRatio(cyberpunk.mutedForeground, cyberpunk.background)).toBeGreaterThanOrEqual(5)
    expect(contrastRatio(cyberpunk.destructiveForeground, cyberpunk.destructive)).toBeGreaterThanOrEqual(4.5)

    const slate = BUILTIN_THEMES.slate.colors

    expect(contrastRatio(slate.destructiveForeground, slate.destructive)).toBeGreaterThanOrEqual(4.5)
  })

  it('ships the royal-blue dark as Nous Classic, sharing the Nous light palette', () => {
    expect(BUILTIN_THEMES['nous-classic']).toBe(nousClassicTheme)
    expect(nousClassicTheme.colors).toBe(nousTheme.colors)
    expect(nousClassicTheme.darkColors?.background).toBe('#0D2F86')
    // Retiring nothing: every earlier default is still a skin you can pick.
    expect(BUILTIN_THEME_LIST.map(theme => theme.name)).toContain('nous-classic')
    expect(BUILTIN_THEME_LIST.map(theme => theme.name)).toContain('nous')
  })

  it('ships Night Owl as the default, hand-tuned on BOTH bands', () => {
    expect(DEFAULT_SKIN_NAME).toBe('night-owl')
    expect(BUILTIN_THEMES[DEFAULT_SKIN_NAME]).toBe(nightOwlTheme)
    // Both bands are authored: no synth pass runs for the skin every install
    // lands on, so `colors` is Night Owl Light and `darkColors` the original.
    expect(nightOwlTheme.darkColors?.background).toBe('#011627')
    expect(nightOwlTheme.colors.background).toBe('#fbfbfb')
  })

  it('leaves the accent picker on Nous, not on whatever ships as default', () => {
    // nousWithAccent rebuilds the NOUS palette around the hue, so aiming this
    // at the default skin would swap Night Owl's palette out from under it.
    expect(ACCENT_SKIN_NAME).toBe('nous')
    expect(ACCENT_SKIN_NAME).not.toBe(DEFAULT_SKIN_NAME)
  })
})
