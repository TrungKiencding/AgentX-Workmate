/**
 * Built-in desktop themes. Names match the CLI skins / dashboard presets.
 * Add new themes here — no code changes needed elsewhere.
 *
 * Every preset carries its axes in a comment (band · display · accent) and is
 * built on OKLCH values written out as hex (the pipeline in `color.ts` parses
 * `#rrggbb` only). Values must clear the contrast gate:
 * `node scripts/check-theme-contrast.mjs` (part of `npm run check`) holds both
 * variants of every preset to the floors in UI-REDESIGN-PLAN §5.30.
 */

import { ensureContrast, labelReadyFill, mix } from './color'
import type { DesktopTheme, DesktopThemeTypography } from './types'

// Color-emoji fonts to append to every stack as a last resort. None of the UI
// text/mono fonts carry emoji glyphs, so without this emoji render as tofu
// boxes on platforms whose default text font lacks them (e.g. Linux/#40364).
// Covers macOS, Windows, Linux, plus the `emoji` generic for anything else.
export const EMOJI_FALLBACK = '"Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji", emoji'

const SYSTEM_SANS =
  '"Segoe WPC", "Segoe UI", -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", system-ui, sans-serif, ' +
  EMOJI_FALLBACK

const SYSTEM_MONO = 'Menlo, Monaco, "SF Mono", monospace, ' + EMOJI_FALLBACK

// Bundled defaults (woff2 vendored in src/fonts/, no CDN fetch at runtime):
// Geist leads the sans stack with the system faces covering scripts the
// subset files lack (CJK, Cyrillic); JetBrains Mono is the default code face.
const GEIST_SANS = '"Geist", ' + SYSTEM_SANS
const JETBRAINS_MONO = '"JetBrains Mono", ' + SYSTEM_MONO

// Display serif — the sanctioned outlier face, used in exactly two slots
// (home greeting, onboarding hero). Roman only.
export const DEFAULT_SERIF_DISPLAY = '"Instrument Serif", Georgia, serif'

export const DEFAULT_TYPOGRAPHY: DesktopThemeTypography = {
  fontSans: GEIST_SANS,
  fontMono: JETBRAINS_MONO,
  fontSerifDisplay: DEFAULT_SERIF_DISPLAY
}

const NOUS_BLUE = '#0053FD'
const PSYCHE_BLUE = '#1540B1'
const PSYCHE_WARM = '#FFE6CB'

/**
 * The two neutral bands, as flat hex (this pipeline is hex-only: `color.ts`
 * mixes, luminance-buckets and contrast-checks every preset value, and it
 * parses `#rrggbb` alone). Each rung is the exact sRGB of the OKLCH stated
 * beside it, and the same rungs are mirrored as `--theme-neutral-*` fallbacks
 * in styles.css — change one, change both.
 *
 * PAPER (light): one ladder on hue 262, ~1% lightness per rung, every neutral
 * carrying a trace of chroma so it never reads as a dead grey patch.
 *
 * GRAPHITE (dark): the new default dark band. +3% lightness per rung — in dark
 * mode elevation IS lightness, never a glow and never a heavier shadow.
 */
const PAPER = {
  sidebar: '#f5f7fa', // oklch(97.55% 0.0045 258.3)
  page: '#f9fafd', // oklch(98.52% 0.0041 271.4)
  card: '#fcfdfe', // oklch(99.36% 0.0017 247.8)
  elevated: '#fefeff', // oklch(99.73% 0.0013 286.4)
  ink: '#16171a' // oklch(20.48% 0.0061 271.1)
} as const

