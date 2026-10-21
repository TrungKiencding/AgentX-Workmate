import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionMessage } from '@/hermes'
import { FALLBACK_LOCALE, setRuntimeI18nLocale } from '@/i18n'

const getSessionMessages = vi.fn()
const notify = vi.fn()
const notifyError = vi.fn()

vi.mock('@/hermes', () => ({ getSessionMessages: (...args: unknown[]) => getSessionMessages(...args) }))
vi.mock('@/store/notifications', () => ({
  notify: (...args: unknown[]) => notify(...args),
  notifyError: (...args: unknown[]) => notifyError(...args)
}))

const { exportSession, hasDataHubResult } = await import('./session-export')

const SEARCH = 'mcp__agentx_agentx_data__search_knowledge'

function transcript(toolName: string, { named = true }: { named?: boolean } = {}): SessionMessage[] {
  return [
    { content: 'Công tác phí 2026?', role: 'user' },
    {
      content: '',
      role: 'assistant',
      tool_calls: [{ function: { arguments: '{}', name: toolName }, id: 'call-1', type: 'function' }]
    },
    { content: '{"result": "{}"}', role: 'tool', tool_call_id: 'call-1', ...(named ? { tool_name: toolName } : {}) },
    { content: 'Mức chi là 300.000 đồng [S1].', role: 'assistant' }
  ]
}

let clicked: string[]

beforeEach(() => {
  setRuntimeI18nLocale('vi')
  clicked = []
  // jsdom has no object URLs; this file's environment is its own.
  Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push(this.download)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  getSessionMessages.mockReset()
  notify.mockReset()
  notifyError.mockReset()
  setRuntimeI18nLocale(FALLBACK_LOCALE)
})

describe('hasDataHubResult', () => {
  it('finds a Data Hub result by its tool name or by the call it answers', () => {
    expect(hasDataHubResult(transcript(SEARCH))).toBe(true)
    expect(hasDataHubResult(transcript(SEARCH, { named: false }))).toBe(true)
    expect(hasDataHubResult(transcript('mcp__agentx_agentx_data_2__read_passage_context'))).toBe(true)
    expect(hasDataHubResult(transcript('read_file'))).toBe(false)
    expect(hasDataHubResult(transcript('mcp__agentx_agentx_database__query'))).toBe(false)
  })

  it('reads tool calls stored as JSON text', () => {
    const messages = transcript(SEARCH, { named: false })
    messages[1] = { ...messages[1], tool_calls: JSON.stringify(messages[1].tool_calls) }

    expect(hasDataHubResult(messages)).toBe(true)
  })
})

describe('exportSession', () => {
  it('refuses a chat holding Data Hub results, with nothing downloaded', async () => {
    getSessionMessages.mockResolvedValue({ messages: transcript(SEARCH), session_id: 's1' })

    await exportSession('s1', { title: 'Công tác phí' })

    expect(clicked).toEqual([])
    expect(notify).toHaveBeenCalledWith({
      kind: 'error',
      message: 'Cuộc trò chuyện này có kết quả từ Data Hub — chỉ được đọc trong Workmate, nên không xuất được.'
    })
    expect(notifyError).not.toHaveBeenCalled()
  })

  it('exports any other chat', async () => {
    getSessionMessages.mockResolvedValue({ messages: transcript('read_file'), session_id: 's1' })

    await exportSession('s1', { title: 'Plan' })

    expect(clicked).toEqual(['plan-s1.json'])
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success' }))
  })
})
