import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { closeOtherTreeTabs, reloadTreePane } from '@/components/pane-shell/tree/store'

import { MessagingSessionActionsMenu, MessagingSessionContextMenu, SessionActionsMenu } from './session-actions-menu'

afterEach(cleanup)

// Exercises the real SessionActionsMenu end-to-end (no DropdownMenu mock) so
// a broken asChild composition on the kebab trigger fails here — the menu
// must still open on click.

vi.mock('@/components/pane-shell/tree/store', () => ({
  closeAllTreeTabs: vi.fn(),
  closeOtherTreeTabs: vi.fn(),
  closeTreeTabsToRight: vi.fn(),
  reloadTreePane: vi.fn(),
  treeTabCloseTargets: vi.fn(() => ({ all: 2, others: 1, right: 1 }))
}))
vi.mock('@/hermes', () => ({ renameSession: vi.fn() }))
vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      common: { cancel: 'Cancel', close: 'Close', delete: 'Delete', save: 'Save' },
      sidebar: {
        projects: {
          menuAppearance: 'Appearance',
          moveFailed: 'Could not move session',
          moveNoProjects: 'No other projects',
          movedTo: (name: string) => `Moved to ${name}`,
          moveToProject: 'Move to project',
          noColor: 'No color'
        },
        row: {
          archive: 'Archive',
          branchFrom: 'Branch from here',
          copyId: 'Copy ID',
          copyIdFailed: 'Failed to copy ID',
          export: 'Export',
          hideTabBar: 'Hide tab bar',
          pin: 'Pin',
          rename: 'Rename',
          renameDesc: 'Leave empty to clear.',
          renameFailed: 'Rename failed',
          renameTitle: 'Rename session',
          renamed: 'Renamed',
          sessionActions: 'Session actions',
          deleteWorkmateCopy: 'Delete from Workmate',
          unpin: 'Unpin',
          untitledPlaceholder: 'Untitled'
        }
      },
      zones: {
        closeAll: 'Close all',
        closeOthers: 'Close others',
        closeToRight: 'Close to the right',
        reload: 'Reload'
      }
    }
  })
}))
vi.mock('@/lib/haptics', () => ({ triggerHaptic: vi.fn() }))
vi.mock('@/lib/profile-color', () => ({ PROFILE_SWATCHES: [] }))
vi.mock('@/lib/session-export', () => ({ exportSession: vi.fn() }))
vi.mock('@/store/gateway', () => ({ activeGateway: vi.fn(() => null) }))
vi.mock('@/store/notifications', () => ({ notify: vi.fn(), notifyError: vi.fn() }))
vi.mock('@/store/projects', () => ({
  $projectTree: atom<unknown[]>([]),
  moveSessionToProject: vi.fn(),
  projectIdForCwd: vi.fn(() => null),
  projectRootCwd: vi.fn(() => '')
}))
vi.mock('@/store/session', () => ({
  $activeSessionId: atom<null | string>(null),
  $selectedStoredSessionId: atom<null | string>(null),
  $sessions: atom<unknown[]>([]),
  sessionMatchesStoredId: vi.fn(() => false),
  sessionPinId: vi.fn((s: { id: string }) => s.id),
  setSessions: vi.fn()
}))
vi.mock('@/store/session-color', () => ({
  $sessionColorOverrides: atom<Record<string, string>>({}),
  setSessionColorOverride: vi.fn()
}))
vi.mock('@/store/session-states', () => ({
  $sessionTiles: atom<unknown[]>([]),
  openSessionTile: vi.fn()
}))
vi.mock('@/store/windows', () => ({
  canOpenSessionWindow: () => false,
  openSessionInNewWindow: vi.fn()
}))

function renderMenu() {
  return render(
    <SessionActionsMenu sessionId="s1" title="My session">
      <button aria-label="Session actions" type="button">
        ⋮
      </button>
    </SessionActionsMenu>
  )
}

