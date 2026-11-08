import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { assistantTextPart, type ChatMessage } from '@/lib/chat-messages'
import type * as ModelOptions from '@/lib/model-options'
import {
  $activeSessionId,
  $awaitingResponse,
  $busy,
  $contextSuggestions,
  $currentCwd,
  $currentModel,
  $currentProvider,
  $freshDraftReady,
  $gatewayState,
  $messages,
  $messagingSessions,
  $selectedStoredSessionId,
  $sessions
} from '@/store/session'

const threadRenderCount = vi.hoisted(() => ({ current: 0 }))
const lastThreadProps = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))

vi.mock('@/components/assistant-ui/thread', async () => {
  const React = await import('react')

  return {
    Thread: (props: Record<string, unknown>) => {
      threadRenderCount.current += 1
      lastThreadProps.current = props

      return React.createElement('div', { 'data-testid': 'thread' })
    }
  }
})

vi.mock('@/components/glyph-field', async () => {
  const React = await import('react')

  return {
    GlyphField: ({ active }: { active: boolean }) =>
      React.createElement('div', { 'data-active': String(active), 'data-testid': 'glyph-field' })
  }
})

vi.mock('@/components/prompt-overlays', () => ({
  PromptOverlays: () => <div data-testid="prompt-overlays" />
}))
vi.mock('@/components/chat/vibe-hearts', () => ({ COMPOSER_HEART_CONFIG: {}, HeartField: () => null }))
vi.mock('@/lib/model-options', async importOriginal => ({
  ...(await importOriginal<typeof ModelOptions>()),
  requestModelOptions: vi.fn(async () => ({ providers: [] }))
}))
vi.mock('./chat-drop-overlay', () => ({ ChatDropOverlay: () => null }))
vi.mock('./chat-swap-overlay', () => ({ ChatSwapOverlay: () => null }))
vi.mock('./composer', () => ({ ChatBar: () => <div data-testid="chat-bar" />, ChatBarFallback: () => null }))
vi.mock('@/components/chat/intro', () => ({
  Intro: ({ children }: { children?: React.ReactNode }) => <div data-testid="home-intro">{children}</div>
}))
vi.mock('./home-workspaces', () => ({ HomeWorkspaces: () => <div data-testid="home-workspaces" /> }))
vi.mock('./hooks/use-file-drop-zone', () => ({
  useFileDropZone: () => ({ dragKind: null, dropHandlers: {} })
}))
vi.mock('./sidebar/session-actions-menu', async () => {
  const React = await import('react')

  return {
    SessionActionsMenu: ({ children }: { children: React.ReactNode }) =>
      React.createElement('div', { 'data-testid': 'session-actions-menu' }, children)
  }
})

const { ChatView } = await import('./index')
const { STARTED_BY_SEND_ROUTE_STATE } = await import('../routes')

function assistantMessage(id: string, text: string): ChatMessage {
  return {
    id,
    parts: [assistantTextPart(text)],
    role: 'assistant'
  }
}

