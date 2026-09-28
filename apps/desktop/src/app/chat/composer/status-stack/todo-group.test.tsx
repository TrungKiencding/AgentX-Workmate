import { act, cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import type { TodoItem } from '@/lib/todos'
import { resetThreadScroll, setThreadAtBottom } from '@/store/thread-scroll'
import { clearSessionTodos, setSessionTodos } from '@/store/todos'

import { ComposerStatusStack } from './index'

// The stack measures itself into a surface var — jsdom has no ResizeObserver.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.stubGlobal('ResizeObserver', ResizeObserverStub)

const SID = 'sess-todo-1'

const plan: TodoItem[] = [
  { content: 'Shrink the CTA', id: '1', status: 'completed' },
  { content: 'Drop the nav item', id: '2', status: 'in_progress' },
  { content: 'Scroll spy', id: '3', status: 'pending' }
]

function renderStack() {
  return render(
    <MemoryRouter>
      <I18nProvider configClient={null} initialLocale="en">
        <ComposerStatusStack queue={null} sessionId={SID} />
      </I18nProvider>
    </MemoryRouter>
  )
}

// The card is the stack's one child: everything above the composer lives in it.
const statusCard = (container: HTMLElement) => container.firstElementChild?.firstElementChild as HTMLElement

describe('ComposerStatusStack todo group', () => {
  beforeEach(() => {
    resetThreadScroll()
    clearSessionTodos(SID)
  })

  afterEach(() => {
    cleanup()
    resetThreadScroll()
    clearSessionTodos(SID)
  })

  it('counts finished items and shows every description', () => {
    setSessionTodos(SID, plan)

    renderStack()

    expect(screen.getByText('Tasks 1/3')).toBeTruthy()

    for (const item of plan) {
      expect(screen.getByText(item.content)).toBeTruthy()
    }
  })

  it('stays solid while the thread is scrolled up', () => {
    setSessionTodos(SID, plan)

    const { container } = renderStack()
    const atBottom = statusCard(container).className

    act(() => setThreadAtBottom(false))

    const scrolledUp = statusCard(container).className

    expect(scrolledUp).toBe(atBottom)
    expect(scrolledUp).not.toMatch(/(^|\s)opacity-/)
  })
})
