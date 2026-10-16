import { cleanup, fireEvent, render } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FALLBACK_LOCALE, setRuntimeI18nLocale } from '@/i18n'
import { type ChatMessagePart, toChatMessages, upsertToolPart } from '@/lib/chat-messages'
import { $toolDisclosureStates } from '@/store/tool-view'

vi.mock('@assistant-ui/react', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAuiState: (select: (state: unknown) => unknown) =>
    select({ message: { id: 'msg-1', status: { type: 'complete' } }, thread: { isRunning: false } })
}))

const { ToolFallback } = await import('./fallback')

type RowProps = ComponentProps<typeof ToolFallback>
type ToolCallPart = Extract<ChatMessagePart, { type: 'tool-call' }>

const SKILL_MD = [
  '---',
  'name: deploy',
  'description: Use when shipping a release. Runs 3 steps.',
  '---',
  '',
  '# Deploy',
  '',
  '1. Build with `npm run build`',
  '2. Test',
  '3. Ship',
  ''
].join('\n')

/** What skill_view returns for the skill (tools/skills_tool.py), trimmed. */
const VIEWED = {
  content: SKILL_MD,
  description: 'Use when shipping a release. Runs 3 steps.',
  name: 'deploy',
  path: 'devops/deploy/SKILL.md',
  readiness_status: 'available',
  success: true,
  tags: ['release']
}

/** What skills_list returns for two skills. */
const LISTED = {
  categories: ['devops'],
  count: 2,
  hint: 'Use skill_view(name) to see full content, tags, and linked files',
  skills: [
    { category: 'devops', description: 'Use when shipping a release.', name: 'deploy' },
    { category: 'devops', description: 'Kubernetes helpers', name: 'k8s' }
  ],
  success: true
}

/**
 * The row the running app builds: tool.start carries the gateway's preview of
 * the call (`_tool_ctx`), tool.complete the args and the result.
 */
function liveCall(toolName: string, args: Record<string, unknown>, context: string, result: unknown): ToolCallPart {
  const started = upsertToolPart([], { context, name: toolName, tool_id: 'call-1' }, 'running')

  const [part] = upsertToolPart(
    started,
    { args, duration_s: 0.004, name: toolName, result, tool_id: 'call-1' },
    'complete'
  )

  return part as ToolCallPart
}

/** The same row reloaded from the stored session: no preview in its args. */
function reloadedCall(toolName: string, args: Record<string, unknown>, result: unknown): ToolCallPart {
  const messages = toChatMessages([
    { content: 'Ship the release', role: 'user', timestamp: 1 },
    {
      content: '',
      role: 'assistant',
      timestamp: 2,
      tool_calls: [{ function: { arguments: JSON.stringify(args), name: toolName }, id: 'call-1' }]
    },
    { content: JSON.stringify(result), role: 'tool', timestamp: 3, tool_call_id: 'call-1', tool_name: toolName }
  ])

  return messages.flatMap(message => message.parts).find(part => part.type === 'tool-call') as ToolCallPart
}

function renderPart({ args, result, toolCallId, toolName }: ToolCallPart) {
  const row = { args, result, toolCallId, toolName } as RowProps

  return render(<ToolFallback {...row} />).container
}

/** Opens the row, failing if it has no toggle to open. */
function expand(container: HTMLElement) {
  const toggle = container.querySelector('[aria-expanded]')

  expect(toggle).not.toBeNull()
  fireEvent.click(toggle!)
  expect(toggle?.getAttribute('aria-expanded')).toBe('true')
}

/** How many times the row paints `text`. */
function timesShown(container: HTMLElement, text: string): number {
  return (container.textContent ?? '').split(text).length - 1
}

/** What the opened row painted: the markdown's heading and list, or code. */
function opened(container: HTMLElement) {
  return {
    code: container.querySelector('pre')?.textContent ?? null,
    heading: container.querySelector('h1')?.textContent ?? null,
    items: Array.from(container.querySelectorAll('li'), item => item.textContent?.trim() ?? '')
  }
}

