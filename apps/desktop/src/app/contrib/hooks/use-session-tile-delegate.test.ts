import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { sessionTileDelegate } from '@/store/session-states'

import { useSessionTileDelegate } from './use-session-tile-delegate'

function renderTile(overrides: Partial<Parameters<typeof useSessionTileDelegate>[0]> = {}) {
  const deps = {
    archiveSession: vi.fn(async () => undefined),
    attachSessionRuntime: vi.fn(async () => 'runtime-attached'),
    branchStoredSession: vi.fn(async () => undefined),
    executeSlashCommand: vi.fn(async () => undefined) as never,
    recoverSessionRuntime: vi.fn(async () => 'runtime-recovered'),
    removeSession: vi.fn(async () => undefined),
    requestGateway: vi.fn(async () => ({})) as never,
    updateSessionState: vi.fn(),
    ...overrides
  }

  renderHook(() => useSessionTileDelegate(deps))

  return deps
}

describe('useSessionTileDelegate', () => {
  it('binds a tile through the runtime attach path (re-attach or fresh bind)', async () => {
    const deps = renderTile()

    await expect(sessionTileDelegate()!.resumeTile('stored-x')).resolves.toBe('runtime-attached')
    expect(deps.attachSessionRuntime).toHaveBeenCalledWith('stored-x')
  })

  it('recovers a tile runtime that died under a send through the shared funnel', async () => {
    const deps = renderTile()

    await expect(sessionTileDelegate()!.recoverRuntime('stored-x', 'runtime-dead')).resolves.toBe('runtime-recovered')
    expect(deps.recoverSessionRuntime).toHaveBeenCalledWith('stored-x', 'runtime-dead')
  })

  it('surfaces an attach failure to the pane (it decides: discard, keep, or error card)', async () => {
    renderTile({ attachSessionRuntime: vi.fn(async () => Promise.reject(new Error('session not found'))) })

    await expect(sessionTileDelegate()!.resumeTile('stored-gone')).rejects.toThrow('session not found')
  })
})
