import { describe, expect, it } from 'vitest'

import { baseColorsFor, contrastRatio } from './color'
import { ACCENT_PRESETS, nousTheme, nousWithAccent } from './presets'

describe('nousWithAccent', () => {
  it('returns the shipped skin for the default accent and for junk input', () => {
    // '' / invalid / the Nous blue itself must be byte-for-byte the shipped
    // theme — "no accent picked" cannot drift from the preset.
    expect(nousWithAccent(ACCENT_PRESETS[0].value)).toBe(nousTheme)
    expect(nousWithAccent('')).toBe(nousTheme)
    expect(nousWithAccent('purple')).toBe(nousTheme)
    expect(nousWithAccent('#0053FD')).toBe(nousTheme)
  })

  it('keeps every curated accent on the gate floors in both bands', () => {
    for (const { name, value } of ACCENT_PRESETS.slice(1)) {
      const theme = nousWithAccent(value)

      expect(theme, name).not.toBe(nousTheme)

      for (const mode of ['light', 'dark'] as const) {
        const c = baseColorsFor(theme, mode)
        const base = baseColorsFor(nousTheme, mode)

        // A filled primary carries its label; stroke duty reads on the page.
        expect(contrastRatio(c.primaryForeground, c.primary), `${name}/${mode} primary label`).toBeGreaterThanOrEqual(
          4.5
        )
        expect(contrastRatio(c.ring, c.background), `${name}/${mode} ring`).toBeGreaterThanOrEqual(3)
        // Only what the blue carried moves — bands and inks stay Paper/Graphite.
        expect(c.background, `${name}/${mode} band`).toBe(base.background)
        expect(c.foreground, `${name}/${mode} ink`).toBe(base.foreground)
        expect(c.mutedForeground, `${name}/${mode} muted ink`).toBe(base.mutedForeground)
        expect(c.destructive, `${name}/${mode} danger`).toBe(base.destructive)
      }
    }
  })
})