const GRAPHITE = {
  sidebar: '#080b10', // oklch(15% 0.012 262)
  page: '#0d0f15', // oklch(17% 0.012 262)
  card: '#13161c', // oklch(20% 0.012 262)
  elevated: '#1a1d23', // oklch(23% 0.012 262)
  muted: '#21242a', // oklch(26% 0.012 262)
  raised: '#252930', // oklch(28% 0.014 262)
  accentSoft: '#1f242e', // oklch(26% 0.020 262)
  border: '#2e333b', // oklch(32% 0.016 262)
  input: '#23272d', // oklch(27% 0.014 262)
  sidebarBorder: '#1e2229', // oklch(25% 0.014 262)
  bubble: '#181f2c', // oklch(24% 0.026 262)
  bubbleBorder: '#2f3849', // oklch(34% 0.032 262)
  ink: '#e6e8ec', // oklch(93% 0.006 262) — 13.8:1 on the page
  inkMuted: '#9a9fa7', // oklch(70% 0.013 262) — 7.2:1
  inkSecondary: '#ced1d6', // oklch(86% 0.008 262)
  inkAccent: '#dee1e7' // oklch(91% 0.008 262)
} as const

/**
 * Nous blue on graphite. The seed itself (L 53%) is too dark to carry a stroke
 * on a 17% ground, so strokes/focus/active use the lifted blue and the primary
 * BUTTON stays deep enough for white text (5.06:1) — the two jobs need
 * different lightness, not different hues.
 */
const NOUS_BLUE_LIFTED = '#4886fe' // oklch(64% 0.19 262) — 5.58:1 on the page
const NOUS_BLUE_DEEP = '#2867e4' // oklch(55% 0.20 262) — white on it: 5.06:1

const nousTint = (pct: number) => `color-mix(in srgb, ${NOUS_BLUE} ${pct}%, #FFFFFF)`
const nousTintTransparent = (pct: number) => `color-mix(in srgb, ${NOUS_BLUE} ${pct}%, transparent)`

/**
 * Nous — canonical AgentX desktop identity. The palette keeps the current
 * glass geometry neutral, then lets the old bb/gui blue and psyche cream
 * return as accent seeds.
 *
 * Axes — band: Paper (light) / Graphite (dark), the hue-262 ladders above ·
 * display: Geist + JetBrains Mono + the Instrument Serif outlier · accent:
 * Nous blue oklch(52.8% 0.259 263), lifted per-band for stroke duty.
 */
export const nousTheme: DesktopTheme = {
  name: 'nous',
  label: 'Nous',
  description: 'Glass neutrals with Nous blue accents',
  colors: {
    background: PAPER.page,
    foreground: PAPER.ink,
    card: PAPER.card,
    cardForeground: PAPER.ink,
    muted: nousTint(5),
    mutedForeground: '#656971',
    popover: PAPER.elevated,
    popoverForeground: PAPER.ink,
    primary: NOUS_BLUE,
    primaryForeground: '#FCFCFC',
    secondary: nousTint(7),
    secondaryForeground: '#25262c',
    accent: nousTint(10),
    accentForeground: '#1f2027',
    border: nousTintTransparent(22),
    input: nousTintTransparent(30),
    ring: NOUS_BLUE,
    midground: NOUS_BLUE,
    composerRing: NOUS_BLUE,
    destructive: '#C72E4D',
    destructiveForeground: '#FFFFFF',
    sidebarBackground: PAPER.sidebar,
    sidebarBorder: nousTintTransparent(18),
    userBubble: nousTint(6),
    userBubbleBorder: nousTintTransparent(24)
  },
  /** Graphite — the default dark band. Quiet ground, elevation by lightness. */
  darkColors: {
    background: GRAPHITE.page,
    foreground: GRAPHITE.ink,
    card: GRAPHITE.card,
    cardForeground: GRAPHITE.ink,
    muted: GRAPHITE.muted,
    mutedForeground: GRAPHITE.inkMuted,
    popover: GRAPHITE.elevated,
    popoverForeground: GRAPHITE.ink,
    primary: NOUS_BLUE_DEEP,
    primaryForeground: '#ffffff',
    secondary: GRAPHITE.raised,
    secondaryForeground: GRAPHITE.inkSecondary,
    accent: GRAPHITE.accentSoft,
    accentForeground: GRAPHITE.inkAccent,
    border: GRAPHITE.border,
    input: GRAPHITE.input,
    ring: NOUS_BLUE_LIFTED,
    midground: NOUS_BLUE_LIFTED,
    composerRing: NOUS_BLUE_LIFTED,
    destructive: '#cf2d56',
    destructiveForeground: '#ffffff',
    sidebarBackground: GRAPHITE.sidebar,
    sidebarBorder: GRAPHITE.sidebarBorder,
    userBubble: GRAPHITE.bubble,
    userBubbleBorder: GRAPHITE.bubbleBorder
  },
  // Bundled Geist + JetBrains Mono, no fontUrl: Nous was the default skin for
  // most of the app's life and half the presets inherit its typography, so it
  // stays CDN-free even now that Night Owl ships first.
  typography: {
    fontSans: GEIST_SANS,
    fontMono: JETBRAINS_MONO
  }
}

