import { describe, expect, it } from 'vitest'

import { type ChatMessage, type ChatMessagePart, chatMessageText } from '@/lib/chat-messages'

import { preserveLocalPendingTurnMessages, reconcileResumeMessages } from './utils'

// Pilot feedback 2026-11: "when I go back into a task that was stopped earlier
// and send a message, the message sits ABOVE the bot's reasoning" — the new
// prompt rendered at the top with the stopped turn's tool runs and reasoning
// underneath it.
//
// A stopped turn's rows keep their live-stream ids (`assistant-stream-*`) for
// the life of the view; Stop only clears `pending`. The stored transcript
// folds that turn into ONE assistant row, so the local rows have no text-equal
// twin there. Every later reconcile then took them for an uncommitted live
// reply and re-appended them at the end of the transcript — after whatever the
// person had sent since.

const text = (value: string): ChatMessagePart => ({ type: 'text', text: value }) as ChatMessagePart

const row = (id: string, role: ChatMessage['role'], parts: ChatMessagePart[], extra: Partial<ChatMessage> = {}) =>
  ({ id, role, parts, ...extra }) as ChatMessage

const tool = (id: string): ChatMessagePart =>
  ({ type: 'tool-call', toolCallId: id, toolName: 'terminal', result: 'done' }) as ChatMessagePart

const reasoning = (value: string): ChatMessagePart => ({ type: 'reasoning', text: value }) as ChatMessagePart

// What the view holds after: prompt → (tool, reasoning, text) ×2 → Stop → "continue".
const STOPPED_A = row('assistant-stream-1', 'assistant', [tool('c1'), reasoning('plan'), text('Cả 3 nguồn khớp hoàn toàn.')], {
  interim: true,
  pending: false
})

const STOPPED_B = row('assistant-stream-2', 'assistant', [tool('c2'), reasoning('check'), text('Kiểm tra thứ tự vị trí:')], {
  pending: false
})

const LOCAL = [
  row('m1', 'user', [text('Phân tích bảng xếp hạng')]),
  STOPPED_A,
  STOPPED_B,
  row('user-optimistic-2', 'user', [text('continue')])
]

// What the backend has once "continue" is accepted: the stopped turn folded
// into one stored row, then the new prompt.
const STORED = [
  row('m1', 'user', [text('Phân tích bảng xếp hạng')]),
  row('m2', 'assistant', [text('Cả 3 nguồn khớp hoàn toàn.\n\nKiểm tra thứ tự vị trí:')]),
  row('m3', 'user', [text('continue')])
]

const order = (messages: ChatMessage[]) => messages.map(message => `${message.role}:${chatMessageText(message).slice(0, 18)}`)

describe('a message sent after a stopped turn stays below it', () => {
  it('does not re-append the stopped turn after the new prompt', () => {
    const merged = preserveLocalPendingTurnMessages(STORED, LOCAL)
    const lastUser = merged.map(message => message.role).lastIndexOf('user')

    // Nothing of the stopped turn may follow the newest prompt.
    expect(merged.slice(lastUser + 1)).toEqual([])
    expect(order(merged)).toEqual(order(STORED))
  })

  it('keeps the newest prompt last through a full resume reconcile', () => {
    const merged = reconcileResumeMessages(STORED, LOCAL)
    const texts = merged.map(message => chatMessageText(message))

    expect(texts[texts.length - 1]).toBe('continue')
    expect(merged.filter(message => message.role === 'user')).toHaveLength(2)
  })

  it('still keeps a live reply that follows the newest prompt', () => {
    // The turn "continue" started is streaming: that row IS the current turn.
    const live = row('assistant-stream-3', 'assistant', [tool('c3'), text('Đang chạy tiếp…')], { pending: true })
    const merged = preserveLocalPendingTurnMessages(STORED, [...LOCAL, live])

    expect(merged[merged.length - 1].id).toBe('assistant-stream-3')
    expect(merged.filter(message => message.id.startsWith('assistant-stream-'))).toHaveLength(1)
  })

  it('still keeps a settled reply the backend has not committed yet', () => {
    // message.complete arrived, the stored transcript has not caught up: the
    // local row is the only copy of the answer and nobody has spoken since.
    const settled = row('assistant-stream-9', 'assistant', [text('Câu trả lời vừa xong')], { pending: false })
    const stored = [row('m1', 'user', [text('Hỏi')])]
    const merged = preserveLocalPendingTurnMessages(stored, [row('m1', 'user', [text('Hỏi')]), settled])

    expect(merged.map(message => message.id)).toEqual(['m1', 'assistant-stream-9'])
  })
})

describe('a stopped turn the backend never committed', () => {
  // Stopped before anything was stored: the local rows are the only copy.
  const STORED_WITHOUT_IT = [row('m1', 'user', [text('Phân tích bảng xếp hạng')]), row('m3', 'user', [text('continue')])]

  it('keeps its rows, above the prompt that followed them', () => {
    const merged = preserveLocalPendingTurnMessages(STORED_WITHOUT_IT, LOCAL)

    expect(merged.map(message => message.id)).toEqual(['m1', 'assistant-stream-1', 'assistant-stream-2', 'm3'])
  })

  it('puts the live reply after the prompt, not among the old rows', () => {
    const live = row('assistant-stream-3', 'assistant', [text('Đang chạy tiếp…')], { pending: true })
    const merged = preserveLocalPendingTurnMessages(STORED_WITHOUT_IT, [...LOCAL, live])

    expect(merged.map(message => message.id)).toEqual([
      'm1',
      'assistant-stream-1',
      'assistant-stream-2',
      'm3',
      'assistant-stream-3'
    ])
  })
})
