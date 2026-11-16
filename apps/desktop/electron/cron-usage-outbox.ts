import { promises as fsp } from 'node:fs'
import path from 'node:path'

import { isAccountSlug, slugBelongsToSubject } from './account-slug'
import type { UsageDelivery, UsageEventFacts, UsageIdentity } from './usage-reporter'
import { USAGE_BATCH_MAX } from './usage-reporter'

/**
 * Scheduled runs in the SSO usage metrics.
 *
 * A scheduled run fires in whichever process ticks its home — this app's
 * backend, a detached messaging gateway, a login service — often while the app
 * is closed, and only this process holds the Keycloak access token the console
 * takes. So every run leaves one `cron.run` event file under its home
 * (cron/usage_outbox.py writes `<home>/cron/usage-outbox/<event_id>.json`), and
 * this sends the files of the signed-in person's homes, then deletes them.
 *
 * The event id is the run's own, so a file sent twice (the app quit between the
 * console's answer and the delete) is counted once. The console takes events at
 * most 7 days old; anything older, or not shaped like an event, is deleted
 * unsent. A home of another account on this machine is left alone: its events
 * go when that person signs in.
 */

/** Under the home; the backend writes the same path (cron/usage_outbox.py, OUTBOX_DIR). */
export const OUTBOX_DIR = path.join('cron', 'usage-outbox')
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
/** Leaves the console a margin: an event this close to its limit could arrive a little too late. */
const SEND_MARGIN_MS = 10 * 60 * 1000
/** The console's tolerance for a clock ahead of its own. */
const MAX_FUTURE_MS = 5 * 60 * 1000
const FILE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/
const ERROR_CODE = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,79}$/
const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/
/** A file larger than this was not written by the backend. */
const MAX_FILE_BYTES = 4096
/**
 * Events sent in one pass, across every home. The console takes 600 usage events
 * a minute per person, shared with live chat turns; a backlog (the app closed for
 * days, many routines) sent in one go would spend that minute and get the chat
 * turns refused. The rest goes on the next pass, minutes later.
 */
export const PASS_MAX_EVENTS = 300
/**
 * The console's answers that mean "these events are malformed": sending them
 * again would be refused the same way. Anything else it refuses (a 404 while it
 * is being deployed, a 409…) says nothing about the events, so they wait.
 */
const MALFORMED_STATUSES = new Set([400, 413, 422])

/**
 * True for an event that only fails because it reads as ahead of the console's
 * clock — this machine's clock runs fast, or was set back since the run. It is
 * kept: once the clocks agree it is an ordinary event. One dated further ahead
 * than an event can live is no clock drift, and is not kept.
 */
export function isAheadOfClock(text: string, nowMs: number): boolean {
  try {
    const value = JSON.parse(text) as { occurred_at?: unknown }
    const occurred = typeof value?.occurred_at === 'string' ? Date.parse(value.occurred_at) : NaN

    return Number.isFinite(occurred) && occurred > nowMs + MAX_FUTURE_MS && occurred <= nowMs + MAX_AGE_MS
  } catch {
    return false
  }
}