describe('SessionActionsMenu', () => {
  it('opens the dropdown on click without a tooltip on the kebab', async () => {
    renderMenu()

    const trigger = screen.getByRole('button', { name: 'Session actions' })

    expect(trigger.closest('[data-slot="tooltip-trigger"]')).toBeNull()

    // Radix's dropdown trigger opens on pointerdown (not on the synthetic
    // 'click' fireEvent alone would dispatch), so fire the full mouse
    // sequence a real click produces.
    fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
    fireEvent.pointerUp(trigger, { button: 0, pointerType: 'mouse' })
    fireEvent.click(trigger)

    expect(await screen.findByRole('menu')).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /rename/i })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /archive/i })).toBeTruthy()
  })
})

describe('MessagingSessionActionsMenu', () => {
  it('offers only local deletion and invokes it', async () => {
    const onDelete = vi.fn()
    render(
      <MessagingSessionActionsMenu onDelete={onDelete}>
        <button aria-label="Session actions" type="button">
          ⋮
        </button>
      </MessagingSessionActionsMenu>
    )

    const trigger = screen.getByRole('button', { name: 'Session actions' })
    fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
    fireEvent.pointerUp(trigger, { button: 0, pointerType: 'mouse' })
    fireEvent.click(trigger)

    const menu = await screen.findByRole('menu')
    expect(screen.getAllByRole('menuitem')).toHaveLength(1)
    expect(menu.textContent).toContain('Delete from Workmate')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete from Workmate' }))
    expect(onDelete).toHaveBeenCalledOnce()
  })

  it('lets a pinned transcript be unpinned so the pin is never stranded', async () => {
    const onDelete = vi.fn()
    const onUnpin = vi.fn()
    render(
      <MessagingSessionActionsMenu onDelete={onDelete} onUnpin={onUnpin}>
        <button aria-label="Session actions" type="button">
          ⋮
        </button>
      </MessagingSessionActionsMenu>
    )

    const trigger = screen.getByRole('button', { name: 'Session actions' })
    fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
    fireEvent.pointerUp(trigger, { button: 0, pointerType: 'mouse' })
    fireEvent.click(trigger)

    await screen.findByRole('menu')
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Unpin', 'Delete from Workmate'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unpin' }))
    expect(onUnpin).toHaveBeenCalledOnce()
    expect(onDelete).not.toHaveBeenCalled()
  })
})

describe('MessagingSessionContextMenu', () => {
  function openContextMenu() {
    fireEvent.contextMenu(screen.getByText('Telegram tab'), { button: 2 })
  }

  it('keeps a row menu to local deletion when no tab verbs are passed', async () => {
    render(
      <MessagingSessionContextMenu onDelete={vi.fn()}>
        <div>Telegram tab</div>
      </MessagingSessionContextMenu>
    )

    openContextMenu()

    await screen.findByRole('menu')
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Delete from Workmate'])
  })

  it("adds a transcript tab's strip verbs without any session-editing verbs", async () => {
    const onClose = vi.fn()
    const onDelete = vi.fn()
    const onHideTabBar = vi.fn()
    const onUnpin = vi.fn()

    render(
      <MessagingSessionContextMenu
        onClose={onClose}
        onDelete={onDelete}
        onHideTabBar={onHideTabBar}
        onUnpin={onUnpin}
        tabPaneId="session-tile:tg-1"
      >
        <div>Telegram tab</div>
      </MessagingSessionContextMenu>
    )

    openContextMenu()

    await screen.findByRole('menu')
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      'Unpin',
      'Reload',
      'Close',
      'Close others',
      'Close to the right',
      'Close all',
      'Delete from Workmate',
      'Hide tab bar'
    ])

    fireEvent.click(screen.getByRole('menuitem', { name: 'Close others' }))
    expect(closeOtherTreeTabs).toHaveBeenCalledWith('session-tile:tg-1')

    openContextMenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Reload' }))
    expect(reloadTreePane).toHaveBeenCalledWith('session-tile:tg-1')

    openContextMenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledOnce()

    openContextMenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Hide tab bar' }))
    expect(onHideTabBar).toHaveBeenCalledOnce()

    openContextMenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete from Workmate' }))
    expect(onDelete).toHaveBeenCalledOnce()
    expect(onUnpin).not.toHaveBeenCalled()
  })
})
