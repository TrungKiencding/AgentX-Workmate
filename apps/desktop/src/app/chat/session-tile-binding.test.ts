import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setGatewayState } from '@/store/session'
import {
  $sessionTiles,
  $tileBindingGeneration,
  invalidateTileRuntimeBindings,
  patchSessionTile,
  type SessionTileDelegate,
  setSessionTileDelegate
} from '@/store/session-states'

import { useTileRuntimeBinding } from './session-tile-binding'

const STORED = 'stored-1'

function delegate(resumeTile: SessionTileDelegate['resumeTile']): SessionTileDelegate {
  return {
    archiveSession: vi.fn(async () => undefined),
    branchSession: vi.fn(async () => undefined),
    deleteSession: vi.fn(async () => undefined),
    executeSlash: vi.fn(async () => undefined),
    interruptSession: vi.fn(async () => undefined),
    recoverRuntime: vi.fn(async () => null),
    resumeTile,
    submitToSession: vi.fn(async () => undefined),
    updateSession: vi.fn()
  }
}

const current = () => $sessionTiles.get().find(t => t.storedSessionId === STORED)

beforeEach(() => {
  setGatewayState('open')
  $sessionTiles.set([{ storedSessionId: STORED }])
})

afterEach(() => {
  cleanup()
  $sessionTiles.set([])
  setGatewayState('idle')
})

describe('useTileRuntimeBinding', () => {
  it('binds an unbound tile once the gateway is open', async () => {
    const resumeTile = vi.fn(async () => 'rt-1')
    setSessionTileDelegate(delegate(resumeTile))

    renderHook(() => useTileRuntimeBinding(STORED))

    await waitFor(() => expect(current()?.runtimeId).toBe('rt-1'))
    expect(resumeTile).toHaveBeenCalledTimes(1)
    expect(current()?.boundGeneration).toBe($tileBindingGeneration.get())
  })

  it('leaves a tile bound on the current connection alone', async () => {
    const resumeTile = vi.fn(async () => 'rt-other')
    setSessionTileDelegate(delegate(resumeTile))
    patchSessionTile(STORED, { runtimeId: 'rt-1' })

    renderHook(() => useTileRuntimeBinding(STORED))
    await act(async () => undefined)

    expect(resumeTile).not.toHaveBeenCalled()
  })

  it('re-attaches in place after a reconnect, without unbinding what the pane shows', async () => {
    let finish!: (id: string) => void
    const resumeTile = vi.fn(() => new Promise<string>(resolve => (finish = resolve)))
    setSessionTileDelegate(delegate(resumeTile))
    patchSessionTile(STORED, { runtimeId: 'rt-1' })

    renderHook(() => useTileRuntimeBinding(STORED))
    act(() => invalidateTileRuntimeBindings())

    await waitFor(() => expect(resumeTile).toHaveBeenCalledTimes(1))
    // While the re-attach is in flight the tile keeps its runtime (and so its
    // transcript) — no spinner flash, no remount.
    expect(current()?.runtimeId).toBe('rt-1')

    await act(async () => finish('rt-1'))

    expect(current()).toMatchObject({ boundGeneration: $tileBindingGeneration.get(), runtimeId: 'rt-1' })
    expect(resumeTile).toHaveBeenCalledTimes(1)
  })

  it('re-attaches once more when another reconnect lands mid-attach', async () => {
    const pending: Array<(id: string) => void> = []
    const resumeTile = vi.fn(() => new Promise<string>(resolve => pending.push(resolve)))
    setSessionTileDelegate(delegate(resumeTile))
    patchSessionTile(STORED, { runtimeId: 'rt-1' })

    renderHook(() => useTileRuntimeBinding(STORED))
    act(() => invalidateTileRuntimeBindings())
    await waitFor(() => expect(resumeTile).toHaveBeenCalledTimes(1))

    act(() => invalidateTileRuntimeBindings())
    await act(async () => pending[0]!('rt-1'))

    await waitFor(() => expect(resumeTile).toHaveBeenCalledTimes(2))
    await act(async () => pending[1]!('rt-1'))

    expect(current()?.boundGeneration).toBe($tileBindingGeneration.get())
  })

  it('keeps showing the conversation when a re-attach fails transiently', async () => {
    const resumeTile = vi.fn(async () => Promise.reject(new Error('request timed out after 30s: session.activate')))
    setSessionTileDelegate(delegate(resumeTile))
    patchSessionTile(STORED, { runtimeId: 'rt-1' })

    renderHook(() => useTileRuntimeBinding(STORED))
    act(() => invalidateTileRuntimeBindings())

    await waitFor(() => expect(current()?.boundGeneration).toBe($tileBindingGeneration.get()))
    expect(current()?.runtimeId).toBe('rt-1')
    expect(current()?.error).toBeUndefined()
    expect(resumeTile).toHaveBeenCalledTimes(1)
  })

  it('discards a tile whose stored session no longer exists', async () => {
    setSessionTileDelegate(delegate(vi.fn(async () => Promise.reject(new Error('session not found')))))

    renderHook(() => useTileRuntimeBinding(STORED))

    await waitFor(() => expect(current()).toBeUndefined())
  })

  it('shows the error card for an unbound tile that fails to bind', async () => {
    setSessionTileDelegate(delegate(vi.fn(async () => Promise.reject(new Error('backend unavailable')))))

    renderHook(() => useTileRuntimeBinding(STORED))

    await waitFor(() => expect(current()?.error).toBe('backend unavailable'))
  })
})
