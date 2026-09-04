/**
 * Desktop theme context.
 *
 * Applies the active theme as CSS custom properties on :root so every
 * Tailwind utility that references a color or font-family token picks up
 * the change automatically.
 *
 * Mode (light/dark/system) controls brightness; skin controls accent.
 * The two are persisted independently. Shift+X toggles light/dark.
 */

import { useStore } from '@nanostores/react'
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react'

import { $registryVersion } from '@/contrib/registry'
import { matchesQuery, useMediaQuery } from '@/hooks/use-media-query'
import { persistString, persistStringRecord, storedString, storedStringRecord } from '@/lib/storage'
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'

import { $backendThemes, $pendingSkinApply } from './backend-sync'
import { baseColorsFor, bestTextOn, hexToRgb, mix } from './color'
import {
  ACCENT_SKIN_NAME,
  BUILTIN_THEME_LIST,
  DEFAULT_SERIF_DISPLAY,
  DEFAULT_SKIN_NAME,
  DEFAULT_TYPOGRAPHY,
  nightOwlTheme,
  nousWithAccent
} from './presets'
import type { DesktopTheme, DesktopThemeColors } from './types'
import { $userThemes, listAllThemes, resolveTheme } from './user-themes'

// Legacy global skin (pre per-profile themes). Still the inheritance fallback
// for any profile without its own assignment, so single-profile users and old
// installs are unaffected.
const SKIN_KEY = 'agentx-desktop-theme-v2'
const MODE_KEY = 'agentx-desktop-mode-v1'
// Per-profile skin + light/dark mode assignments: { [profileKey]: value }. A
// profile inherits the global default until it's given its own appearance.
const PROFILE_SKINS_KEY = 'agentx-desktop-profile-themes-v1'
const PROFILE_MODES_KEY = 'agentx-desktop-profile-modes-v1'
// Accent override for the Nous preset ('' = the shipped Nous blue). Same
// global + per-profile shape as skin/mode.
const ACCENT_KEY = 'agentx-desktop-accent-v1'
const PROFILE_ACCENTS_KEY = 'agentx-desktop-profile-accents-v1'
// Last active profile, recorded so the boot-time paint can pick that profile's
// theme before the gateway reports which profile actually launched.
const LAST_PROFILE_KEY = 'agentx-desktop-active-profile-v1'
const RETIRED_SKINS = new Set(['nous-light', 'default', 'gold'])

export type ThemeMode = 'light' | 'dark' | 'system'

const INJECTED_FONT_URLS = new Set<string>()

const resolveMode = (mode: ThemeMode, systemDark = matchesQuery('(prefers-color-scheme: dark)')): 'light' | 'dark' =>
  mode === 'system' ? (systemDark ? 'dark' : 'light') : mode

const normalizeSkin = (name: string | null): string =>
  name && resolveTheme(name) && !RETIRED_SKINS.has(name) ? name : DEFAULT_SKIN_NAME

// Nothing stored means a fresh install, and the shipped default is Night Owl —
// a dark skin, so the mode it ships with is dark rather than the OS's answer.
const normalizeMode = (value: string | null): ThemeMode =>
  value === 'light' || value === 'dark' || value === 'system' ? value : 'dark'

const normalizeAccent = (value: string | null): string =>
  value && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : ''

// ─── Per-profile appearance persistence ─────────────────────────────────────
// Skin and mode are each stored per profile. "default" isn't a real profile —
// it *is* the legacy global slot, so it reads/writes the global directly. Named
// profiles get their own entry and fall back to that global until assigned, so
// unassigned profiles and pre-per-profile installs stay on the global value.
const profilePref = <T extends string>(record: string, legacy: string, normalize: (v: string | null) => T) => ({
  resolve: (profile: string): T => normalize(storedStringRecord(record)[profile] ?? storedString(legacy)),
  assign: (profile: string, value: T): void => {
    if (profile === 'default') {
      persistString(legacy, value)
    } else {
      persistStringRecord(record, { ...storedStringRecord(record), [profile]: value })
    }
  }
})

export const skinPref = profilePref(PROFILE_SKINS_KEY, SKIN_KEY, normalizeSkin)
export const modePref = profilePref(PROFILE_MODES_KEY, MODE_KEY, normalizeMode)
export const accentPref = profilePref(PROFILE_ACCENTS_KEY, ACCENT_KEY, normalizeAccent)

// Last active profile — lets the boot paint pick its appearance before the
// gateway reports which profile actually launched.
const readBootProfileKey = () => normalizeProfileKey(storedString(LAST_PROFILE_KEY))
const rememberActiveProfileKey = (profile: string) => persistString(LAST_PROFILE_KEY, profile)

