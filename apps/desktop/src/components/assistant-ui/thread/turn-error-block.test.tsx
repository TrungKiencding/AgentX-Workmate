import { AssistantRuntimeProvider, type ThreadMessage, useExternalStoreRuntime } from '@assistant-ui/react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FALLBACK_LOCALE, setRuntimeI18nLocale } from '@/i18n'

import { Thread } from '.'

// A failed turn, as AssistantMessage renders it: plain words, "Try again" only
// where it helps (and only on the latest turn), the raw text folded with its
// code under "Error details", and the dismiss control kept.

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', TestResizeObserver)
vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
  window.setTimeout(() => callback(performance.now()), 0)
)
vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
vi.stubGlobal('CSS', { escape: (str: string) => str })

Element.prototype.scrollTo = function scrollTo() {}

const createdAt = new Date('2026-11-01T00:00:00.000Z')

afterEach(() => {
  cleanup()
  setRuntimeI18nLocale(FALLBACK_LOCALE)
})

function userMessage(id = 'user-1'): ThreadMessage {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text: 'question' }],
    attachments: [],
    createdAt,
    metadata: { custom: {} }
  } as ThreadMessage
}

function failedMessage(error: string, errorCode?: string, id = 'assistant-error-1'): ThreadMessage {
  return {
    id,
    role: 'assistant',
    content: [],
    status: { type: 'incomplete', reason: 'error', error },
    createdAt,
    metadata: {
      unstable_state: null,
      unstable_annotations: [],
      unstable_data: [],
      steps: [],
      custom: errorCode ? { errorCode } : {}
    }
  } as ThreadMessage
}

function answer(id: string): ThreadMessage {
  return {
    id,
    role: 'assistant',
    content: [{ type: 'text', text: 'later answer' }],
    status: { type: 'complete', reason: 'stop' },
    createdAt,
    metadata: { unstable_state: null, unstable_annotations: [], unstable_data: [], steps: [], custom: {} }
  } as ThreadMessage
}

function Harness({
  messages,
  onDismissError,
  onReload,
  readOnly = false
}: {
  messages: ThreadMessage[]
  onDismissError?: (messageId: string) => void
  onReload?: (parentId: null | string) => Promise<void>
  readOnly?: boolean
}) {
  const runtime = useExternalStoreRuntime<ThreadMessage>({
    messages,
    isRunning: false,
    onNew: async () => {},
    ...(onReload ? { onReload } : {})
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread onDismissError={onDismissError} readOnly={readOnly} />
    </AssistantRuntimeProvider>
  )
}

const RATE_LIMIT_RAW =
  'API call failed after 3 retries: HTTP 429: {"error":{"message":"Rate limit reached"}} Retry-After: 20'

describe('TurnErrorBlock', () => {
  it('says what happened in plain words, and folds the raw text with its code', () => {
    render(<Harness messages={[userMessage(), failedMessage(RATE_LIMIT_RAW, 'rate_limited')]} />)

    const alert = screen.getByRole('alert')
    expect(within(alert).getByText('Too many requests right now')).toBeTruthy()
    expect(
      within(alert).getByText('Requests are arriving faster than allowed. Try again in about 20 seconds.')
    ).toBeTruthy()
    expect(alert.textContent).not.toContain('HTTP 429')
    expect(alert.getAttribute('data-error-code')).toBe('rate_limited')

    const toggle = within(alert).getByRole('button', { name: 'Error details' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)

    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(alert.textContent).toContain('Error code: rate_limited')
    expect(alert.textContent).toContain(RATE_LIMIT_RAW)
    expect(within(alert).getByRole('button', { name: 'Copy error details' })).toBeTruthy()

    fireEvent.click(toggle)
    expect(alert.textContent).not.toContain('Error code: rate_limited')
  })

  it('retries through the thread’s own regenerate when retrying can help', async () => {
    const onReload = vi.fn(async () => undefined)
    render(
      <Harness messages={[userMessage(), failedMessage('Connection error.', 'network_error')]} onReload={onReload} />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    await waitFor(() => expect(onReload).toHaveBeenCalledTimes(1))
    expect(onReload).toHaveBeenCalledWith('user-1', expect.anything())
  })

  it.each([
    'quota_exceeded',
    'auth_failed',
    'model_unavailable',
    'context_too_long',
    'content_filtered',
    'license_expired'
  ])('offers no retry for %s, where sending it again cannot help', code => {
    render(<Harness messages={[userMessage(), failedMessage('raw', code)]} onReload={vi.fn(async () => undefined)} />)

    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it('offers no retry on an older failed turn, which would discard the turns after it', () => {
    render(
      <Harness
        messages={[
          userMessage(),
          failedMessage('Connection error.', 'network_error'),
          userMessage('user-2'),
          answer('a-2')
        ]}
        onReload={vi.fn(async () => undefined)}
      />
    )

    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it('offers no retry in a read-only transcript', () => {
    render(
      <Harness
        messages={[userMessage(), failedMessage('Connection error.', 'network_error')]}
        onReload={vi.fn(async () => undefined)}
        readOnly
      />
    )

    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it('keeps the dismiss control', () => {
    const onDismissError = vi.fn()
    render(<Harness messages={[userMessage(), failedMessage('x', 'timeout')]} onDismissError={onDismissError} />)

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss error' }))

    expect(onDismissError).toHaveBeenCalledWith('assistant-error-1')
  })

  it('reads the text of a row stored before codes existed', () => {
    render(<Harness messages={[userMessage(), failedMessage('HTTP 503: Service Unavailable')]} />)

    expect(screen.getByText('The model is overloaded')).toBeTruthy()
    expect(screen.getByRole('alert').getAttribute('data-error-code')).toBe('overloaded')
  })

  it('speaks the chosen language', () => {
    setRuntimeI18nLocale('vi')
    render(
      <Harness
        messages={[userMessage(), failedMessage(RATE_LIMIT_RAW, 'rate_limited')]}
        onReload={vi.fn(async () => undefined)}
      />
    )

    const alert = screen.getByRole('alert')
    expect(within(alert).getByText('Đang có quá nhiều yêu cầu')).toBeTruthy()
    expect(
      within(alert).getByText('Yêu cầu đang được gửi nhanh hơn mức cho phép. Thử lại sau khoảng 20 giây.')
    ).toBeTruthy()
    expect(within(alert).getByRole('button', { name: 'Thử lại' })).toBeTruthy()

    fireEvent.click(within(alert).getByRole('button', { name: 'Chi tiết lỗi' }))
    expect(alert.textContent).toContain('Mã lỗi: rate_limited')
  })
})
