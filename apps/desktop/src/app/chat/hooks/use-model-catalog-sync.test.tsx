import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $activeGatewayProfile } from '@/store/profile'

import type { SessionView } from '../session-view'

import { useModelCatalogSync } from './use-model-catalog-sync'

const catalog = {
  provider: 'litellm',
  model: 'retired',
  providers: [{ name: 'AgentX AI Gateway', slug: 'litellm', models: ['new', 'valid'] }]
}

function setup(sessionId: string | null = null) {
  const view = {
    $model: atom('retired'),
    $provider: atom('litellm'),
    $runtimeId: atom(sessionId)
  } as unknown as SessionView

  const select = vi.fn(async () => true)
  const options = { data: catalog, ready: true, busy: false, profile: 'default', view, select }

  return { view, select, options }
}

describe('useModelCatalogSync', () => {
  beforeEach(() => $activeGatewayProfile.set('default'))
  afterEach(() => {
    cleanup()
    $activeGatewayProfile.set('default')
  })

  it.each([null, 'live', 'tile'])(
    'repairs only the owning surface %s after a fresh catalog arrives',
    async sessionId => {
      const { options, select } = setup(sessionId)
      renderHook(() => useModelCatalogSync(options))
      await waitFor(() =>
        expect(select).toHaveBeenCalledExactlyOnceWith({
          provider: 'litellm',
          model: 'new',
          sessionId,
          automatic: true
        })
      )
    }
  )

  it('waits for discovery and for the current turn to finish', async () => {
    const { options, select } = setup('live')

    const { rerender } = renderHook(props => useModelCatalogSync(props), {
      initialProps: { ...options, busy: true, ready: false }
    })

    expect(select).not.toHaveBeenCalled()
    rerender({ ...options, busy: true })
    expect(select).not.toHaveBeenCalled()
    rerender(options)
    await waitFor(() => expect(select).toHaveBeenCalledTimes(1))
  })

  it('keeps a still-granted manual choice and ignores background profiles', () => {
    const { options, view, select } = setup()

    ;(view.$model as ReturnType<typeof atom<string>>).set('valid')
    const { rerender } = renderHook(props => useModelCatalogSync(props), { initialProps: options })
    expect(select).not.toHaveBeenCalled()
    rerender({ ...options, profile: 'other' })
    act(() => {
      ;(view.$model as ReturnType<typeof atom<string>>).set('retired')
    })
    rerender({ ...options, profile: 'other', data: { ...catalog } })
    expect(select).not.toHaveBeenCalled()
  })

  it('joins background repair and send preparation, and refuses send after a failed switch', async () => {
    const { options, select } = setup('live')
    let finish!: (ok: boolean) => void
    select.mockImplementation(
      () =>
        new Promise<boolean>(resolve => {
          finish = resolve
        })
    )
    const { result, rerender } = renderHook(props => useModelCatalogSync(props), { initialProps: options })
    const first = result.current(catalog)
    const second = result.current(catalog)
    expect(select).toHaveBeenCalledTimes(1)
    await act(async () => {
      finish(false)
      expect(await first).toBe(false)
      expect(await second).toBe(false)
    })
    rerender({ ...options })
    expect(select).toHaveBeenCalledTimes(1)
  })

  it('refuses to send when the conversation changes while repair is in flight', async () => {
    const { options, view, select } = setup('one')
    let finish!: (ok: boolean) => void
    select.mockImplementation(
      () =>
        new Promise<boolean>(resolve => {
          finish = resolve
        })
    )
    const { result } = renderHook(() => useModelCatalogSync({ ...options, ready: false }))
    const pending = result.current(catalog)
    await act(async () => {
      ;(view.$runtimeId as ReturnType<typeof atom<string | null>>).set('two')
      finish(true)
      expect(await pending).toBe(false)
    })
  })

  it('validates a newer grant after joining an older model repair', async () => {
    const { options, view, select } = setup('live')
    const model = view.$model as ReturnType<typeof atom<string>>
    let finish!: (ok: boolean) => void
    select.mockImplementationOnce(
      () =>
        new Promise<boolean>(resolve => {
          model.set('new')
          finish = resolve
        })
    )
    select.mockImplementation(async () => {
      model.set('newest')

      return true
    })
    const { result } = renderHook(() => useModelCatalogSync({ ...options, ready: false }))
    const older = result.current(catalog)

    const latest = result.current({
      ...catalog,
      providers: [{ name: 'AgentX AI Gateway', slug: 'litellm', models: ['newest'] }]
    })

    expect(select).toHaveBeenCalledTimes(1)
    await act(async () => {
      finish(true)
      expect(await older).toBe(true)
      expect(await latest).toBe(true)
    })
    expect(select).toHaveBeenCalledTimes(2)
    expect(model.get()).toBe('newest')
    expect(select).toHaveBeenLastCalledWith({
      provider: 'litellm',
      model: 'newest',
      sessionId: 'live',
      automatic: true
    })
  })
})
