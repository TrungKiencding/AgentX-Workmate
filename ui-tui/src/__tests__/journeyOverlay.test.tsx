import { PassThrough } from 'stream'

import { renderSync } from '@agentx/ink'
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  handler: undefined as undefined | ((input: string, key: Record<string, boolean>) => void),
  openInEditor: vi.fn<(initial: string, suffix?: string) => Promise<null | string>>()
}))

// Stub useInput so the overlay doesn't enter raw mode under renderSync, keeping
// the latest render's handler so a test presses keys against current state.
vi.mock('@agentx/ink', async importOriginal => {
  const mod = await importOriginal()

  return {
    ...mod,
    useInput: (handler: (input: string, key: Record<string, boolean>) => void) => {
      harness.handler = handler
    }
  }
})

vi.mock('../lib/editor.js', () => ({ openInEditor: harness.openInEditor }))

import { Journey } from '../components/journey.js'
import type { GatewayClient } from '../gatewayClient.js'
import { stripAnsi } from '../lib/text.js'
import { DEFAULT_THEME } from '../theme.js'

type Params = Record<string, unknown>

const MEMORY = {
  body: 'second',
  entry: 'second',
  glyph: '◆',
  id: 'memory:memory:1',
  label: 'second',
  meta: 'MEMORY.md',
  style: 'memory'
}

const SKILL = { glyph: '●', id: 'my-skill', label: 'my-skill', meta: 'used 2×', style: 'skill' }

// One slice holding one row, so the overlay opens with that row selected.
const framesWith = (node: Params) => ({
  axis: { end: 'now', start: 'then' },
  buckets: [{ date: '2026-10-15', index: 0, label: 'Oct 15', memories: 1, nodes: [node], skills: 0 }],
  count: 1,
  frames: [{ grid: [] }],
  legend: [],
  summary: []
})

const unmounts: Array<() => void> = []

afterEach(() => {
  unmounts.splice(0).forEach(unmount => unmount())
  harness.openInEditor.mockReset()
})

/** Mount the overlay over a fake gateway; resolves once a row is selected. */
async function mount(
  node: Params,
  respond: (method: string, params: Params) => unknown = () => ({ message: 'ok', ok: true })
) {
  const request = vi.fn((method: string, params: Params = {}) =>
    Promise.resolve(method === 'learning.frames' ? framesWith(node) : respond(method, params))
  )

  const stdout = new PassThrough()
  const stdin = new PassThrough()
  const stderr = new PassThrough()
  let output = ''

  Object.assign(stdout, { columns: 100, isTTY: false, rows: 40 })
  Object.assign(stdin, { isTTY: false })
  Object.assign(stderr, { isTTY: false })
  stdout.on('data', chunk => {
    output += chunk.toString()
  })

  harness.handler = undefined

  const instance = renderSync(
    <Journey gw={{ request } as unknown as GatewayClient} onClose={() => {}} t={DEFAULT_THEME} />,
    {
      patchConsole: false,
      stderr: stderr as NodeJS.WriteStream,
      stdin: stdin as NodeJS.ReadStream,
      stdout: stdout as NodeJS.WriteStream
    }
  )

  unmounts.push(() => {
    instance.unmount()
    instance.cleanup()
  })

  const screen = () => stripAnsi(output)
  await vi.waitFor(() => expect(screen()).toContain('e edit · d delete'))

  return { request, screen }
}

const press = (input: string) => harness.handler?.(input, {})

const callsTo = (request: ReturnType<typeof vi.fn>, method: string) =>
  request.mock.calls.filter(([m]) => m === method).map(([, params]) => params as Params)

describe('/journey overlay mutations', () => {
  it('deletes a memory row by the text it showed, not its positional id alone', async () => {
    const { request, screen } = await mount(MEMORY)

    press('d')
    await vi.waitFor(() => expect(screen()).toContain('delete second? y/N'))
    press('y')

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith('learning.delete', { entry: 'second', id: 'memory:memory:1' })
    )
  })

  it('edits a memory row from its own text, sent back as the entry', async () => {
    harness.openInEditor.mockResolvedValue('second, revised')
    const { request } = await mount(MEMORY)

    press('e')

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith('learning.edit', {
        content: 'second, revised',
        entry: 'second',
        id: 'memory:memory:1'
      })
    )
    expect(harness.openInEditor).toHaveBeenCalledWith('second', '.txt')
    // The positional lookup could name a different entry by now.
    expect(callsTo(request, 'learning.detail')).toEqual([])
  })

  it('edits a skill by name, prefilled from its SKILL.md', async () => {
    harness.openInEditor.mockResolvedValue('---\nname: my-skill\n---\nv2')

    const { request } = await mount(SKILL, method =>
      method === 'learning.detail'
        ? { content: '---\nname: my-skill\n---\nv1', kind: 'skill', message: '', ok: true }
        : { message: "updated 'my-skill'", ok: true }
    )

    press('e')

    await vi.waitFor(() => expect(callsTo(request, 'learning.edit')).toHaveLength(1))
    expect(harness.openInEditor).toHaveBeenCalledWith('---\nname: my-skill\n---\nv1', '.md')
    expect(JSON.parse(JSON.stringify(callsTo(request, 'learning.edit')[0]))).toEqual({
      content: '---\nname: my-skill\n---\nv2',
      id: 'my-skill'
    })
  })

  it('reloads the timeline when the memory changed since it loaded', async () => {
    const { request, screen } = await mount(MEMORY, () => ({
      code: 'missing',
      message: 'That entry is no longer in memory.',
      ok: false
    }))

    press('d')
    await vi.waitFor(() => expect(screen()).toContain('delete second? y/N'))
    press('y')

    await vi.waitFor(() => expect(callsTo(request, 'learning.frames')).toHaveLength(2))
    await vi.waitFor(() => expect(screen()).toContain('That entry is no longer in memory.'))
  })
})