// ─── Color math (for synthesised light variants of dark-only skins) ────────
// The palette derivation (synthLightColors / baseColorsFor) lives in ./color —
// a leaf module — so the contrast gate script measures the exact variants the
// app paints, and the VS Code converter shares the same math.

/** Returns the seed palette for a given skin + mode (no overrides applied). */
export function getBaseColors(skinName: string, mode: 'light' | 'dark'): DesktopThemeColors {
  return baseColorsFor(resolveTheme(skinName) ?? nightOwlTheme, mode)
}

function deriveTheme(skinName: string, mode: 'light' | 'dark', accent = ''): DesktopTheme {
  const resolved = resolveTheme(skinName) ?? nightOwlTheme
  // The accent picker recolors the Nous preset only — every other theme owns
  // its accent. '' (or the Nous blue itself) resolves to the shipped skin.
  const seed = accent && skinName === ACCENT_SKIN_NAME ? nousWithAccent(accent) : resolved

  return {
    ...seed,
    name: `${skinName}-${mode}`,
    label: `${seed.label} ${mode === 'light' ? 'Light' : 'Dark'}`,
    description: `${seed.label} ${mode} palette`,
    colors: baseColorsFor(seed, mode)
  }
}

/**
 * Some palettes intentionally keep a bright background even when
 * `mode === 'dark'`, so we shouldn't apply the `.dark` class. Decide from
 * the actual background luminance.
 */
function renderedModeFor(colors: DesktopThemeColors, mode: 'light' | 'dark'): 'light' | 'dark' {
  const rgb = hexToRgb(colors.background)

  if (!rgb) {
    return mode
  }

  const [r, g, b] = rgb.map(v => v / 255)

  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5 ? 'light' : 'dark'
}

// ─── CSS application ────────────────────────────────────────────────────────

// Per-mode mix knobs. Light/dark fallbacks live in styles.css `:root` /
// `:root.dark`; setting them inline keeps active-skin overrides surviving
// the boot-time paint.
// styles.css --theme-neutral-chrome — keep in sync. Both rungs are the page
// colour of their band (PAPER.page / GRAPHITE.page in presets.ts), so the
// default skin's chrome mix is a no-op and a tinted skin is pulled toward the
// band rather than toward a 0-chroma near-black.
const NEUTRAL_CHROME = { light: '#f9fafd', dark: '#0d0f15' } as const

const chromeBackground = (background: string, isDark: boolean) =>
  mix(background, NEUTRAL_CHROME[isDark ? 'dark' : 'light'], isDark ? 0.26 : 0.08)

const mixesFor = (isDark: boolean): Record<string, string> => ({
  '--theme-mix-chrome': isDark ? '74%' : '92%',
  '--theme-mix-sidebar': '100%',
  '--theme-mix-card': isDark ? '38%' : '22%',
  // 100% in both modes: the elevated rung (popover / menu / dialog) is the one
  // surface that must stay a visible step above the card, so it paints the
  // skin's own elevated colour instead of being pulled back into the card.
  '--theme-mix-elevated': '100%',
  // 100% in both modes, like the elevated rung: the user bubble paints the
  // skin's own colour instead of being pulled back toward the neutral card,
  // where a sent prompt used to disappear into the page it sits on.
  '--theme-mix-bubble': '100%'
})

