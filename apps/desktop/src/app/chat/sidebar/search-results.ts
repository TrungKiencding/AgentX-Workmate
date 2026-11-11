import { sessionMatchesSearch } from '@/lib/session-search'
import type { SessionInfo, SessionSearchResult } from '@/types/hermes'

/**
 * The sidebar's search results, as a pure merge of what is loaded and what the
 * full-text search returned.
 *
 * Two bugs lived in the inline version (pilot feedback 2026-11-10):
 *
 *  - A conversation deleted from the results stayed in them. The server hits
 *    were a private copy that no delete touched, and a hit with no loaded
 *    session behind it was rebuilt as a row — so the deleted chat came straight
 *    back until the query was retyped.
 *  - A hit outside the loaded page was titled with its match snippet, which is
 *    whatever text matched: tool output, escaped JSON, a CSS rule. The endpoint
 *    already sends the session's own title and preview; they were dropped.
 */

/** FTS marks the matched term `>>>like this<<<` and elides with `...`. */
const SNIPPET_MARKS = />>>|<<</g

/**
 * A match snippet as one readable line: marks removed, JSON escapes undone
 * (snippets often come from tool arguments stored as JSON), whitespace folded.
 */
export function cleanSearchSnippet(snippet: null | string | undefined): string {
  return (snippet ?? '')
    .replace(SNIPPET_MARKS, '')
    .replace(/\\[nrt]/g, ' ')
    .replace(/\\(["'\\/])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:\.{3}|…)\s*|\s*(?:\.{3}|…)$/g, '')
}

/**
 * A row for a hit that is not in the loaded sessions. Titled the way every
 * other row is — the session's title, else its first message — and only when
 * the session has neither does the cleaned snippet stand in.
 */
export function searchResultToSession(result: SessionSearchResult): SessionInfo {
  const started = result.started_at ?? result.session_started ?? Date.now() / 1000

  return {
    archived: Boolean(result.archived),
    cwd: null,
    ended_at: result.ended_at ?? null,
    id: result.session_id,
    _lineage_root_id: result.lineage_root ?? null,
    input_tokens: result.input_tokens ?? 0,
    is_active: Boolean(result.is_active),
    last_active: result.last_active ?? started,
    message_count: result.message_count ?? 0,
    model: result.model ?? null,
    output_tokens: result.output_tokens ?? 0,
    preview: result.preview?.trim() || cleanSearchSnippet(result.snippet) || null,
    source: result.source ?? null,
    started_at: started,
    title: result.title?.trim() || null,
    tool_call_count: result.tool_call_count ?? 0
  }
}

const hitIds = (match: SessionSearchResult): string[] =>
  [match.session_id, match.lineage_root].filter((id): id is string => Boolean(id))

/** Server hits minus the conversations the user has just deleted or archived. */
export function pruneRemovedSearchMatches(
  matches: readonly SessionSearchResult[],
  removed: ReadonlySet<string>
): SessionSearchResult[] {
  return removed.size ? matches.filter(match => !hitIds(match).some(id => removed.has(id))) : [...matches]
}

/**
 * Loaded sessions that match the query (instant, client-side) followed by the
 * server's hits for everything outside the loaded page. A removed conversation
 * appears in neither half.
 */
export function mergeSearchResults({
  loaded,
  query,
  removed,
  serverMatches,
  sessionByAnyId
}: {
  loaded: readonly SessionInfo[]
  query: string
  removed: ReadonlySet<string>
  serverMatches: readonly SessionSearchResult[]
  sessionByAnyId: ReadonlyMap<string, SessionInfo>
}): SessionInfo[] {
  if (!query) {
    return []
  }

  const out = new Map<string, SessionInfo>()

  for (const session of loaded) {
    if (!removed.has(session.id) && sessionMatchesSearch(session, query)) {
      out.set(session.id, session)
    }
  }

  for (const match of pruneRemovedSearchMatches(serverMatches, removed)) {
    if (out.has(match.session_id)) {
      continue
    }

    const known = sessionByAnyId.get(match.session_id)

    if (known && (removed.has(known.id) || out.has(known.id))) {
      continue
    }

    out.set(match.session_id, known ?? searchResultToSession(match))
  }

  return [...out.values()]
}