/**
 * Night Owl — the shipped default. Sarah Drasner's palette, both halves of it:
 * the deep-navy original on the dark band, Night Owl Light on the light one, so
 * the skin keeps its identity whichever way the mode switch goes instead of
 * having a light variant synthesised for it.
 *
 * Two departures from the source theme, both forced by the contrast gate (an
 * editor theme only has to carry code on one surface; a whole app has to carry
 * labels on fills too): the comment grey is lifted to clear 4.5:1 as muted body
 * text, and the semantic fills wear the page colour as their label rather than
 * white — Night Owl's red and blue are both too light to hold a white one.
 *
 * Axes — band: navy, bg oklch(19% 0.05 250) dark / near-white light · display:
 * Geist + JetBrains Mono (bundled, no CDN — this is the default skin) · accent:
 * Night Owl periwinkle #82AAFF dark, #4876D6 light.
 */
export const nightOwlTheme: DesktopTheme = {
  name: 'night-owl',
  label: 'Night Owl',
  description: 'Deep navy with periwinkle and cyan — the shipped default',
  colors: {
    background: '#fbfbfb',
    foreground: '#403f53',
    card: '#ffffff',
    cardForeground: '#403f53',
    muted: '#f0f0f0',
    mutedForeground: '#5c6180', // 5.75:1 on the muted rung (source #989fb1 sat at 2.4)
    popover: '#ffffff',
    popoverForeground: '#403f53',
    primary: '#3f68c4', // Night Owl Light blue, deepened until white reads on it
    primaryForeground: '#ffffff',
    secondary: '#eceef4',
    secondaryForeground: '#3c3b50',
    accent: '#e4ebf8',
    accentForeground: '#33436b',
    border: '#d7dbe3',
    input: '#ccd2dc',
    ring: '#3f68c4',
    midground: '#3f68c4',
    composerRing: '#3f68c4',
    destructive: '#b8403c', // the source's #c96765 lifted to a white-label fill
    destructiveForeground: '#ffffff',
    sidebarBackground: '#f0f0f0',
    sidebarBorder: '#d0d5de',
    userBubble: '#eef2fc',
    userBubbleBorder: '#d5deef'
  },
  darkColors: {
    background: '#011627', // the canonical Night Owl page
    foreground: '#d6deeb',
    card: '#0b2942',
    cardForeground: '#d6deeb',
    muted: '#0e2c44',
    mutedForeground: '#93aec4', // 6.1:1 on the page — the source #637777 sat at 3.8
    popover: '#102a43',
    popoverForeground: '#d6deeb',
    // The true Night Owl blue (#82AAFF) stays on the strokes below; a filled
    // control has to carry a label, and dark-on-#82AAFF lands at Lc 58.
    primary: '#8fb4ff',
    primaryForeground: '#011627', // a light fill takes the page as its label
    secondary: '#1d3b53', // Night Owl's own selection blue, as the raised fill
    secondaryForeground: '#cbd8e9',
    accent: '#12283c',
    accentForeground: '#cbd8ea',
    border: '#21405a',
    input: '#1c3348',
    ring: '#82aaff',
    midground: '#82aaff',
    composerRing: '#82aaff',
    destructive: '#d2423e', // Night Owl's #EF5350, deepened until white reads
    destructiveForeground: '#ffffff',
    sidebarBackground: '#010e1a',
    sidebarBorder: '#173753',
    userBubble: '#0d2438',
    userBubbleBorder: '#20455f'
  },
  // Bundled faces only, for the same reason Nous carries them: the default skin
  // must never fetch a font CDN at runtime.
  typography: {
    fontSans: GEIST_SANS,
    fontMono: JETBRAINS_MONO
  },
  // Night Owl's own ANSI sets. Without them the integrated terminal keeps the
  // VS Code default palette, which is the one place the default skin would stop
  // looking like itself.
  terminal: {
    foreground: '#403f53',
    black: '#403f53',
    red: '#de3d3b',
    green: '#08916a',
    yellow: '#e0af02',
    blue: '#288ed7',
    magenta: '#d6438a',
    cyan: '#2aa298',
    white: '#93a1a1',
    brightBlack: '#403f53',
    brightRed: '#de3d3b',
    brightGreen: '#08916a',
    brightYellow: '#daaa01',
    brightBlue: '#288ed7',
    brightMagenta: '#d6438a',
    brightCyan: '#2aa298',
    brightWhite: '#93a1a1'
  },
  darkTerminal: {
    foreground: '#d6deeb',
    cursor: '#82aaff',
    black: '#011627',
    red: '#ef5350',
    green: '#22da6e',
    yellow: '#c5e478',
    blue: '#82aaff',
    magenta: '#c792ea',
    cyan: '#21c7a8',
    white: '#ffffff',
    brightBlack: '#637777',
    brightRed: '#ef5350',
    brightGreen: '#22da6e',
    brightYellow: '#ffeb95',
    brightBlue: '#82aaff',
    brightMagenta: '#c792ea',
    brightCyan: '#7fdbca',
    brightWhite: '#ffffff'
  }
}

