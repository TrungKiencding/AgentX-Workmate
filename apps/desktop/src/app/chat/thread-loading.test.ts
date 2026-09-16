import { describe, expect, it } from 'vitest'

import type { ChatMessage } from '@/lib/chat-messages'

import { lastVisibleMessageIsUser } from './thread-loading'

function message(id: string, role: ChatMessage['role'], hidden = false): ChatMessage {
  return {
    id,
    role,
    parts: [{ type: 'text', text: `${role}:${id}` }],
    hidden
  }
}

describe('lastVisibleMessageIsUser', () => {
  it('skips hidden trailing messages', () => {
    const messages = [message('u1', 'user'), message('a1', 'assistant', true)]

    expect(lastVisibleMessageIsUser(messages)).toBe(true)
  })

  it('is false once an assistant message is the last visible one', () => {
    const messages = [message('u1', 'user'), message('a1', 'assistant')]

    expect(lastVisibleMessageIsUser(messages)).toBe(false)
  })

  it('is false for an empty transcript', () => {
    expect(lastVisibleMessageIsUser([])).toBe(false)
  })
})
