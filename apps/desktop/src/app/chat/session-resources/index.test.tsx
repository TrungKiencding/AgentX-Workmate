import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { atom, computed } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { onComposerInsertRequest } from '@/app/chat/composer/focus'
import { PRIMARY_SESSION_VIEW, type SessionView, SessionViewProvider } from '@/app/chat/session-view'
import type { ChatMessage } from '@/lib/chat-messages'
import type * as LocalPreview from '@/lib/local-preview'
import { localPreviewTarget, normalizeOrLocalPreviewTarget } from '@/lib/local-preview'
import { $repoStatusByCwd, _resetCodingStatusForTests } from '@/store/coding-status'
import { $previewTabs, closeRightRail } from '@/store/preview'
import { $activeGatewayProfile } from '@/store/profile'

import { $sessionResourcesPinned, setSessionResourcesPinned } from './store'

import { SessionWorkspace } from './index'

vi.mock('@/lib/local-preview', async importOriginal => ({
  ...(await importOriginal<typeof LocalPreview>()),
  normalizeOrLocalPreviewTarget: vi.fn(async (path: string, cwd: string) => localPreviewTarget(path, cwd))
}))

const reply = (path: string): ChatMessage => ({
  id: path,
  role: 'assistant',
  parts: [],
  createdFiles: [{ name: path.split('/').pop() || path, path }]
})

const $messages = atom<ChatMessage[]>([])
const $runtimeId = atom<string | null>('runtime-a')
const $storedId = atom<string | null>('stored-a')

const view: SessionView = {
  ...PRIMARY_SESSION_VIEW,
  $messages,
  $runtimeId,
  $storedId,
  $cwd: atom('/work'),
  $messagesEmpty: computed($messages, messages => messages.length === 0)
}

function mount(onAddSource = vi.fn(), canCompose = true) {
  return render(
    <SessionViewProvider value={view}>
      <SessionWorkspace canCompose={canCompose} enabled onAddSource={onAddSource}>
        <div data-testid="composer">Composer remains mounted</div>
      </SessionWorkspace>
    </SessionViewProvider>
  )
}

// jsdom lays nothing out: give the chat a width, and a ResizeObserver the test
// fires by hand, so the docked/floating decision runs for real.
let chatWidth = 0
let resizeObservers: Array<() => void> = []

const resizeChat = (width: number) => {
  chatWidth = width
  act(() => resizeObservers.forEach(notify => notify()))
}

const widthDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth')!

/** Stand in for the desktop bridge's file stat for one test. */
function withFileStat(stat: { exists: boolean; isFile: boolean }) {
  const previousBridge = window.agentxDesktop

  Object.defineProperty(window, 'agentxDesktop', {
    configurable: true,
    writable: true,
    value: { statPath: async () => ({ byteSize: 0, mimeType: '', modifiedMs: 0, ...stat }) }
  })

  return () =>
    Object.defineProperty(window, 'agentxDesktop', { configurable: true, writable: true, value: previousBridge })
}

const dock = () => screen.getByTestId('session-resources')

beforeEach(() => {
  $messages.set([reply('/work/report.pdf')])
  $runtimeId.set('runtime-a')
  $storedId.set('stored-a')
  closeRightRail()
  setSessionResourcesPinned(true)
  vi.mocked(normalizeOrLocalPreviewTarget).mockImplementation(async (path, cwd) => localPreviewTarget(path, cwd))
  chatWidth = 0
  resizeObservers = []
  Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get: () => chatWidth })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private readonly notify: () => void

      constructor(callback: ResizeObserverCallback) {
        this.notify = () => callback([], this as unknown as ResizeObserver)
      }

      observe() {
        resizeObservers.push(this.notify)
      }

      disconnect() {
        resizeObservers = resizeObservers.filter(notify => notify !== this.notify)
      }

      unobserve() {}
    }
  )
})
afterEach(() => {
  cleanup()
  closeRightRail()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  Object.defineProperty(Element.prototype, 'clientWidth', widthDescriptor)
})

