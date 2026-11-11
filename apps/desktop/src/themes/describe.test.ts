import { describe, expect, it } from 'vitest'

import { type Locale, TRANSLATIONS } from '@/i18n'

import { themeDescription } from './describe'
import { BUILTIN_THEMES } from './presets'

// The accent-only pseudo skin has no card of its own.
const BUILT_IN = Object.values(BUILTIN_THEMES).filter(theme => theme.description)

// Pilot 2026-11-10: with the app in 简体中文 the Appearance page still read
// "Warm neutral grays — colour only as a signal" under every theme card.
describe('theme descriptions follow the app language', () => {
  it('every built-in theme has a description in the English catalog that matches its preset', () => {
    for (const theme of BUILT_IN) {
      expect(themeDescription(theme, TRANSLATIONS.en), theme.name).toBe(theme.description)
    }
  })

  it.each(['vi', 'zh', 'zh-hant', 'ja', 'ar'] as Locale[])('%s translates every built-in theme', locale => {
    for (const theme of BUILT_IN) {
      const translated = themeDescription(theme, TRANSLATIONS[locale])

      expect(translated, `${locale}:${theme.name}`).toBeTruthy()
      expect(translated, `${locale}:${theme.name}`).not.toBe(theme.description)
    }
  })

  it('keeps the description a user or marketplace theme came with', () => {
    expect(themeDescription({ description: 'My own palette', name: 'user-solarized' }, TRANSLATIONS.vi)).toBe(
      'My own palette'
    )
    expect(themeDescription({ name: 'user-bare' }, TRANSLATIONS.vi)).toBe('')
  })

  it('has no description for a theme that no longer exists', () => {
    const names = new Set(BUILT_IN.map(theme => theme.name))

    for (const locale of ['en', 'vi', 'zh'] as Locale[]) {
      expect(Object.keys(TRANSLATIONS[locale].settings.appearance.themeDescriptions).filter(name => !names.has(name))).toEqual(
        []
      )
    }
  })
})
