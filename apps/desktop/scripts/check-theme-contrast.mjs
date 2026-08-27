#!/usr/bin/env node
/**
 * Theme contrast gate — UI-REDESIGN-PLAN Phase 8.
 *
 * Measures every built-in preset in both variants exactly as the app paints
 * them: the preset data and the variant derivation (`baseColorsFor`, incl. the
 * synthesised light pass) are imported straight from `src/themes/` — Node's
 * type stripping runs the .ts sources, so there is no mirrored math to drift.
 *
 * Gates (per variant), from UI-REDESIGN-PLAN §5.30 + §2.2:
 *   text pairs      WCAG ≥ 4.5:1   fg/bg, card, popover, muted, secondary,
 *                                  accent, primary, destructive
 *   filled controls APCA |Lc| ≥ 60 primary + destructive carry their label
 *   focus ring      WCAG ≥ 3:1     ring vs page (WCAG 1.4.11 boundary)
 *   hairlines       WCAG ≥ 1.2:1   border/sidebarBorder must exist on screen
 *
 * The plan's shorthand "border/bg ≥ 3:1" is deliberately NOT applied to
 * hairlines: 3:1 is the WCAG floor for boundaries that are the sole indicator
 * (the focus ring, gated above). design.md's quiet-hairline principle owns
 * divider strength; the 1.2:1 floor only catches borders that have vanished
 * (§1 A6, the original audit finding). APCA Lc is printed for every text pair;
 * below 60 it warns without failing — WCAG 4.5 is the plan's body floor.
 *
 * Run: node scripts/check-theme-contrast.mjs   (wired into `npm run check`)
 */

import { registerHooks } from 'node:module'

// The theme sources use the app's extensionless relative imports; Node's type
// stripping doesn't resolve those, so append `.ts` when the bare specifier
// misses. Registered before the dynamic imports below pull in the graph.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context)
      }

      throw error
    }
  }
})

const { baseColorsFor, contrastRatio, hexToRgb } = await import('../src/themes/color.ts')
const { ACCENT_PRESETS, BUILTIN_THEME_LIST, nousWithAccent } = await import('../src/themes/presets.ts')

// ─── color-mix() resolution ────────────────────────────────────────────────
// Presets may express soft fills as `color-mix(in srgb, <hex> N%, <hex|transparent>)`
// (the only form used). CSS mixes gamma sRGB component-wise; `transparent`
// keeps the first color at alpha N%, composited here over the pair's backdrop.

