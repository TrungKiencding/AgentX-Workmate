import { atom } from 'nanostores'

import { translateNow } from '@/i18n'
import { claimRunAnnouncement, finishedRuns, type RunStamps } from '@/lib/cron-runs'
import type { CronJob } from '@/types/hermes'

import { dispatchNativeNotification } from './native-notifications'
import { notify } from './notifications'

// Cron *jobs* (not run sessions) power the sidebar "Cron jobs" section. Listing
// the job — schedule, state, live next-run countdown — makes the job the
// first-class entity; its runs (sessions) resolve under it in the cron detail.
export const $cronJobs = atom<CronJob[]>([])

// `last_run_at` per job as of the previous list, so a run that happened in the
// background can be announced (see lib/cron-runs). null until the first list.
let seenRuns: null | RunStamps = null

const jobLabel = (job: CronJob): string =>
  (typeof job.name === 'string' && job.name.trim()) || translateNow('cron.runUntitled')

/** Tell the person a scheduled job just ran: a toast in the app, and an OS
 *  notification when they are away from it. A job runs with nobody watching,
 *  and its only trace used to be a "last run" line in a page they had to open. */
function announceFinishedRuns(jobs: CronJob[]): void {
  const { finished, seen } = finishedRuns(
    seenRuns,
    jobs.map(job => ({ id: job.id, job, lastRunAt: job.last_run_at }))
  )

  seenRuns = seen

  for (const { job } of finished) {
    if (!claimRunAnnouncement(job.id, job.last_run_at)) {
      continue
    }

    const failed = Boolean(job.last_status && job.last_status !== 'ok')
    const title = translateNow(failed ? 'cron.runFailedTitle' : 'cron.runDoneTitle', jobLabel(job))
    const message = translateNow(failed ? 'cron.runFailedBody' : 'cron.runDoneBody')

    notify({
      action: {
        label: translateNow('cron.viewRun'),
        onClick: () => {
          setCronFocusJobId(job.id)
          requestCronReview()
        }
      },
      id: `cron-run:${job.id}`,
      kind: failed ? 'error' : 'success',
      message,
      // Not about the open chat: it must survive switching conversations.
      scope: 'app',
      title
    })
    dispatchNativeNotification({ body: message, global: true, kind: 'backgroundDone', tag: `cron:${job.id}`, title })
  }
}

export const setCronJobs = (jobs: CronJob[]) => {
  announceFinishedRuns(jobs)
  $cronJobs.set(jobs)
}

/** Test-only: forget what has been seen, as after a fresh launch. */
export function resetCronRunTracking(): void {
  seenRuns = null
}

// In-place edit so the cron overlay's mutations (create/edit/delete/pause/…)
// land in the same atom the sidebar renders — no stale list until the next poll.
export const updateCronJobs = (fn: (jobs: CronJob[]) => CronJob[]) => $cronJobs.set(fn($cronJobs.get()))

// One-shot focus target: clicking "Manage" on a job sets this, then opens the
// cron overlay, which reads it once to select + scroll to that job. Cleared
// after consumption so re-opening cron normally doesn't re-focus a stale job.
export const $cronFocusJobId = atom<null | string>(null)
export const setCronFocusJobId = (id: null | string) => $cronFocusJobId.set(id)

// Shell-owned one-shot intent for stores without router context. Do not set a
// focus id here: the cron overlay's first fetch may not have loaded that row.
export const $cronReviewRequest = atom(0)
export const requestCronReview = () => $cronReviewRequest.set($cronReviewRequest.get() + 1)
