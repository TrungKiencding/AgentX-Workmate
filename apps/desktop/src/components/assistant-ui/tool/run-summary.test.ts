import { describe, expect, it } from 'vitest'

import { TRANSLATIONS } from '@/i18n/catalog'

import { summarizeToolRun, type ToolCallLike, toolPresentVerb } from './run-summary'

const en = TRANSLATIONS.en.assistant.toolRun
const vi = TRANSLATIONS.vi.assistant.toolRun

function tool(toolName: string, args: Record<string, unknown> = {}, result?: unknown): ToolCallLike {
  return { args, result, toolCallId: `${toolName}-${Math.random()}`, toolName }
}

const read = (path: string) => tool('read_file', { path }, { content: '' })
const searched = (query: string) => tool('search_files', { query }, { hits: [] })
const ran = (command: string) => tool('terminal', { command }, { exit_code: 0 })

const settled = (tools: ToolCallLike[]) => summarizeToolRun(tools, false, en)
const running = (tools: ToolCallLike[]) => summarizeToolRun(tools, true, en)

// A run only ever holds ephemeral activity: reads, searches, commands. File
// edits and other cards are split out before a run is summarized, so there is
// no "Edited …" clause to test here — that work shows as its own diff card.
describe('summarizeToolRun', () => {
  it('names a lone target and counts the rest', () => {
    expect(settled([searched('toolRuns'), read('a.ts'), read('b.ts'), read('c.ts')])).toBe('Explored 4 files')
  })

  it('orders clauses explore then run regardless of call order', () => {
    expect(settled([ran('ls'), read('a.ts'), read('b.ts'), ran('pwd'), ran('id')])).toBe(
      'Explored 2 files, ran 3 commands'
    )
  })

  it('counts commands rather than naming them once they have run', () => {
    expect(settled([ran('git status')])).toBe('Ran 1 command')
    expect(settled([read('status.ts'), ran('a'), ran('b'), ran('c'), ran('d'), ran('e')])).toBe(
      'Explored status.ts, ran 5 commands'
    )
  })

  it('puts the running category in the present tense and leaves the rest past', () => {
    expect(running([read('a.ts'), tool('read_file', { path: 'b.ts' }), ran('x'), ran('y')])).toBe(
      'Exploring 2 files, ran 2 commands'
    )
  })

  it('names the command that is still running', () => {
    expect(running([tool('terminal', { command: 'npm run typecheck' })])).toMatch(/^Running /)
  })

  // Sequential calls leave a gap where the run is still going but nothing is
  // pending. Falling back to past tense there contradicted the ticker still
  // scrolling underneath, so the most recent call carries the present tense.
  it('stays in the present tense between two sequential calls', () => {
    expect(running([read('a.ts'), ran('x'), ran('y')])).toBe('Explored a.ts, running 2 commands')
  })

  // A turn can end — or the agent can simply move on — with a call that never
  // got a result. The run is history at that point and has to read as history,
  // or it narrates work that stopped happening and never offers its toggle.
  it('reads a run the turn left unresolved as finished', () => {
    expect(settled([read('a.ts'), tool('search_files', { query: 'toolRuns' })])).toBe('Explored 2 files')
  })

  // The tool is `session_search`; listing it as `session_search_recall` left
  // it narrated as "Using 1 tool".
  it('reads a search through earlier chats as exploring', () => {
    expect(toolPresentVerb('session_search', en)).toBe('Exploring')
    expect(settled([tool('session_search', { query: 'auth refactor' }, { count: 2 })])).toBe('Explored auth refactor')
  })

  // Reading a skill or listing them is a lookup, as read_file and list_files
  // are; left out, every run that loaded a skill ended "used 1 tool". A skill
  // change is a write, and stays with the other tools.
  it('reads loading a skill as exploring', () => {
    const viewed = tool('skill_view', { name: 'deploy' }, { success: true })

    expect(toolPresentVerb('skill_view', en)).toBe('Exploring')
    expect(toolPresentVerb('skills_list', en)).toBe('Exploring')
    expect(settled([viewed, read('a.ts'), ran('ls')])).toBe('Explored 2 files, ran 1 command')
    expect(summarizeToolRun([viewed, read('a.ts'), ran('ls')], false, vi)).toBe('Đã xem 2 tệp, đã chạy 1 lệnh')
    expect(settled([tool('skill_manage', { action: 'patch', name: 'deploy' }, { success: true })])).toBe('Used 1 tool')
  })

  it("narrates in the app's language, with the catalog owning the nouns", () => {
    const mcp = (name: string) => tool(name)

    expect(summarizeToolRun([mcp('mcp_webmate_webmate'), mcp('mcp_webmate_search')], true, vi)).toBe(
      'Đang dùng 2 công cụ'
    )
    expect(summarizeToolRun([read('a.ts'), ran('x'), ran('y')], false, vi)).toBe('Đã xem a.ts, đã chạy 2 lệnh')
    expect(toolPresentVerb('terminal', vi)).toBe('Đang chạy')
    expect(toolPresentVerb('terminal', en)).toBe('Running')
  })
})
