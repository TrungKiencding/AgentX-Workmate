import { FALLBACK_LOCALE } from '@/i18n/languages'
import type { Locale } from '@/i18n/types'
import { capitalize, normalize } from '@/lib/text'

import introCopyJsonl from './intro-copy.jsonl?raw'

/**
 * The headline of the empty chat — the one large line that sits over the
 * composer ("What should we work on?").
 *
 * `intro-copy.jsonl` holds English headlines flavoured per personality (pirate,
 * noir, …), and English only — so it is consulted just when the app runs in
 * English with a non-neutral personality. Everything else — the neutral default
 * in any locale, or any personality in a non-English locale — reads the
 * catalog's `assistant.intro.headlines`, so the default (Vietnamese) install
 * never speaks English on its home surface.
 */

const NEUTRAL_PERSONALITIES = new Set(['', 'default', 'none', 'neutral'])

/** Last resort when a pool is empty — never shown by a well-formed catalog. */
const FALLBACK_HEADLINE = 'What should we work on?'

/**
 * The greeting's time-of-day bucket. Split on the hour so the wording matches
 * what a person would say, not a clock: morning until noon, afternoon until 6.
 */
export function introGreetingSlot(hour: number): 'afternoon' | 'evening' | 'morning' {
  if (hour < 12) {
    return 'morning'
  }

  return hour < 18 ? 'afternoon' : 'evening'
}

function titleize(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(capitalize)
    .join(' ')
}

function parseHeadlines(raw: string): Record<string, string[]> {
  const byPersonality: Record<string, string[]> = {}

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()

    if (!trimmed) {
      continue
    }

    try {
      const parsed: unknown = JSON.parse(trimmed)

      if (!parsed || typeof parsed !== 'object') {
        continue
      }

      const { headline, personality } = parsed as Record<string, unknown>

      if (typeof personality !== 'string' || typeof headline !== 'string' || !personality.trim() || !headline.trim()) {
        continue
      }

      const key = normalize(personality)
      byPersonality[key] ??= []
      byPersonality[key].push(headline.trim())
    } catch {
      // Bad generated copy should not break the whole desktop app.
    }
  }

  return byPersonality
}

const HEADLINES_BY_PERSONALITY = parseHeadlines(introCopyJsonl)

/** A personality the file doesn't know still gets named, so the choice shows. */
function genericHeadlines(personalityKey: string): string[] {
  const label = titleize(personalityKey)

  return [
    `${label} mode is on. What's next?`,
    `What should ${label} AgentX tackle?`,
    `${label} mode, ready when you are.`
  ]
}

function pickBySeed<T>(items: readonly T[], seed: number): T | undefined {
  return items.length > 0 ? items[Math.abs(seed) % items.length] : undefined
}

export type IntroHeadlineOptions = {
  /** `assistant.intro.headlines` of the active locale. */
  headlines: readonly string[]
  locale: Locale
  personality?: string
  seed?: number
}

/** The headline for the home surface — see the module note for which source wins. */
export function resolveIntroHeadline({ headlines, locale, personality, seed = 0 }: IntroHeadlineOptions): string {
  const personalityKey = normalize(personality)
  const flavoured = locale === FALLBACK_LOCALE && !NEUTRAL_PERSONALITIES.has(personalityKey)

  const pool = flavoured ? (HEADLINES_BY_PERSONALITY[personalityKey] ?? genericHeadlines(personalityKey)) : headlines

  return pickBySeed(pool, seed) ?? pickBySeed(headlines, seed) ?? FALLBACK_HEADLINE
}
