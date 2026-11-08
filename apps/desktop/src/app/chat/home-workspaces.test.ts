import { describe, expect, it } from 'vitest'

import type { SidebarProjectTree } from '@/app/chat/sidebar/projects/workspace-groups'

import { homeWorkspaceRows } from './home-workspaces'

const project = (id: string, over: Partial<SidebarProjectTree> = {}): SidebarProjectTree => ({
  id,
  label: id,
  path: `/work/${id}`,
  repos: [],
  sessionCount: 1,
  ...over
})

const summary = (rows: ReturnType<typeof homeWorkspaceRows>) =>
  rows.map(row => `${row.kind === 'folder' ? row.label : '(none)'}${row.selected ? ' ✓' : ''}`)

describe('homeWorkspaceRows', () => {
  const projects = [
    project('alpha', { lastActive: 30 }),
    project('beta', { lastActive: 20 }),
    project('gamma', { lastActive: 10 }),
    project('delta', { lastActive: 5 })
  ]

  it('lists the three most recent folders, checks the chosen one, then "no folder"', () => {
    expect(summary(homeWorkspaceRows(projects, '/work/beta'))).toEqual(['alpha', 'beta ✓', 'gamma', '(none)'])
  })

  it('keeps the chosen folder visible when it is older than the three shown', () => {
    expect(summary(homeWorkspaceRows(projects, '/work/delta'))).toEqual(['alpha', 'beta', 'delta ✓', '(none)'])
  })

  it('checks the project that holds a subfolder', () => {
    expect(summary(homeWorkspaceRows(projects, '/work/alpha/src'))).toEqual(['alpha ✓', 'beta', 'gamma', '(none)'])
  })

  it('checks "no folder" when the chat has none', () => {
    expect(summary(homeWorkspaceRows(projects, ''))).toEqual(['alpha', 'beta', 'gamma', '(none) ✓'])
  })

  // The unnamed folder takes the last slot, so picking a listed folder leaves
  // the rows above it where they were.
  it('adds a folder no project names in the last slot, checked', () => {
    const rows = homeWorkspaceRows(projects, '/Users/me/Desktop')

    expect(summary(rows)).toEqual(['alpha', 'beta', 'Desktop ✓', '(none)'])
    expect(rows[2]).toMatchObject({ kind: 'folder', path: '/Users/me/Desktop' })
  })

  it('does not credit an auto project for a folder it merely contains', () => {
    const home = project('home', { isAuto: true, lastActive: 40, path: '/Users/me' })

    expect(summary(homeWorkspaceRows([home, ...projects], '/Users/me/Desktop'))).toEqual([
      'home',
      'alpha',
      'Desktop ✓',
      '(none)'
    ])
  })

  it('offers repos found on disk when there are no chats yet, and never the "no project" bucket', () => {
    const fresh = [
      project('found', { isAuto: true, sessionCount: 0 }),
      project('bucket', { isNoProject: true, path: null })
    ]

    expect(summary(homeWorkspaceRows(fresh, ''))).toEqual(['found', '(none) ✓'])
  })

  it('is just "no folder" on a first launch with nothing on disk', () => {
    expect(summary(homeWorkspaceRows([], ''))).toEqual(['(none) ✓'])
  })
})