function applyTheme(theme: DesktopTheme, mode: 'light' | 'dark') {
  if (typeof document === 'undefined') {
    return
  }

  const root = document.documentElement
  const c = theme.colors
  const typo = { ...DEFAULT_TYPOGRAPHY, ...nightOwlTheme.typography, ...theme.typography }
  const rendered = renderedModeFor(c, mode)
  const isDark = rendered === 'dark'
  const midground = c.midground ?? c.ring
  const skinName = theme.name.endsWith(`-${mode}`) ? theme.name.slice(0, -mode.length - 1) : theme.name

  root.style.setProperty('color-scheme', rendered)
  root.dataset.agentxTheme = skinName
  root.dataset.agentxMode = rendered
  root.classList.toggle('dark', isDark)

  // Brand seeds feed every glass + shadcn token via `color-mix()` in styles.css.
  const seeds: Record<string, string> = {
    '--theme-foreground': c.foreground,
    '--theme-primary': c.primary,
    '--theme-secondary': c.secondary,
    '--theme-accent-soft': c.accent,
    '--theme-midground': midground,
    '--theme-warm': c.primary,
    '--theme-background-seed': c.background,
    '--theme-sidebar-seed': c.sidebarBackground ?? c.background,
    '--theme-card-seed': c.card,
    '--theme-elevated-seed': c.popover,
    '--theme-bubble-seed': c.userBubble ?? c.popover
  }

  // shadcn/Tailwind tokens that aren't derived from the seed chain.
  const palette: Record<string, string> = {
    '--dt-primary-foreground': c.primaryForeground,
    '--dt-secondary-foreground': c.secondaryForeground,
    '--dt-accent-foreground': c.accentForeground,
    '--dt-border': c.border,
    '--dt-input': c.input,
    '--dt-ring': c.ring,
    '--dt-muted': c.muted,
    '--dt-midground-foreground': c.midgroundForeground ?? bestTextOn(midground),
    '--dt-composer-ring': c.composerRing ?? midground,
    '--dt-destructive': c.destructive,
    '--dt-destructive-foreground': c.destructiveForeground,
    '--dt-sidebar-border': c.sidebarBorder ?? c.border,
    '--dt-user-bubble-border': c.userBubbleBorder ?? c.border,
    '--dt-font-sans': typo.fontSans,
    '--dt-font-mono': typo.fontMono,
    // Optional per-theme override; every theme falls back to the bundled face.
    '--dt-font-serif-display': typo.fontSerifDisplay ?? DEFAULT_SERIF_DISPLAY,
    '--noise-opacity-mul': isDark ? 'calc(0.04 / 0.21)' : 'calc(0.34 / 0.21)'
  }

  for (const [k, v] of Object.entries({ ...seeds, ...mixesFor(isDark), ...palette })) {
    root.style.setProperty(k, v)
  }

  const chromeBg = chromeBackground(c.background, isDark)

  window.agentxDesktop?.setTitleBarTheme?.({
    background: chromeBg,
    foreground: c.foreground
  })

  // Raw (non-JSON) keys read by the inline pre-paint script in index.html —
  // they let a brand-new window paint the themed background on its very first
  // frame, before this module has even loaded.
  try {
    window.localStorage.setItem('agentx-boot-background', chromeBg)
    window.localStorage.setItem('agentx-boot-color-scheme', rendered)
  } catch {
    // Storage may be unavailable (private mode / quota); the inline script
    // falls back to prefers-color-scheme.
  }

  if (typo.fontUrl && !INJECTED_FONT_URLS.has(typo.fontUrl)) {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = typo.fontUrl
    link.dataset.agentxThemeFont = 'true'
    document.head.appendChild(link)
    INJECTED_FONT_URLS.add(typo.fontUrl)
  }
}

// Pin Electron's nativeTheme to the app's mode so the NATIVE window chrome
// (macOS vibrancy material, titlebar, pre-paint background) matches the app
// theme instead of the OS appearance. An explicit light/dark pick is forced;
// 'system' stays 'system' so prefers-color-scheme keeps tracking the OS.
const syncNativeTheme = (pref: ThemeMode, rendered: 'light' | 'dark') =>
  window.agentxDesktop?.setNativeTheme?.(pref === 'system' ? 'system' : rendered)

// Boot-time paint to avoid a flash before <ThemeProvider> mounts. Use the last
// active profile's appearance so a non-default profile relaunch paints its own
// skin + light/dark mode.
if (typeof window !== 'undefined') {
  const profile = readBootProfileKey()
  const pref = modePref.resolve(profile)
  const resolved = resolveMode(pref)
  const theme = deriveTheme(skinPref.resolve(profile), resolved, accentPref.resolve(profile))
  applyTheme(theme, resolved)
  syncNativeTheme(pref, renderedModeFor(theme.colors, resolved))
}

// ─── Context ────────────────────────────────────────────────────────────────

interface ThemeContextValue {
  theme: DesktopTheme
  themeName: string
  mode: ThemeMode
  /** The light/dark switch the user picked. */
  resolvedMode: 'light' | 'dark'
  /**
   * The mode actually painted, derived from the active background's luminance.
   * Differs from `resolvedMode` for skins that keep a bright surface in "dark"
   * (or vice-versa). Surface-bound UI (e.g. the terminal palette) should key off
   * this so it matches what's on screen instead of inverting.
   */
  renderedMode: 'light' | 'dark'
  availableThemes: Array<{ name: string; label: string; description: string }>
  /** Accent override for the Nous preset — '' means the shipped Nous blue. */
  accent: string
  setTheme: (name: string) => void
  setMode: (mode: ThemeMode) => void
  setAccent: (hex: string) => void
}

const SKIN_LIST = BUILTIN_THEME_LIST.map(({ name, label, description }) => ({ name, label, description }))

