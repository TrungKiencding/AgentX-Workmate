/**
 * Small color helpers shared by the theme context (synthesised light variants)
 * and the VS Code theme converter (token → seed mapping).
 *
 * Everything works in 6-digit `#rrggbb`. `normalizeHex` is the front door for
 * untrusted input (VS Code themes use `#rgb`, `#rgba`, `#rrggbbaa`, and named
 * tokens), flattening alpha over a backdrop so downstream math stays simple.
 *
 * This module stays a leaf (no value imports): `scripts/check-theme-contrast.mjs`
 * loads it directly under Node to measure the presets with the app's own math.
 */

import type { DesktopTheme, DesktopThemeColors } from './types'

export function hexToRgb(hex: string): [number, number, number] | null {
  const clean = hex.trim().replace(/^#/, '')

  if (!/^[0-9a-f]{6}$/i.test(clean)) {
    return null
  }

  return [0, 2, 4].map(i => parseInt(clean.slice(i, i + 2), 16)) as [number, number, number]
}

export const rgbToHex = ([r, g, b]: [number, number, number]): string =>
  `#${[r, g, b]
    .map(n =>
      Math.round(Math.min(255, Math.max(0, n)))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`

export function mix(a: string, b: string, amount: number): string {
  const ar = hexToRgb(a)
  const br = hexToRgb(b)

  return ar && br
    ? rgbToHex([ar[0] + (br[0] - ar[0]) * amount, ar[1] + (br[1] - ar[1]) * amount, ar[2] + (br[2] - ar[2]) * amount])
    : a
}

const linearize = (channel: number): number =>
  channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4

/** WCAG relative luminance (gamma-corrected), 0..1. */
export function relativeLuminance(hex: string): number {
  const rgb = hexToRgb(hex)

  if (!rgb) {
    return 0
  }

  const [r, g, b] = rgb.map(v => linearize(v / 255))

  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio (1..21) between two hex colors. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)

  return la >= lb ? (la + 0.05) / (lb + 0.05) : (lb + 0.05) / (la + 0.05)
}

/** Returns a readable foreground (#161616 or #ffffff) for a background hex. */
export function readableOn(hex: string): string {
  return relativeLuminance(hex) > 0.58 ? '#161616' : '#ffffff'
}

/**
 * Like `readableOn`, but decided by measured contrast instead of a luminance
 * threshold — on mid-tone fills the threshold coin-flips to the *worse* side
 * (white on #9a9a9a reads 2.8:1 where black reads 6.3:1).
 */
export function bestTextOn(hex: string): string {
  return contrastRatio('#ffffff', hex) >= contrastRatio('#161616', hex) ? '#ffffff' : '#161616'
}

/**
 * Guarantee `color` reads against `bg`: if it's below `min` contrast, mix it
 * toward white (on a dark bg) or black (on a light bg) in steps until it clears,
 * keeping the hue as much as possible. Used so imported accents never collapse
 * into a near-background sidebar (the "invisible label" case).
 */
export function ensureContrast(color: string, bg: string, min: number): string {
  if (contrastRatio(color, bg) >= min) {
    return color
  }

  const towards = relativeLuminance(bg) < 0.5 ? '#ffffff' : '#000000'
  let best = color

  for (let amount = 0.2; amount <= 1.0001; amount += 0.2) {
    best = mix(color, towards, Math.min(amount, 1))

    if (contrastRatio(best, bg) >= min) {
      return best
    }
  }

  return best
}

