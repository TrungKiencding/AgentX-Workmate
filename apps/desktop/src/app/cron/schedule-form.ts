/**
 * The schedule half of the cron editor, as a form a person can fill in.
 *
 * The editor used to offer fixed presets — "Daily" *was* `0 9 * * *` — and
 * showed the result in a read-only strip, so the only way to run something at
 * 21:00 was to pick "Custom" and write a cron expression (pilot feedback
 * 2026-11-10: "không chỉnh sửa được giờ hẹn"). Here a preset is a *shape* and
 * its parts are fields: a time for daily/weekdays/weekly/monthly, a weekday
 * for weekly, a day for monthly, a minute for hourly.
 *
 * Pure: `scheduleFormFromExpr` and `scheduleExprFromForm` round-trip every
 * expression a preset can express, and anything else lands in `custom`
 * untouched, so opening and saving a job never rewrites a schedule the form
 * cannot represent.
 */

export type SchedulePreset = 'custom' | 'daily' | 'every-15-minutes' | 'hourly' | 'monthly' | 'weekdays' | 'weekly'

export const SCHEDULE_PRESETS: readonly SchedulePreset[] = [
  'daily',
  'weekdays',
  'weekly',
  'monthly',
  'hourly',
  'every-15-minutes',
  'custom'
]

/** Monday first, the way a Vietnamese (and ISO) week reads. Cron's 0 = Sunday. */
export const SCHEDULE_WEEKDAYS: readonly string[] = ['1', '2', '3', '4', '5', '6', '0']

export const SCHEDULE_MONTHDAYS: readonly string[] = Array.from({ length: 31 }, (_, index) => String(index + 1))

/** Minutes offered for "hourly"; a stored value outside the list is kept. */
export const SCHEDULE_MINUTES: readonly string[] = Array.from({ length: 12 }, (_, index) => String(index * 5))

/** Days a short month lacks: cron skips the month rather than running late. */
export const LAST_DAY_EVERY_MONTH_HAS = 28

export interface ScheduleForm {
  preset: SchedulePreset
  /** "HH:MM", 24h — daily, weekdays, weekly, monthly. */
  time: string
  /** Cron day of week, '0' (Sunday) … '6' — weekly. */
  weekday: string
  /** '1' … '31' — monthly. */
  monthday: string
  /** '0' … '59' — hourly. */
  minute: string
  /** The raw expression — custom. */
  custom: string
}

export const DEFAULT_SCHEDULE_FORM: ScheduleForm = {
  preset: 'daily',
  time: '09:00',
  weekday: '1',
  monthday: '1',
  minute: '0',
  custom: ''
}

const isInt = (value: string, min: number, max: number): boolean =>
  /^\d{1,2}$/.test(value) && Number(value) >= min && Number(value) <= max

const pad = (value: number | string): string => String(value).padStart(2, '0')

function clock(hour: string, minute: string): string {
  return `${pad(Number(hour))}:${pad(Number(minute))}`
}

function timeParts(time: string): [number, number] {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim())

  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
    return [9, 0]
  }

  return [Number(match[1]), Number(match[2])]
}

