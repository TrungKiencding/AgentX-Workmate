import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { ProjectMenu } from './project-menu'
import type { SidebarProjectTree } from './workspace-groups'

afterEach(cleanup)

// jsdom doesn't implement ResizeObserver; Radix's PopoverContent/Arrow use it
// (via @radix-ui/react-use-size) to measure the arrow once the popover is
// actually mounted. The kebab-only test above never opens a Popover, so it
// doesn't need this — only the appearance-popover test below does.
beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      common: { cancel: 'Cancel', confirm: 'Confirm', done: 'Done', loading: 'Loading…' },
      sidebar: {
        projects: {
          copyPath: 'Copy path',
          deleteConfirm: 'This cannot be undone.',
          menu: 'Actions',
          menuAddFolder: 'Add folder',
          menuAppearance: 'Appearance',
          menuDelete: 'Delete',
          menuNewChat: 'New chat',
          menuRename: 'Rename',
          menuShowAll: 'Show all chats',
          noColor: 'No color',
          removeFromSidebar: 'Remove from sidebar',
          reveal: 'Reveal in file manager'
        }
      }
    }
  })
}))

vi.mock('@/store/layout', () => ({
  $panesFlipped: {
    get: () => false,
    listen: () => () => {},
    subscribe: (fn: (v: boolean) => void) => {
      fn(false)

      return () => {}
    }
  },
  dismissAutoProject: vi.fn()
}))

vi.mock('@/store/projects', () => ({
  addFolderToProject: vi.fn(),
  copyPath: vi.fn(),
  deleteProject: vi.fn(),
  enterProject: vi.fn(),
  openProjectRename: vi.fn(),
  projectRootCwd: (project: { path?: null | string }) => project.path ?? '',
  requestStartWorkSession: vi.fn(),
  revealPath: vi.fn(),
  setProjectAppearance: vi.fn().mockResolvedValue(false)
}))

const store = await import('@/store/projects')

const project = {
  color: null,
  icon: null,
  id: 'p1',
  isAuto: false,
  label: 'Test D',
  path: '/repo'
} as unknown as SidebarProjectTree

const tipTrigger = (el: HTMLElement) => el.closest('[data-slot="tooltip-trigger"]')

const openTriggerMenu = (trigger: HTMLElement) => {
  // Radix's dropdown trigger opens on pointerdown (a synthetic 'click' fireEvent
  // alone won't do it), so fire the full mouse sequence a real click produces —
  // same technique as session-actions-menu.test.tsx (#67500).
  fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
  fireEvent.pointerUp(trigger, { button: 0, pointerType: 'mouse' })
  fireEvent.click(trigger)
}

describe('ProjectMenu', () => {
  it('does not wrap the kebab trigger in a Tip', () => {
    render(<ProjectMenu project={project} />)

    const button = screen.getByRole('button', { name: 'Actions' })
    expect(tipTrigger(button)).toBeNull()
  })

  // When anchorRef is absent, PopoverAnchor wraps the dropdown trigger so the
  // appearance popover positions against the kebab. asChild must still reach
  // the real button (no non-forwarding wrappers inside the chain — #67500).
  it('opens the appearance popover through the kebab trigger when anchorRef is absent', async () => {
    render(<ProjectMenu project={project} />)

    const trigger = screen.getByRole('button', { name: 'Actions' })

    openTriggerMenu(trigger)

    const appearanceItem = await screen.findByRole('menuitem', { name: 'Appearance' })

    fireEvent.click(appearanceItem)

    // The color-swatch "No color" clear option only renders once the
    // appearance Popover is actually open — proving the click reached the
    // real button through the full Tip > PopoverAnchor > DropdownMenuTrigger
    // chain rather than getting silently dropped on an intermediate wrapper.
    expect(await screen.findByRole('button', { name: 'No color' })).toBeTruthy()
  }, 15000)

  it('leads with where to go: a new chat in the folder, then every chat it holds', async () => {
    render(<ProjectMenu project={project} />)
    openTriggerMenu(screen.getByRole('button', { name: 'Actions' }))

    const items = (await screen.findAllByRole('menuitem')).map(item => item.textContent)
    expect(items.slice(0, 2)).toEqual(['New chat', 'Show all chats'])
    expect(items).not.toContain('Set active')

    fireEvent.click(screen.getByRole('menuitem', { name: 'New chat' }))
    expect(store.requestStartWorkSession).toHaveBeenCalledWith('/repo', undefined, { openTab: true })
  }, 15000)

  it('"Add folder…" goes straight to the picker for an explicit project', async () => {
    render(<ProjectMenu project={project} />)
    openTriggerMenu(screen.getByRole('button', { name: 'Actions' }))

    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add folder…' }))
    expect(store.addFolderToProject).toHaveBeenCalledWith({ id: 'p1', name: 'Test D' })
  }, 15000)

  it('an auto project can be renamed (it adopts its folder) but takes no extra folders', async () => {
    const auto = { ...project, id: '/repo', isAuto: true } as SidebarProjectTree
    render(<ProjectMenu project={auto} />)
    openTriggerMenu(screen.getByRole('button', { name: 'Actions' }))

    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename…' }))
    expect(store.openProjectRename).toHaveBeenCalledWith(auto)

    openTriggerMenu(screen.getByRole('button', { name: 'Actions' }))
    await screen.findAllByRole('menuitem')
    expect(screen.queryByRole('menuitem', { name: 'Add folder…' })).toBeNull()
  }, 15000)

  it('inside the drilled-in view it does not offer to show all again', async () => {
    render(<ProjectMenu project={project} scoped />)
    openTriggerMenu(screen.getByRole('button', { name: 'Actions' }))

    await screen.findAllByRole('menuitem')
    expect(screen.queryByRole('menuitem', { name: 'Show all chats' })).toBeNull()
  }, 15000)
})