/**
 * Nous Classic — the royal-blue dark AgentX shipped before Graphite, kept whole
 * so nobody loses the palette they chose. Same light side as Nous; only the
 * dark band differs.
 *
 * Axes — band: royal blue, bg oklch(34.7% 0.151 264) · display: Geist +
 * JetBrains Mono · accent: psyche cream oklch(93.8% 0.045 69) on the blue.
 */
export const nousClassicTheme: DesktopTheme = {
  name: 'nous-classic',
  label: 'Nous Classic',
  description: 'The original royal-blue dark, with the Nous light palette',
  colors: nousTheme.colors,
  darkColors: {
    background: '#0D2F86',
    foreground: PSYCHE_WARM,
    card: '#12378F',
    cardForeground: PSYCHE_WARM,
    muted: '#183F9A',
    mutedForeground: '#B5C7F3',
    popover: '#123A96',
    popoverForeground: PSYCHE_WARM,
    primary: PSYCHE_WARM,
    primaryForeground: '#0D2F86',
    secondary: '#1B45A4',
    secondaryForeground: '#E0E8FF',
    accent: PSYCHE_BLUE,
    accentForeground: '#F0F4FF',
    border: '#3158AD',
    input: '#0B2566',
    ring: PSYCHE_WARM,
    midground: NOUS_BLUE,
    composerRing: PSYCHE_WARM,
    destructive: '#C0473A',
    destructiveForeground: '#FEF2F2',
    sidebarBackground: '#09286F',
    sidebarBorder: '#234A9C',
    userBubble: '#143B91',
    userBubbleBorder: '#3A63BD'
  },
  typography: {
    fontSans: GEIST_SANS,
    fontMono: JETBRAINS_MONO
  }
}

/**
 * Midnight — deep blue-violet dark. Matches the dashboard midnight theme.
 *
 * Axes — band: violet-navy, bg oklch(14.9% 0.042 280) rising to the popover
 * rung · display: system sans + JetBrains Mono · accent: periwinkle
 * oklch(65.6% 0.151 286) carrying ring and focus on the dark band.
 */
