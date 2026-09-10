import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

import { en } from './en'
import { ja } from './ja'
import {
  DEFAULT_LOCALE,
  LOCALE_HTML_LANG,
  LOCALES,
  type Dictionary,
  type Locale
} from './types'
import { vi } from './vi'
import { zhHans } from './zh-Hans'

const DICTIONARIES: Record<Locale, Dictionary> = {
  vi,
  en,
  'zh-Hans': zhHans,
  ja
}

const STORAGE_KEY = 'agentx-landing-locale'

const isLocale = (value: unknown): value is Locale => LOCALES.includes(value as Locale)

/** Stored choice wins; a private window or blocked storage just falls through. */
function readStored(): Locale | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)

    return isLocale(stored) ? stored : null
  } catch {
    return null
  }
}

/**
 * Resolution order: an explicit `?lang=` in the URL (so a link can carry a
 * language), then what the visitor picked last, then the browser's own list,
 * then Vietnamese — the language the desktop app itself opens in.
 */
function detectLocale(): Locale {
  if (typeof window === 'undefined') {
    return DEFAULT_LOCALE
  }

  const requested = new URLSearchParams(window.location.search).get('lang')

  if (isLocale(requested)) {
    return requested
  }

  const stored = readStored()

  if (stored) {
    return stored
  }

  for (const tag of window.navigator.languages ?? []) {
    const lower = tag.toLowerCase()

    if (lower.startsWith('vi')) return 'vi'
    if (lower.startsWith('ja')) return 'ja'
    if (lower.startsWith('en')) return 'en'
    // zh-Hant / zh-TW / zh-HK read Traditional; this page only ships
    // Simplified, so they fall through to English rather than getting
    // characters they would have to squint at.
    if (lower === 'zh' || lower.startsWith('zh-hans') || lower.startsWith('zh-cn') || lower.startsWith('zh-sg')) {
      return 'zh-Hans'
    }
  }

  return DEFAULT_LOCALE
}

type I18nValue = {
  locale: Locale
  t: Dictionary
  setLocale: (next: Locale) => void
}

const I18nContext = createContext<I18nValue | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectLocale)

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next)

    try {
      window.localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Nothing to do — the choice still applies for this visit.
    }
  }, [])

  // The document's own language metadata is part of the translation: screen
  // readers pick a voice from `lang`, and search results read the title.
  useEffect(() => {
    const dictionary = DICTIONARIES[locale]

    document.documentElement.lang = LOCALE_HTML_LANG[locale]
    document.title = dictionary.meta.title
    document.querySelector('meta[name="description"]')?.setAttribute('content', dictionary.meta.description)
  }, [locale])

  const value = useMemo<I18nValue>(() => ({ locale, t: DICTIONARIES[locale], setLocale }), [locale, setLocale])

  return <I18nContext value={value}>{children}</I18nContext>
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext)

  if (!value) {
    throw new Error('useI18n must be called inside <I18nProvider>')
  }

  return value
}

export { LOCALES, LOCALE_LABELS, type Locale } from './types'
