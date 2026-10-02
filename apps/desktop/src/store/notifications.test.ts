import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  $notifications,
  clearNotifications,
  closeAllNotifications,
  closeNotification,
  dismissNotification,
  isDiskFullErrorMessage,
  notify,
  notifyError,
  resetNotifications
} from './notifications'

beforeEach(() => {
  resetNotifications()
})

function lastMessage(): string {
  return $notifications.get()[0]?.message ?? ''
}

// Regression for #39365: a gateway auth 401 (bad API_SERVER_KEY) must not be
// summarized as a provider (OpenAI/OpenRouter) API key problem.
test('gateway_auth_failed error is summarized as gateway auth, not provider key', () => {
  notifyError(
    new Error(
      '401 {"error": {"message": "Invalid gateway API key (API_SERVER_KEY)", "type": "gateway_auth_error", "code": "gateway_auth_failed"}}'
    ),
    'Request failed'
  )

  expect(lastMessage()).toContain('API_SERVER_KEY')
  expect(lastMessage()).not.toMatch(/OpenAI/i)
})

test('provider invalid_api_key error still maps to the OpenAI summary', () => {
  notifyError(
    new Error('401 {"error": {"message": "Incorrect API key provided", "code": "invalid_api_key"}}'),
    'Request failed'
  )

  expect(lastMessage()).toMatch(/OpenAI rejected the API key/i)
})

test('disk-full / ENOSPC errors toast a free-space message', () => {
  expect(isDiskFullErrorMessage('OSError: [Errno 28] No space left on device')).toBe(true)
  expect(isDiskFullErrorMessage('sqlite3.OperationalError: database or disk is full')).toBe(true)
  expect(isDiskFullErrorMessage('disk full: session storage could not be written — free some disk space')).toBe(true)
  expect(isDiskFullErrorMessage('This is often a full disk — free some space')).toBe(true)
  expect(isDiskFullErrorMessage('session storage could not be written: permission denied')).toBe(false)
  expect(isDiskFullErrorMessage('network timeout')).toBe(false)

  notifyError(new Error('OSError: [Errno 28] No space left on device: state.db'), 'Prompt failed')

  expect(lastMessage()).toMatch(/Disk full/i)
  expect(lastMessage()).toMatch(/free some space/i)
})

test('session storage write failure is treated as disk-full class', () => {
  notifyError(
    new Error('disk full: session storage could not be written — free some disk space and try again'),
    'Prompt failed'
  )

  expect(lastMessage()).toMatch(/Disk full/i)
})

describe('closing versus withdrawing', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const ids = () => $notifications.get().map(item => item.id)

  test('moving to another chat clears the chat’s notices, keeps the app’s, and closes nothing', () => {
    const closedChat = vi.fn()
    const closedApp = vi.fn()

    notify({ id: 'chat', kind: 'warning', message: 'Send failed', onDismiss: closedChat })
    notify({ id: 'update', kind: 'info', message: 'Update available', onDismiss: closedApp, scope: 'app' })

    clearNotifications()

    expect(ids()).toEqual(['update'])
    expect(closedChat).not.toHaveBeenCalled()
    expect(closedApp).not.toHaveBeenCalled()
  })

  test('a notice the app withdraws, or one that times out, was not closed by the person', () => {
    vi.useFakeTimers()

    const closed = vi.fn()

    notify({ id: 'withdrawn', kind: 'warning', message: 'Agent out of date', onDismiss: closed, scope: 'app' })
    notify({ id: 'timed', kind: 'info', message: 'Updated', durationMs: 1000, onDismiss: closed, scope: 'app' })

    dismissNotification('withdrawn')
    vi.advanceTimersByTime(1000)

    expect(ids()).toEqual([])
    expect(closed).not.toHaveBeenCalled()
  })

  test('the person closing one notice, or all of them, closes each once', () => {
    const closed = vi.fn()

    notify({ id: 'a', kind: 'warning', message: 'A', onDismiss: () => closed('a') })
    notify({ id: 'b', kind: 'info', message: 'B', onDismiss: () => closed('b'), scope: 'app' })
    notify({ id: 'c', kind: 'error', message: 'C', onDismiss: () => closed('c') })

    closeNotification('a')
    closeNotification('a')
    expect(closed.mock.calls).toEqual([['a']])

    closeAllNotifications()
    expect(ids()).toEqual([])
    expect(closed.mock.calls).toEqual([['a'], ['c'], ['b']])
  })

  test('a burst of chat notices keeps the newest four and never pushes out an app notice', () => {
    vi.useFakeTimers()

    notify({ id: 'update', kind: 'info', message: 'Update available', durationMs: 0, scope: 'app' })

    for (const n of [1, 2, 3, 4, 5, 6]) {
      notify({ id: `saved-${n}`, kind: 'success', message: `Saved ${n}` })
    }

    expect(ids()).toEqual(['saved-6', 'saved-5', 'saved-4', 'saved-3', 'update'])

    // What the cap dropped is gone for good: its timer does not outlive it.
    expect(vi.getTimerCount()).toBe(4)
  })
})
