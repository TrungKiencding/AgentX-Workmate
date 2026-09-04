import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useState } from 'react'

import { requestComposerFocus, requestComposerInsert } from '@/app/chat/composer/focus'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n/context'
import { Clock, FileText, FolderOpen, Mail, NotebookTabs, Search } from '@/lib/icons'
import { $keycloakAccount, refreshKeycloakAccount } from '@/store/account'
import { $repoStatus } from '@/store/coding-status'
import { $desktopOnboarding } from '@/store/onboarding'
import { $profileScope, $showAllProfiles } from '@/store/profile'
import { $projectTree, requestStartWorkSession } from '@/store/projects'
import { $currentCwd, $sessions } from '@/store/session'

import { type IntroChipSource, introChipSources, introGreetingSlot, type IntroStarterId } from './intro-chips'
import { resolveIntroBody } from './intro-copy'

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

// The entrance plays once per app launch, not once per empty state: switching
// away from a session and back should not re-run the greeting. Module scope is
// exactly the lifetime we want — it resets when the window reloads.
let entrancePlayed = false

/** Chip glyphs. Tabler only, one per kind — see design.md § Iconography. */
const CHIP_ICON = {
  draft: Mail,
  explain: Search,
  plan: NotebookTabs,
  project: FolderOpen,
  resume: Clock,
  summarize: FileText
} as const

export function Intro({ onResumeSession, personality, seed }: IntroProps) {
  const [mountSeed] = useState(() => Math.floor(Math.random() * 100000))
  const [playEntrance] = useState(() => !entrancePlayed)
  const { locale, t } = useI18n()

  const account = useStore($keycloakAccount)
  const onboarding = useStore($desktopOnboarding)
  const sessions = useStore($sessions)
  const projects = useStore($projectTree)
  const profileScope = useStore($profileScope)
  const showAllProfiles = useStore($showAllProfiles)
  const activeCwd = useStore($currentCwd)
  // Null off a repository — the composer's coding rail runs the same probe, so
  // the chips and the branch strip never disagree about what the folder is.
  const cwdIsRepo = useStore($repoStatus) !== null

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
        cwdIsRepo,
        onboardingActive,
        profileScope,
        projects,
        sessions,
        showAllProfiles
      }),
    [activeCwd, cwdIsRepo, onResumeSession, onboardingActive, profileScope, projects, sessions, showAllProfiles]
  )

  const intro = t.assistant.intro

  const body = resolveIntroBody({
    bodyVariants: intro.bodyVariants,
    locale,
    personality,
    seed: mountSeed + (seed ?? 0)
  })

  const name = account.displayName?.trim() ?? ''
  const slot = introGreetingSlot(new Date().getHours())

  const greeting =
    slot === 'morning'
      ? intro.greetingMorning(name || undefined)
      : slot === 'afternoon'
        ? intro.greetingAfternoon(name || undefined)
        : intro.greetingEvening(name || undefined)

  // Label + prompt per starter. "Explain" speaks of the repo inside one and of
  // the folder anywhere else — the same folder probe the chip order uses.
  const starterCopy = (starter: IntroStarterId): { label: string; prompt: string } => {
    switch (starter) {
      case 'explain':
        return cwdIsRepo
          ? { label: intro.starterExplainLabel, prompt: intro.starterExplainPrompt }
          : { label: intro.starterExplainFolderLabel, prompt: intro.starterExplainFolderPrompt }

      case 'plan':
        return { label: intro.starterPlanLabel, prompt: intro.starterPlanPrompt }

      case 'summarize':
        return { label: intro.starterSummarizeLabel, prompt: intro.starterSummarizePrompt }

      case 'draft':
        return { label: intro.starterDraftLabel, prompt: intro.starterDraftPrompt }
    }
  }

  const chipLabel = (chip: IntroChipSource): string => {
    if (chip.kind === 'resume') {
      return intro.resume(chip.title)
    }

    if (chip.kind === 'project') {
      return t.sidebar.newSessionIn(chip.label)
    }

    return starterCopy(chip.starter).label
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

    requestComposerInsert(starterCopy(chip.starter).prompt, { target: 'main' })
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
          {body}
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
