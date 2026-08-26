/**
 * Quick-start chips for the empty chat home surface.
 *
 * Every chip is grounded in something the app already knows — the session the
 * user was last in, a project they already added — plus two fixed starters that
 * come from the locale file. Nothing here invents a suggestion: if there is no
 * recent session, there is no resume chip.
 *
 * The selection is a pure function so it can be tested without a renderer, and
 * so `Intro` stays a rendering component.
 */

import { sessionRecency, type SidebarProjectTree } from '@/app/chat/sidebar/projects/workspace-groups'
import { normalizeProfileKey } from '@/store/profile'
import type { SessionInfo } from '@/types/hermes'

/** Fixed starters, keyed so their label + prompt live in the locale files. */
export type IntroStarterId = 'explain' | 'plan'

export type IntroChipSource =
  | { kind: 'project'; label: string; path: string }
  | { kind: 'resume'; sessionId: string; title: string }
  | { kind: 'starter'; starter: IntroStarterId }

/** At most four — past that the row stops reading as "a few ways in". */
const MAX_CHIPS = 4

const STARTERS: IntroStarterId[] = ['explain', 'plan']

const trimmed = (value: null | string | undefined): string => value?.trim() ?? ''

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

export interface IntroChipInput {
  /** Cwd of the surface the chips render on — its project is already "here". */
  activeCwd?: null | string
  /** False when the surface has no way to open a session: offer no resume chip. */
  canResume?: boolean
  /** True while the onboarding overlay owns the screen: show no chips at all. */
  onboardingActive?: boolean
  /** `$profileScope` — the profile whose sessions the sidebar is showing. */
  profileScope?: null | string
  projects?: SidebarProjectTree[]
  sessions?: SessionInfo[]
  /** `$showAllProfiles` — when true, scope filtering is off. */
  showAllProfiles?: boolean
}

/**
 * Resume → project → starters, capped at {@link MAX_CHIPS}.
 *
 * The resume chip mirrors the sidebar's own view (profile scope, archived
 * excluded, most recent first) so "Resume X" always names a row the user can
 * also see. The project chip skips the project the surface is already sitting
 * in — offering to open where you already are is noise.
 */
export function introChipSources({
  activeCwd,
  canResume = true,
  onboardingActive = false,
  profileScope,
  projects = [],
  sessions = [],
  showAllProfiles = false
}: IntroChipInput): IntroChipSource[] {
  if (onboardingActive) {
    return []
  }

  const chips: IntroChipSource[] = []

  const inScope = showAllProfiles
    ? sessions
    : sessions.filter(session => normalizeProfileKey(session.profile) === profileScope)

  const recent = inScope
    .filter(session => Boolean(trimmed(session.id)) && !session.archived)
    .reduce<null | SessionInfo>(
      (best, session) => (!best || sessionRecency(session) > sessionRecency(best) ? session : best),
      null
    )

  const recentTitle = recent && (trimmed(recent.title) || trimmed(recent.preview))

  if (canResume && recent && recentTitle) {
    chips.push({ kind: 'resume', sessionId: recent.id, title: recentTitle })
  }

  const here = trimmed(activeCwd)

  const project = projects
    .filter(node => !node.archived && Boolean(trimmed(node.path)) && trimmed(node.path) !== here)
    .reduce<null | SidebarProjectTree>(
      (best, node) => (!best || (node.lastActive ?? 0) > (best.lastActive ?? 0) ? node : best),
      null
    )

  if (project) {
    chips.push({ kind: 'project', label: project.label, path: trimmed(project.path) })
  }

  for (const starter of STARTERS) {
    chips.push({ kind: 'starter', starter })
  }

  return chips.slice(0, MAX_CHIPS)
}
