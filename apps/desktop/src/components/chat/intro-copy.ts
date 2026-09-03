import { FALLBACK_LOCALE } from '@/i18n/languages'
import type { Locale } from '@/i18n/types'
import { capitalize, normalize } from '@/lib/text'

import introCopyJsonl from './intro-copy.jsonl?raw'

/**
 * The line under the home greeting.
 *
 * `intro-copy.jsonl` is English copy flavoured per personality (pirate, noir,
 * …), and English only — so it is consulted just when the app runs in English
 * with a non-neutral personality. Everything else — the neutral default in any
 * locale, or any personality in a non-English locale — reads the catalog's
 * `assistant.intro.bodyVariants`, so the default (Vietnamese) install never
 * speaks English on its home surface.
 */

type IntroCopy = {
  headline: string
  body: string
}

type IntroCopyRecord = IntroCopy & {
  personality: string
}

const NEUTRAL_PERSONALITIES = new Set(['', 'default', 'none', 'neutral'])

const FALLBACK_COPY: IntroCopy[] = [
  {
    headline: 'What are we moving today?',
    body: "Send a bug, branch, plan, or rough idea. I'll inspect the repo and turn it into the next concrete step."
  },
  {
    headline: "What's on your mind?",
    body: "Bring the code, question, or stuck part. I'll read the room before making changes."
  },
  {
    headline: 'What should AgentX look at?',
    body: "Send the task, failing path, or half-formed plan. I'll help turn it into action."
  },
  {
    headline: 'Where should we start?',
    body: "Bring the problem, goal, or file. I'll inspect first and keep the next step concrete."
  },
  {
    headline: 'What needs attention?',
    body: "Send the context you have. I'll help sort it into a plan or a fix."
  }
]

function normalizeKey(value?: string): string {
  return normalize(value)
}

function titleize(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(capitalize)
    .join(' ')
}

function isIntroCopyRecord(value: unknown): value is IntroCopyRecord {
  if (!value || typeof value !== 'object') {
    return false
  }

  const record = value as Record<string, unknown>

  return (
    typeof record.personality === 'string' &&
    typeof record.headline === 'string' &&
    typeof record.body === 'string' &&
    Boolean(record.personality.trim()) &&
    Boolean(record.headline.trim()) &&
    Boolean(record.body.trim())
  )
}

function parseIntroCopy(raw: string): Record<string, IntroCopy[]> {
  const byPersonality: Record<string, IntroCopy[]> = {}

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()

    if (!trimmed) {
      continue
    }

    try {
      const parsed: unknown = JSON.parse(trimmed)

      if (!isIntroCopyRecord(parsed)) {
        continue
      }

      const key = normalizeKey(parsed.personality)
      byPersonality[key] ??= []
      byPersonality[key].push({
        headline: parsed.headline.trim(),
        body: parsed.body.trim()
      })
    } catch {
      // Bad generated copy should not break the whole desktop app.
    }
  }

  return byPersonality
}

const INTRO_COPY_BY_PERSONALITY = parseIntroCopy(introCopyJsonl)

function fallbackCopyForPersonality(personalityKey: string): IntroCopy[] {
  const label = titleize(personalityKey)

  return [
    {
      headline: `${label} mode is on. What should we work on?`,
      body: "Send the task, file, or rough idea. I'll use your configured voice and keep the work grounded in this repo."
    },
    {
      headline: `What does ${label} AgentX need to see?`,
      body: "Bring the context or the stuck part. I'll adapt to your configured personality."
    },
    {
      headline: `${label} mode is ready.`,
      body: "Send the problem, file, or idea. I'll follow the personality you've configured."
    },
    {
      headline: `What should ${label} AgentX tackle?`,
      body: "Drop the task here. I'll keep the work grounded in the repo."
    },
    {
      headline: 'Where should we begin?',
      body: `Give me the context and I'll answer in ${label} mode.`
    }
  ]
}

function pickBySeed<T>(items: readonly T[], seed: number): T | undefined {
  return items.length > 0 ? items[Math.abs(seed) % items.length] : undefined
}

export type IntroBodyOptions = {
  /** `assistant.intro.bodyVariants` of the active locale. */
  bodyVariants: readonly string[]
  locale: Locale
  personality?: string
  seed?: number
}

/** The body line for the home surface — see the module note for which source wins. */
export function resolveIntroBody({ bodyVariants, locale, personality, seed = 0 }: IntroBodyOptions): string {
  const personalityKey = normalizeKey(personality)
  const flavoured = locale === FALLBACK_LOCALE && !NEUTRAL_PERSONALITIES.has(personalityKey)

  if (flavoured) {
    const copies = INTRO_COPY_BY_PERSONALITY[personalityKey] || fallbackCopyForPersonality(personalityKey)

    return (pickBySeed(copies, seed) ?? FALLBACK_COPY[0]).body
  }

  return pickBySeed(bodyVariants, seed) ?? FALLBACK_COPY[0].body
}