/** Perceptual-ish luminance in 0..1 (naive, for light/dark bucketing). */
export function luminance(hex: string): number {
  const rgb = hexToRgb(hex)

  if (!rgb) {
    return 0
  }

  const [r, g, b] = rgb.map(v => v / 255)

  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * Coerce any CSS hex color VS Code themes throw at us into a flat 6-digit
 * `#rrggbb`, compositing alpha over `backdrop`. Accepts `#rgb`, `#rgba`,
 * `#rrggbb`, `#rrggbbaa` (with or without the leading `#`). Returns null for
 * non-hex values (named colors, `rgb()`, etc.) so callers can fall back.
 */
export function normalizeHex(input: string | undefined | null, backdrop = '#000000'): string | null {
  if (typeof input !== 'string') {
    return null
  }

  let clean = input.trim().replace(/^#/, '')

  // Expand shorthand (#rgb / #rgba) to full width.
  if (clean.length === 3 || clean.length === 4) {
    clean = clean
      .split('')
      .map(ch => ch + ch)
      .join('')
  }

  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(clean)) {
    return null
  }

  const rgb = hexToRgb(`#${clean.slice(0, 6)}`)

  if (!rgb) {
    return null
  }

  if (clean.length === 6) {
    return rgbToHex(rgb)
  }

  const alpha = parseInt(clean.slice(6, 8), 16) / 255
  const base = hexToRgb(backdrop) ?? [0, 0, 0]

  return rgbToHex([
    base[0] + (rgb[0] - base[0]) * alpha,
    base[1] + (rgb[1] - base[1]) * alpha,
    base[2] + (rgb[2] - base[2]) * alpha
  ])
}

// ─── Synthesised light variants ─────────────────────────────────────────────

/**
 * Light palette for a dark-only theme (single-palette presets and skins the
 * light/dark toggle would otherwise invert). Soft accent tints on white, with
 * the floors the contrast gate (`scripts/check-theme-contrast.mjs`) holds every
 * variant to: body text ≥ 4.5:1, the focus ring ≥ 3:1, and a filled control
 * that carries its own label — deepened until white text reads, because
 * `readableOn`'s threshold coin-flips on mid-tone accents.
 */
export function synthLightColors(seed: DesktopTheme): DesktopThemeColors {
  const accent = seed.colors.ring || seed.colors.primary
  const soft = mix('#ffffff', accent, 0.1)
  const softer = mix('#ffffff', accent, 0.06)
  // Base oklch(92% 0.005 286): deep enough that the hairline still exists on
  // the accent-tinted sidebar (#ececef sat exactly on the 1.2:1 floor there).
  const border = mix('#e4e4e8', accent, 0.14)
  const midground = ensureContrast(seed.colors.midground ?? accent, '#ffffff', 3)

  // Every authored preset's primary wears a white label; the synthesised one
  // does too, deepening bright accents (neon green, mid grey) until it reads.
  let primary = accent

  for (let step = 0; step < 10 && contrastRatio('#ffffff', primary) < 4.5; step++) {
    primary = mix(primary, '#000000', 0.12)
  }

  return {
    background: '#ffffff',
    foreground: '#161616',
    card: '#ffffff',
    cardForeground: '#161616',
    muted: softer,
    mutedForeground: ensureContrast(mix('#6b6b70', accent, 0.16), '#ffffff', 4.5),
    popover: '#ffffff',
    popoverForeground: '#161616',
    primary,
    primaryForeground: '#ffffff',
    secondary: soft,
    secondaryForeground: ensureContrast(mix('#2a2a2a', accent, 0.34), soft, 4.5),
    accent: soft,
    accentForeground: ensureContrast(mix('#2a2a2a', accent, 0.34), soft, 4.5),
    border,
    input: mix('#e2e2e6', accent, 0.18),
    ring: ensureContrast(accent, '#ffffff', 3),
    midground,
    midgroundForeground: bestTextOn(midground),
    destructive: '#b94a3a',
    destructiveForeground: '#ffffff',
    sidebarBackground: mix('#fafafa', accent, 0.05),
    sidebarBorder: border,
    userBubble: soft,
    userBubbleBorder: border
  }
}

/**
 * The palette a theme paints in a given mode — the shared rule behind
 * `getBaseColors` (themes/context.tsx) and the contrast gate: dark uses the
 * hand-tuned dark palette when one exists, light synthesises one for
 * single-palette themes.
 */
export function baseColorsFor(theme: DesktopTheme, mode: 'light' | 'dark'): DesktopThemeColors {
  if (mode === 'dark') {
    return theme.darkColors ?? theme.colors
  }

  return theme.darkColors ? theme.colors : synthLightColors(theme)
}
