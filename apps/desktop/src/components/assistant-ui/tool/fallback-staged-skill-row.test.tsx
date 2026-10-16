import { cleanup, fireEvent, render } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FALLBACK_LOCALE, setRuntimeI18nLocale } from '@/i18n'
import { $toolDisclosureStates } from '@/store/tool-view'

vi.mock('@assistant-ui/react', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAuiState: (select: (state: unknown) => unknown) =>
    select({ message: { id: 'msg-1', status: { type: 'complete' } }, thread: { isRunning: false } })
}))

const { ToolFallback } = await import('./fallback')

type RowProps = ComponentProps<typeof ToolFallback>

const GATE_MESSAGE = 'Staged for approval (skills.write_approval is on). Not yet saved — review with /skills pending.'

const GIST = "patch 'deploy' SKILL.md (+2/-1 lines)"

const PENDING_ID = '5b0e7a91'

const STAGED_RESULT = { gist: GIST, message: GATE_MESSAGE, pending_id: PENDING_ID, staged: true, success: true }

/** A skill_manage row that patched the "deploy" skill. */
function renderSkillRow(result: unknown = STAGED_RESULT) {
  const row = {
    args: { action: 'patch', name: 'deploy', new_string: 'npm run build\nnpm test', old_string: 'npm run build' },
    result,
    toolCallId: 'call-skill',
    toolName: 'skill_manage'
  } as RowProps

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

afterEach(() => {
  cleanup()
  $toolDisclosureStates.set({})
  setRuntimeI18nLocale(FALLBACK_LOCALE)
})

// With skills.write_approval on, skill_manage stages every write and answers
// `success: true`. The row read as a plain success titled "Skill Manage", and
// opened onto "Staged: true" and the pending id.
describe('staged skill change', () => {
  it('keeps a change that landed a plain finished row', () => {
    const container = renderSkillRow({ message: "Skill 'deploy' patched.", success: true })

    expect(container.textContent).not.toContain('Skill change awaiting approval')
    expect(container.querySelector('[aria-label="Awaiting approval"]')).toBeNull()
  })

  it('says it is waiting for approval, in the plain row colours', () => {
    const container = renderSkillRow()

    expect(container.textContent).toContain('Skill change awaiting approval')
    expect(container.textContent).not.toContain('Skill Manage')
    expect(container.querySelector('[aria-label="Awaiting approval"]')).not.toBeNull()
    // Waiting is neither a refusal nor a failure.
    expect(container.querySelector('[class*="text-(--ui-yellow)"]')).toBeNull()
    expect(container.querySelector('[class*="text-destructive"]')).toBeNull()
  })

  it('opens onto the change, then where to review it, and nothing of the gate bookkeeping', () => {
    const container = renderSkillRow()

    expand(container)

    expect(timesShown(container, GIST)).toBe(1)
    expect(timesShown(container, GATE_MESSAGE)).toBe(1)

    const painted = container.textContent ?? ''

    expect(painted.indexOf(GIST)).toBeLessThan(painted.indexOf(GATE_MESSAGE))
    expect(painted).not.toMatch(/staged:/i)
    expect(painted).not.toContain(PENDING_ID)
    // SKILL.md is a file name, not a link to a domain.
    expect(container.querySelector('a')).toBeNull()
  })

  it('says it in the display language', () => {
    setRuntimeI18nLocale('vi')

    const container = renderSkillRow()

    expect(container.textContent).toContain('Chờ phê duyệt thay đổi kỹ năng')
    expect(container.querySelector('[aria-label="Đang chờ phê duyệt"]')).not.toBeNull()

    expand(container)

    expect(timesShown(container, GIST)).toBe(1)
    expect(timesShown(container, GATE_MESSAGE)).toBe(1)
    expect(container.textContent).not.toContain(PENDING_ID)
  })
})
