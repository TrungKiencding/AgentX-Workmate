import { cleanup, render } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { type ChatMessagePart, upsertToolPart } from '@/lib/chat-messages'
import { $toolDisclosureStates } from '@/store/tool-view'

vi.mock('@assistant-ui/react', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAuiState: (select: (state: unknown) => unknown) =>
    select({ message: { id: 'msg-1', status: { type: 'complete' } }, thread: { isRunning: false } })
}))

const { ToolFallback } = await import('./fallback')

type RowProps = ComponentProps<typeof ToolFallback>
type ToolCallPart = Extract<ChatMessagePart, { type: 'tool-call' }>

/** A new 200-line file as the gateway reports it: a preview capped at 78 of its lines. */
function writeFilePart(stats?: { added: number; removed: number }): ToolCallPart {
  const preview = Array.from({ length: 78 }, (_, i) => `+line ${i}`)

  const [part] = upsertToolPart(
    [],
    {
      args: { content: '...', path: '/work/analysis.py' },
      inline_diff: [
        '  ┊ review diff',
        'a/analysis.py → b/analysis.py',
        '@@ -0,0 +1,200 @@',
        ...preview,
        '… omitted 122 diff line(s) across 1 additional file(s)/section(s)'
      ].join('\n'),
      ...(stats ? { inline_diff_stats: stats } : {}),
      name: 'write_file',
      result: { bytes_written: 9000 },
      tool_id: 'call-1'
    },
    'complete'
  )

  return part as ToolCallPart
}

function headerText({ args, result, toolCallId, toolName }: ToolCallPart): string {
  const row = { args, result, toolCallId, toolName } as RowProps

  return render(<ToolFallback {...row} />).container.textContent ?? ''
}

afterEach(() => {
  cleanup()
  $toolDisclosureStates.set({})
})

describe('file edit row line counts', () => {
  it('shows the real size of the change, not the size of the capped preview', () => {
    const text = headerText(writeFilePart({ added: 200, removed: 0 }))

    expect(text).toContain('+200')
    expect(text).not.toContain('+78')
  })

  it('counts the preview when the backend sent no stats', () => {
    expect(headerText(writeFilePart())).toContain('+78')
  })
})
