import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { ConfirmRequestHost, requestConfirm } from './confirm-request'

// requestConfirm replaces the OS confirm(): one promise per question, settled
// by the app's own dialog — true only on the confirm button.

afterEach(cleanup)

describe('requestConfirm', () => {
  it('resolves true when the confirm button is pressed', async () => {
    render(<ConfirmRequestHost />)

    let answer: Promise<boolean> = Promise.resolve(false)

    act(() => {
      answer = requestConfirm({ confirmLabel: 'Delete chat', destructive: true, title: 'Delete “Notes”?' })
    })

    expect(screen.getByText('Delete “Notes”?')).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete chat' }))
    })

    await expect(answer).resolves.toBe(true)
  })

  it('resolves false on Cancel', async () => {
    render(<ConfirmRequestHost />)

    let answer: Promise<boolean> = Promise.resolve(true)

    act(() => {
      answer = requestConfirm({ title: 'Reset everything?' })
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    })

    await expect(answer).resolves.toBe(false)
  })

  it('cancels a pending question when a new one arrives', async () => {
    render(<ConfirmRequestHost />)

    let first: Promise<boolean> = Promise.resolve(true)

    act(() => {
      first = requestConfirm({ title: 'First?' })
    })
    act(() => {
      void requestConfirm({ title: 'Second?' })
    })

    await expect(first).resolves.toBe(false)
    expect(screen.getByText('Second?')).toBeTruthy()
  })
})
