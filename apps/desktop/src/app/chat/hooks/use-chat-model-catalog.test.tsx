import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, renderHook, waitFor } from '@testing-library/react'
import { atom } from 'nanostores'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HermesGateway } from '@/hermes'
import { $activeGatewayProfile } from '@/store/profile'
import type { ModelOptionsResponse } from '@/types/hermes'

import type { SessionView } from '../session-view'

import { useChatModelCatalog } from './use-chat-model-catalog'

function setup() {
  const model = atom('old')
  const runtimeId = atom<string | null>(null)
  const storedId = atom<string | null>(null)
  const busy = atom(false)

  const view = {
    $model: model,
    $provider: atom('litellm'),
    $runtimeId: runtimeId,
    $storedId: storedId,
    $busy: busy
  } as unknown as SessionView

  const state = {
    catalog: {
      model: 'old',
      provider: 'litellm',
      providers: [{ name: 'AgentX AI Gateway', slug: 'litellm', models: ['old', 'valid'] }]
    } as ModelOptionsResponse
  }

  const order: string[] = []
  const request = vi.fn(async () => state.catalog)

  const select = vi.fn(async ({ model: next }: { model: string }) => {
    order.push('switch')
    model.set(next)

    return true
  })

  const submit = vi.fn(async () => {
    order.push('submit')

    return true
  })

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  const options = {
    gateway: { request } as unknown as HermesGateway,
    profile: 'default',
    sessionId: null,
    enabled: true,
    busy: false,
    view,
    onSelectModel: select,
    onSubmit: submit
  }

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )

  const hook = renderHook(props => useChatModelCatalog(props), { initialProps: options, wrapper })

  return { ...hook, model, runtimeId, storedId, busy, state, request, select, submit, options, order, queryClient }
}

