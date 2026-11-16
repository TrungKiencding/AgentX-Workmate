import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  addPendingSessionDelete,
  clearPendingSessionDelete,
  forgetRememberedSession,
  getRememberedSessionId,
  pendingSessionDeletes,
  setRememberedSessionId
} from '@/store/session'

import { replayPendingSessionDeletes } from './index'

// Deleting a chat closes its runtime before the delete request goes out; a
// reload or quit in that window lost the delete and the relaunch reopened the
// chat as the remembered one, read-only and without a composer.
describe('pending session deletes', () => {
  afterEach(() => {
    window.localStorage.clear()
  })

  it('records a delete until the backend answers, per chat', () => {
    addPendingSessionDelete({ id: 'tg-1', profile: null })
    addPendingSessionDelete({ id: 'local-2', profile: 'tro-ly' })
    addPendingSessionDelete({ id: 'tg-1', profile: null })

    expect(pendingSessionDeletes()).toEqual([
      { id: 'local-2', profile: 'tro-ly' },
      { id: 'tg-1', profile: null }
    ])

    clearPendingSessionDelete('tg-1')
    expect(pendingSessionDeletes()).toEqual([{ id: 'local-2', profile: 'tro-ly' }])
  })

  it('reads a corrupted record as nothing pending', () => {
    window.localStorage.setItem('agentx.desktop.pendingSessionDeletes', '{not json')

    expect(pendingSessionDeletes()).toEqual([])
  })

  it('forgets the remembered chat it deletes', () => {
    setRememberedSessionId('tg-1')
    forgetRememberedSession(['tg-1'])

    expect(getRememberedSessionId()).toBeNull()
  })

  it('finishes a delete the last run cut short, and hides the chat meanwhile', async () => {
    addPendingSessionDelete({ id: 'tg-1', profile: 'tro-ly' })
    const hide = vi.fn()
    const restore = vi.fn()
    const remove = vi.fn(async () => ({ ok: true, deleted_ids: ['tg-1'] }))

    await replayPendingSessionDeletes(hide, restore, remove)

    expect(hide).toHaveBeenCalledWith(['tg-1'])
    expect(remove).toHaveBeenCalledWith('tg-1', 'tro-ly')
    expect(restore).not.toHaveBeenCalled()
    expect(pendingSessionDeletes()).toEqual([])
  })

  it('brings the chat back when the backend refuses the delete', async () => {
    addPendingSessionDelete({ id: 'tg-1', profile: null })
    const restore = vi.fn()

    await replayPendingSessionDeletes(
      vi.fn(),
      restore,
      vi.fn(async () => {
        throw new Error('500')
      })
    )

    expect(restore).toHaveBeenCalledWith(['tg-1'])
    expect(pendingSessionDeletes()).toEqual([])
  })

  it('does nothing when no delete is pending', async () => {
    const hide = vi.fn()

    await replayPendingSessionDeletes(hide, vi.fn(), vi.fn())

    expect(hide).not.toHaveBeenCalled()
  })
})