export const midnightTheme: DesktopTheme = {
  name: 'midnight',
  label: 'Midnight',
  description: 'Deep blue-violet with cool accents',
  colors: {
    background: '#08081c',
    foreground: '#ddd6ff',
    card: '#0d0d28',
    cardForeground: '#ddd6ff',
    muted: '#13133a',
    mutedForeground: '#8b89c0', // oklch(65.3% 0.081 286) — 6.05:1 on the page
    popover: '#0f0f2e',
    popoverForeground: '#ddd6ff',
    primary: '#ddd6ff',
    primaryForeground: '#08081c',
    secondary: '#1a1a4a',
    secondaryForeground: '#c4bff0',
    accent: '#1a1a44',
    accentForeground: '#d0c8ff',
    border: '#1e1e52',
    input: '#1e1e52',
    ring: '#8b80e8',
    midground: '#8b80e8',
    destructive: '#b03060',
    destructiveForeground: '#fef2f2',
    sidebarBackground: '#06061a',
    sidebarBorder: '#1b1b4e', // oklch(25.7% 0.091 278) — hairline clears the 1.2:1 floor
    userBubble: '#14143a',
    userBubbleBorder: '#242466'
  },
  typography: {
    fontMono: `"JetBrains Mono", ${SYSTEM_MONO}`,
    fontUrl: 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap'
  }
}

/**
 * Ember — warm crimson and bronze, forge vibes. Matches the CLI ares skin.
 *
 * Axes — band: near-black umber, bg oklch(15.3% 0.035 63) · display: system
 * sans + IBM Plex Mono · accent: bronze oklch(66% 0.157 55).
 */
export const emberTheme: DesktopTheme = {
  name: 'ember',
  label: 'Ember',
  description: 'Warm crimson and bronze — forge vibes',
  colors: {
    background: '#160800',
    foreground: '#ffd8b0',
    card: '#1e0e04',
    cardForeground: '#ffd8b0',
    muted: '#2a1408',
    mutedForeground: '#aa7a56',
    popover: '#221008',
    popoverForeground: '#ffd8b0',
    primary: '#ffd8b0',
    primaryForeground: '#160800',
    secondary: '#341800',
    secondaryForeground: '#f0c090',
    accent: '#301600',
    accentForeground: '#e8c080',
    border: '#3a1c08',
    input: '#3a1c08',
    ring: '#d97316',
    midground: '#d97316',
    destructive: '#c43010',
    destructiveForeground: '#fef2f2',
    sidebarBackground: '#100600',
    sidebarBorder: '#3a1a08', // oklch(26% 0.058 48) — hairline clears the 1.2:1 floor
    userBubble: '#2a1000',
    userBubbleBorder: '#4a2010'
  },
  typography: {
    fontMono: `"IBM Plex Mono", ${SYSTEM_MONO}`,
    fontUrl: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;700&display=swap'
  }
}

/**
 * Mono — clean grayscale. Matches the CLI mono skin and dashboard mono theme.
 *
 * Axes — band: deliberately achromatic (the one preset exempt from the
 * trace-of-chroma rule — grayscale IS its identity), bg oklch(16.4% 0 0) ·
 * display: system stacks · accent: silver oklch(68.6% 0 0).
 */
export const monoTheme: DesktopTheme = {
  name: 'mono',
  label: 'Mono',
  description: 'Clean grayscale — minimal and focused',
  colors: {
    background: '#0e0e0e',
    foreground: '#eaeaea',
    card: '#141414',
    cardForeground: '#eaeaea',
    muted: '#1e1e1e',
    mutedForeground: '#808080',
    popover: '#181818',
    popoverForeground: '#eaeaea',
    primary: '#eaeaea',
    primaryForeground: '#0e0e0e',
    secondary: '#262626',
    secondaryForeground: '#c8c8c8',
    accent: '#222222',
    accentForeground: '#d8d8d8',
    border: '#2a2a2a',
    input: '#2a2a2a',
    ring: '#9a9a9a',
    midground: '#9a9a9a',
    destructive: '#a84040',
    destructiveForeground: '#fef2f2',
    sidebarBackground: '#0a0a0a',
    sidebarBorder: '#202020',
    userBubble: '#1a1a1a',
    userBubbleBorder: '#363636'
  }
}

