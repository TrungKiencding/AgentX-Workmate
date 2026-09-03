import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { AssistantRuntimeProvider, type ThreadMessage, useExternalStoreRuntime } from '@assistant-ui/react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Thread } from '.'

/**
 * The attachment chips under a user bubble must stay readable.
 *
 * The bubble's container is a sticky, opaque, full-bleed mask — that is what
 * makes older content scrolling *behind* a pinned prompt read as "behind"
 * rather than as two layers of text on top of each other. The attachment row
 * is a flow sibling BELOW that mask, so it scrolls away behind it too.
 *
 * The shipped bug: the row carried `-mt-3` (12px) against a 6px flex gap, so it
 * sat 6px inside the mask at rest — and a pinned mask paints another
 * `--sticky-human-top` lower than its flow position, which is exactly where a
 * freshly sent turn comes to rest. The chip's top was sliced off for the whole
 * turn, not just while scrolling (measured 9.67px of overlap in the running
 * app). Two things keep it legible, and both are asserted here: the row takes
 * no upward pull, and the gap it lives in is wider than the sticky offset.
 */

const createdAt = new Date('2026-05-01T00:00:00.000Z')
const ATTACHMENT_REF = '@file:.agentx/desktop-attachments/skill-2.md'

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.stubGlobal('ResizeObserver', TestResizeObserver)
vi.stubGlobal('CSS', { escape: (value: string) => value })

Element.prototype.scrollTo = function scrollTo() {}

afterEach(() => {
  cleanup()
})

function userMessage(): ThreadMessage {
  return {
    id: 'user-1',
    role: 'user',
    content: [{ type: 'text', text: 'follow the attached skill' }],
    attachments: [],
    createdAt,
    metadata: { custom: { attachmentRefs: [ATTACHMENT_REF] } }
  } as unknown as ThreadMessage
}

function Harness() {
  const runtime = useExternalStoreRuntime<ThreadMessage>({
    messages: [userMessage()],
    isRunning: false,
    onNew: async () => {}
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread />
    </AssistantRuntimeProvider>
  )
}

function attachmentRow(container: HTMLElement): HTMLElement {
  const row = container.querySelector<HTMLElement>('[data-slot="aui_user-attachments"]')

  expect(row, 'a user message with attachment refs renders an attachment row').toBeTruthy()

  return row as HTMLElement
}

describe('user message attachments', () => {
  it('renders the refs as chips in a flow sibling below the sticky bubble', () => {
    const { container } = render(<Harness />)
    const row = attachmentRow(container)

    // A sibling, not a child: inside the mask the chips would ride along with
    // the pinned bubble instead of scrolling away under it.
    expect(row.previousElementSibling?.getAttribute('data-slot')).toBe('aui_user-message-root')
    expect(row.querySelector('.ref')).toBeTruthy()
    expect(row.textContent).toContain('.agentx/desktop-attachments/skill-2.md')
  })

  it('takes no upward pull that would tuck the chips under the mask', () => {
    const { container } = render(<Harness />)
    const className = attachmentRow(container).className

    // jsdom resolves no Tailwind, so the guard is on the declaration itself:
    // any negative top margin eats into the gap the clearance depends on.
    expect(/(?:^|\s)-m(?:t|y)-/.test(className), `attachment row must not pull up: "${className}"`).toBe(false)
    expect(/margin(?:-block-start|-top)?:\s*-/.test(className), `attachment row must not pull up: "${className}"`).toBe(
      false
    )
  })

  it('leaves the row a gap wider than the distance a pinned bubble drops', () => {
    const styles = readFileSync(resolve(__dirname, '../../../styles.css'), 'utf-8')

    const rem = (token: string): number => {
      const match = new RegExp(`--${token}:\\s*([0-9.]+)rem`).exec(styles)

      expect(match, `styles.css should declare --${token} in rem`).toBeTruthy()

      return Number((match as RegExpExecArray)[1])
    }

    // The row sits one --conversation-turn-gap below the mask's flow box; a
    // pinned mask paints --sticky-human-top below that same box. Keep the gap
    // the larger of the two or the chips get sliced again.
    expect(rem('sticky-human-top')).toBeLessThan(rem('conversation-turn-gap'))
  })
})
