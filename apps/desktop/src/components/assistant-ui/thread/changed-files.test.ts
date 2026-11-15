import { describe, expect, it } from 'vitest'

import { type ChatMessagePart, upsertToolPart } from '@/lib/chat-messages'

import { deriveChangedFiles } from './changed-files'

const ESC = String.fromCharCode(27)

/**
 * What tui_gateway puts in `inline_diff` for a new file of `lines` lines: the
 * review header, the file line, the hunk line, and a preview capped at 80
 * rendered lines (agent/display `_MAX_INLINE_DIFF_LINES`) — 78 of the file's
 * own — closed by the "omitted" note.
 */
function cappedCreateDiff(name: string, lines: number): string {
  const body = Array.from({ length: Math.min(lines, 78) }, (_, i) => `${ESC}[32m+line ${i}${ESC}[0m`)

  const omitted =
    lines > 78 ? [`${ESC}[35m… omitted ${lines - 78} diff line(s) across 1 additional file(s)/section(s)${ESC}[0m`] : []

  return [
    '  ┊ review diff',
    `${ESC}[36ma/${name} → b/${name}${ESC}[0m`,
    `${ESC}[35m@@ -0,0 +1,${lines} @@${ESC}[0m`,
    ...body,
    ...omitted
  ].join('\n')
}

/** The part a live turn holds once the gateway's tool.complete has landed. */
function completed(parts: ChatMessagePart[], payload: Parameters<typeof upsertToolPart>[1]): ChatMessagePart[] {
  return upsertToolPart(parts, payload, 'complete')
}

describe('deriveChangedFiles', () => {
  it('reports the real size of a new file longer than the diff preview', () => {
    const parts = completed([], {
      args: { content: '...', path: '/work/analysis.py' },
      inline_diff: cappedCreateDiff('analysis.py', 267),
      inline_diff_stats: { added: 267, removed: 0 },
      name: 'write_file',
      result: { bytes_written: 9000 },
      tool_id: 'call-1'
    })

    expect(deriveChangedFiles(parts)).toEqual([
      { added: 267, name: 'analysis.py', path: '/work/analysis.py', removed: 0 }
    ])
  })

  it('sums the real stats of every edit to the same file', () => {
    const written = completed([], {
      args: { content: '...', path: '/work/gen_data.py' },
      inline_diff: cappedCreateDiff('gen_data.py', 141),
      inline_diff_stats: { added: 141, removed: 0 },
      name: 'write_file',
      result: { bytes_written: 5000 },
      tool_id: 'call-1'
    })

    const patched = completed(written, {
      args: { path: '/work/gen_data.py' },
      inline_diff: '  ┊ review diff\na/gen_data.py → b/gen_data.py\n@@ -1,2 +1,2 @@\n-old\n+new',
      inline_diff_stats: { added: 7, removed: 7 },
      name: 'patch',
      result: { success: true },
      tool_id: 'call-2'
    })

    expect(deriveChangedFiles(patched)).toEqual([
      { added: 148, name: 'gen_data.py', path: '/work/gen_data.py', removed: 7 }
    ])
  })

  it('counts the diff itself when the backend sent no stats (older transcripts)', () => {
    const parts = completed([], {
      args: { path: '/work/notes.md' },
      inline_diff: '  ┊ review diff\na/notes.md → b/notes.md\n@@ -1,2 +1,3 @@\n-old\n+new\n+more',
      name: 'patch',
      result: { success: true },
      tool_id: 'call-1'
    })

    expect(deriveChangedFiles(parts)).toEqual([{ added: 2, name: 'notes.md', path: '/work/notes.md', removed: 1 }])
  })

  it('counts the diff itself when the stats are not usable numbers', () => {
    const parts = completed([], {
      args: { path: '/work/notes.md' },
      inline_diff: '  ┊ review diff\na/notes.md → b/notes.md\n@@ -1 +1 @@\n-old\n+new',
      inline_diff_stats: { added: -3, removed: 'many' } as never,
      name: 'patch',
      result: { success: true },
      tool_id: 'call-1'
    })

    expect(deriveChangedFiles(parts)).toEqual([{ added: 1, name: 'notes.md', path: '/work/notes.md', removed: 1 }])
  })
})