/**
 * Cyberpunk — neon green on black, matrix terminal. A fun skin: it keeps its
 * phosphor identity, but every pair still clears the contrast gate.
 *
 * Axes — band: black-green, bg oklch(12.5% 0.043 142) · display: Courier all
 * the way down (terminal cosplay is the point) · accent: phosphor green
 * oklch(86.9% 0.278 144).
 */
export const cyberpunkTheme: DesktopTheme = {
  name: 'cyberpunk',
  label: 'Cyberpunk',
  description: 'Neon green on black — matrix terminal',
  colors: {
    background: '#000a00',
    foreground: '#00ff41',
    card: '#001200',
    cardForeground: '#00ff41',
    muted: '#001a00',
    mutedForeground: '#21a83d', // oklch(64.1% 0.184 146) — 6.45:1 on the page (was #1a8a30 at 4.53:1)
    popover: '#001000',
    popoverForeground: '#00ff41',
    primary: '#00ff41',
    primaryForeground: '#000a00',
    secondary: '#002800',
    secondaryForeground: '#00cc34',
    accent: '#002000',
    accentForeground: '#00e038',
    border: '#003000',
    input: '#003000',
    ring: '#00ff41',
    midground: '#00ff41',
    destructive: '#e60036', // oklch(58.4% 0.235 22) — deep enough for a white label
    destructiveForeground: '#ffffff', // 4.75:1 · Lc 76 (near-black on #ff003c sat at Lc 40)
    sidebarBackground: '#000600',
    sidebarBorder: '#002800', // oklch(24% 0.082 142) — hairline clears the 1.2:1 floor
    userBubble: '#001400',
    userBubbleBorder: '#004800'
  },
  typography: {
    fontMono: `"Courier New", Courier, monospace, ${EMOJI_FALLBACK}`,
    fontSans: `"Courier New", Courier, monospace, ${EMOJI_FALLBACK}`
  }
}

/**
 * Slate — cool slate blue for developers. Matches the CLI slate skin.
 *
 * Axes — band: blue-grey, bg oklch(17.6% 0.014 258) · display: system sans +
 * JetBrains Mono · accent: sky oklch(71.5% 0.152 253).
 */
export const slateTheme: DesktopTheme = {
  name: 'slate',
  label: 'Slate',
  description: 'Cool slate blue — focused developer theme',
  colors: {
    background: '#0d1117',
    foreground: '#c9d1d9',
    card: '#161b22',
    cardForeground: '#c9d1d9',
    muted: '#21262d',
    mutedForeground: '#8b949e',
    popover: '#1c2128',
    popoverForeground: '#c9d1d9',
    primary: '#c9d1d9',
    primaryForeground: '#0d1117',
    secondary: '#2a3038',
    secondaryForeground: '#adb5bf',
    accent: '#1e2530',
    accentForeground: '#c0c8d0',
    border: '#30363d',
    input: '#30363d',
    ring: '#58a6ff',
    midground: '#58a6ff',
    destructive: '#c23e3e', // oklch(55.5% 0.169 24) — carries its light label at 4.68:1 (was #cf4848 at 4.11:1)
    destructiveForeground: '#fef2f2',
    sidebarBackground: '#090d13',
    sidebarBorder: '#1c2228',
    userBubble: '#1e2a38',
    userBubbleBorder: '#2e4060'
  },
  typography: {
    fontMono: `"JetBrains Mono", ${SYSTEM_MONO}`
  }
}


