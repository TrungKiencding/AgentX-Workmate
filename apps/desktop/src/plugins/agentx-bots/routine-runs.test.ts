import { claimRunAnnouncement, host } from '@agentx/plugin-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// eslint-disable-next-line no-restricted-imports -- test harness, not plugin code
import { resetRunAnnouncements } from '@/lib/cron-runs'

import { collectFinishedRoutines, resetRoutineRunTracking } from './routines'
import type { CronJob } from './types'

// Pilot 2026-11: an assistant's scheduled task ran (or failed) and nothing on
// screen said so. The backend broadcasts `routines.changed`; this is what the
// plugin reads off the job stores when it does.
describe('collectFinishedRoutines', () => {
  const NOW = Date.parse('2026-11-10T21:00:30+07:00')
  const ago = (ms: number) => new Date(NOW - ms).toISOString()
  let stores: Record<string, CronJob[]>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    resetRoutineRunTracking()
    resetRunAnnouncements()
    stores = {
      default: [{ job_id: 'main-job', last_run_at: ago(86_400_000), name: 'Việc của trợ lý chính' }],
      'tai-chinh': [{ job_id: 'j1', last_run_at: null, name: 'Bản tin tài chính' }]
    }
    vi.spyOn(host, 'requestPrimary').mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'profiles.list') {
        return { profiles: [{ name: 'default' }, { name: 'tai-chinh' }, { name: 'broken' }] } as never
      }

      if (method === 'cron.manage' && params.profile === 'broken') {
        throw new Error('store unreadable')
      }

      if (method === 'cron.manage') {
        return { jobs: stores[String(params.profile)] ?? [] } as never
      }

      throw new Error(`unexpected ${method}`)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('reports nothing at launch, then the routine that ran', async () => {
    expect(await collectFinishedRoutines()).toEqual([])

    stores['tai-chinh'] = [{ job_id: 'j1', last_run_at: ago(1_000), last_status: 'ok', name: 'Bản tin tài chính' }]

    const runs = await collectFinishedRoutines()

    expect(runs.map(run => [run.profile, run.job.job_id, run.job.last_status])).toEqual([['tai-chinh', 'j1', 'ok']])
    // …once.
    expect(await collectFinishedRoutines()).toEqual([])
  })

  it("leaves the main assistant's jobs to the app's own announcements", async () => {
    await collectFinishedRoutines()
    stores.default = [{ job_id: 'main-job', last_run_at: ago(500), last_status: 'ok', name: 'Việc của trợ lý chính' }]

    expect(await collectFinishedRoutines()).toEqual([])
    expect(vi.mocked(host.requestPrimary).mock.calls.some(([, params]) => params?.profile === 'default')).toBe(false)
  })

  it('carries the failure kind of a failed run', async () => {
    await collectFinishedRoutines()
    stores['tai-chinh'] = [
      { job_id: 'j1', last_error_kind: 'rate_limit', last_run_at: ago(1_000), last_status: 'error', name: 'Bản tin' }
    ]

    const [run] = await collectFinishedRoutines()

    expect(run.job.last_error_kind).toBe('rate_limit')
  })

  it('does not announce a run another surface already announced', async () => {
    await collectFinishedRoutines()

    const stamp = ago(1_000)

    stores['tai-chinh'] = [{ job_id: 'j1', last_run_at: stamp, last_status: 'ok', name: 'Bản tin' }]
    claimRunAnnouncement('j1', stamp)

    expect(await collectFinishedRoutines()).toEqual([])
  })

  it('reads the stores once for a burst of change events', async () => {
    const [first, second] = await Promise.all([collectFinishedRoutines(), collectFinishedRoutines()])

    expect(first).toBe(second)
    expect(vi.mocked(host.requestPrimary).mock.calls.filter(([method]) => method === 'profiles.list')).toHaveLength(1)
  })
})