const ThemeContext = createContext<ThemeContextValue>({
  theme: nightOwlTheme,
  themeName: DEFAULT_SKIN_NAME,
  mode: 'dark',
  resolvedMode: 'dark',
  renderedMode: 'dark',
  availableThemes: SKIN_LIST,
  accent: '',
  setTheme: () => {},
  setMode: () => {},
  setAccent: () => {}
})

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Skin + mode are assigned per profile; the active profile drives which
  // appearance shows. Single-profile users only ever see "default", so their
  // behavior is unchanged.
  const profileKey = normalizeProfileKey(useStore($activeGatewayProfile))

  // Built-ins + user-installed + registry-contributed themes. Reactive so an
  // import or a plugin registration shows up live in the palette, settings
  // grid, and `/skin` without a reload.
  const userThemes = useStore($userThemes)
  const backendThemes = useStore($backendThemes)
  const registryVersion = useStore($registryVersion)

  const availableThemes = useMemo(
    () =>
      listAllThemes().map(({ name, label, description }) => ({
        name,
        label,
        description
      })),
    // userThemes + backendThemes + registryVersion ARE listAllThemes' reactivity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [userThemes, backendThemes, registryVersion]
  )

  const [themeName, setThemeNameState] = useState(() =>
    typeof window === 'undefined' ? DEFAULT_SKIN_NAME : skinPref.resolve(readBootProfileKey())
  )

  const [mode, setModeState] = useState<ThemeMode>(() =>
    typeof window === 'undefined' ? 'dark' : modePref.resolve(readBootProfileKey())
  )

  const [accent, setAccentState] = useState(() =>
    typeof window === 'undefined' ? '' : accentPref.resolve(readBootProfileKey())
  )

  // Follow profile switches: paint the profile's assigned skin + mode and
  // remember it for the next boot's first paint.
  useEffect(() => {
    rememberActiveProfileKey(profileKey)
    setThemeNameState(skinPref.resolve(profileKey))
    setModeState(modePref.resolve(profileKey))
    setAccentState(accentPref.resolve(profileKey))
  }, [profileKey])

  const systemDark = useMediaQuery('(prefers-color-scheme: dark)')
  const resolvedMode = resolveMode(mode, systemDark)

  const activeTheme = useMemo(
    () => deriveTheme(themeName, resolvedMode, accent),
    // deriveTheme resolves its seed through the merged registry, so the theme
    // stores are its reactivity too — an in-place palette edit of the ACTIVE
    // skin (live theme authoring) must repaint, not just a name switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [themeName, resolvedMode, accent, userThemes, backendThemes, registryVersion]
  )

  // What actually gets painted (matches the `.dark` class applyTheme toggles).
  const renderedMode = useMemo(() => renderedModeFor(activeTheme.colors, resolvedMode), [activeTheme, resolvedMode])

  useEffect(() => applyTheme(activeTheme, resolvedMode), [activeTheme, resolvedMode])

  // Keep the native window appearance pinned to the app theme (vibrancy
  // material, titlebar, new-window pre-paint background).
  useEffect(() => syncNativeTheme(mode, renderedMode), [mode, renderedMode])

  // Assign to whichever profile is live right now (read fresh so the callbacks
  // stay stable across profile switches).
  const liveProfile = () => normalizeProfileKey($activeGatewayProfile.get())

  const setTheme = useCallback((name: string) => {
    const next = normalizeSkin(name)
    setThemeNameState(next)
    skinPref.assign(liveProfile(), next)
  }, [])

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next)
    modePref.assign(liveProfile(), next)
  }, [])

  const setAccent = useCallback((hex: string) => {
    const next = normalizeAccent(hex)
    setAccentState(next)
    accentPref.assign(liveProfile(), next)
  }, [])

  // Drain a backend-driven skin switch (AgentX authoring/activating a skin from a
  // prompt, or `/skin` on another surface). setTheme persists it per profile, so
  // the choice sticks like any manual pick.
  const pendingSkin = useStore($pendingSkinApply)

  useEffect(() => {
    if (pendingSkin) {
      setTheme(pendingSkin)
      $pendingSkinApply.set(null)
    }
  }, [pendingSkin, setTheme])

  // The light/dark toggle (Shift+X by default) is owned by the keybind runtime
  // (`appearance.toggleMode`) so it shows up in the hotkey map and is rebindable.

  const value = useMemo<ThemeContextValue>(
    () => ({ theme: activeTheme, themeName, mode, resolvedMode, renderedMode, availableThemes, accent, setTheme, setMode, setAccent }),
    [activeTheme, themeName, mode, resolvedMode, renderedMode, availableThemes, accent, setTheme, setMode, setAccent]
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export const useTheme = (): ThemeContextValue => useContext(ThemeContext)