/**
 * Curated accent seeds for the Nous preset (Settings → Appearance → Accent).
 * Same construction as Nous blue — mid-lightness, committed chroma — so every
 * derived pair keeps its floors. The contrast gate walks these too.
 */
export const ACCENT_PRESETS = [
  { name: 'nousBlue', value: NOUS_BLUE }, // oklch(52.8% 0.259 263) — the default
  { name: 'violet', value: '#7d24d3' }, // oklch(50% 0.24 300)
  { name: 'magenta', value: '#c11a8e' }, // oklch(55% 0.22 345)
  { name: 'green', value: '#008a48' }, // oklch(55% 0.15 155)
  { name: 'amber', value: '#bb6802' }, // oklch(60% 0.14 60)
  { name: 'teal', value: '#008aa3' } // oklch(58% 0.11 215)
] as const

export type AccentPresetName = (typeof ACCENT_PRESETS)[number]['name']

/**
 * Nous, re-seeded on a different accent. The neutral bands, inks and semantic
 * colors stay exactly Paper/Graphite — only what the blue used to carry moves:
 * fills and strokes re-tint, the primary deepens until its white label reads
 * (`labelReadyFill`), and stroke duty gets the same per-band contrast lift as
 * Nous blue (≥ 3:1 on paper, ≥ 4.5:1 on graphite). The default accent returns
 * `nousTheme` itself, so "no accent picked" is byte-for-byte the shipped skin.
 */
export function nousWithAccent(accent: string): DesktopTheme {
  if (!/^#[0-9a-f]{6}$/i.test(accent) || accent.toLowerCase() === NOUS_BLUE.toLowerCase()) {
    return nousTheme
  }

  const tint = (pct: number) => `color-mix(in srgb, ${accent} ${pct}%, #FFFFFF)`
  const tintTransparent = (pct: number) => `color-mix(in srgb, ${accent} ${pct}%, transparent)`
  const lightStroke = ensureContrast(accent, PAPER.page, 3)
  const lifted = ensureContrast(accent, GRAPHITE.page, 4.5)
  const primary = labelReadyFill(accent)

  return {
    ...nousTheme,
    colors: {
      ...nousTheme.colors,
      muted: tint(5),
      primary,
      // labelReadyFill targets pure white; the shipped #FCFCFC could sit a
      // hair under 4.5:1 on a fill that lands exactly on the floor.
      primaryForeground: '#ffffff',
      secondary: tint(7),
      accent: tint(10),
      border: tintTransparent(22),
      input: tintTransparent(30),
      ring: lightStroke,
      midground: lightStroke,
      composerRing: lightStroke,
      sidebarBorder: tintTransparent(18),
      userBubble: tint(6),
      userBubbleBorder: tintTransparent(24)
    },
    darkColors: {
      ...nousTheme.darkColors!,
      primary,
      accent: mix(GRAPHITE.elevated, accent, 0.1),
      ring: lifted,
      midground: lifted,
      composerRing: lifted,
      userBubble: mix(GRAPHITE.card, accent, 0.12),
      userBubbleBorder: mix(GRAPHITE.card, accent, 0.3)
    }
  }
}

export const BUILTIN_THEMES: Record<string, DesktopTheme> = {
  'night-owl': nightOwlTheme,
  nous: nousTheme,
  'nous-classic': nousClassicTheme,
  midnight: midnightTheme,
  ember: emberTheme,
  mono: monoTheme,
  cyberpunk: cyberpunkTheme,
  slate: slateTheme
}

export const BUILTIN_THEME_LIST = Object.values(BUILTIN_THEMES)

/** Skin used when nothing is persisted or the persisted name is retired. */
export const DEFAULT_SKIN_NAME = 'night-owl'

/**
 * The one skin the accent picker recolors. Deliberately NOT the default skin:
 * `nousWithAccent` rebuilds the Nous palette around the chosen hue, so pointing
 * this at another skin would silently swap that skin's palette for Nous's. Every
 * other theme — Night Owl included — owns its accent outright.
 */
export const ACCENT_SKIN_NAME = 'nous'
