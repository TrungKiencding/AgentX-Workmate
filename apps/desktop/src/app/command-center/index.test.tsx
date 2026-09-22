// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $pinnedSessionIds } from '@/store/layout'
import { $sessions } from '@/store/session'
import type { SessionInfo } from '@/types/hermes'

import { CommandCenterView } from './index'

const session = (over: Partial<SessionInfo> & { id: string }): SessionInfo =>
  ({
    ended_at: null,
    is_active: false,
    last_active: 0,
    message_count: 2,
    model: null,
    preview: null,
    source: 'desktop',
    started_at: 0,
    title: `Session ${over.id}`,
    ...over
  }) as SessionInfo

function renderSessions() {
  return render(
    <MemoryRouter initialEntries={['/command-center']}>
      <CommandCenterView onClose={vi.fn()} onDeleteSession={vi.fn(async () => {})} onOpenSession={vi.fn()} />
    </MemoryRouter>
  )
}

beforeEach(() => {
  $pinnedSessionIds.set([])
})

afterEach(() => {
  cleanup()
  $sessions.set([])
})

describe('CommandCenterView sessions list', () => {
  // Opening a platform transcript caches its row in $sessions (resume →
  // resolveStoredSession). The sidebar keeps those rows out of recents; the
  // Command Center must too, or a read-only Telegram chat shows up as an
  // ordinary one with a Pin toggle, export and delete.
  it('leaves read-only messaging transcripts out, as the sidebar recents do', () => {
    $sessions.set([
      session({ id: 'local', last_active: 10, title: 'Draft the brief' }),
      session({ id: 'tg', last_active: 99, source: 'telegram', title: 'Chat with Lan' }),
      session({ id: 'sl', last_active: 98, source: ' Slack ', title: 'Standup' })
    ])

    renderSessions()

    expect(screen.getByText('Draft the brief')).toBeTruthy()
    expect(screen.queryByText('Chat with Lan')).toBeNull()
    expect(screen.queryByText('Standup')).toBeNull()
    // One row, so one set of row actions — none for the platform transcripts.
    expect(screen.getAllByRole('button', { name: 'Pin session' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Delete session' })).toHaveLength(1)
  })

  it('does not surface them through the search either', async () => {
    $sessions.set([
      session({ id: 'local', last_active: 10, title: 'Draft the brief' }),
      session({ id: 'tg', last_active: 99, source: 'telegram', title: 'Chat with Lan' })
    ])

    renderSessions()

    fireEvent.change(screen.getByPlaceholderText('Search sessions, views, and actions'), {
      target: { value: 'Lan' }
    })

    expect(await screen.findByText('No matching results found.')).toBeTruthy()
    expect(screen.queryByText('Chat with Lan')).toBeNull()
  })

  it('reads as empty when the only cached rows are platform transcripts', () => {
    $sessions.set([session({ id: 'tg', last_active: 99, source: 'telegram', title: 'Chat with Lan' })])

    renderSessions()

    expect(screen.getByText('No sessions yet.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Pin session' })).toBeNull()
  })

  it('still lists local chats, newest first', async () => {
    $sessions.set([
      session({ id: 'older', last_active: 10, title: 'Older chat' }),
      session({ id: 'newer', last_active: 50, source: 'cli', title: 'Newer chat' })
    ])

    renderSessions()

    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2))
    expect(screen.getAllByRole('listitem').map(item => item.textContent)).toEqual([
      expect.stringContaining('Newer chat'),
      expect.stringContaining('Older chat')
    ])
  })
})
