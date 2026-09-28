import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { HubStateView } from '@/types/hermes'

import { HubStateNote } from './hub-state-note'

const DAY = 86_400_000

function view(overrides: Partial<HubStateView> = {}): HubStateView {
  return {
    archived_at: null,
    desired_state: 'installed',
    name: 'tracker',
    reason: null,
    reason_version: null,
    serving_until: null,
    slug: 'tracker',
    status: 'active',
    successor: null,
    visible: true,
    withdrawn: false,
    ...overrides
  }
}

function note(hubState: HubStateView, gateway = false): null | string {
  cleanup()
  render(<HubStateNote gateway={gateway} hubState={hubState} />)

  return screen.queryByTestId('hub-card-state')?.textContent ?? null
}

afterEach(cleanup)

/** The one sentence a card says of what AgentX Hub decided (hub decisions §8 #22, §9.1 #18). */
describe('HubStateNote', () => {
  it('says nothing of a copy the hub keeps as it is', () => {
    expect(note(view())).toBeNull()
  })

  it('says the hub keeps it off, and why — before anything else', () => {
    expect(
      note(view({ desired_state: 'disabled', reason: 'yanked: leaks tokens', status: 'archived', withdrawn: true }))
    ).toBe(
      'AgentX Hub switched this off: yanked: leaks tokens. Only the hub turns it back on; you can still remove it.'
    )
    expect(note(view({ desired_state: 'disabled', withdrawn: true }))).toBe(
      'AgentX Hub switched this off. Only the hub turns it back on; you can still remove it.'
    )
  })

  it('says its author stopped publishing it, and what they point to', () => {
    expect(note(view({ status: 'archived', successor: { label: 'Tracker Two', slug: 'tracker-two' } }))).toBe(
      'Its author stopped publishing it: it still works on this machine, but no newer version will come. Its author points to Tracker Two instead.'
    )
    // A successor is the archive's word: none is said of a server taken down.
    expect(note(view({ status: 'yanked', successor: { label: 'Tracker Two', slug: 'tracker-two' } }))).toBeNull()
  })

  it('says until when the gateway serves a server reached through it — and when that is over, that it is', () => {
    const ahead = new Date(Date.now() + 5 * DAY).toISOString()
    const over = new Date(Date.now() - DAY).toISOString()
    const archived = 'Its author stopped publishing it: it still works on this machine, but no newer version will come.'

    expect(note(view({ serving_until: ahead, status: 'archived' }), true)).toMatch(
      new RegExp(`^${archived.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} AgentX Gateway serves it until .+\\.$`)
    )
    expect(note(view({ serving_until: over, status: 'archived' }), true)).toBe(
      `${archived} AgentX Gateway no longer serves it.`
    )
    // Installed from its manifest, it runs here whatever the gateway does.
    expect(note(view({ serving_until: ahead, status: 'archived' }))).toBe(archived)
  })

  it('says it is no longer the person’s to see', () => {
    expect(note(view({ visible: false }))).toBe(
      'You can no longer see this on AgentX Hub: it still works, but no newer version will come.'
    )
  })
})
