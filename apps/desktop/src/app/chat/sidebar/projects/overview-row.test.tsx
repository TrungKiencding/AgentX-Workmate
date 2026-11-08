import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SessionInfo } from '@/hermes'

import { ProjectOverviewRow } from './overview-row'
import type { SidebarProjectTree } from './workspace-groups'

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      sidebar: {
        newSessionIn: (label: string) => `New chat in ${label}`,
        projectEmpty: 'No chats yet',
        projects: {
          reorder: (label: string) => `Reorder ${label}`,
          showAll: (count: number) => `Show all ${count} chats`,
          toggle: (label: string, open: boolean) => `${open ? 'Show' : 'Hide'} ${label} chats`
        }
      }
    }
  })
}))

// Open state lives in a persisted store in the app; a plain object stands in.
const openState = vi.hoisted(() => ({ value: {} as Record<string, boolean> }))

vi.mock('./model', () => ({
  PROJECT_PREVIEW_COUNT: 5,
  latestProjectSessions: () => [],
  useWorkspaceNodeOpen: (id: string, defaultOpen: boolean) => [
    openState.value[id] ?? defaultOpen,
    () => {
      openState.value[id] = !(openState.value[id] ?? defaultOpen)
    }
  ]
}))

// ProjectMenu (the kebab) has its own test file — stub it; the right-click
// wrapper passes its children through so the row still renders.
vi.mock('./project-menu', () => ({
  ProjectContextMenu: ({ children }: { children: ReactNode }) => children,
  ProjectMenu: () => null
}))

afterEach(() => {
  cleanup()
  openState.value = {}
})

const project = { id: 'p1', label: 'Báo cáo', path: '/work/bao-cao', repos: [], sessionCount: 0 } as SidebarProjectTree
const session = (id: string) => ({ id, title: id }) as unknown as SessionInfo
const renderRows = (rows: SessionInfo[]) => rows.map(row => <div key={row.id}>{row.title}</div>)

describe('ProjectOverviewRow', () => {
  it('starts collapsed, and the whole row opens it', () => {
    const { rerender } = render(<ProjectOverviewRow project={project} renderRows={renderRows} />)

    const toggle = screen.getByRole('button', { name: 'Show Báo cáo chats' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('No chats yet')).toBeNull()

    fireEvent.click(toggle)
    rerender(<ProjectOverviewRow project={project} renderRows={renderRows} />)

    expect(screen.getByRole('button', { name: 'Hide Báo cáo chats' }).getAttribute('aria-expanded')).toBe('true')
    expect(openState.value['project:p1']).toBe(true)
  })

  it('an open project with no chats says so instead of rendering nothing', () => {
    openState.value['project:p1'] = true
    render(<ProjectOverviewRow project={project} renderRows={renderRows} />)

    expect(screen.getByText('No chats yet')).toBeTruthy()
  })

  it('shows its recent chats, and "show all" drills in when there are more', () => {
    openState.value['project:p1'] = true
    const onEnter = vi.fn()

    render(
      <ProjectOverviewRow
        onEnter={onEnter}
        previewSessions={[session('Chat A'), session('Chat B')]}
        project={{ ...project, sessionCount: 9 }}
        renderRows={renderRows}
      />
    )

    expect(screen.getByText('Chat A')).toBeTruthy()
    expect(screen.getByText('Chat B')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Show all 9 chats' }))
    expect(onEnter).toHaveBeenCalledWith('p1')
  })

  it('offers no "show all" when every chat is already showing', () => {
    openState.value['project:p1'] = true

    render(
      <ProjectOverviewRow
        onEnter={vi.fn()}
        previewSessions={[session('Chat A')]}
        project={{ ...project, sessionCount: 1 }}
        renderRows={renderRows}
      />
    )

    expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull()
  })

  it('"+" starts a chat in the project folder and sits in a Tip', () => {
    const onNewSession = vi.fn()
    render(<ProjectOverviewRow onNewSession={onNewSession} project={project} />)

    const add = screen.getByRole('button', { name: 'New chat in Báo cáo' })
    expect(add.closest('[data-slot="tooltip-trigger"]')).toBeTruthy()

    fireEvent.click(add)
    expect(onNewSession).toHaveBeenCalledWith('/work/bao-cao')
  })

  it('reads as a folder that opens with the row', () => {
    const { container, rerender } = render(<ProjectOverviewRow project={project} />)
    expect(container.querySelector('.codicon-folder')).toBeTruthy()

    openState.value['project:p1'] = true
    rerender(<ProjectOverviewRow project={{ ...project }} />)
    expect(container.querySelector('.codicon-folder-opened')).toBeTruthy()
  })

  it('truncates a long project name instead of running under the row actions', () => {
    const long = { ...project, label: 'modifying Mihon android app for reading manga offline' }

    render(<ProjectOverviewRow onNewSession={vi.fn()} project={long} />)

    expect(screen.getByText(long.label).classList.contains('truncate')).toBe(true)
  })
})
