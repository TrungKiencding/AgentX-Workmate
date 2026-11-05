/**
 * Scheduled tasks ("Lịch tự động") of one assistant = the cron jobs in that
 * profile's own cron store (`cron.manage` with `profile`). The job runs as
 * that profile, so the instruction is stored as-is.
 */

import { host, queryClient, useQuery } from '@agentx/plugin-sdk'

import type { BotsText } from './i18n'
import { PLUGIN_ID } from './state'
import type { CronJob } from './types'

export const ROUTINES_KEY = [PLUGIN_ID, 'routines'] as const

/** Jobs made by the older Bot Mode carry a "[bot:<name>] " name prefix. */
const BOT_TAG_RE = /^\[bot:[a-z0-9][a-z0-9_-]*\]\s*/i

export function routineTitle(job: Pick<CronJob, 'name'>, untitled: string): string {
  return (job.name || '').replace(BOT_TAG_RE, '').trim() || untitled
}

export function routineActive(job: Pick<CronJob, 'enabled' | 'state'>): boolean {
  return job.enabled !== false && job.state !== 'paused'
}

export async function loadRoutines(profile: string): Promise<CronJob[]> {
  const res = await host.request<{ jobs?: CronJob[] }>('cron.manage', {
    action: 'list',
    include_disabled: true,
    profile
  })

  return Array.isArray(res?.jobs) ? res.jobs : []
}

export function useRoutines(profile: string) {
  return useQuery({
    queryKey: [...ROUTINES_KEY, profile],
    queryFn: () => loadRoutines(profile),
    refetchInterval: 30_000,
    staleTime: 10_000
  })
}

export function invalidateRoutines(profile: string): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: [...ROUTINES_KEY, profile], exact: true })
}

export async function routineAction(
  profile: string,
  jobId: string,
  action: 'pause' | 'remove' | 'resume'
): Promise<void> {
  await host.request('cron.manage', { action, name: jobId, profile })
  await invalidateRoutines(profile)
}

export interface NewRoutine {
  instruction: string
  repeat: number | null
  schedule: string
  title: string
}

export async function addRoutine(profile: string, routine: NewRoutine): Promise<void> {
  await host.request('cron.manage', {
    action: 'add',
    name: routine.title,
    schedule: routine.schedule,
    prompt: routine.instruction,
    profile,
    ...(routine.repeat ? { repeat: routine.repeat } : {})
  })
  await invalidateRoutines(profile)
}

/** Titles/tasks go into JSON and a scheduler; a NUL byte is the one thing
 *  that can't round-trip. */
export function hasControlChars(...values: string[]): boolean {
  return values.some(value => value.includes('\0'))
}

// ── schedule picker model ─────────────────────────────────────────────────────

export type Frequency = 'advanced' | 'daily' | 'hourly' | 'interval' | 'monthly' | 'once' | 'weekdays' | 'weekly'
export type Unit = 'd' | 'h' | 'm'
export type Weekday = '0' | '1' | '2' | '3' | '4' | '5' | '6'

export const FREQUENCIES: readonly Frequency[] = [
  'daily',
  'weekdays',
  'weekly',
  'monthly',
  'hourly',
  'interval',
  'once',
  'advanced'
]
export const WEEKDAYS: readonly Weekday[] = ['1', '2', '3', '4', '5', '6', '0']
export const UNITS: readonly Unit[] = ['m', 'h', 'd']

export interface ScheduleState {
  freq: Frequency
  /** "HH:MM", 24h. */
  time: string
  weekday: Weekday
  monthday: string
  intervalN: string
  intervalUnit: Unit
  onceN: string
  onceUnit: Unit
  repeatN: string
  raw: string
}

export const defaultSchedule = (): ScheduleState => ({
  freq: 'daily',
  time: '08:00',
  weekday: '1',
  monthday: '1',
  intervalN: '2',
  intervalUnit: 'h',
  onceN: '30',
  onceUnit: 'm',
  repeatN: '',
  raw: ''
})