describe('session resources interactions', () => {
  it('clears the previous session inventory and repo summary for a new draft in the same folder', async () => {
    const previousBridge = window.agentxDesktop

    const status = {
      branch: 'develop',
      defaultBranch: 'main',
      detached: false,
      ahead: 0,
      behind: 0,
      staged: 0,
      unstaged: 1,
      untracked: 0,
      conflicted: 0,
      changed: 1,
      added: 6,
      removed: 6,
      files: []
    }

    Object.defineProperty(window, 'agentxDesktop', {
      configurable: true,
      writable: true,
      value: { git: { repoStatus: async () => status } }
    })

    try {
      $repoStatusByCwd.set({ '/work': status })
      $messages.set([
        { ...reply('/work/report.pdf'), parts: [{ type: 'text', text: '[Old source](https://example.com/old)' }] }
      ])
      mount()
      expect(within(dock()).getByRole('button', { name: /Changes/ })).toBeTruthy()
      expect(within(dock()).getByText('Old source')).toBeTruthy()

      // New Chat keeps the chosen folder. Even a late old-message update must
      // not give the identity-less draft the previous conversation's resources.
      act(() => {
        $storedId.set(null)
        $runtimeId.set(null)
      })
      expect(screen.queryByTestId('session-resources')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Session resources' })).toBeNull()
      act(() => {
        $repoStatusByCwd.set({ '/work': { ...status, added: 12 } })
        $messages.set([reply('/work/late-old-output.pdf')])
      })
      expect(screen.queryByTestId('session-resources')).toBeNull()

      // Background cache remains intact; returning to the old conversation
      // restores its own inventory instead of destroying it to clear the draft.
      act(() => {
        $messages.set([reply('/work/report.pdf')])
        $runtimeId.set('runtime-a')
        $storedId.set('stored-a')
      })
      await waitFor(() => expect(within(dock()).getByText('report.pdf')).toBeTruthy())
      expect(within(dock()).getByRole('button', { name: /Changes/ })).toBeTruthy()
    } finally {
      cleanup()
      _resetCodingStatusForTests()
      Object.defineProperty(window, 'agentxDesktop', { configurable: true, writable: true, value: previousBridge })
    }
  })
  it('opens an inline image without probing a nonexistent filesystem path', async () => {
    const dataUrl = `data:image/png;base64,${'A'.repeat(128)}`
    $messages.set([{ id: 'image', role: 'assistant', parts: [{ type: 'image', image: dataUrl }] }])
    mount()
    fireEvent.click(within(dock()).getByRole('button', { name: /image.png/ }))
    await waitFor(() => expect($previewTabs.get()[0]?.target).toMatchObject({ dataUrl, previewKind: 'image' }))
    expect(normalizeOrLocalPreviewTarget).not.toHaveBeenCalled()
  })
  it('opens a file using the existing preview pipeline and keeps the conversation mounted', async () => {
    mount()
    const composer = screen.getByTestId('composer')
    fireEvent.click(within(dock()).getByRole('button', { name: /report.pdf/ }))
    await waitFor(() =>
      expect($previewTabs.get()[0]?.target).toMatchObject({ path: '/work/report.pdf', previewKind: 'pdf' })
    )
    expect(screen.getByTestId('composer')).toBe(composer)
  })

  it('lists every resource without extra search chrome and resets on session switch', async () => {
    mount()
    act(() => $messages.set(Array.from({ length: 30 }, (_, i) => reply(`/work/report-${i}.zip`))))
    // A long history is read in short passes; the list fills in.
    await waitFor(() => expect(within(dock()).getAllByRole('listitem')).toHaveLength(30))
    expect(within(dock()).queryByRole('searchbox')).toBeNull()
    act(() => {
      $storedId.set('stored-b')
      $runtimeId.set('runtime-b')
      $messages.set([reply('/work/other.docx')])
    })
    expect(within(dock()).queryByText('report-29.zip')).toBeNull()
    expect(within(dock()).getByText('other.docx')).toBeTruthy()
    expect(within(dock()).queryByRole('searchbox')).toBeNull()
  })

  it.each(['session', 'profile', 'unmount'] as const)('ignores a stale file probe after %s changes', async kind => {
    let finish!: (value: ReturnType<typeof localPreviewTarget>) => void
    vi.mocked(normalizeOrLocalPreviewTarget).mockReturnValueOnce(
      new Promise(resolve => {
        finish = resolve
      })
    )
    const mounted = mount()
    fireEvent.click(within(dock()).getByRole('button', { name: /report.pdf/ }))
    const profile = $activeGatewayProfile.get()

    if (kind === 'session') {
      act(() => {
        $storedId.set('stored-b')
        $runtimeId.set('runtime-b')
        $messages.set([])
      })
    }

    if (kind === 'profile') {
      act(() => $activeGatewayProfile.set('other-profile'))
    }

    if (kind === 'unmount') {
      mounted.unmount()
    }

    await act(async () => finish(localPreviewTarget('/work/report.pdf')))
    expect($previewTabs.get()).toEqual([])
    act(() => $activeGatewayProfile.set(profile))
  })

  it('surfaces an opening error next to its row and allows retry', async () => {
    vi.mocked(normalizeOrLocalPreviewTarget).mockRejectedValueOnce(new Error('unavailable'))
    mount()
    fireEvent.click(within(dock()).getByRole('button', { name: /report.pdf/ }))
    await waitFor(() => expect(within(dock()).getByRole('alert')).toBeTruthy())
    fireEvent.click(within(dock()).getByRole('button', { name: /report.pdf/ }))
    await waitFor(() => expect($previewTabs.get()).toHaveLength(1))
    expect(within(dock()).queryByRole('alert')).toBeNull()
  })

  it('opens by default and hides/reopens directly with the same icon', () => {
    mount()
    const composer = screen.getByTestId('composer')
    const toggle = screen.getByRole('button', { name: 'Session resources' })
    expect(toggle.textContent).toBe('')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(toggle)
    expect(screen.queryByTestId('session-resources')).toBeNull()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(dock()).toBeTruthy()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('composer')).toBe(composer)
    fireEvent.keyDown(dock(), { key: 'Escape' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
  })

  it('does not show a sidebar or reserve space before a session starts', () => {
    $messages.set([])
    $runtimeId.set(null)
    $storedId.set(null)
    mount()
    expect(screen.queryByTestId('session-resources')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Session resources' })).toBeNull()
    expect(screen.getByTestId('composer').closest('[data-resources]')?.getAttribute('data-resources')).toBe('false')
    act(() => {
      $runtimeId.set('first-runtime')
      $storedId.set('first-session')
    })
    // Allocating an empty backend session alone is still not a started chat.
    expect(screen.queryByTestId('session-resources')).toBeNull()
    act(() => $messages.set([{ id: 'first-prompt', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }]))
    expect(dock()).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Session resources' }).getAttribute('aria-expanded')).toBe('true')
  })

  it('remembers a closed card through streaming and into the next conversation', () => {
    mount()
    const toggle = screen.getByRole('button', { name: 'Session resources' })
    fireEvent.click(toggle)
    expect($sessionResourcesPinned.get()).toBe(false)
    act(() => $messages.set([{ ...reply('/work/report.pdf'), pending: true }]))
    expect(screen.queryByTestId('session-resources')).toBeNull()
    act(() => {
      $storedId.set('next-session')
      $runtimeId.set('next-runtime')
      $messages.set([reply('/work/new-session.pdf')])
    })
    // Closing it is a choice about the card, not about one conversation.
    expect(screen.queryByTestId('session-resources')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Session resources' }))
    expect(within(dock()).getByText('new-session.pdf')).toBeTruthy()
    expect($sessionResourcesPinned.get()).toBe(true)
  })

  it('floats closed in a narrow chat, opens on request, and steps aside when the conversation is touched', async () => {
    const mounted = mount()
    const workspace = mounted.container.querySelector('.session-workspace')!
    expect(workspace.getAttribute('data-layout')).toBe('docked')
    expect(dock()).toBeTruthy()

    // A viewer opens beside the chat: the card no longer has a column.
    resizeChat(680)
    expect(workspace.getAttribute('data-layout')).toBe('floating')
    expect(screen.queryByTestId('session-resources')).toBeNull()
    const toggle = screen.getByRole('button', { name: 'Session resources' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(toggle)
    expect(dock()).toBeTruthy()
    // Opening a file keeps the list in reach for the next one…
    fireEvent.click(within(dock()).getByRole('button', { name: /report.pdf/ }))
    await waitFor(() => expect($previewTabs.get()).toHaveLength(1))
    expect(dock()).toBeTruthy()
    // …and going back to the conversation puts it away.
    fireEvent.pointerDown(screen.getByTestId('composer'))
    expect(screen.queryByTestId('session-resources')).toBeNull()
    // None of this touched the remembered choice for the docked card.
    expect($sessionResourcesPinned.get()).toBe(true)

    resizeChat(1200)
    expect(workspace.getAttribute('data-layout')).toBe('docked')
    expect(dock()).toBeTruthy()

    // Back to narrow: closed again, whatever it was the last time.
    resizeChat(680)
    fireEvent.click(screen.getByRole('button', { name: 'Session resources' }))
    resizeChat(1200)
    resizeChat(680)
    expect(screen.queryByTestId('session-resources')).toBeNull()
  })

  it('says in the row that a file is gone instead of opening a viewer on it', async () => {
    const restore = withFileStat({ exists: false, isFile: false })

    try {
      mount()
      fireEvent.click(within(dock()).getByRole('button', { name: /report.pdf/ }))
      await waitFor(() => expect(within(dock()).getByRole('alert').textContent).toBe('The file was moved or deleted.'))
      expect($previewTabs.get()).toEqual([])
    } finally {
      restore()
    }
  })

  it('does not open a folder as if it were a file', async () => {
    const restore = withFileStat({ exists: true, isFile: false })

    try {
      mount()
      fireEvent.click(within(dock()).getByRole('button', { name: /report.pdf/ }))
      await waitFor(() =>
        expect(within(dock()).getByRole('alert').textContent).toBe('Could not open this item. Select it to retry.')
      )
      expect($previewTabs.get()).toEqual([])
    } finally {
      restore()
    }
  })

  it('offers no way to create an output where there is no composer to write into', () => {
    $messages.set([{ id: 'hello', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }])
    mount(undefined, false)
    expect(within(dock()).queryByRole('button', { name: 'Create an output' })).toBeNull()
    expect(within(dock()).queryByRole('button', { name: 'Add a source' })).toBeTruthy()
  })

  it('labels an output by its extension and leaves a clean folder without a Changes row', async () => {
    $repoStatusByCwd.set({
      '/work': {
        branch: 'main',
        defaultBranch: 'main',
        detached: false,
        ahead: 0,
        behind: 0,
        staged: 0,
        unstaged: 0,
        untracked: 0,
        conflicted: 0,
        changed: 0,
        added: 0,
        removed: 0,
        files: []
      }
    })

    try {
      $messages.set([reply('/work/Báo cáo.docx'), reply('/work/Slides.pptx'), reply('/work/data.parquet')])
      mount()
      expect(within(dock()).queryByRole('button', { name: /Changes/ })).toBeNull()
      await waitFor(() =>
        expect([...dock().querySelectorAll('.session-resource-type')].map(node => node.textContent)).toEqual([
          'PPTX',
          'DOCX'
        ])
      )
    } finally {
      _resetCodingStatusForTests()
    }
  })

  it('uses the existing source picker and scoped composer for the add buttons', async () => {
    const onAddSource = vi.fn()
    const inserted = vi.fn()
    const unsubscribe = onComposerInsertRequest(inserted)

    try {
      mount(onAddSource)
      fireEvent.click(within(dock()).getByRole('button', { name: 'Add a source' }))
      expect(onAddSource).toHaveBeenCalledOnce()
      fireEvent.click(within(dock()).getByRole('button', { name: 'Create an output' }))
      // A whole request, not the button's own label — and only once however
      // often the button is pressed.
      await waitFor(() =>
        expect(inserted).toHaveBeenCalledWith({
          mode: 'block',
          once: true,
          target: 'main',
          text: 'Put the result of this conversation into a document file.'
        })
      )
    } finally {
      unsubscribe()
    }
  })
})
