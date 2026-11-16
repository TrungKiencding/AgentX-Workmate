/**
 * Noticing that a scheduled job has just run.
 *
 * A job runs in the background — the scheduler tick, or a child process for an
 * assistant's routine — and nothing told the person it had happened: the list
 * quietly changed its "last run" line (pilot feedback 2026-11: "không có thông
 * báo trên màn hình"). The job list is the one signal every surface already
 * has, so a run is read off it: a job we already knew whose `last_run_at`
 * moved to a moment that is recent.
 *
 * Both halves of that rule matter:
 *  - *already known*: the first list after launch, a profile-scope switch or a
 *    newly listed job all show stamps we have not seen before. None of those
 *    is a run that happened while the person was looking away from it.
 *  - *recent*: a stamp that moved but lies in the past (a store restored from
 *    sync, an edit that rewrote the record) is not news.
 */

export interface RunStamped {
  /** Stable identity of the job. */
  id: string
  lastRunAt: null | string | undefined
}

/** How old a `last_run_at` may be and still count as "just ran". Generous: a
 *  long job stamps its end, but the list can be read a poll interval later. */
export const RECENT_RUN_MS = 10 * 60_000

export type RunStamps = ReadonlyMap<string, string>

const stampOf = (job: RunStamped): string => job.lastRunAt?.trim() || ''

/**
 * The jobs in `jobs` that have run since `seen` was recorded, plus the stamps
 * to remember next time. `seen === null` is the first sighting: it only seeds.
 * Stamps of jobs missing from `jobs` are kept — a list scoped to one profile
 * must not make the others look new when the scope widens again.
 */
export function finishedRuns<T extends RunStamped>(
  seen: null | RunStamps,
  jobs: readonly T[],
  now: number = Date.now()
): { finished: T[]; seen: Map<string, string> } {
  const next = new Map(seen ?? [])
  const finished: T[] = []

  for (const job of jobs) {
    const stamp = stampOf(job)
    const before = seen?.get(job.id)

    next.set(job.id, stamp)

    if (!seen || before === undefined || !stamp || stamp === before) {
      continue
    }

    const ranAt = Date.parse(stamp)

    if (Number.isFinite(ranAt) && now - ranAt <= RECENT_RUN_MS && ranAt - now <= RECENT_RUN_MS) {
      finished.push(job)
    }
  }

  return { finished, seen: next }
}

/** How much of a run's result an announcement shows: a toast or an OS
 *  notification holds a few lines, and the whole result is one click away. */
export const RUN_EXCERPT_MAX = 180

/**
 * What a finished run said, sized for an announcement — or '' when it left
 * nothing to show. The backend sends `last_output_preview` already redacted
 * and flattened to plain text; this only fits it to the surface.
 */
export function runExcerpt(preview: null | string | undefined, max: number = RUN_EXCERPT_MAX): string {
  const text = typeof preview === 'string' ? preview.replace(/\s+/g, ' ').trim() : ''

  if (text.length <= max) {
    return text
  }

  const cut = text.slice(0, max - 1)
  const lastSpace = cut.lastIndexOf(' ')

  // Prefer a word boundary, unless that would throw away most of it.
  return `${(lastSpace >= max / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}

// One run, one announcement. The core cron store and the assistants plugin can
// both see the same job (a list scoped to every profile includes assistants'
// routines), and each would otherwise notify.
const announced = new Set<string>()
const ANNOUNCED_CAP = 500

/** True the first time a given run is claimed; false for every later claim. */
export function claimRunAnnouncement(jobId: string, lastRunAt: null | string | undefined): boolean {
  const key = `${jobId}@${lastRunAt?.trim() || ''}`

  if (announced.has(key)) {
    return false
  }

  if (announced.size >= ANNOUNCED_CAP) {
    announced.clear()
  }

  announced.add(key)

  return true
}

/** Test-only. */
export function resetRunAnnouncements(): void {
  announced.clear()
}