const positive = (value: string, fallback = 1, max = 9999) =>
  Math.min(max, Math.max(1, Number.parseInt(value, 10) || fallback))

function parseTime(value: string): [number, number] {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())

  if (!match) {
    return [8, 0]
  }

  return [Math.min(23, Number(match[1])), Math.min(59, Number(match[2]))]
}

/** The AgentX schedule string for the picker state ('' when unusable). */
export function composeSchedule(state: ScheduleState): string {
  const [h, m] = parseTime(state.time)

  switch (state.freq) {
    case 'once':
      return `${positive(state.onceN)}${state.onceUnit}`

    case 'hourly':
      return 'every 1h'

    case 'daily':
      return `${m} ${h} * * *`

    case 'weekdays':
      return `${m} ${h} * * 1-5`

    case 'weekly':
      return `${m} ${h} * * ${state.weekday}`

    case 'monthly':
      return `${m} ${h} ${positive(state.monthday, 1, 28)} * *`

    case 'interval':
      return `every ${positive(state.intervalN)}${state.intervalUnit}`

    default:
      return state.raw.trim()
  }
}

/** Repeat cap ("stop after N runs") — only for recurring picks. */
export function repeatCount(state: ScheduleState): number | null {
  return state.freq !== 'once' && state.freq !== 'advanced' && state.repeatN.trim() ? positive(state.repeatN) : null
}

export const formatClock = (h: number, m: number) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`

function durationText(n: number, unit: Unit, b: BotsText): string {
  return `${n} ${b.unit[unit]}`
}

/** Plain-language description of a stored schedule (cron.manage's display
 *  form: "every 120m", "once in 30m", "once at …", or a 5-field cron). */
export function describeSchedule(schedule: string | null | undefined, b: BotsText): string {
  const value = (schedule || '').trim()

  const every = /^every (\d+)m$/.exec(value)

  if (every) {
    const minutes = Number(every[1])

    if (minutes % 1440 === 0) {
      return b.sEveryDays(minutes / 1440)
    }

    if (minutes % 60 === 0) {
      return b.sEveryHours(minutes / 60)
    }

    return b.sEveryMinutes(minutes)
  }

  const everyUnit = /^every (\d+)([mhd])$/.exec(value)

  if (everyUnit) {
    const n = Number(everyUnit[1])

    return everyUnit[2] === 'd' ? b.sEveryDays(n) : everyUnit[2] === 'h' ? b.sEveryHours(n) : b.sEveryMinutes(n)
  }

  const onceIn = /^(?:once in )?(\d+)([mhd])$/.exec(value)

  if (onceIn) {
    return b.sOnceIn(durationText(Number(onceIn[1]), onceIn[2] as Unit, b))
  }

  const onceInWords = /^once in (.+)$/.exec(value)

  if (onceInWords) {
    return b.sOnceIn(onceInWords[1])
  }

  const onceAt = /^once at (.+)$/.exec(value)

  if (onceAt) {
    return b.sOnceAt(onceAt[1])
  }

  const cron = /^(\d{1,2}) (\d{1,2}) (\S+) \* (\S+)$/.exec(value)

  if (cron) {
    const time = formatClock(Number(cron[2]), Number(cron[1]))
    const [, , , dom, dow] = cron

    if (dom === '*' && dow === '*') {
      return b.sDaily(time)
    }

    if (dom === '*' && dow === '1-5') {
      return b.sWeekdays(time)
    }

    if (dom === '*' && /^[0-6]$/.test(dow)) {
      return b.sWeekly(b.weekday[dow as Weekday], time)
    }

    if (/^\d{1,2}$/.test(dom) && dow === '*') {
      return b.sMonthly(dom, time)
    }
  }

  if (value === '0 * * * *') {
    return b.sHourly
  }

  return value ? b.sRaw(value) : ''
}

/** Live sentence under the picker, so the user reads what they chose. */
export function previewSchedule(state: ScheduleState, b: BotsText): string {
  const base = describeSchedule(composeSchedule(state), b)
  const repeat = repeatCount(state)

  return base && repeat ? base + b.sTimes(repeat) : base
}