describe('chat catalog lifecycle and send validation', () => {
  beforeEach(() => $activeGatewayProfile.set('default'))
  afterEach(() => {
    cleanup()
    $activeGatewayProfile.set('default')
  })

  it('refreshes at startup and on Electron focus, preserving a valid choice', async () => {
    const h = setup()
    await waitFor(() => expect(h.result.current.modelOptionsQuery.isFetching).toBe(false))
    expect(h.request).toHaveBeenCalledWith('model.options', { refresh: true, explicit_only: true })
    expect(h.select).not.toHaveBeenCalled()
    h.state.catalog = {
      ...h.state.catalog,
      providers: [{ name: 'AgentX AI Gateway', slug: 'litellm', models: ['new'] }]
    }
    act(() => {
      fireEvent(window, new Event('focus'))
    })
    await waitFor(() => expect(h.model.get()).toBe('new'))
    expect(h.request).toHaveBeenCalledTimes(2)
  })

  it('refreshes and switches before submitting even when the cached catalog is warm', async () => {
    const h = setup()
    await waitFor(() => expect(h.result.current.modelOptionsQuery.isFetching).toBe(false))
    h.state.catalog = {
      ...h.state.catalog,
      providers: [{ name: 'AgentX AI Gateway', slug: 'litellm', models: ['new'] }]
    }
    await act(async () => {
      expect(await h.result.current.submitWithCurrentModel('hello')).toBe(true)
    })
    expect(h.order).toEqual(['switch', 'submit'])
    expect(h.model.get()).toBe('new')
    expect(h.request).toHaveBeenCalledTimes(2)
  })

  it('leaves the draft unsent after a failed session switch and allows a retry', async () => {
    const h = setup()
    await waitFor(() => expect(h.result.current.modelOptionsQuery.isFetching).toBe(false))
    h.state.catalog = {
      ...h.state.catalog,
      providers: [{ name: 'AgentX AI Gateway', slug: 'litellm', models: ['new'] }]
    }
    h.select.mockResolvedValue(false)
    await act(async () => {
      expect(await h.result.current.submitWithCurrentModel('hello')).toBe(false)
    })
    expect(h.submit).not.toHaveBeenCalled()
    h.select.mockResolvedValue(true)
    await act(async () => {
      expect(await h.result.current.submitWithCurrentModel('hello')).toBe(true)
    })
    expect(h.submit).toHaveBeenCalledTimes(1)
  })

  it('does not send into another conversation when navigation happens during discovery', async () => {
    const h = setup()
    await waitFor(() => expect(h.result.current.modelOptionsQuery.isFetching).toBe(false))
    let finish!: (data: ModelOptionsResponse) => void
    h.request.mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    const pending = h.result.current.submitWithCurrentModel('hello')
    await waitFor(() => expect(h.request).toHaveBeenCalledTimes(2))
    await act(async () => {
      h.storedId.set('another')
      finish(h.state.catalog)
      expect(await pending).toBe(false)
    })
    expect(h.submit).not.toHaveBeenCalled()
  })

  it('does not reuse a read started before send when the SSO grant changed during that read', async () => {
    const h = setup()
    await waitFor(() => expect(h.result.current.modelOptionsQuery.isFetching).toBe(false))
    const oldCatalog = h.state.catalog
    const fresh = { ...oldCatalog, providers: [{ name: 'AgentX AI Gateway', slug: 'litellm', models: ['new'] }] }
    let finish!: (data: ModelOptionsResponse) => void
    h.request
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finish = resolve
          })
      )
      .mockResolvedValue(fresh)
    const oldRead = h.result.current.modelOptionsQuery.refetch()
    await waitFor(() => expect(h.request).toHaveBeenCalledTimes(2))
    const pending = h.result.current.submitWithCurrentModel('hello')
    expect(h.submit).not.toHaveBeenCalled()
    await act(async () => {
      finish(oldCatalog)
      await oldRead
      expect(await pending).toBe(true)
    })
    expect(h.request).toHaveBeenCalledTimes(3)
    expect(h.model.get()).toBe('new')
    expect(h.order).toEqual(['switch', 'submit'])
  })

  it('keeps queuing during an active turn without a model switch or extra discovery', async () => {
    const h = setup()
    await waitFor(() => expect(h.result.current.modelOptionsQuery.isFetching).toBe(false))
    act(() => h.busy.set(true))
    await act(async () => {
      expect(await h.result.current.submitWithCurrentModel('queue this')).toBe(true)
    })
    expect(h.select).not.toHaveBeenCalled()
    expect(h.request).toHaveBeenCalledTimes(1)
  })

  it('preserves queuing when another turn starts while send is refreshing the catalog', async () => {
    const h = setup()
    await waitFor(() => expect(h.result.current.modelOptionsQuery.isFetching).toBe(false))
    let finish!: (data: ModelOptionsResponse) => void
    h.request.mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    const pending = h.result.current.submitWithCurrentModel('queue this')
    await waitFor(() => expect(h.request).toHaveBeenCalledTimes(2))
    await act(async () => {
      h.busy.set(true)
      h.rerender({ ...h.options, busy: true })
      finish({
        ...h.state.catalog,
        providers: [{ name: 'AgentX AI Gateway', slug: 'litellm', models: ['new'] }]
      })
      expect(await pending).toBe(true)
    })
    expect(h.select).not.toHaveBeenCalled()
    expect(h.model.get()).toBe('old')
    expect(h.submit).toHaveBeenCalledWith('queue this', undefined)
  })

  it('keeps the current model when discovery fails, with normal send errors owned by the submit pipeline', async () => {
    const h = setup()
    await waitFor(() => expect(h.result.current.modelOptionsQuery.isFetching).toBe(false))
    h.request.mockRejectedValue(new Error('offline'))
    await act(async () => {
      expect(await h.result.current.submitWithCurrentModel('hello')).toBe(true)
    })
    expect(h.model.get()).toBe('old')
    expect(h.select).not.toHaveBeenCalled()
    expect(h.submit).toHaveBeenCalledTimes(1)
  })

  it('does not refresh hidden or messaging surfaces on focus', async () => {
    const h = setup()
    await waitFor(() => expect(h.result.current.modelOptionsQuery.isFetching).toBe(false))
    h.rerender({ ...h.options, enabled: false })
    act(() => {
      fireEvent(window, new Event('focus'))
    })
    expect(h.request).toHaveBeenCalledTimes(1)
  })
})
