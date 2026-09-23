import { describe, expect, it } from 'vitest'

import { latestSessionTodos, parseTodos, todoCallResult } from './todos'

describe('parseTodos', () => {
  it('parses todo arrays with valid ids, content, and statuses', () => {
    expect(
      parseTodos([
        { content: 'Gather ingredients', id: 'prep', status: 'completed' },
        { content: 'Boil water', id: 'boil', status: 'in_progress' },
        { content: 'Serve', id: 'serve', status: 'pending' }
      ])
    ).toEqual([
      { content: 'Gather ingredients', id: 'prep', status: 'completed' },
      { content: 'Boil water', id: 'boil', status: 'in_progress' },
      { content: 'Serve', id: 'serve', status: 'pending' }
    ])
  })

  it('parses nested todo payloads from wrapped objects and JSON strings', () => {
    expect(parseTodos({ todos: [{ content: 'Plate', id: 'plate', status: 'pending' }] })).toEqual([
      { content: 'Plate', id: 'plate', status: 'pending' }
    ])

    expect(parseTodos('{"todos":[{"id":"plate","content":"Plate","status":"pending"}]}')).toEqual([
      { content: 'Plate', id: 'plate', status: 'pending' }
    ])
  })

  it('returns null for non-todo payloads', () => {
    expect(parseTodos(undefined)).toBeNull()
    expect(parseTodos('not json')).toBeNull()
    expect(parseTodos({ message: 'no todos here' })).toBeNull()
  })
})

describe('latestSessionTodos', () => {
  const todoPart = (todos: unknown, extra: Record<string, unknown> = {}) => ({
    type: 'tool-call',
    toolCallId: 't1',
    toolName: 'todo',
    args: { todos },
    ...extra
  })

  it('returns the last todo list across the transcript (result beats args)', () => {
    const messages = [
      { parts: [todoPart([{ content: 'Old', id: 'a', status: 'pending' }])] },
      { parts: [{ type: 'text', text: 'hi' }] },
      {
        parts: [
          todoPart([{ content: 'Stale', id: 'a', status: 'pending' }], {
            result: { todos: [{ content: 'Fresh', id: 'a', status: 'completed' }] }
          })
        ]
      }
    ]

    expect(latestSessionTodos(messages)).toEqual([{ content: 'Fresh', id: 'a', status: 'completed' }])
  })

  it('prefers the live carried `todos` field over args', () => {
    const messages = [
      {
        parts: [
          todoPart([{ content: 'Args', id: 'a', status: 'pending' }], {
            todos: [{ content: 'Live', id: 'a', status: 'in_progress' }]
          })
        ]
      }
    ]

    expect(latestSessionTodos(messages)).toEqual([{ content: 'Live', id: 'a', status: 'in_progress' }])
  })

  it('returns null when no todo tool calls exist', () => {
    expect(latestSessionTodos([{ parts: [{ type: 'text', text: 'hi' }] }])).toBeNull()
    expect(latestSessionTodos([])).toBeNull()
  })

  it('skips a rejected todo call, so the list before it still stands', () => {
    const plan = [
      { content: 'Shrink the CTA', id: '1', status: 'completed' },
      { content: 'Drop the nav item', id: '2', status: 'in_progress' }
    ]

    const messages = [
      { parts: [todoPart(plan, { result: { todos: plan } })] },
      {
        parts: [
          todoPart([{ id: '3', status: 'pending' }], {
            result: '{"error": "New todo items need a short task description in \'content\'"}'
          })
        ]
      }
    ]

    expect(latestSessionTodos(messages)).toEqual(plan)
  })
})

describe('todoCallResult', () => {
  const full = [
    { content: 'Shrink the CTA', id: '1', status: 'completed' },
    { content: 'Drop the nav item', id: '2', status: 'in_progress' },
    { content: 'Scroll spy', id: '3', status: 'pending' }
  ]

  it('reads the full list the tool returned, not the partial update it was sent', () => {
    const mergeCall = {
      args: {
        merge: true,
        todos: [
          { id: '1', status: 'completed' },
          { id: '2', status: 'in_progress' }
        ]
      },
      result: { summary: { total: 3 }, todos: full }
    }

    expect(todoCallResult(mergeCall)).toEqual(full)
  })

  it('prefers the gateway-lifted `todos` field', () => {
    expect(todoCallResult({ result: { todos: [] }, todos: full })).toEqual(full)
  })

  it('has no list for a call that failed or has not finished', () => {
    expect(todoCallResult({ result: { error: 'todos must be a list, got int' } })).toBeNull()
    expect(todoCallResult({})).toBeNull()
  })
})