describe('ChatView render isolation', () => {
  beforeEach(() => {
    threadRenderCount.current = 0
    lastThreadProps.current = {}
    $activeSessionId.set('runtime-1')
    $awaitingResponse.set(false)
    $busy.set(false)
    $contextSuggestions.set([])
    $currentCwd.set('/work')
    $currentModel.set('test-model')
    $currentProvider.set('test-provider')
    $freshDraftReady.set(false)
    $gatewayState.set('closed')
    $messages.set([assistantMessage('assistant-1', 'Stable historical answer')])
    $messagingSessions.set([])
    $selectedStoredSessionId.set('stored-1')
    $sessions.set([{ id: 'stored-1', message_count: 1, title: 'Stable chat' } as never])
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    $activeSessionId.set(null)
    $awaitingResponse.set(false)
    $busy.set(false)
    $contextSuggestions.set([])
    $currentCwd.set('')
    $currentModel.set('')
    $currentProvider.set('')
    $freshDraftReady.set(false)
    $gatewayState.set('idle')
    $messages.set([])
    $messagingSessions.set([])
    $selectedStoredSessionId.set(null)
    $sessions.set([])
  })

  it('does not re-render chat history when an unrelated parent idle tick updates', () => {
    const props = {
      gateway: null,
      maxVoiceRecordingSeconds: 120,
      onAddContextRef: vi.fn(),
      onAddUrl: vi.fn(),
      onAttachDroppedItems: vi.fn(),
      onAttachImageBlob: vi.fn(),
      onBranchInNewChat: vi.fn(),
      onCancel: vi.fn(),
      onDeleteSelectedSession: vi.fn(),
      onEdit: vi.fn(),
      onPasteClipboardImage: vi.fn(),
      onPickFiles: vi.fn(),
      onPickFolders: vi.fn(),
      onPickImages: vi.fn(),
      onReload: vi.fn(),
      onRemoveAttachment: vi.fn(),
      onRetryResume: vi.fn(),
      onSteer: vi.fn(),
      onSubmit: vi.fn(),
      onThreadMessagesChange: vi.fn(),
      onToggleSelectedPin: vi.fn(),
      onTranscribeAudio: vi.fn()
    }

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } }
    })

    function ParentTickHarness() {
      const [tick, setTick] = useState(0)

      return (
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/stored-1']}>
            <button onClick={() => setTick(value => value + 1)} type="button">
              parent tick {tick}
            </button>
            <ChatView {...props} />
          </MemoryRouter>
        </QueryClientProvider>
      )
    }

    render(<ParentTickHarness />)

    expect(screen.getByTestId('thread')).toBeTruthy()
    expect(threadRenderCount.current).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: /parent tick/i }))

    // memo(ChatView) with stable props must absorb the parent's idle tick —
    // the transcript (Thread) must not re-render. This is PR #38470's contract.
    expect(threadRenderCount.current).toBe(1)
  })

  it('renders messaging conversations as a branded read-only live transcript', () => {
    $sessions.set([])
    $selectedStoredSessionId.set('telegram-session')
    $activeSessionId.set('telegram-session')
    $messagingSessions.set([
      {
        id: 'telegram-session',
        source: 'telegram',
        title: 'Design review with Linh',
        message_count: 2,
        last_active: 1,
        started_at: 1
      } as never
    ])

    const props = {
      gateway: null,
      onAddContextRef: vi.fn(),
      onAddUrl: vi.fn(),
      onAttachDroppedItems: vi.fn(),
      onAttachImageBlob: vi.fn(),
      onCancel: vi.fn(),
      onDeleteSelectedSession: vi.fn(),
      onEdit: vi.fn(),
      onPasteClipboardImage: vi.fn(),
      onPickFiles: vi.fn(),
      onPickFolders: vi.fn(),
      onPickImages: vi.fn(),
      onReload: vi.fn(),
      onRemoveAttachment: vi.fn(),
      onRetryResume: vi.fn(),
      onSteer: vi.fn(),
      onSubmit: vi.fn(),
      onThreadMessagesChange: vi.fn(),
      onToggleSelectedPin: vi.fn()
    }

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/telegram-session']}>
          <ChatView {...props} />
        </MemoryRouter>
      </QueryClientProvider>
    )

    expect(screen.getByText('Design review with Linh')).toBeTruthy()
    expect(screen.getAllByText('Telegram').length).toBeGreaterThan(0)
    expect(screen.getByTestId('messaging-read-only-bar')).toBeTruthy()
    expect(screen.queryByTestId('chat-bar')).toBeNull()
    expect(screen.queryByTestId('prompt-overlays')).toBeNull()
    expect(lastThreadProps.current.readOnly).toBe(true)
  })

  it('stays read-only when the gateway compressed the transcript past the segment it was opened as', () => {
    // Opened as mid-M, then compressed again by the messaging gateway: the
    // listed row is now tip-T and only its chain still names mid-M. No cached
    // mid-M row is left in $sessions (a tile, or after a list wipe).
    $sessions.set([])
    $selectedStoredSessionId.set('mid-M')
    $activeSessionId.set('rt-telegram')
    $messagingSessions.set([
      {
        _lineage_ids: ['root-R', 'mid-M', 'tip-T'],
        _lineage_root_id: 'root-R',
        id: 'tip-T',
        source: 'telegram',
        title: 'Design review, continued',
        message_count: 4,
        last_active: 2,
        started_at: 1
      } as never
    ])

    const props = {
      gateway: null,
      onAddContextRef: vi.fn(),
      onAddUrl: vi.fn(),
      onAttachDroppedItems: vi.fn(),
      onAttachImageBlob: vi.fn(),
      onCancel: vi.fn(),
      onDeleteSelectedSession: vi.fn(),
      onEdit: vi.fn(),
      onPasteClipboardImage: vi.fn(),
      onPickFiles: vi.fn(),
      onPickFolders: vi.fn(),
      onPickImages: vi.fn(),
      onReload: vi.fn(),
      onRemoveAttachment: vi.fn(),
      onRetryResume: vi.fn(),
      onSteer: vi.fn(),
      onSubmit: vi.fn(),
      onThreadMessagesChange: vi.fn(),
      onToggleSelectedPin: vi.fn()
    }

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/mid-M']}>
          <ChatView {...props} />
        </MemoryRouter>
      </QueryClientProvider>
    )

    expect(screen.getByText('Design review, continued')).toBeTruthy()
    expect(screen.getByTestId('messaging-read-only-bar')).toBeTruthy()
    expect(screen.queryByTestId('chat-bar')).toBeNull()
    expect(screen.queryByTestId('prompt-overlays')).toBeNull()
    expect(lastThreadProps.current.readOnly).toBe(true)
  })

  // The glyph field is the ground of the empty chat — the greeting's surface —
  // and must never sit behind a transcript, where characters compete with text.
  it('arms the glyph field with the greeting, and only there', () => {
    const props = {
      gateway: null,
      onAddContextRef: vi.fn(),
      onAddUrl: vi.fn(),
      onAttachDroppedItems: vi.fn(),
      onAttachImageBlob: vi.fn(),
      onCancel: vi.fn(),
      onDeleteSelectedSession: vi.fn(),
      onEdit: vi.fn(),
      onPasteClipboardImage: vi.fn(),
      onPickFiles: vi.fn(),
      onPickFolders: vi.fn(),
      onPickImages: vi.fn(),
      onReload: vi.fn(),
      onRemoveAttachment: vi.fn(),
      onRetryResume: vi.fn(),
      onSteer: vi.fn(),
      onSubmit: vi.fn(),
      onThreadMessagesChange: vi.fn(),
      onToggleSelectedPin: vi.fn()
    }

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    const renderAt = (path: string) =>
      render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[path]}>
            <ChatView {...props} />
          </MemoryRouter>
        </QueryClientProvider>
      )

    // A conversation with history: no field, no greeting.
    renderAt('/stored-1')

    expect(screen.getByTestId('glyph-field').dataset.active).toBe('false')
    expect(screen.queryByTestId('home-intro')).toBeNull()
    cleanup()

    // The fresh draft: the greeting fronts it, and the field is armed with it.
    $activeSessionId.set(null)
    $selectedStoredSessionId.set(null)
    $messages.set([])
    $freshDraftReady.set(true)
    renderAt('/')

    // The greeting, with the folder card: a fresh draft can still pick its folder.
    expect(screen.getByTestId('glyph-field').dataset.active).toBe('true')
    expect(screen.getByTestId('home-intro')).toBeTruthy()
    expect(screen.getByTestId('home-workspaces')).toBeTruthy()
  })

  // A draft's first send creates its chat and re-homes the route onto it; the
  // new slice is empty for a beat before the optimistic message lands in it.
  // That beat must not read as an empty chat — it flashed the greeting (and
  // bounced the composer back to the centre) under the send.
  it('keeps the greeting off the chat a send just created', () => {
    const props = {
      gateway: null,
      onAddContextRef: vi.fn(),
      onAddUrl: vi.fn(),
      onAttachDroppedItems: vi.fn(),
      onAttachImageBlob: vi.fn(),
      onCancel: vi.fn(),
      onDeleteSelectedSession: vi.fn(),
      onEdit: vi.fn(),
      onPasteClipboardImage: vi.fn(),
      onPickFiles: vi.fn(),
      onPickFolders: vi.fn(),
      onPickImages: vi.fn(),
      onReload: vi.fn(),
      onRemoveAttachment: vi.fn(),
      onRetryResume: vi.fn(),
      onSteer: vi.fn(),
      onSubmit: vi.fn(),
      onThreadMessagesChange: vi.fn(),
      onToggleSelectedPin: vi.fn()
    }

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    $messages.set([])

    const renderAt = (entry: { pathname: string; state?: unknown }) =>
      render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[entry]}>
            <ChatView {...props} />
          </MemoryRouter>
        </QueryClientProvider>
      )

    // A routed chat that really is empty (a new chat in a project): greeted,
    // but its folder is settled — no folder card.
    renderAt({ pathname: '/stored-1' })
    expect(screen.getByTestId('home-intro')).toBeTruthy()
    expect(screen.queryByTestId('home-workspaces')).toBeNull()
    cleanup()

    // The same empty slice, reached by the send's own re-home: not greeted.
    renderAt({ pathname: '/stored-1', state: STARTED_BY_SEND_ROUTE_STATE })
    expect(screen.getByTestId('glyph-field').dataset.active).toBe('false')
    expect(screen.queryByTestId('home-intro')).toBeNull()
  })
})
