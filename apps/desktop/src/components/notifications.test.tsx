import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $notifications, clearNotifications, notify, resetNotifications } from '@/store/notifications'

import { NotificationStack } from './notifications'

// A notice's buttons are the person closing it: the only way its onDismiss, and
// the snoozes hung on it, runs.

beforeEach(() => {
  resetNotifications()
})

afterEach(() => {
  cleanup()
  resetNotifications()
})

describe('NotificationStack', () => {
  it('closes a notice with its close button', () => {
    const closed = vi.fn()

    notify({ id: 'agent', kind: 'warning', message: 'The agent is out of date', onDismiss: closed, scope: 'app' })
    render(<NotificationStack />)

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }))

    expect(closed).toHaveBeenCalledTimes(1)
    expect($notifications.get()).toEqual([])
  })

  it('takes the action, then closes the notice', () => {
    const order: string[] = []

    notify({
      id: 'update',
      kind: 'info',
      message: 'An update is available',
      durationMs: 0,
      scope: 'app',
      action: { label: 'See what’s new', onClick: () => order.push('action') },
      onDismiss: () => order.push('closed')
    })
    render(<NotificationStack />)

    fireEvent.click(screen.getByRole('button', { name: 'See what’s new' }))

    expect(order).toEqual(['action', 'closed'])
    expect($notifications.get()).toEqual([])
  })

  it('closes every notice with Clear all, app notices included', () => {
    const closed = vi.fn()

    notify({ id: 'chat', kind: 'error', message: 'Send failed', onDismiss: () => closed('chat') })
    notify({ id: 'agent', kind: 'warning', message: 'Restart AgentX', onDismiss: () => closed('agent'), scope: 'app' })
    render(<NotificationStack />)

    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }))

    expect(closed.mock.calls).toEqual([['agent'], ['chat']])
    expect($notifications.get()).toEqual([])
  })

  it('keeps an app notice on screen when the chat changes', () => {
    notify({ id: 'chat', kind: 'error', message: 'Send failed' })
    notify({ id: 'update', kind: 'info', message: 'An update is available', durationMs: 0, scope: 'app' })
    render(<NotificationStack />)

    act(() => clearNotifications())

    expect(screen.getByText('An update is available')).toBeTruthy()
    expect(screen.queryByText('Send failed')).toBeNull()
  })
})
