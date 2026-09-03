import { describe, expect, it } from 'vitest'

import { en } from '@/i18n/en'
import { vi } from '@/i18n/vi'

import { resolveIntroBody } from './intro-copy'

const enVariants = en.assistant.intro.bodyVariants
const viVariants = vi.assistant.intro.bodyVariants

describe('resolveIntroBody', () => {
  it('reads the catalog for the neutral personality in every locale', () => {
    for (const personality of [undefined, '', 'none', 'default', 'Neutral']) {
      expect(viVariants).toContain(resolveIntroBody({ bodyVariants: viVariants, locale: 'vi', personality }))
      expect(enVariants).toContain(resolveIntroBody({ bodyVariants: enVariants, locale: 'en', personality }))
    }
  })

  it('reads the catalog for a flavoured personality outside English', () => {
    // The jsonl flavour is English-only; a Vietnamese app must not fall into it.
    for (const seed of [0, 1, 2, 3, 4, 5]) {
      const body = resolveIntroBody({ bodyVariants: viVariants, locale: 'vi', personality: 'pirate', seed })

      expect(viVariants).toContain(body)
      expect(enVariants).not.toContain(body)
    }
  })

  it('keeps the personality flavour when the app runs in English', () => {
    const body = resolveIntroBody({ bodyVariants: enVariants, locale: 'en', personality: 'pirate' })

    expect(body.length).toBeGreaterThan(0)
    expect(enVariants).not.toContain(body)
  })

  it('names an unknown English personality in its generic copy', () => {
    expect(resolveIntroBody({ bodyVariants: enVariants, locale: 'en', personality: 'grumpy-cat', seed: 4 })).toContain(
      'Grumpy Cat mode'
    )
  })

  it('cycles the variants by seed, deterministically', () => {
    const bodies = viVariants.map((_, seed) => resolveIntroBody({ bodyVariants: viVariants, locale: 'vi', seed }))

    expect(bodies).toEqual([...viVariants])
    expect(resolveIntroBody({ bodyVariants: viVariants, locale: 'vi', seed: viVariants.length })).toBe(viVariants[0])
    expect(resolveIntroBody({ bodyVariants: viVariants, locale: 'vi', seed: -1 })).toBe(viVariants[1])
  })

  it('survives an empty variant list', () => {
    expect(resolveIntroBody({ bodyVariants: [], locale: 'vi' }).length).toBeGreaterThan(0)
  })
})
