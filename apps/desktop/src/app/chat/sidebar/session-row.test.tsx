import { cleanup, render, screen, within } from '@testing-library/react'
import { atom } from 'nanostores'
import type * as React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SessionInfo } from '@/hermes'
import type * as ComposerStatusStore from '@/store/composer-status'
import type * as SessionStore from '@/store/session'
import type * as SessionStatesStore from '@/store/session-states'
import type * as WindowsStore from '@/store/windows'

import { SidebarSessionRow } from './session-row'

afterEach(cleanup)

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      sidebar: {
        row: {
          ageMin: 'm',
          ageNow: 'now',
          backgroundRunning: 'Running in background',
          finishedUnread: 'Finished',
          handoffOrigin: (platform: string) => `Started on ${platform}`,
          needsInput: 'Needs input',
          sessionActions: 'Session actions',
          sessionRunning: 'Running',
          waitingForAnswer: 'Waiting for answer'
        }
      }
    }
  })
}))

vi.mock('@/app/chat/profile-tag', () => ({ ProfileTag: () => null }))
vi.mock('@/app/chat/session-drag', () => ({ startSessionDrag: vi.fn() }))
// PlatformAvatar is intentionally NOT mocked (do not reintroduce this — see
// #67500, Gille's third pass): it's a forwardRef component that spreads its
// props onto the rendered span, and mocking it with a stand-in that spreads
// props itself only proves the MOCK forwards them, not that the real
// component does. This file exercises the actual production component so a
// regression in its ref/prop forwarding fails here again.
vi.mock('@/lib/chat-runtime', () => ({ sessionTitle: (s: SessionInfo) => (s as unknown as { title: string }).title }))
vi.mock('@/lib/haptics', () => ({ triggerHaptic: vi.fn() }))
vi.mock('@/lib/session-source', () => ({
  handoffOriginSource: (state?: string, platform?: string) => (state && platform ? platform : null),
  isMessagingSource: (source?: string) => source === 'telegram',
  normalizeSessionSource: (source?: string) => source || null,
  sessionSourceLabel: (source: string) => source
}))
vi.mock('@/lib/time', () => ({ coarseElapsed: () => ({ unit: 'minute' as const, value: 5 }) }))

// These mocks use importOriginal rather than replacing the module wholesale:
// session-row.tsx (and its transitive imports, e.g. session-color.ts) reads
// several store exports beyond the ones this file cares about, and that set
// keeps growing as the app evolves upstream. A wholesale replacement mock
// silently turns every export it doesn't list into `undefined`, which then
// crashes nanostores' `computed()` the moment a new dependency is added
// upstream (as happened twice already: $stalledSessionIds, then $sessions).
// Overriding only the named atoms we actually control keeps this test
// resilient to that drift.
vi.mock('@/store/composer-status', async importOriginal => {
  const actual = await importOriginal<typeof ComposerStatusStore>()

  return { ...actual, $backgroundRunningSessionIds: atom<string[]>([]) }
})
vi.mock('@/store/session', async importOriginal => {
  const actual = await importOriginal<typeof SessionStore>()

  return { ...actual, $unreadFinishedSessionIds: atom<string[]>([]) }
})
vi.mock('@/store/session-states', async importOriginal => {
  const actual = await importOriginal<typeof SessionStatesStore>()

  return {
    ...actual,
    $attentionSessionIds: atom<string[]>([]),
    $stalledSessionIds: atom<string[]>([]),
    openSessionTile: vi.fn()
  }
})
vi.mock('@/store/windows', async importOriginal => {
  const actual = await importOriginal<typeof WindowsStore>()

  return {
    ...actual,
    canOpenSessionWindow: () => false,
    openSessionInNewWindow: vi.fn()
  }
})

// SessionActionsMenu open behavior is covered in session-actions-menu.test.tsx
// against the real component. Stub it here so this file stays focused on the
// row chrome (handoff avatar tip, etc.). Each stub wraps its children in its
// own test id and records its props, so a platform transcript that fell back
// to the full menus (or lost its Unpin wiring) fails here instead of passing
// through an identical stand-in.
const menuProps = vi.hoisted(() => new Map<string, Record<string, unknown>>())

afterEach(() => menuProps.clear())

vi.mock('./session-actions-menu', () => {
  const stub =
    (testId: string) =>
    ({ children, ...props }: { children: React.ReactNode } & Record<string, unknown>) => {
      menuProps.set(testId, props)

      return <div data-testid={testId}>{children}</div>
    }

  return {
    MessagingSessionActionsMenu: stub('messaging-actions-menu'),
    MessagingSessionContextMenu: stub('messaging-context-menu'),
    SessionActionsMenu: stub('session-actions-menu'),
    SessionContextMenu: stub('session-context-menu')
  }
})

vi.mock('./use-profile-prewarm', () => ({
  useProfilePrewarm: () => ({ cancelPrewarm: vi.fn(), startPrewarm: vi.fn() })
}))

function makeSession(overrides: Partial<SessionInfo> & { title: string }): SessionInfo {
  return {
    handoff_platform: null,
    handoff_state: null,
    id: 's1',
    last_active: 0,
    profile: 'default',
    started_at: 0,
    ...overrides
  } as unknown as SessionInfo
}

const tipTrigger = (el: HTMLElement) => el.closest('[data-slot="tooltip-trigger"]')

const noop = vi.fn()

