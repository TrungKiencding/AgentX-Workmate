import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ConfirmDialog } from './confirm-dialog'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('confirmation lifecycle', () => {
  it('does not close a later screen when a pending confirmation resolves after unmount', async () => {
    vi.useFakeTimers()
    let finish!: () => void

    const action = new Promise<void>(resolve => {
      finish = resolve
    })

    const close = vi.fn()

    const view = render(
      <ConfirmDialog confirmLabel="Revoke device" onClose={close} onConfirm={() => action} open title="Revoke" />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Revoke device' }))
    view.unmount()
    await act(async () => {
      finish()
      await action
    })
    act(() => {
      vi.runAllTimers()
    })
    expect(close).not.toHaveBeenCalled()
  })

  it('cancels a completed confirmation’s delayed close when the dialog unmounts', async () => {
    vi.useFakeTimers()
    const close = vi.fn()

    const view = render(
      <ConfirmDialog
        confirmLabel="Revoke device"
        onClose={close}
        onConfirm={async () => undefined}
        open
        title="Revoke"
      />
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Revoke device' }))
    })
    view.unmount()
    act(() => {
      vi.runAllTimers()
    })
    expect(close).not.toHaveBeenCalled()
  })

  it('permits retry after a failed action, while submitting a pending action only once', async () => {
    const action = vi.fn().mockRejectedValueOnce(new Error('Try again')).mockResolvedValueOnce(undefined)
    const close = vi.fn()
    render(<ConfirmDialog confirmLabel="Revoke device" onClose={close} onConfirm={action} open title="Revoke" />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Revoke device' }))
      fireEvent.click(screen.getByRole('button', { name: 'Revoke device' }))
    })
    expect(screen.getByText('Try again')).toBeTruthy()
    expect(action).toHaveBeenCalledTimes(1)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Revoke device' }))
    })
    expect(action).toHaveBeenCalledTimes(2)
  })
})
