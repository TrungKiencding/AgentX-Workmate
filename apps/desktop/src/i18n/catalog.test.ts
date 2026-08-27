import { describe, expect, it } from 'vitest'

import { KANBAN_LOCALES } from '@/plugins/kanban/i18n'

import { TRANSLATIONS } from './catalog'
import { DEFAULT_LOCALE, FALLBACK_LOCALE, LOCALE_OPTIONS } from './languages'
import type { Locale } from './types'

/** Every leaf path in a message tree, as `a.b.c`, paired with its value. */
function leaves(node: unknown, prefix = ''): [string, unknown][] {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    return [[prefix, node]]
  }

  return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
    leaves(value, prefix ? `${prefix}.${key}` : key)
  )
}

function leafMap(node: unknown): Map<string, unknown> {
  return new Map(leaves(node))
}

describe('desktop i18n catalog', () => {
  it('ships a bundle for every language in the picker, and no orphan bundles', () => {
    const advertised = LOCALE_OPTIONS.map(option => option.id as Locale).sort()
    const shipped = (Object.keys(TRANSLATIONS) as Locale[]).sort()

    expect(shipped).toEqual(advertised)
  })

  it('covers every English key in the default locale, so nothing falls back', () => {
    // The default locale is what a fresh install opens in. A key missing here
    // renders in English mid-sentence, so pin exact parity rather than trusting
    // the runtime fallback to paper over it.
    const en = leafMap(TRANSLATIONS[FALLBACK_LOCALE])
    const fallbackLocale = leafMap(TRANSLATIONS[DEFAULT_LOCALE])

    expect([...en.keys()].filter(key => !fallbackLocale.has(key))).toEqual([])
    expect([...fallbackLocale.keys()].filter(key => !en.has(key))).toEqual([])
  })

  it('keeps every default-locale message the same shape as its English source', () => {
    // A string translated as a function (or an interpolator that dropped an
    // argument) throws or silently swallows its value at render time.
    const en = leafMap(TRANSLATIONS[FALLBACK_LOCALE])
    const translated = leafMap(TRANSLATIONS[DEFAULT_LOCALE])

    const mismatched = [...en].filter(([key, source]) => {
      const value = translated.get(key)

      if (typeof source !== typeof value) {
        return true
      }

      return typeof source === 'function' && source.length !== (value as () => string).length
    })

    expect(mismatched.map(([key]) => key)).toEqual([])
  })

  it('leaves no default-locale message empty', () => {
    const blank = [...leafMap(TRANSLATIONS[DEFAULT_LOCALE])]
      .filter(([, value]) => typeof value === 'string' && value.length === 0)
      .map(([key]) => key)

    // `notifications.native.turnDoneBody` is deliberately empty — the OS
    // notification carries the session title alone.
    expect(blank).toEqual(['notifications.native.turnDoneBody'])
  })

  it('translates the bundled kanban plugin into the default locale too', () => {
    // Plugin bundles fall back to their own English messages, so a plugin that
    // skipped the default locale would show English inside a Vietnamese app.
    const en = leafMap(KANBAN_LOCALES[FALLBACK_LOCALE])
    const translated = leafMap(KANBAN_LOCALES[DEFAULT_LOCALE])

    expect([...en.keys()].filter(key => !translated.has(key))).toEqual([])
    expect([...translated.keys()].filter(key => !en.has(key))).toEqual([])
  })
})
