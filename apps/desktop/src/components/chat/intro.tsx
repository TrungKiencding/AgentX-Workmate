import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useState } from 'react'

import { requestComposerFocus, requestComposerInsert } from '@/app/chat/composer/focus'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n/context'
import { Clock, FolderOpen, NotebookTabs, Search } from '@/lib/icons'
import { capitalize, normalize } from '@/lib/text'
import { $keycloakAccount, refreshKeycloakAccount } from '@/store/account'
import { $desktopOnboarding } from '@/store/onboarding'
import { $profileScope, $showAllProfiles } from '@/store/profile'
import { $projectTree, requestStartWorkSession } from '@/store/projects'
import { $currentCwd, $sessions } from '@/store/session'

import { type IntroChipSource, introChipSources, introGreetingSlot } from './intro-chips'
import introCopyJsonl from './intro-copy.jsonl?raw'

type IntroCopy = {
  headline: string
  body: string
}

type IntroCopyRecord = IntroCopy & {
  personality: string
}

export type IntroProps = {
  /**
   * Open an existing session. Navigation belongs to the route that owns this
   * surface, so the resume chip is handed the action rather than reaching for
   * a router from inside a presentational component. Without it the chip is
   * simply not offered.
   */
  onResumeSession?: (sessionId: string) => void
  personality?: string
  seed?: number
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

function neutralCopy(): IntroCopy[] {
  return INTRO_COPY_BY_PERSONALITY.none || INTRO_COPY_BY_PERSONALITY.default || FALLBACK_COPY
}

function fallbackCopyForPersonality(personalityKey: string): IntroCopy[] {
  if (NEUTRAL_PERSONALITIES.has(personalityKey)) {
    return neutralCopy()
  }

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

function pickCopy(copies: IntroCopy[], seed = 0): IntroCopy {
  return copies[Math.abs(seed) % copies.length] || FALLBACK_COPY[0]
}

function resolveCopy(personality?: string, seed?: number): IntroCopy {
  const personalityKey = normalizeKey(personality)

  const copies = NEUTRAL_PERSONALITIES.has(personalityKey)
    ? INTRO_COPY_BY_PERSONALITY[personalityKey] || neutralCopy()
    : INTRO_COPY_BY_PERSONALITY[personalityKey] || fallbackCopyForPersonality(personalityKey)

  return pickCopy(copies, seed)
}

// The entrance plays once per app launch, not once per empty state: switching
// away from a session and back should not re-run the greeting. Module scope is
// exactly the lifetime we want — it resets when the window reloads.
let entrancePlayed = false

/** Chip glyphs. Tabler only, one per kind — see design.md § Iconography. */
const CHIP_ICON = {
  explain: Search,
  plan: NotebookTabs,
  project: FolderOpen,
  resume: Clock
} as const

export function Intro({ onResumeSession, personality, seed }: IntroProps) {
  const [mountSeed] = useState(() => Math.floor(Math.random() * 100000))
  const [playEntrance] = useState(() => !entrancePlayed)
  const copy = resolveCopy(personality, mountSeed + (seed ?? 0))
  const { t } = useI18n()

  const account = useStore($keycloakAccount)
  const onboarding = useStore($desktopOnboarding)
  const sessions = useStore($sessions)
  const projects = useStore($projectTree)
  const profileScope = useStore($profileScope)
  const showAllProfiles = useStore($showAllProfiles)
  const activeCwd = useStore($currentCwd)

  useEffect(() => {
    entrancePlayed = true
  }, [])

  // Who the user is, read from the token store on disk in the main process —
  // no network, and idempotent, so an empty state that remounts costs nothing.
  useEffect(() => {
    if (!$keycloakAccount.get().loaded) {
      void refreshKeycloakAccount()
    }
  }, [])

  // Onboarding owns the screen while it's up; and `configured === null` just
  // means the first runtime check hasn't answered yet, so hold the row back
  // rather than flash chips and pull them away.
  const onboardingActive = onboarding.manual || onboarding.configured !== true

  const chips = useMemo(
    () =>
      introChipSources({
        activeCwd,
        canResume: Boolean(onResumeSession),
        onboardingActive,
        profileScope,
        projects,
        sessions,
        showAllProfiles
      }),
    [activeCwd, onResumeSession, onboardingActive, profileScope, projects, sessions, showAllProfiles]
  )

  const intro = t.assistant.intro
  const name = account.displayName?.trim() ?? ''
  const slot = introGreetingSlot(new Date().getHours())

  const greeting =
    slot === 'morning'
      ? intro.greetingMorning(name || undefined)
      : slot === 'afternoon'
        ? intro.greetingAfternoon(name || undefined)
        : intro.greetingEvening(name || undefined)

  const chipLabel = (chip: IntroChipSource): string => {
    if (chip.kind === 'resume') {
      return intro.resume(chip.title)
    }

    if (chip.kind === 'project') {
      return t.sidebar.newSessionIn(chip.label)
    }

    return chip.starter === 'explain' ? intro.starterExplainLabel : intro.starterPlanLabel
  }

  // One existing action per chip — nothing here is a new navigation path.
  const runChip = (chip: IntroChipSource) => {
    if (chip.kind === 'resume') {
      onResumeSession?.(chip.sessionId)

      return
    }

    if (chip.kind === 'project') {
      requestStartWorkSession(chip.path)

      return
    }

    requestComposerInsert(chip.starter === 'explain' ? intro.starterExplainPrompt : intro.starterPlanPrompt, {
      target: 'main'
    })
    requestComposerFocus('main')
  }

  return (
    <div
      className="pointer-events-none flex w-full min-w-0 flex-col items-center justify-center px-0.5 py-6 text-center text-muted-foreground sm:px-6 lg:px-8"
      data-entrance={playEntrance ? '' : undefined}
      data-slot="aui_intro"
    >
      <div className="w-full min-w-0">
        <h2 className="intro-greeting intro-enter font-serif-display text-2xl text-(--ui-text-primary)">{greeting}</h2>

        <p className="intro-body intro-enter" style={{ '--intro-step': 1 } as React.CSSProperties}>
          {copy.body}
        </p>

        {chips.length > 0 && (
          <div aria-label={intro.quickStart} className="intro-chips pointer-events-auto" role="group">
            {chips.map((chip, index) => {
              const Icon = CHIP_ICON[chip.kind === 'starter' ? chip.starter : chip.kind]

              return (
                <Button
                  className="intro-enter max-w-full"
                  key={chip.kind === 'starter' ? chip.starter : `${chip.kind}:${chipLabel(chip)}`}
                  onClick={() => runChip(chip)}
                  size="chip"
                  style={{ '--intro-step': index + 2 } as React.CSSProperties}
                  variant="chip"
                >
                  <Icon />
                  <span className="truncate">{chipLabel(chip)}</span>
                </Button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