describe('SidebarSessionRow', () => {
  it('keeps an aria-label on the kebab without wrapping it in a Tip', () => {
    render(
      <SidebarSessionRow
        isPinned={false}
        isSelected={false}
        isWorking={false}
        onArchive={noop}
        onDelete={noop}
        onPin={noop}
        onResume={noop}
        session={makeSession({ title: 'AgentX doctor health check results' })}
      />
    )

    const kebab = screen.getByRole('button', { name: 'Session actions' })
    expect(tipTrigger(kebab)).toBeNull()
  })

  it('does not render a handoff avatar for a locally-started session', () => {
    const { container } = render(
      <SidebarSessionRow
        isPinned={false}
        isSelected={false}
        isWorking={false}
        onArchive={noop}
        onDelete={noop}
        onPin={noop}
        onResume={noop}
        session={makeSession({ title: 'Local session' })}
      />
    )

    // PlatformAvatar's span is the only aria-hidden SPAN this row ever
    // renders (idle dot / arc-border / branch-stem are all inactive here) —
    // Codicon icons (e.g. the kebab trigger) are also aria-hidden but render
    // as <i>, not <span>, so this selector doesn't accidentally match them.
    expect(container.querySelector('span[aria-hidden="true"]')).toBeNull()
  })

  it('wraps the handoff platform avatar in a Tip for a session started on another platform', () => {
    const { container } = render(
      <SidebarSessionRow
        isPinned={false}
        isSelected={false}
        isWorking={false}
        onArchive={noop}
        onDelete={noop}
        onPin={noop}
        onResume={noop}
        session={makeSession({
          handoff_platform: 'telegram',
          handoff_state: 'active',
          title: 'Continued from Telegram'
        })}
      />
    )

    // PlatformAvatar is the REAL component here (see the note above the vi.mock
    // block, #67500 third pass) — it renders the Telegram brand SVG rather
    // than the platform name as text, so query the avatar span itself (the
    // row's only aria-hidden span in this state) rather than text content,
    // and confirm its tooltip trigger actually attaches to it — proving the
    // real forwardRef/...rest path works, not a mock that fakes it.
    const avatar = container.querySelector('span[aria-hidden="true"]')
    expect(avatar).toBeTruthy()
    expect(tipTrigger(avatar as HTMLElement)).toBeTruthy()
  })

  it('shows the source avatar on a direct messaging conversation', () => {
    const { container } = render(
      <SidebarSessionRow
        isPinned={false}
        isSelected={false}
        isWorking={false}
        onArchive={noop}
        onDelete={noop}
        onPin={noop}
        onResume={noop}
        session={makeSession({ source: 'telegram', title: 'Telegram conversation' })}
      />
    )

    expect(container.querySelector('span[aria-hidden="true"]')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Session actions' })).toBeTruthy()
  })

  it('gives a platform transcript only the read-only menus', () => {
    const onDelete = vi.fn()
    const onPin = vi.fn()

    render(
      <SidebarSessionRow
        isPinned={false}
        isSelected={false}
        isWorking={false}
        onArchive={noop}
        onDelete={onDelete}
        onPin={onPin}
        onResume={noop}
        session={makeSession({ source: 'telegram', title: 'Telegram conversation' })}
      />
    )

    const kebabMenu = screen.getByTestId('messaging-actions-menu')

    expect(within(kebabMenu).getByRole('button', { name: 'Session actions' })).toBeTruthy()
    expect(screen.getByTestId('messaging-context-menu')).toBeTruthy()
    expect(screen.queryByTestId('session-actions-menu')).toBeNull()
    expect(screen.queryByTestId('session-context-menu')).toBeNull()

    for (const menu of ['messaging-actions-menu', 'messaging-context-menu']) {
      expect(menuProps.get(menu)?.onDelete).toBe(onDelete)
      // Unpin only belongs on a row that is actually pinned.
      expect(menuProps.get(menu)?.onUnpin).toBeUndefined()
    }
  })

  it('lets a pinned platform transcript undo its pin from both menus', () => {
    const onPin = vi.fn()

    render(
      <SidebarSessionRow
        isPinned
        isSelected={false}
        isWorking={false}
        onArchive={noop}
        onDelete={noop}
        onPin={onPin}
        onResume={noop}
        session={makeSession({ source: 'telegram', title: 'Pinned Telegram conversation' })}
      />
    )

    expect(menuProps.get('messaging-actions-menu')?.onUnpin).toBe(onPin)
    expect(menuProps.get('messaging-context-menu')?.onUnpin).toBe(onPin)
  })

  it('gives a local chat the full session menus', () => {
    render(
      <SidebarSessionRow
        isPinned={false}
        isSelected={false}
        isWorking={false}
        onArchive={noop}
        onDelete={noop}
        onPin={noop}
        onResume={noop}
        session={makeSession({ source: 'desktop', title: 'Desktop chat' })}
      />
    )

    const kebabMenu = screen.getByTestId('session-actions-menu')

    expect(within(kebabMenu).getByRole('button', { name: 'Session actions' })).toBeTruthy()
    expect(screen.getByTestId('session-context-menu')).toBeTruthy()
    expect(screen.queryByTestId('messaging-actions-menu')).toBeNull()
    expect(screen.queryByTestId('messaging-context-menu')).toBeNull()
  })

  it('keeps the hover age label on one line', () => {
    // The label lives in the 24px actions column; without nowrap a spelled-out
    // unit ("47 phút") broke at its space and stacked "47" over "phút".
    render(
      <SidebarSessionRow
        isPinned={false}
        isSelected={false}
        isWorking={false}
        onArchive={noop}
        onDelete={noop}
        onPin={noop}
        onResume={noop}
        session={makeSession({ title: 'Weekly report' })}
      />
    )

    expect(screen.getByText('5m').className).toContain('whitespace-nowrap')
  })
})
