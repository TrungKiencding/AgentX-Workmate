import { describe, expect, it } from 'vitest'

import { ar } from '@/i18n/ar'
import { en } from '@/i18n/en'
import { ja } from '@/i18n/ja'
import { vi } from '@/i18n/vi'
import { zh } from '@/i18n/zh'
import { zhHant } from '@/i18n/zh-hant'

import { introGreetingSlot, resolveIntroHeadline } from './intro-copy'

const enHeadlines = en.assistant.intro.headlines
const viHeadlines = vi.assistant.intro.headlines

describe('introGreetingSlot', () => {
  it('splits the day the way a person would say it', () => {
    expect(introGreetingSlot(0)).toBe('morning')
    expect(introGreetingSlot(11)).toBe('morning')
    expect(introGreetingSlot(12)).toBe('afternoon')
    expect(introGreetingSlot(17)).toBe('afternoon')
    expect(introGreetingSlot(18)).toBe('evening')
    expect(introGreetingSlot(23)).toBe('evening')
  })
})

describe('resolveIntroHeadline', () => {
  it('reads the catalog for the neutral personality in every locale', () => {
    for (const personality of [undefined, '', 'none', 'default', 'Neutral']) {
      expect(viHeadlines).toContain(resolveIntroHeadline({ headlines: viHeadlines, locale: 'vi', personality }))
      expect(enHeadlines).toContain(resolveIntroHeadline({ headlines: enHeadlines, locale: 'en', personality }))
    }
  })

  it('reads the catalog for a flavoured personality outside English', () => {
    // The jsonl flavour is English-only; a Vietnamese app must not fall into it.
    for (const seed of [0, 1, 2, 3, 4, 5]) {
      const headline = resolveIntroHeadline({ headlines: viHeadlines, locale: 'vi', personality: 'pirate', seed })

      expect(viHeadlines).toContain(headline)
    }
  })

  it('keeps the personality flavour when the app runs in English', () => {
    const headline = resolveIntroHeadline({ headlines: enHeadlines, locale: 'en', personality: 'Pirate', seed: 0 })

    expect(headline).toBe('Ahoy! Ready to sail the repo')
    expect(enHeadlines).not.toContain(headline)
  })

  it('names an unknown English personality in its generic copy', () => {
    for (const seed of [0, 1, 2]) {
      expect(resolveIntroHeadline({ headlines: enHeadlines, locale: 'en', personality: 'grumpy-cat', seed })).toContain(
        'Grumpy Cat'
      )
    }
  })

  it('cycles the headlines by seed, deterministically', () => {
    const picked = viHeadlines.map((_, seed) => resolveIntroHeadline({ headlines: viHeadlines, locale: 'vi', seed }))

    expect(picked).toEqual([...viHeadlines])
    expect(resolveIntroHeadline({ headlines: viHeadlines, locale: 'vi', seed: viHeadlines.length })).toBe(
      viHeadlines[0]
    )
    expect(resolveIntroHeadline({ headlines: viHeadlines, locale: 'vi', seed: -1 })).toBe(viHeadlines[1])
  })

  it('survives an empty pool', () => {
    expect(resolveIntroHeadline({ headlines: [], locale: 'vi' }).length).toBeGreaterThan(0)
  })

  it('keeps every locale to a few short lines — one line over the composer, never a paragraph', () => {
    for (const catalog of [ar, en, ja, vi, zh, zhHant]) {
      const { headlines } = catalog.assistant.intro

      expect(headlines.length).toBeGreaterThanOrEqual(3)

      for (const headline of headlines) {
        expect(headline.trim()).toBe(headline)
        expect(headline.length).toBeLessThanOrEqual(40)
      }
    }
  })
})
