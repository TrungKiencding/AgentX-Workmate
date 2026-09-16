import type { ChatMessage } from '@/lib/chat-messages'

export function lastVisibleMessageIsUser(messages: ChatMessage[]): boolean {
  // Allocation-free reverse scan — runs in a hot $messages computed.
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (!messages[i].hidden) {
      return messages[i].role === 'user'
    }
  }

  return false
}

