/**
 * Built-in desktop themes. Names match the CLI skins / dashboard presets.
 * Add new themes here — no code changes needed elsewhere.
 */

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
  // The default skin rides DEFAULT_TYPOGRAPHY (bundled Geist + JetBrains
  // Mono). No fontUrl on purpose: the default theme must never fetch a font
  // CDN at runtime.
  typography: {
    fontSans: GEIST_SANS,
    fontMono: JETBRAINS_MONO
  }
}

/**
 * Nous Classic — the royal-blue dark AgentX shipped before Graphite, kept whole
 * so nobody loses the palette they chose. Same light side as Nous; only the
 * dark band differs.
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

/** Deep blue-violet with cool accents. Matches the dashboard midnight theme. */
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
    mutedForeground: '#7c7ab0',
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
    sidebarBorder: '#12123a',
    userBubble: '#14143a',
    userBubbleBorder: '#242466'
  },
  typography: {
    fontMono: `"JetBrains Mono", ${SYSTEM_MONO}`,
    fontUrl: 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap'
  }
}

/** Warm crimson and bronze — forge vibes. Matches the CLI ares skin. */
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
    sidebarBorder: '#2a1004',
    userBubble: '#2a1000',
    userBubbleBorder: '#4a2010'
  },
  typography: {
    fontMono: `"IBM Plex Mono", ${SYSTEM_MONO}`,
    fontUrl: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;700&display=swap'
  }
}

/** Clean grayscale. Matches the CLI mono skin and dashboard mono theme. */
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

/** Neon green on black. Matches the CLI cyberpunk skin and dashboard theme. */
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
    mutedForeground: '#1a8a30',
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
    destructive: '#ff003c',
    destructiveForeground: '#000a00',
    sidebarBackground: '#000600',
    sidebarBorder: '#001800',
    userBubble: '#001400',
    userBubbleBorder: '#004800'
  },
  typography: {
    fontMono: `"Courier New", Courier, monospace, ${EMOJI_FALLBACK}`,
    fontSans: `"Courier New", Courier, monospace, ${EMOJI_FALLBACK}`
  }
}

/** Cool slate blue for developers. Matches the CLI slate skin. */
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
    destructive: '#cf4848',
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

export const BUILTIN_THEMES: Record<string, DesktopTheme> = {
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
export const DEFAULT_SKIN_NAME = 'nous'
