import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SessionInfo } from '@/hermes'
import { toSessionRows } from '@/lib/session-date-groups'

import { VirtualSessionList } from './virtual-session-list'

afterEach(cleanup)

// jsdom lays nothing out, so the real virtualizer measures a 0px viewport and
// renders no rows; hand every row through instead.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 28,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ end: (index + 1) * 28, index, start: index * 28 })),
    measureElement: () => undefined
  })
}))

vi.mock('@/i18n', () => ({
  useI18n: () => ({ t: { sidebar: { dateDivider: {} } } })
}))

vi.mock('./session-row', () => ({
  SidebarSessionRow: ({ isSelected, session }: { isSelected: boolean; session: SessionInfo }) => (
    <div data-selected={isSelected} data-testid={`session-row-${session.id}`}>
      {session.id}
    </div>
  )
}))

const session = (id: string, over: Partial<SessionInfo> = {}): SessionInfo =>
  ({ id, last_active: 1, profile: 'default', started_at: 1, ...over }) as SessionInfo

const noop = () => {}

describe('VirtualSessionList active row', () => {
  it('highlights a compressed row while one of its middle segments is selected', () => {
    // A platform chat opened as mid-M keeps that id after the gateway compresses
    // it again; the listed row is the tip, whose chain still names mid-M.
    const tip = session('tip-T', { _lineage_ids: ['root-R', 'mid-M', 'tip-T'], _lineage_root_id: 'root-R' })

    render(
      <VirtualSessionList
        activeSessionId="mid-M"
        onArchiveSession={noop}
        onDeleteSession={noop}
        onResumeSession={noop}
        onTogglePin={noop}
        pinned={false}
        rows={toSessionRows([{ session: tip }, { session: session('other') }])}
        sortable={false}
        workingSessionIdSet={new Set()}
      />
    )

    expect(screen.getByTestId('session-row-tip-T').dataset.selected).toBe('true')
    expect(screen.getByTestId('session-row-other').dataset.selected).toBe('false')
  })
})
