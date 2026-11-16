import { type ReactNode, useEffect, useState } from 'react'

import { useKeycloakAccount } from '@/hooks/use-keycloak-account'
import { useI18n } from '@/i18n/context'
import { Moon, Sun, Sunset } from '@/lib/icons'

import { introGreetingSlot, resolveIntroHeadline } from './intro-copy'

export type IntroProps = {
  /** What follows the headline — the home surface's folder card. */
  children?: ReactNode
  personality?: string
  seed?: number
}

// The entrance plays once per app launch, not once per empty state: switching
// away from a session and back should not re-run the greeting. Module scope is
// exactly the lifetime we want — it resets when the window reloads.
let entrancePlayed = false

// Which headline a launch starts on. `seed` (bumped per new chat) walks the
// pool from here, so the line is the same for as long as a chat stays empty —
// across re-mounts — and new per chat.
const LAUNCH_SEED = Math.floor(Math.random() * 100000)

/** The time of day, drawn the way the platform's own widgets mark it. */
const SLOT_ICON = { afternoon: Sunset, evening: Moon, morning: Sun } as const

/**
 * The empty chat's hero: a small greeting that names the person beside the
 * time of day, one large serif line that asks what to do, then whatever the
 * surface hands it (the folder card). Nothing in the text is clickable — the
 * composer stays the call to action. See DESIGN.md § Home surface.
 */
export function Intro({ children, personality, seed }: IntroProps) {
  const [playEntrance] = useState(() => !entrancePlayed)
  const { locale, t } = useI18n()
  const account = useKeycloakAccount()

  useEffect(() => {
    entrancePlayed = true
  }, [])

  const intro = t.assistant.intro

  const headline = resolveIntroHeadline({
    headlines: intro.headlines,
    locale,
    personality,
    seed: LAUNCH_SEED + (seed ?? 0)
  })

  const name = account.displayName?.trim() || undefined
  const slot = introGreetingSlot(new Date().getHours())
  const SlotIcon = SLOT_ICON[slot]

  const greeting =
    slot === 'morning'
      ? intro.greetingMorning(name)
      : slot === 'afternoon'
        ? intro.greetingAfternoon(name)
        : intro.greetingEvening(name)

  return (
    <div className="home-hero" data-entrance={playEntrance ? '' : undefined} data-slot="aui_intro">
      <div className="home-hero-head">
        <p className="home-hero-greeting intro-enter">
          <SlotIcon aria-hidden="true" className="home-hero-time" data-time={slot} />
          <span className="min-w-0 truncate">{greeting}</span>
        </p>
        <h2
          className="home-hero-headline intro-enter font-serif-display tracking-display text-balance"
          style={{ '--intro-step': 1 } as React.CSSProperties}
        >
          {headline}
        </h2>
      </div>
      {children}
    </div>
  )
}