const MIX_RE = /^color-mix\(in srgb,\s*(#[0-9a-f]{6})\s+([\d.]+)%,\s*(#[0-9a-f]{6}|transparent)\)$/i

const toRgb = hex => hexToRgb(hex) ?? [0, 0, 0]

const rgbHex = rgb => `#${rgb.map(n => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0')).join('')}`

const blend = (a, b, weightA) => rgbHex(toRgb(a).map((ch, i) => ch * weightA + toRgb(b)[i] * (1 - weightA)))

/** Flattens a preset color (hex or color-mix) to opaque #rrggbb over `backdrop`. */
function resolve(value, backdrop) {
  if (typeof value !== 'string') {
    return null
  }

  const mix = value.trim().match(MIX_RE)

  if (!mix) {
    return /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim().toLowerCase() : null
  }

  const [, color, pct, other] = mix
  const amount = Number(pct) / 100

  return other.toLowerCase() === 'transparent' ? blend(color, backdrop, amount) : blend(color, other, amount)
}

// ─── APCA (APCA-W3 / SAPC-4g, v0.1.9 constants) ────────────────────────────
// https://github.com/Myndex/apca-w3 — reference implementation constants.

const apcaY = hex => {
  const [r, g, b] = toRgb(hex).map(v => (v / 255) ** 2.4)

  return 0.2126729 * r + 0.7151522 * g + 0.072175 * b
}

const softClamp = y => (y >= 0.022 ? y : y + (0.022 - y) ** 1.414)

/** APCA Lc (±); positive = dark text on light, negative = light on dark. */
function apcaLc(text, bg) {
  const yTxt = softClamp(apcaY(text))
  const yBg = softClamp(apcaY(bg))

  if (Math.abs(yBg - yTxt) < 0.0005) {
    return 0
  }

  if (yBg > yTxt) {
    const sapc = (yBg ** 0.56 - yTxt ** 0.57) * 1.14

    return sapc < 0.1 ? 0 : (sapc - 0.027) * 100
  }

  const sapc = (yBg ** 0.65 - yTxt ** 0.62) * 1.14

  return sapc > -0.1 ? 0 : (sapc + 0.027) * 100
}

// ─── Pairs & floors ────────────────────────────────────────────────────────

const TEXT_MIN = 4.5
const BOUNDARY_MIN = 3
const HAIRLINE_MIN = 1.2
const LABEL_APCA_MIN = 60

function pairsFor(c) {
  const bg = resolve(c.background, '#000000')
  const onBg = key => resolve(c[key], bg)
  const pair = (kind, label, fgRaw, bgRaw, backdrop = bg) => {
    const solidBg = resolve(bgRaw, backdrop)

    return solidBg === null ? null : { bg: solidBg, fg: resolve(fgRaw, solidBg), kind, label }
  }

  return [
    pair('text', 'foreground/background', c.foreground, c.background),
    pair('text', 'cardForeground/card', c.cardForeground, c.card),
    pair('text', 'popoverForeground/popover', c.popoverForeground, c.popover),
    pair('text', 'mutedForeground/background', c.mutedForeground, c.background),
    pair('text', 'secondaryForeground/secondary', c.secondaryForeground, c.secondary),
    pair('text', 'accentForeground/accent', c.accentForeground, c.accent),
    pair('label', 'primaryForeground/primary', c.primaryForeground, c.primary),
    pair('label', 'destructiveForeground/destructive', c.destructiveForeground, c.destructive),
    pair('boundary', 'ring/background', c.ring, c.background),
    pair('hairline', 'border/background', c.border, c.background),
    c.sidebarBorder && c.sidebarBackground
      ? pair('hairline', 'sidebarBorder/sidebarBackground', c.sidebarBorder, c.sidebarBackground)
      : null
  ].filter(Boolean)
}

const FLOORS = { boundary: BOUNDARY_MIN, hairline: HAIRLINE_MIN, label: TEXT_MIN, text: TEXT_MIN }

// ─── Report ────────────────────────────────────────────────────────────────

const failures = []
const warnings = []
const rows = []

// Built-ins, plus the Nous preset re-seeded on every curated accent — the
// picker's variants hold the same floors as the shipped skin.
const measured = [
  ...BUILTIN_THEME_LIST.map(theme => [theme.name, theme]),
  ...ACCENT_PRESETS.filter(preset => nousWithAccent(preset.value) !== BUILTIN_THEME_LIST[0]).map(preset => [
    `nous+${preset.name}`,
    nousWithAccent(preset.value)
  ])
]

for (const [label, theme] of measured) {
  for (const mode of ['light', 'dark']) {
    const variant = `${label}/${mode}${theme.darkColors ? '' : mode === 'light' ? ' (synth)' : ''}`

    for (const { kind, label, fg, bg } of pairsFor(baseColorsFor(theme, mode))) {
      if (fg === null) {
        failures.push(`${variant} · ${label}: unresolvable color`)
        continue
      }

      const ratio = contrastRatio(fg, bg)
      const lc = kind === 'text' || kind === 'label' ? apcaLc(fg, bg) : null
      const ok = ratio >= FLOORS[kind] && (kind !== 'label' || Math.abs(lc) >= LABEL_APCA_MIN)

      rows.push(
        `${ok ? ' ' : '✗'} ${variant.padEnd(24)} ${label.padEnd(36)} ${ratio.toFixed(2).padStart(6)}:1` +
          (lc === null ? '' : `  Lc ${Math.abs(lc).toFixed(0).padStart(3)}`)
      )

      if (!ok) {
        failures.push(
          `${variant} · ${label}: ${ratio.toFixed(2)}:1` +
            (lc === null ? '' : ` (Lc ${Math.abs(lc).toFixed(0)})`) +
            ` — floor ${FLOORS[kind]}:1${kind === 'label' ? ` + Lc ${LABEL_APCA_MIN}` : ''}`
        )
      } else if (kind === 'text' && Math.abs(lc) < LABEL_APCA_MIN) {
        warnings.push(`${variant} · ${label}: Lc ${Math.abs(lc).toFixed(0)} < ${LABEL_APCA_MIN} (WCAG ${ratio.toFixed(2)}:1 passes)`)
      }
    }
  }
}

const verbose = process.argv.includes('--verbose')

if (verbose) {
  console.log(rows.join('\n'))
}

if (warnings.length > 0 && verbose) {
  console.log(`\nAPCA advisories (non-blocking):\n${warnings.map(w => `  · ${w}`).join('\n')}`)
}

if (failures.length > 0) {
  console.error(`\nTheme contrast gate: ${failures.length} failing pair(s)\n${failures.map(f => `  ✗ ${f}`).join('\n')}`)
  process.exit(1)
}

console.log(
  `Theme contrast gate: ${rows.length} pairs across ${measured.length} palettes × 2 variants — all clear` +
    (warnings.length > 0 ? ` (${warnings.length} APCA advisories; --verbose to list)` : '')
)
