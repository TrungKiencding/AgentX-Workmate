import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FALLBACK_LOCALE, setRuntimeI18nLocale } from '@/i18n'
import type { StarmapGraph } from '@/types/hermes'

import { StarMap } from './star-map'

const graph: StarmapGraph = {
  clusters: [],
  edges: [],
  memory: [{ body: 'likes tea', entry: 'likes tea', source: 'memory', timestamp: null, title: 'likes tea' }],
  nodes: [
    {
      category: 'memory',
      createdBy: 'memory',
      id: 'memory:memory:0',
      kind: 'memory',
      label: 'likes tea',
      memorySource: 'memory',
      pinned: false,
      state: 'active',
      timestamp: null,
      useCount: 0
    }
  ],
  stats: {}
}

beforeEach(() => {
  // jsdom has neither: the map paints nothing, but its DOM chrome still renders.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      disconnect() {}
      observe() {}
      unobserve() {}
    }
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})

afterEach(() => {
  cleanup()
  setRuntimeI18nLocale(FALLBACK_LOCALE)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('StarMap legend', () => {
  it('keys the node shapes and the rings', () => {
    render(<StarMap graph={graph} />)

    expect(screen.getByText('skill')).toBeTruthy()
    expect(screen.getByText('memory')).toBeTruthy()
    expect(screen.getByText('core = oldest · outer = newer')).toBeTruthy()
  })

  it('speaks the active locale', () => {
    setRuntimeI18nLocale('vi')
    render(<StarMap graph={graph} />)

    expect(screen.getByText('kỹ năng')).toBeTruthy()
    expect(screen.getByText('ghi nhớ')).toBeTruthy()
    expect(screen.getByText('tâm = cũ nhất · vòng ngoài = mới hơn')).toBeTruthy()
  })
})