afterEach(() => {
  cleanup()
  $toolDisclosureStates.set({})
  setRuntimeI18nLocale(FALLBACK_LOCALE)
})

const BODY = { code: null, heading: 'Deploy', items: ['Build with npm run build', 'Test', 'Ship'] }

// skill_view opened onto "Name", "Description", then "Content: --- name: …":
// the SKILL.md again, frontmatter first, clipped to one line.
describe('opened skill_view row', () => {
  it('opens onto the skill as markdown, without its frontmatter', () => {
    const container = renderPart(liveCall('skill_view', { name: 'deploy' }, 'deploy', VIEWED))

    expect(container.textContent).toContain('Read skill deploy')
    expect(container.textContent).toContain('4ms')

    expand(container)

    expect(opened(container)).toEqual(BODY)

    for (const text of ['name: deploy', 'description:', 'Runs 3 steps', 'Content', '---']) {
      expect(container.textContent, text).not.toContain(text)
    }
  })

  it('opens the same way reloaded, its args without the preview', () => {
    const container = renderPart(reloadedCall('skill_view', { name: 'deploy' }, VIEWED))

    expect(container.textContent).toContain('Read skill deploy')

    expand(container)

    expect(opened(container)).toEqual(BODY)
    expect(container.textContent).not.toContain('name: deploy')
  })

  it('prints a script a view asked for as code, not as markdown', () => {
    const script = {
      content: '# Ship it\nimport os\n\nprint(os.getcwd())\n',
      file: 'scripts/ship.py',
      file_type: '.py',
      name: 'deploy',
      success: true
    }

    const container = renderPart(
      liveCall('skill_view', { file_path: 'scripts/ship.py', name: 'deploy' }, 'deploy → scripts/ship.py', script)
    )

    expect(container.textContent).toContain('Read skill deploy → scripts/ship.py')

    expand(container)

    expect(opened(container)).toEqual({
      code: '# Ship it\nimport os\n\nprint(os.getcwd())',
      heading: null,
      items: []
    })
  })

  it('says it in the display language', () => {
    setRuntimeI18nLocale('vi')

    const container = renderPart(reloadedCall('skill_view', { name: 'deploy' }, VIEWED))

    expect(container.textContent).toContain('Đã đọc kỹ năng deploy')

    expand(container)

    expect(opened(container)).toEqual(BODY)
    expect(container.textContent).not.toContain('Tên:')
  })
})

// skills_list opened onto "Categories: devops", "Count: 2", "Hint: …" and
// "Skills: 2 items (…)": English keys in every language, and no skill named.
describe('opened skills_list row', () => {
  const LINES = ['deploy — Use when shipping a release.', 'k8s — Kubernetes helpers']

  it('opens onto one line per skill', () => {
    const container = renderPart(liveCall('skills_list', {}, '', LISTED))

    expect(container.textContent).toContain('Listed skills')
    expect(container.textContent).toContain('2 skills')

    expand(container)

    expect(opened(container).items).toEqual(LINES)

    for (const text of ['Categories', 'Count', 'Hint', 'Skills:']) {
      expect(container.textContent, text).not.toContain(text)
    }
  })

  it('lists the same lines reloaded, in the display language', () => {
    setRuntimeI18nLocale('vi')

    const container = renderPart(reloadedCall('skills_list', {}, LISTED))

    expect(container.textContent).toContain('Đã liệt kê kỹ năng')
    expect(container.textContent).toContain('2 kỹ năng')

    expand(container)

    expect(opened(container).items).toEqual(LINES)

    for (const text of ['Categories', 'Gợi ý', 'Skills:']) {
      expect(container.textContent, text).not.toContain(text)
    }
  })

  it("opens an empty list onto the tool's note, once", () => {
    const note = 'No skills found in skills/ directory.'

    const container = renderPart(
      reloadedCall('skills_list', {}, { categories: [], message: note, skills: [], success: true })
    )

    expand(container)

    expect(timesShown(container, note)).toBe(1)
    expect(opened(container).items).toEqual([])
  })
})
