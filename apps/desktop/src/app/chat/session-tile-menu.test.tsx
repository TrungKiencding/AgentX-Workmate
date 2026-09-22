import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $pinnedSessionIds } from '@/store/layout'
import { $messagingSessions, $selectedStoredSessionId, $sessions } from '@/store/session'
import { type SessionTileDelegate, setSessionTileDelegate } from '@/store/session-states'
import type { SessionInfo } from '@/types/hermes'

import { SessionTabMenu, WorkspaceTabMenu } from './session-tile'

// The tile's chat surface is irrelevant to its tab menu; stubbing ChatView keeps
// this file off the whole thread/composer module graph.
vi.mock('./index', () => ({ ChatView: () => null }))

// Everything else is real: the stores the menu resolves the tab's source from,
// the tile delegate its Delete goes through, and both session menus — so a
// transcript tab that falls back to the full menu fails here.

const TELEGRAM_ID = 'tg-1'
const LOCAL_ID = 'desk-1'

// Verbs that edit or re-home a Workmate chat; a platform transcript is
// read-only, so none may appear on its tab.
const EDITING_VERBS = ['Rename', 'Pin', 'Branch', 'Archive', 'Move to project', 'Appearance', 'Export']

function row(id: string, source: string): SessionInfo {
  return {
    cwd: null,
    ended_at: null,
    id,
    input_tokens: 0,
    is_active: false,
    last_active: 1,
    message_count: 2,
    model: null,
    output_tokens: 0,
    parent_session_id: null,
    preview: null,
    source,
    started_at: 1,
    title: `${source} chat`,
    tool_call_count: 0
  }
}

function delegate(): SessionTileDelegate & { deleteSession: ReturnType<typeof vi.fn> } {
  return {
    archiveSession: vi.fn(async () => undefined),
    branchSession: vi.fn(async () => undefined),
    deleteSession: vi.fn(async () => undefined),
    executeSlash: vi.fn(async () => undefined),
    interruptSession: vi.fn(async () => undefined),
    resumeTile: vi.fn(async () => 'runtime'),
    submitToSession: vi.fn(async () => undefined),
    updateSession: vi.fn()
  }
}

async function openMenuOn(label: string): Promise<string[]> {
  fireEvent.contextMenu(screen.getByText(label), { button: 2 })
  await screen.findByRole('menu')

  return screen.getAllByRole('menuitem').map(item => item.textContent?.trim() ?? '')
}

function renderTileTab(storedSessionId: string, onClose = vi.fn()) {
  render(
    <SessionTabMenu onClose={onClose} storedSessionId={storedSessionId} tabPaneId={`session-tile:${storedSessionId}`}>
      <button type="button">Tab</button>
    </SessionTabMenu>
  )

  return onClose
}

describe('session tab menus on a platform transcript', () => {
  let tileDelegate: ReturnType<typeof delegate>

  beforeEach(() => {
    tileDelegate = delegate()
    setSessionTileDelegate(tileDelegate)
  })

  afterEach(() => {
    cleanup()
    $messagingSessions.set([])
    $sessions.set([])
    $pinnedSessionIds.set([])
    $selectedStoredSessionId.set(null)
  })

  it("offers a Telegram tile tab only Delete from Workmate plus the tab's own verbs", async () => {
    $messagingSessions.set([row(TELEGRAM_ID, 'telegram')])
    const onClose = renderTileTab(TELEGRAM_ID)

    const items = await openMenuOn('Tab')

    expect(items).toEqual(
      expect.arrayContaining(['Reload', 'Close', 'Close others', 'Close to the right', 'Close all'])
    )
    expect(items).toContain('Delete from Workmate')

    for (const verb of [...EDITING_VERBS, 'Unpin', 'Delete']) {
      expect(items).not.toContain(verb)
    }

    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete from Workmate' }))
    expect(tileDelegate.deleteSession).toHaveBeenCalledWith(TELEGRAM_ID)

    await openMenuOn('Tab')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('lets a pinned transcript tab undo its pin, and nothing else', async () => {
    $messagingSessions.set([row(TELEGRAM_ID, 'telegram')])
    $pinnedSessionIds.set([TELEGRAM_ID])
    renderTileTab(TELEGRAM_ID)

    const items = await openMenuOn('Tab')

    expect(items).toContain('Unpin')

    for (const verb of EDITING_VERBS) {
      expect(items).not.toContain(verb)
    }

    fireEvent.click(screen.getByRole('menuitem', { name: 'Unpin' }))
    expect($pinnedSessionIds.get()).not.toContain(TELEGRAM_ID)
  })

  it('still treats a transcript row resolved through $sessions as read-only', async () => {
    // A tile pulls its row into $sessions once it has messages; the source,
    // not the slice it was found in, decides the menu.
    $sessions.set([row(TELEGRAM_ID, 'telegram')])
    renderTileTab(TELEGRAM_ID)

    const items = await openMenuOn('Tab')

    expect(items).toContain('Delete from Workmate')
    expect(items).not.toContain('Rename')
  })

  it('switches to the read-only menu when the transcript row loads after the tab mounted', async () => {
    // On startup tabs restore before $messagingSessions loads, so the menu first
    // mounts without knowing the source and must follow the row when it arrives.
    renderTileTab(TELEGRAM_ID)
    act(() => $messagingSessions.set([row(TELEGRAM_ID, 'telegram')]))

    const items = await openMenuOn('Tab')

    expect(items).toContain('Delete from Workmate')
    expect(items).not.toContain('Rename')
  })

  it("gives the main tab's transcript the read-only menu with Close and Hide tab bar", async () => {
    $messagingSessions.set([row(TELEGRAM_ID, 'telegram')])
    $selectedStoredSessionId.set(TELEGRAM_ID)

    render(
      <WorkspaceTabMenu>
        <button type="button">Main</button>
      </WorkspaceTabMenu>
    )

    const items = await openMenuOn('Main')

    expect(items).toEqual(expect.arrayContaining(['Close', 'Delete from Workmate', 'Hide tab bar']))

    for (const verb of EDITING_VERBS) {
      expect(items).not.toContain(verb)
    }
  })

  it('keeps the full session menu on a local chat tab', async () => {
    $sessions.set([row(LOCAL_ID, 'desktop')])
    renderTileTab(LOCAL_ID)

    const items = await openMenuOn('Tab')

    expect(items).toEqual(expect.arrayContaining(['Rename', 'Pin', 'Branch', 'Archive', 'Move to project', 'Close']))
    expect(items).toContain('Delete')
    expect(items).not.toContain('Delete from Workmate')
  })
})
