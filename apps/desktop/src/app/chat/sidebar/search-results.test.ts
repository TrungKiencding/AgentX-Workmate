import { describe, expect, it } from 'vitest'

import type { SessionInfo, SessionSearchResult } from '@/types/hermes'

import {
  cleanSearchSnippet,
  mergeSearchResults,
  pruneRemovedSearchMatches,
  searchResultToSession
} from './search-results'

function session(over: Partial<SessionInfo> & { id: string }): SessionInfo {
  return {
    archived: false,
    cwd: null,
    ended_at: null,
    input_tokens: 0,
    is_active: false,
    last_active: 100,
    message_count: 2,
    model: null,
    output_tokens: 0,
    preview: null,
    source: 'desktop',
    started_at: 100,
    title: null,
    tool_call_count: 0,
    ...over
  }
}

function hit(over: Partial<SessionSearchResult> & { session_id: string }): SessionSearchResult {
  return { model: null, role: 'tool', session_started: 50, snippet: '', source: 'desktop', ...over }
}

const NONE: ReadonlySet<string> = new Set()

function merge(over: Partial<Parameters<typeof mergeSearchResults>[0]>) {
  const loaded = over.loaded ?? []

  return mergeSearchResults({
    loaded,
    query: 'agent',
    removed: NONE,
    serverMatches: [],
    sessionByAnyId: new Map(loaded.map(row => [row.id, row])),
    ...over
  })
}

describe('cleanSearchSnippet', () => {
  it('drops the match marks and reads as one line', () => {
    expect(cleanSearchSnippet('...tiêu chí >>>nghiệm thu<<< AI\n  agent')).toBe('tiêu chí nghiệm thu AI agent')
  })

  // The rows in the pilot's screenshot: "…n ContainerDb(state, \\\"state…".
  it('undoes the JSON escapes of a tool-argument match', () => {
    expect(cleanSearchSnippet('...\\n ContainerDb(state, \\"state\\")')).toBe('ContainerDb(state, "state")')
  })

  it('is empty for nothing', () => {
    expect(cleanSearchSnippet(null)).toBe('')
    expect(cleanSearchSnippet('  ...  ')).toBe('')
  })
})

describe('searchResultToSession', () => {
  it("titles the row with the session's own title, not the text that matched", () => {
    const row = searchResultToSession(
      hit({
        last_active: 900,
        message_count: 14,
        preview: 'Viết tiêu chí nghiệm thu',
        session_id: 's1',
        snippet: '...wrap{max-width:1260px;mar...',
        title: 'Tiêu chí nghiệm thu AI agent'
      })
    )

    expect(row.title).toBe('Tiêu chí nghiệm thu AI agent')
    expect(row.preview).toBe('Viết tiêu chí nghiệm thu')
    expect(row.last_active).toBe(900)
    expect(row.message_count).toBe(14)
  })

  it('falls back to the first message for an untitled session', () => {
    const row = searchResultToSession(
      hit({ preview: 'Thiết kế chi tiết AgentX', session_id: 's1', snippet: '...nOnly when the consumer is *...' })
    )

    expect(row.title).toBeNull()
    expect(row.preview).toBe('Thiết kế chi tiết AgentX')
  })

  it('uses the cleaned snippet only when the session has neither', () => {
    const row = searchResultToSession(hit({ session_id: 's1', snippet: '...\\n>>>agent<<< notes' }))

    expect(row.preview).toBe('agent notes')
  })

  it('carries the archived flag and the lineage root', () => {
    const row = searchResultToSession(hit({ archived: true, lineage_root: 'root', session_id: 'tip' }))

    expect(row.archived).toBe(true)
    expect(row._lineage_root_id).toBe('root')
  })
})

describe('mergeSearchResults', () => {
  it('lists matching loaded sessions first, then server hits outside the loaded page', () => {
    const loaded = [session({ id: 'a', title: 'AI agent plan' }), session({ id: 'b', title: 'Groceries' })]

    const rows = merge({
      loaded,
      serverMatches: [hit({ session_id: 'a' }), hit({ session_id: 'z', title: 'Old agent chat' })]
    })

    expect(rows.map(row => row.id)).toEqual(['a', 'z'])
    expect(rows[1].title).toBe('Old agent chat')
  })

  it('returns nothing without a query', () => {
    expect(merge({ query: '', serverMatches: [hit({ session_id: 'z' })] })).toEqual([])
  })

  // The reported bug: right-click → delete on a result left the row in place.
  it('drops a deleted conversation that only the server hits knew about', () => {
    const serverMatches = [hit({ session_id: 'gone', title: 'Agent notes' }), hit({ session_id: 'kept', title: 'Agent' })]

    expect(merge({ serverMatches }).map(row => row.id)).toEqual(['gone', 'kept'])
    expect(merge({ removed: new Set(['gone']), serverMatches }).map(row => row.id)).toEqual(['kept'])
  })

  it('drops a deleted conversation that was loaded when the hits were fetched', () => {
    // The optimistic delete has already taken it out of the loaded list; the
    // stale hit must not rebuild it.
    const rows = merge({
      loaded: [],
      removed: new Set(['a']),
      serverMatches: [hit({ session_id: 'a', title: 'AI agent plan' })]
    })

    expect(rows).toEqual([])
  })

  it('matches a removal by lineage root as well as by tip', () => {
    const serverMatches = [hit({ lineage_root: 'root', session_id: 'tip', title: 'Agent' })]

    expect(merge({ removed: new Set(['root']), serverMatches })).toEqual([])
  })

  it('does not list one conversation twice when a hit names its older id', () => {
    const loaded = [session({ id: 'tip', title: 'AI agent plan' })]

    const rows = merge({
      loaded,
      serverMatches: [hit({ session_id: 'old' })],
      sessionByAnyId: new Map([
        ['tip', loaded[0]],
        ['old', loaded[0]]
      ])
    })

    expect(rows.map(row => row.id)).toEqual(['tip'])
  })

  it('brings a conversation back when its delete failed and the tombstone is lifted', () => {
    const serverMatches = [hit({ session_id: 'a', title: 'Agent' })]

    expect(merge({ removed: new Set(['a']), serverMatches })).toEqual([])
    expect(merge({ removed: NONE, serverMatches }).map(row => row.id)).toEqual(['a'])
  })
})

describe('pruneRemovedSearchMatches', () => {
  it('returns the hits untouched when nothing was removed', () => {
    const matches = [hit({ session_id: 'a' })]

    expect(pruneRemovedSearchMatches(matches, NONE)).toEqual(matches)
  })
})
