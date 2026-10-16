import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MemoryEntriesResponse } from '@/types/hermes'

import { MemoryEntriesPanel, memoryEntryErrorCode } from './memory-entries'

// "Bộ nhớ không cho phép xem thông tin bên trong": Settings → Memory now lists
// what the built-in memory holds and lets the user fix or drop an entry.

const store = (entries: string[], overrides: Partial<MemoryEntriesResponse['user']> = {}) => ({
  chars: entries.join('\n§\n').length,
  enabled: true,
  entries,
  limit: 1375,
  readable: true,
  ...overrides
})

let data: MemoryEntriesResponse
let failNext: Error | null
const calls: { body?: unknown; method?: string; path: string }[] = []

beforeEach(() => {
  data = { memory: store(['Repo uses uv']), user: store(['Thích ăn kẹo', 'Làm việc buổi sáng']) }
  failNext = null
  calls.length = 0

  vi.stubGlobal('agentxDesktop', {
    api: vi.fn(async (request: { body?: unknown; method?: string; path: string }) => {
      calls.push(request)

      if (failNext && request.method) {
        const error = failNext
        failNext = null
        throw error
      }

      if (request.method === 'DELETE') {
        const { entry, target } = request.body as { entry: string; target: 'memory' | 'user' }
        data = { ...data, [target]: store(data[target].entries.filter(e => e !== entry)) }

        return { entry_count: data[target].entries.length, ok: true }
      }

      if (request.method === 'PUT') {
        const { content, entry, target } = request.body as { content: string; entry: string; target: 'memory' | 'user' }
        data = { ...data, [target]: store(data[target].entries.map(e => (e === entry ? content : e))) }

        return { entry_count: data[target].entries.length, ok: true }
      }

      return data
    })
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return render(
    <QueryClientProvider client={client}>
      <MemoryEntriesPanel />
    </QueryClientProvider>
  )
}

const group = (target: 'memory' | 'user') =>
  window.document.querySelector<HTMLElement>(`[data-memory-target="${target}"]`)!

describe('MemoryEntriesPanel', () => {
  it('lists what each store holds, with its usage', async () => {
    renderPanel()

    expect(await screen.findByText('Thích ăn kẹo')).toBeTruthy()
    expect(within(group('user')).getByText('Làm việc buổi sáng')).toBeTruthy()
    expect(within(group('memory')).getByText('Repo uses uv')).toBeTruthy()
    expect(within(group('user')).getByText(`${data.user.chars}/1,375 characters`)).toBeTruthy()
    expect(calls[0]).toMatchObject({ path: '/api/memory/entries' })
  })

  it('says so when a store is empty, switched off, or unreadable', async () => {
    data = {
      memory: store([], { enabled: false }),
      user: store([], { readable: false })
    }
    renderPanel()

    await screen.findByText('No notes yet.')

    expect(within(group('memory')).getByText('No notes yet.')).toBeTruthy()
    expect(within(group('memory')).getByText(/AgentX neither reads nor adds/)).toBeTruthy()
    expect(within(group('user')).getByText("This memory file couldn't be read.")).toBeTruthy()
  })

  it('deletes exactly the confirmed entry and reloads', async () => {
    renderPanel()
    await screen.findByText('Thích ăn kẹo')

    const row = screen.getByText('Thích ăn kẹo').closest('li')!
    fireEvent.click(within(row).getByRole('button', { name: 'Delete' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete', hidden: false }))

    await waitFor(() => expect(screen.queryByText('Thích ăn kẹo')).toBeNull())
    expect(calls.find(call => call.method === 'DELETE')).toMatchObject({
      body: { entry: 'Thích ăn kẹo', target: 'user' },
      path: '/api/memory/entries'
    })
    expect(screen.getByText('Làm việc buổi sáng')).toBeTruthy()
  })

  it('edits an entry in place', async () => {
    renderPanel()
    await screen.findByText('Repo uses uv')

    const row = screen.getByText('Repo uses uv').closest('li')!
    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }))

    const editor = screen.getByRole('textbox', { name: 'Memory entry' })
    fireEvent.change(editor, { target: { value: 'Repo uses uv and ruff' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('Repo uses uv and ruff')).toBeTruthy()
    expect(calls.find(call => call.method === 'PUT')).toMatchObject({
      body: { content: 'Repo uses uv and ruff', entry: 'Repo uses uv', target: 'memory' }
    })
  })

  it("explains a refused edit in the app's words and keeps the editor open", async () => {
    renderPanel()
    await screen.findByText('Repo uses uv')

    fireEvent.click(within(screen.getByText('Repo uses uv').closest('li')!).getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Memory entry' }), { target: { value: 'x'.repeat(50) } })
    failNext = new Error('400: {"detail":{"code":"too_long","message":"Memory would hold 3,000/2,200 characters."}}')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(calls.some(call => call.method === 'PUT')).toBe(true))
    expect(screen.getByRole('textbox', { name: 'Memory entry' })).toBeTruthy()
  })
})

describe('memoryEntryErrorCode', () => {
  it('reads the code out of the bridge error', () => {
    expect(
      memoryEntryErrorCode(
        new Error(
          'Error invoking remote method \'agentx:api\': Error: 404: {"detail":{"code":"missing","message":"x"}}'
        )
      )
    ).toBe('missing')
    expect(memoryEntryErrorCode(new Error('500: Internal Server Error'))).toBeNull()
  })
})
