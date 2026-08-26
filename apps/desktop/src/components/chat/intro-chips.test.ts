import { describe, expect, it } from 'vitest'

import type { SidebarProjectTree } from '@/app/chat/sidebar/projects/workspace-groups'
import type { SessionInfo } from '@/types/hermes'

import { introChipSources, introGreetingSlot } from './intro-chips'

const session = (over: Partial<SessionInfo> & { id: string }): SessionInfo =>
  ({
    ended_at: null,
    is_active: false,
    message_count: 2,
    model: null,
    preview: null,
    source: null,
    started_at: 0,
    title: `Session ${over.id}`,
    last_active: 0,
    ...over
  }) as SessionInfo

const project = (over: Partial<SidebarProjectTree> & { id: string }): SidebarProjectTree => ({
  label: over.label ?? over.id,
  path: over.path ?? `/repo/${over.id}`,
  repos: [],
  sessionCount: 1,
  ...over
})

const kinds = (chips: ReturnType<typeof introChipSources>) => chips.map(chip => chip.kind)

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

describe('introChipSources', () => {
  it('offers only the starters when there is no history', () => {
    expect(kinds(introChipSources({ showAllProfiles: true }))).toEqual(['starter', 'starter'])
  })

  it('shows nothing at all while onboarding owns the screen', () => {
    expect(
      introChipSources({
        onboardingActive: true,
        projects: [project({ id: 'p_1' })],
        sessions: [session({ id: 's1', last_active: 10 })],
        showAllProfiles: true
      })
    ).toEqual([])
  })

  it('resumes the most recently active session, never an archived one', () => {
    const chips = introChipSources({
      sessions: [
        session({ id: 'old', last_active: 10 }),
        session({ id: 'newest-but-archived', archived: true, last_active: 99 }),
        session({ id: 'newest', last_active: 40, title: 'Ship the migration' })
      ],
      showAllProfiles: true
    })

    expect(chips[0]).toEqual({ kind: 'resume', sessionId: 'newest', title: 'Ship the migration' })
  })

  it('falls back to the preview when a session has no title, and skips it when it has neither', () => {
    expect(
      introChipSources({
        sessions: [session({ id: 's1', title: null, preview: 'fix the flake' })],
        showAllProfiles: true
      })[0]
    ).toEqual({
      kind: 'resume',
      sessionId: 's1',
      title: 'fix the flake'
    })

    expect(
      kinds(introChipSources({ sessions: [session({ id: 's1', title: '  ', preview: null })], showAllProfiles: true }))
    ).toEqual(['starter', 'starter'])
  })

  it('honours the sidebar profile scope', () => {
    const sessions = [
      session({ id: 'mine', profile: 'work', last_active: 10 }),
      session({ id: 'theirs', profile: 'other', last_active: 99 })
    ]

    expect(introChipSources({ profileScope: 'work', sessions })[0]).toMatchObject({ sessionId: 'mine' })
    expect(introChipSources({ sessions, showAllProfiles: true })[0]).toMatchObject({ sessionId: 'theirs' })
  })

  it('picks the most recent project and skips the one the surface already sits in', () => {
    const projects = [
      project({ id: 'p_a', label: 'Alpha', lastActive: 10, path: '/repo/a' }),
      project({ id: 'p_b', label: 'Beta', lastActive: 90, path: '/repo/b' }),
      project({ id: 'p_c', label: 'Gone', archived: true, lastActive: 99, path: '/repo/c' }),
      project({ id: 'p_d', label: 'Pathless', lastActive: 95, path: null })
    ]

    expect(introChipSources({ projects, showAllProfiles: true })[0]).toEqual({
      kind: 'project',
      label: 'Beta',
      path: '/repo/b'
    })

    expect(introChipSources({ activeCwd: '/repo/b', projects, showAllProfiles: true })[0]).toMatchObject({
      label: 'Alpha'
    })
  })

  it('caps the row at four, resume first then project then starters', () => {
    const chips = introChipSources({
      projects: [project({ id: 'p_a', lastActive: 5 })],
      sessions: [session({ id: 's1', last_active: 5 })],
      showAllProfiles: true
    })

    expect(kinds(chips)).toEqual(['resume', 'project', 'starter', 'starter'])
    expect(chips).toHaveLength(4)
  })
})
