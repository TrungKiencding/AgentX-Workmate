import { describe, expect, it } from 'vitest'

import type { ChatMessage } from '@/lib/chat-messages'

import { finalizeInterruptedMessages, truncateSubmitParams } from './rewind'

describe('truncateSubmitParams', () => {
  it('omits truncation fields when no ordinal is set', () => {
    expect(truncateSubmitParams(undefined)).toEqual({})
  })

  it('confirms intent for every ordinal, and the empty edge only for ordinal 0', () => {
    expect(truncateSubmitParams(0)).toEqual({
      confirm_truncate: true,
      truncate_before_user_ordinal: 0,
      confirm_empty_truncate: true
    })
    expect(truncateSubmitParams(1)).toEqual({
      confirm_truncate: true,
      truncate_before_user_ordinal: 1
    })
  })

  it('never sends an ordinal without the intent flag the gateway requires', () => {
    // The gateway drops history only for a submit that declares itself a
    // rewind. An ordinal built here without confirm_truncate would be refused
    // (and, on an older gateway, would truncate silently).
    for (const ordinal of [0, 1, 2, 7]) {
      const params = truncateSubmitParams(ordinal)

      expect(params.truncate_before_user_ordinal).toBe(ordinal)
      expect(params.confirm_truncate).toBe(true)
    }
  })
})

describe('finalizeInterruptedMessages', () => {
  const user: ChatMessage = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Viết một bài luận' }] }

  // Stop while the model was still thinking used to drop the whole reply:
  // the question was left with no trace of what happened to it.
  it('keeps a stopped reply that only has reasoning so far, and marks it stopped', () => {
    const thinking: ChatMessage = {
      id: 'stream-1',
      role: 'assistant',
      pending: true,
      parts: [{ type: 'reasoning', text: 'The user wants an essay about Hà Nội…' }]
    }

    const settled = finalizeInterruptedMessages([user, thinking], 'stream-1', { stopped: true })

    expect(settled).toHaveLength(2)
    expect(settled[1]).toMatchObject({ id: 'stream-1', pending: false, stopped: true })
  })

  it('keeps the tool rows a stopped turn already ran', () => {
    const ranTools: ChatMessage = {
      id: 'stream-2',
      role: 'assistant',
      pending: true,
      parts: [{ type: 'tool-call', toolCallId: 't1', toolName: 'web_search', args: {}, argsText: '{}', result: {} }]
    }

    expect(finalizeInterruptedMessages([user, ranTools], 'stream-2', { stopped: true })).toHaveLength(2)
  })

  it('still drops a bubble with nothing in it', () => {
    const empty: ChatMessage = {
      id: 'stream-3',
      role: 'assistant',
      pending: true,
      parts: [
        { type: 'text', text: '  ' },
        { type: 'reasoning', text: '' }
      ]
    }

    expect(finalizeInterruptedMessages([user, empty], 'stream-3', { stopped: true })).toEqual([user])
  })

  it('does not call a reply stopped when the turn ended for another reason', () => {
    const partial: ChatMessage = {
      id: 'stream-4',
      role: 'assistant',
      pending: true,
      parts: [{ type: 'text', text: 'Hà Nội có lịch sử' }]
    }

    const [, settled] = finalizeInterruptedMessages([user, partial], 'stream-4')

    expect(settled.pending).toBe(false)
    expect(settled.stopped).toBeUndefined()
  })
})
