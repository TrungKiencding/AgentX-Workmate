import { describe, expect, it } from 'vitest'

import { claimRunAnnouncement, finishedRuns, RECENT_RUN_MS, resetRunAnnouncements } from './cron-runs'

const NOW = Date.parse('2026-11-10T21:00:30+07:00')
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString()
const job = (id: string, lastRunAt: null | string) => ({ id, lastRunAt })

describe('finishedRuns', () => {
  it('only seeds on the first sighting — nothing has "just run" at launch', () => {
    const { finished, seen } = finishedRuns(null, [job('a', at(-5_000)), job('b', null)], NOW)

    expect(finished).toEqual([])
    expect([...seen]).toEqual([
      ['a', at(-5_000)],
      ['b', '']
    ])
  })

  it('reports a known job whose last run moved to just now', () => {
    const first = finishedRuns(null, [job('a', at(-86_400_000)), job('b', null)], NOW)
    const second = finishedRuns(first.seen, [job('a', at(-2_000)), job('b', null)], NOW)

    expect(second.finished.map(j => j.id)).toEqual(['a'])
    // …once.
    expect(finishedRuns(second.seen, [job('a', at(-2_000)), job('b', null)], NOW).finished).toEqual([])
  })

  it("reports a job's first ever run", () => {
    const first = finishedRuns(null, [job('a', null)], NOW)

    expect(finishedRuns(first.seen, [job('a', at(-1_000))], NOW).finished.map(j => j.id)).toEqual(['a'])
  })

  it('does not report a job it has never listed before', () => {
    // A profile-scope switch, or a job created elsewhere that already ran.
    const first = finishedRuns(null, [job('a', null)], NOW)

    expect(finishedRuns(first.seen, [job('a', null), job('other-profile', at(-1_000))], NOW).finished).toEqual([])
  })

  it('remembers jobs a narrower list left out', () => {
    const all = finishedRuns(null, [job('a', at(-86_400_000)), job('b', at(-86_400_000))], NOW)
    const scoped = finishedRuns(all.seen, [job('a', at(-86_400_000))], NOW)
    const wide = finishedRuns(scoped.seen, [job('a', at(-86_400_000)), job('b', at(-86_400_000))], NOW)

    expect(wide.finished).toEqual([])
    // …and still notices b running afterwards.
    expect(finishedRuns(wide.seen, [job('b', at(-500))], NOW).finished.map(j => j.id)).toEqual(['b'])
  })

  it('ignores a stamp that moved but is not recent', () => {
    const first = finishedRuns(null, [job('a', at(-86_400_000))], NOW)

    expect(finishedRuns(first.seen, [job('a', at(-RECENT_RUN_MS - 1_000))], NOW).finished).toEqual([])
    expect(finishedRuns(first.seen, [job('a', at(RECENT_RUN_MS + 60_000))], NOW).finished).toEqual([])
  })

  it('ignores a stamp it cannot read, and a stamp that was cleared', () => {
    const first = finishedRuns(null, [job('a', at(-86_400_000)), job('b', at(-86_400_000))], NOW)

    expect(finishedRuns(first.seen, [job('a', 'not a date'), job('b', null)], NOW).finished).toEqual([])
  })
})

describe('claimRunAnnouncement', () => {
  it('lets exactly one surface announce a run', () => {
    resetRunAnnouncements()

    expect(claimRunAnnouncement('j1', at(-1_000))).toBe(true)
    expect(claimRunAnnouncement('j1', at(-1_000))).toBe(false)
    // The next run of the same job is a new announcement.
    expect(claimRunAnnouncement('j1', at(0))).toBe(true)
    expect(claimRunAnnouncement('j2', at(-1_000))).toBe(true)
  })
})