/** Read a stored schedule into the form. Empty → the default (daily, 09:00). */
export function scheduleFormFromExpr(expr: string): ScheduleForm {
  const normalized = expr.trim().replace(/\s+/g, ' ')

  if (!normalized) {
    return DEFAULT_SCHEDULE_FORM
  }

  const custom: ScheduleForm = { ...DEFAULT_SCHEDULE_FORM, custom: normalized, preset: 'custom' }

  if (normalized === '*/15 * * * *') {
    return { ...DEFAULT_SCHEDULE_FORM, preset: 'every-15-minutes' }
  }

  const parts = normalized.split(' ')

  if (parts.length !== 5) {
    return custom
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts

  if (month !== '*' || !isInt(minute, 0, 59)) {
    return custom
  }

  if (hour === '*') {
    return dayOfMonth === '*' && dayOfWeek === '*'
      ? { ...DEFAULT_SCHEDULE_FORM, minute: String(Number(minute)), preset: 'hourly' }
      : custom
  }

  if (!isInt(hour, 0, 23)) {
    return custom
  }

  const timed = { ...DEFAULT_SCHEDULE_FORM, time: clock(hour, minute) }

  if (dayOfMonth === '*' && dayOfWeek === '*') {
    return { ...timed, preset: 'daily' }
  }

  if (dayOfMonth === '*' && dayOfWeek === '1-5') {
    return { ...timed, preset: 'weekdays' }
  }

  if (dayOfMonth === '*' && isInt(dayOfWeek, 0, 7)) {
    // Cron accepts 7 for Sunday; the form knows one Sunday.
    return { ...timed, preset: 'weekly', weekday: String(Number(dayOfWeek) % 7) }
  }

  if (dayOfWeek === '*' && isInt(dayOfMonth, 1, 31)) {
    return { ...timed, monthday: String(Number(dayOfMonth)), preset: 'monthly' }
  }

  return custom
}

/** The schedule string the form stands for ('' for an empty custom field). */
export function scheduleExprFromForm(form: ScheduleForm): string {
  const [hour, minute] = timeParts(form.time)

  switch (form.preset) {
    case 'daily':
      return `${minute} ${hour} * * *`

    case 'weekdays':
      return `${minute} ${hour} * * 1-5`

    case 'weekly':
      return `${minute} ${hour} * * ${isInt(form.weekday, 0, 6) ? Number(form.weekday) : 1}`

    case 'monthly':
      return `${minute} ${hour} ${isInt(form.monthday, 1, 31) ? Number(form.monthday) : 1} * *`

    case 'hourly':
      return `${isInt(form.minute, 0, 59) ? Number(form.minute) : 0} * * * *`

    case 'every-15-minutes':
      return '*/15 * * * *'

    default:
      return form.custom.trim()
  }
}

/**
 * Switch the frequency. The other fields are kept, so going daily → weekly →
 * daily never loses the chosen time; switching to custom starts from the
 * expression the form held, so there is something to edit instead of a blank.
 */
export function withSchedulePreset(form: ScheduleForm, preset: SchedulePreset): ScheduleForm {
  if (preset === form.preset) {
    return form
  }

  return preset === 'custom' ? { ...form, custom: scheduleExprFromForm(form), preset } : { ...form, preset }
}

/** Which fields a preset shows. */
export function scheduleFields(preset: SchedulePreset): {
  minute: boolean
  monthday: boolean
  time: boolean
  weekday: boolean
} {
  return {
    minute: preset === 'hourly',
    monthday: preset === 'monthly',
    time: preset === 'daily' || preset === 'weekdays' || preset === 'weekly' || preset === 'monthly',
    weekday: preset === 'weekly'
  }
}

/** The words `describeSchedule` needs — a subset of the `cron` translations. */
export interface ScheduleCopy {
  dayFallback: (value: string) => string
  days: Record<string, string>
  everyDayAt: (time: string) => string
  everyDayOfWeekAt: (day: string, time: string) => string
  everyDays: (count: number) => string
  everyHourAt: (minute: string) => string
  everyHours: (count: number) => string
  everyMinutes: (count: number) => string
  monthlyOnDayAt: (dayOfMonth: string, time: string) => string
  topOfHour: string
  weekdaysAt: (time: string) => string
}

/**
 * A stored schedule as a sentence ("Mỗi ngày lúc 21:00"), or '' when it has no
 * plain reading and the caller should show the expression itself. Covers what
 * the form can build plus the backend's interval display ("every 120m").
 * `formatClock` is passed in so the sentence follows the app's language rather
 * than the machine's clock style.
 */
export function describeSchedule(
  expr: string,
  copy: ScheduleCopy,
  formatClock: (hour: number, minute: number) => string
): string {
  const normalized = expr.trim().replace(/\s+/g, ' ')
  const interval = /^every (\d+)\s*([mhd])$/i.exec(normalized)

  if (interval) {
    const count = Number(interval[1])
    const unit = interval[2].toLowerCase()

    if (unit === 'd' || (unit === 'm' && count % 1440 === 0)) {
      return copy.everyDays(unit === 'd' ? count : count / 1440)
    }

    if (unit === 'h' || count % 60 === 0) {
      return copy.everyHours(unit === 'h' ? count : count / 60)
    }

    return copy.everyMinutes(count)
  }

  const form = scheduleFormFromExpr(normalized)
  const [hour, minute] = timeParts(form.time)
  const time = formatClock(hour, minute)

  switch (form.preset) {
    case 'daily':
      return normalized ? copy.everyDayAt(time) : ''

    case 'weekdays':
      return copy.weekdaysAt(time)

    case 'weekly':
      return copy.everyDayOfWeekAt(copy.days[form.weekday] ?? copy.dayFallback(form.weekday), time)

    case 'monthly':
      return copy.monthlyOnDayAt(form.monthday, time)

    case 'hourly':
      return form.minute === '0' ? copy.topOfHour : copy.everyHourAt(pad(form.minute))

    case 'every-15-minutes':
      return copy.everyMinutes(15)

    default:
      return ''
  }
}