/** One event from the outbox, as the console takes it; null for anything else. */
export function parseCronUsageEvent(text: string, fileName: string, nowMs: number): UsageEventFacts | null {
  let value: unknown

  try {
    value = JSON.parse(text)
  } catch {
    return null
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const event = value as Record<string, unknown>
  const keys = Object.keys(event).sort().join(',')
  const failed = event.outcome === 'failure'
  const occurred = typeof event.occurred_at === 'string' ? Date.parse(event.occurred_at) : NaN

  if (
    keys !==
      (failed
        ? 'duration_ms,error_code,event_id,feature,occurred_at,outcome'
        : 'duration_ms,event_id,feature,occurred_at,outcome') ||
    event.feature !== 'cron.run' ||
    !(failed || event.outcome === 'success') ||
    `${event.event_id}.json` !== fileName ||
    !FILE_NAME.test(fileName) ||
    !Number.isInteger(event.duration_ms) ||
    (event.duration_ms as number) < 0 ||
    (event.duration_ms as number) > 3_600_000 ||
    (failed && !(typeof event.error_code === 'string' && ERROR_CODE.test(event.error_code))) ||
    !/(?:Z|[+-]\d{2}:\d{2})$/.test(String(event.occurred_at)) ||
    !Number.isFinite(occurred) ||
    occurred < nowMs - MAX_AGE_MS + SEND_MARGIN_MS ||
    occurred > nowMs + MAX_FUTURE_MS
  ) {
    return null
  }

  return {
    event_id: event.event_id as string,
    occurred_at: event.occurred_at as string,
    feature: 'cron.run',
    outcome: failed ? 'failure' : 'success',
    duration_ms: event.duration_ms as number,
    ...(failed ? { error_code: event.error_code as string } : {})
  }
}

async function directoryNames(dir: string): Promise<string[]> {
  try {
    return await fsp.readdir(dir)
  } catch {
    return []
  }
}

/**
 * The homes whose scheduled runs count for `subject`: each account home of theirs
 * (`<root>/accounts/<slug>`, the slug derived from the subject) with its profiles
 * — Bot Mode assistants included, they are profiles. An install from before
 * account homes keeps everything under `<root>`, which is then theirs.
 */
export async function cronUsageHomes(root: string, subject: string): Promise<string[]> {
  const accounts = path.join(root, 'accounts')
  let bases: string[]

  try {
    await fsp.access(accounts)
    bases = (await directoryNames(accounts))
      .filter(slug => isAccountSlug(slug) && slugBelongsToSubject(slug, subject))
      .map(slug => path.join(accounts, slug))
  } catch {
    bases = [root]
  }

  const homes: string[] = []

  for (const base of bases) {
    homes.push(base)

    for (const name of await directoryNames(path.join(base, 'profiles'))) {
      if (PROFILE_NAME.test(name)) {
        homes.push(path.join(base, 'profiles', name))
      }
    }
  }

  return homes
}

export interface CronUsageOutboxDeps {
  /** The AgentX root (main.ts AGENTX_HOME). */
  root: string
  /** The signed-in person, with a usable token; null when there is none. */
  identity: () => Promise<UsageIdentity | null>
  deliver: (identity: UsageIdentity, events: UsageEventFacts[]) => Promise<UsageDelivery>
  now?: () => number
  log?: (line: string) => void
}

export interface CronUsageDrain {
  sent: number
  /** Deleted unsent: too old, not an event, or refused by the console as malformed. */
  dropped: number
  /** Left for a later pass: no session, the console could not take them now, ahead of its clock, or past this pass's budget. */
  kept: number
}

type BatchOutcome = 'stop' | 'continue'

/** Drains the outbox of every home of the signed-in person; one pass at a time. */
export class CronUsageOutbox {
  private running: Promise<CronUsageDrain> | null = null
  private readonly logged = new Set<string>()
  constructor(private readonly deps: CronUsageOutboxDeps) {}

  /** A pass already under way is joined rather than run twice: two would send the same files. */
  drain(): Promise<CronUsageDrain> {
    this.running ??= this.pass().finally(() => {
      this.running = null
    })

    return this.running
  }

  private logOnce(line: string): void {
    if (!this.logged.has(line)) {
      this.logged.add(line)
      this.deps.log?.(line)
    }
  }

  private async pass(): Promise<CronUsageDrain> {
    const result: CronUsageDrain = { sent: 0, dropped: 0, kept: 0 }

    try {
      const identity = await this.deps.identity().catch(() => null)

      if (!identity?.token || !identity.subject) {
        return result
      }

      const budget = { left: PASS_MAX_EVENTS }

      for (const home of await cronUsageHomes(this.deps.root, identity.subject)) {
        if (!(await this.drainHome(path.join(home, OUTBOX_DIR), identity, result, budget))) {
          break // the console cannot take events now, or this pass sent its share; the other homes wait
        }
      }

      if (result.dropped > 0) {
        this.logOnce('[usage] dropped scheduled-run events the console would not take (too old or malformed)')
      }
    } catch {
      /* Metrics never change what the app does. */
    }

    return result
  }

  /** False when the pass stops here: the console could not take events now, or the budget is spent. */
  private async drainHome(
    dir: string,
    identity: UsageIdentity,
    result: CronUsageDrain,
    budget: { left: number }
  ): Promise<boolean> {
    const now = (this.deps.now || Date.now)()
    const ready: { file: string; event: UsageEventFacts }[] = []

    for (const name of (await directoryNames(dir)).sort()) {
      if (!name.endsWith('.json')) {
        continue // the backend's temporary files, or someone else's
      }

      const file = path.join(dir, name)
      let event: UsageEventFacts | null = null
      let ahead = false

      try {
        const stat = await fsp.lstat(file)

        if (!stat.isFile()) {
          continue // not a file the backend wrote: not ours to delete
        }

        if (stat.size <= MAX_FILE_BYTES) {
          const text = await fsp.readFile(file, 'utf8')
          event = parseCronUsageEvent(text, name, now)
          ahead = !event && isAheadOfClock(text, now)
        }
      } catch {
        continue // gone meanwhile
      }

      if (event) {
        ready.push({ file, event })
      } else if (ahead) {
        result.kept++ // a clock out of step, not a bad event: it goes once the clocks agree
      } else {
        await this.remove(file)
        result.dropped++
      }
    }

    const sendable = ready.slice(0, Math.max(0, budget.left))
    const overBudget = ready.length - sendable.length

    for (let start = 0; start < sendable.length; start += USAGE_BATCH_MAX) {
      const batch = sendable.slice(start, start + USAGE_BATCH_MAX)
      budget.left -= batch.length

      if ((await this.sendBatch(identity, batch, result)) === 'stop') {
        result.kept += sendable.length - start - batch.length + overBudget

        return false
      }
    }

    if (overBudget > 0) {
      result.kept += overBudget

      return false
    }

    return budget.left > 0
  }

  /**
   * Sends one batch; 'stop' when the console cannot take events now (what the batch
   * did not send is counted kept). A batch refused as malformed is sent again one
   * event at a time, so a single bad event — one dated past the console's window by
   * a clock out of step — does not take the good ones down with it.
   */
  private async sendBatch(
    identity: UsageIdentity,
    batch: { file: string; event: UsageEventFacts }[],
    result: CronUsageDrain
  ): Promise<BatchOutcome> {
    const delivery = await this.deps.deliver(
      identity,
      batch.map(entry => entry.event)
    )

    if (delivery === 'accepted') {
      await Promise.all(batch.map(entry => this.remove(entry.file)))
      result.sent += batch.length

      return 'continue'
    }

    // 'failed': no answer, a 5xx or a 429. 401/403: this session's token was refused —
    // another session, or a sign-in, may send them. Any other refusal that is not about
    // the events themselves (a 404 mid-deploy…). Either way, they wait.
    if (delivery === 'failed' || !MALFORMED_STATUSES.has(delivery.refused)) {
      result.kept += batch.length

      return 'stop'
    }

    if (batch.length === 1) {
      // The console says this event is malformed; sending it again would be refused the same way.
      await this.remove(batch[0].file)
      result.dropped++

      return 'continue'
    }

    for (let index = 0; index < batch.length; index++) {
      if ((await this.sendBatch(identity, [batch[index]], result)) === 'stop') {
        result.kept += batch.length - index - 1

        return 'stop'
      }
    }

    return 'continue'
  }

  private async remove(file: string): Promise<void> {
    await fsp.rm(file, { force: true }).catch(() => undefined)
  }
}
