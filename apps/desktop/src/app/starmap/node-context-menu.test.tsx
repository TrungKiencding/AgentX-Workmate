import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FALLBACK_LOCALE, setRuntimeI18nLocale } from '@/i18n'
import { $notifications, resetNotifications } from '@/store/notifications'
import { $starmapGraph, $starmapMemoryLocked, loadStarmapGraph, resetStarmapGraph } from '@/store/starmap'
import type { StarmapGraph } from '@/types/hermes'

import { NodeContextMenu, type NodeMenuTarget } from './node-context-menu'

// Memory node ids are positional (`memory:<source>:<index>`). A delete used to
// evict the node locally and never reload, so the next delete on the same map
// aimed one entry too far. The menu now sends the entry's text and holds memory
// actions until the graph has reloaded.

let entries: string[]
let graphGate: Promise<void> | null
let releaseGraph: () => void
let failDelete: Error | null
const deletes: unknown[] = []

function graphOf(list: string[]): StarmapGraph {
  return {
    clusters: [],
    edges: [],
    memory: list.map(entry => ({ body: entry, entry, source: 'memory', timestamp: null, title: entry })),
    nodes: list.map((entry, i) => ({
      category: 'memory',
      createdBy: 'memory',
      id: `memory:memory:${i}`,
      kind: 'memory',
      label: entry,
      memorySource: 'memory',
      pinned: false,
      state: 'active',
      timestamp: null,
      useCount: 0
    })),
    stats: {}
  }
}

beforeEach(() => {
  releaseGraph = () => {}
  graphGate = null
  entries = ['first', 'second', 'third']
  failDelete = null
  deletes.length = 0

  vi.stubGlobal('agentxDesktop', {
    api: vi.fn(async (request: { body?: unknown; method?: string; path: string }) => {
      if (request.path === '/api/learning/graph') {
        await graphGate

        return graphOf(entries)
      }

      if (request.method === 'DELETE' && request.path === '/api/learning/node') {
        deletes.push(request.body)

        if (failDelete) {
          throw failDelete
        }

        // The backend removes the entry by its text (MemoryStore.remove_entry).
        const { entry } = request.body as { entry: string }
        entries = entries.filter(e => e !== entry)

        return { message: 'deleted memory from MEMORY.md', ok: true }
      }

      throw new Error(`unexpected ${request.method ?? 'GET'} ${request.path}`)
    })
  })
})

afterEach(async () => {
  // A test that failed mid-delete must not leave its reload — and with it the
  // store's memory lock — hanging over the next one.
  releaseGraph()
  await waitFor(() => expect($starmapMemoryLocked.get()).toBe(false))
  cleanup()
  resetStarmapGraph()
  resetNotifications()
  setRuntimeI18nLocale(FALLBACK_LOCALE)
  vi.unstubAllGlobals()
})

/** The menu as the star map opens it on the loaded graph's `index`-th memory. */
function targetAt(index: number): NodeMenuTarget {
  const card = $starmapGraph.get()!.memory[index]!

  return { entry: card.entry, id: `memory:memory:${index}`, kind: 'memory', label: card.title, x: 8, y: 8 }
}

/** Mirrors StarMap: choosing an action closes the menu. */
function Menu({ initial }: { initial: NodeMenuTarget }) {
  const [target, setTarget] = useState<NodeMenuTarget | null>(initial)

  return <NodeContextMenu onClose={() => setTarget(null)} onNodeRemoved={() => setTarget(null)} target={target} />
}

async function confirmDelete() {
  fireEvent.click(screen.getByRole('button', { name: 'Delete memory' }))
  const dialog = await screen.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
}

const labels = () => $starmapGraph.get()!.nodes.map(node => node.label)

describe('NodeContextMenu delete', () => {
  it('deletes the memory it showed by its text, and holds memory actions until the map reloads', async () => {
    await loadStarmapGraph(true)
    render(<Menu initial={targetAt(1)} />)

    graphGate = new Promise<void>(resolve => (releaseGraph = resolve))
    await confirmDelete()

    await waitFor(() => expect(deletes).toEqual([{ entry: 'second', id: 'memory:memory:1' }]))
    expect(labels()).toEqual(['first', 'third'])
    // "third" still carries its old id (memory:memory:2), one past its entry.
    expect($starmapMemoryLocked.get()).toBe(true)

    render(<Menu initial={targetAt(2)} />)
    expect(screen.getByRole('button', { name: 'Delete memory' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Edit memory…' })).toHaveProperty('disabled', true)

    releaseGraph()
    await waitFor(() => expect($starmapMemoryLocked.get()).toBe(false))
    expect($starmapGraph.get()!.nodes.map(node => node.id)).toEqual(['memory:memory:0', 'memory:memory:1'])

    // Even sent with the stale id, the second delete names "third" by its text.
    await confirmDelete()
    await waitFor(() => expect($starmapMemoryLocked.get()).toBe(false))
    expect(deletes).toEqual([
      { entry: 'second', id: 'memory:memory:1' },
      { entry: 'third', id: 'memory:memory:2' }
    ])
    expect(entries).toEqual(['first'])
    expect(labels()).toEqual(['first'])
  })

  it('explains a memory that changed elsewhere, and shows the map as it now is', async () => {
    await loadStarmapGraph(true)
    render(<Menu initial={targetAt(0)} />)

    // Rewritten by the agent after the map loaded: the backend no longer finds it.
    entries = ['first, revised', 'second', 'third']
    failDelete = new Error('404: {"detail":{"code":"missing","message":"That entry is no longer in memory."}}')
    await confirmDelete()

    await waitFor(() => expect(labels()).toEqual(['first, revised', 'second', 'third']))
    expect($starmapMemoryLocked.get()).toBe(false)
    expect($notifications.get()[0]).toMatchObject({
      kind: 'error',
      message: 'This memory changed somewhere else. The map has been reloaded.',
      title: 'first'
    })
  })

  it('speaks the active locale', async () => {
    setRuntimeI18nLocale('vi')
    await loadStarmapGraph(true)
    render(<Menu initial={targetAt(0)} />)

    expect(screen.getByRole('button', { name: 'Sửa ghi nhớ…' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Xoá ghi nhớ' }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Xoá first?')).toBeTruthy()
    expect(within(dialog).getByText('Ghi nhớ này sẽ bị xoá vĩnh viễn.')).toBeTruthy()
  })
})
