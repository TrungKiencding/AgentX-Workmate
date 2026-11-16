import { describe, expect, it } from 'vitest'

import {
  DEFAULT_SCHEDULE_FORM,
  describeSchedule,
  SCHEDULE_PRESETS,
  type ScheduleCopy,
  scheduleExprFromForm,
  scheduleFields,
  scheduleFormFromExpr,
  withSchedulePreset
} from './schedule-form'

describe('cron schedule form', () => {
  it('opens a new job on daily at 09:00', () => {
    const form = scheduleFormFromExpr('')

    expect(form).toEqual(DEFAULT_SCHEDULE_FORM)
    expect(scheduleExprFromForm(form)).toBe('0 9 * * *')
  })

  // The reported bug: "daily" was the literal 09:00 and there was no way to move it.
  it('lets a daily job run at any time of day', () => {
    const form = { ...scheduleFormFromExpr(''), time: '21:00' }

    expect(scheduleExprFromForm(form)).toBe('0 21 * * *')
    expect(scheduleExprFromForm({ ...form, time: '07:45' })).toBe('45 7 * * *')
  })

  it.each([
    ['0 9 * * *', { preset: 'daily', time: '09:00' }],
    ['30 21 * * *', { preset: 'daily', time: '21:30' }],
    ['5 7 * * 1-5', { preset: 'weekdays', time: '07:05' }],
    ['0 18 * * 0', { preset: 'weekly', time: '18:00', weekday: '0' }],
    ['15 8 * * 5', { preset: 'weekly', time: '08:15', weekday: '5' }],
    ['0 9 1 * *', { monthday: '1', preset: 'monthly', time: '09:00' }],
    ['45 6 28 * *', { monthday: '28', preset: 'monthly', time: '06:45' }],
    ['0 * * * *', { minute: '0', preset: 'hourly' }],
    ['30 * * * *', { minute: '30', preset: 'hourly' }],
    ['*/15 * * * *', { preset: 'every-15-minutes' }]
  ] as const)('reads %s into its fields and writes it back unchanged', (expr, fields) => {
    const form = scheduleFormFromExpr(expr)

    expect(form).toMatchObject(fields)
    expect(scheduleExprFromForm(form)).toBe(expr)
  })

  it('reads cron Sunday-as-7 as Sunday', () => {
    expect(scheduleFormFromExpr('0 9 * * 7')).toMatchObject({ preset: 'weekly', weekday: '0' })
  })

  it('normalises spacing and leading zeros without changing meaning', () => {
    const form = scheduleFormFromExpr('  05   07  *  *  * ')

    expect(form).toMatchObject({ preset: 'daily', time: '07:05' })
    expect(scheduleExprFromForm(form)).toBe('5 7 * * *')
  })

  it.each([
    'every 2h',
    '30m',
    '0 9 * * 1,3,5',
    '0 9-17 * * 1-5',
    '0 9 1 1 *',
    '0 9 15 * 1',
    '*/5 * * * *',
    '0 9,21 * * *',
    '0 25 * * *',
    '2026-12-01T09:00'
  ])('keeps %s verbatim as a custom schedule', expr => {
    const form = scheduleFormFromExpr(expr)

    expect(form.preset).toBe('custom')
    expect(scheduleExprFromForm(form)).toBe(expr)
  })

  it('keeps the chosen time when the frequency changes and changes back', () => {
    const daily = { ...scheduleFormFromExpr(''), time: '21:30' }
    const weekly = withSchedulePreset(daily, 'weekly')
    const back = withSchedulePreset(withSchedulePreset(weekly, 'hourly'), 'daily')

    expect(scheduleExprFromForm(weekly)).toBe('30 21 * * 1')
    expect(scheduleExprFromForm(back)).toBe('30 21 * * *')
  })

  it('starts a custom schedule from the expression the form already held', () => {
    const form = withSchedulePreset({ ...scheduleFormFromExpr(''), time: '21:00' }, 'custom')

    expect(form.custom).toBe('0 21 * * *')
    expect(scheduleExprFromForm(form)).toBe('0 21 * * *')
  })

  it('reports an empty custom field as no schedule', () => {
    expect(scheduleExprFromForm({ ...DEFAULT_SCHEDULE_FORM, custom: '   ', preset: 'custom' })).toBe('')
  })

  it('falls back to safe values rather than writing a broken expression', () => {
    const broken = { ...DEFAULT_SCHEDULE_FORM, minute: 'x', monthday: '40', time: 'nope', weekday: '9' }

    expect(scheduleExprFromForm({ ...broken, preset: 'daily' })).toBe('0 9 * * *')
    expect(scheduleExprFromForm({ ...broken, preset: 'weekly' })).toBe('0 9 * * 1')
    expect(scheduleExprFromForm({ ...broken, preset: 'monthly' })).toBe('0 9 1 * *')
    expect(scheduleExprFromForm({ ...broken, preset: 'hourly' })).toBe('0 * * * *')
  })

  it('shows a time field for every preset that runs at a time of day', () => {
    const withTime = SCHEDULE_PRESETS.filter(preset => scheduleFields(preset).time)

    expect(withTime).toEqual(['daily', 'weekdays', 'weekly', 'monthly'])
    expect(scheduleFields('weekly').weekday).toBe(true)
    expect(scheduleFields('monthly').monthday).toBe(true)
    expect(scheduleFields('hourly')).toEqual({ minute: true, monthday: false, time: false, weekday: false })
    expect(scheduleFields('custom')).toEqual({ minute: false, monthday: false, time: false, weekday: false })
  })
})

describe('describeSchedule', () => {
  const copy: ScheduleCopy = {
    dayFallback: value => `day ${value}`,
    days: { '0': 'Sunday', '1': 'Monday', '5': 'Friday' },
    everyDayAt: time => `Every day at ${time}`,
    everyDayOfWeekAt: (day, time) => `Every ${day} at ${time}`,
    everyDays: count => `Every ${count} days`,
    everyHourAt: minute => `Every hour at :${minute}`,
    everyHours: count => `Every ${count} hours`,
    everyMinutes: count => `Every ${count} minutes`,
    monthlyOnDayAt: (dayOfMonth, time) => `Monthly on day ${dayOfMonth} at ${time}`,
    topOfHour: 'At the top of every hour',
    weekdaysAt: time => `Weekdays at ${time}`
  }

  const clock = (hour: number, minute: number) => `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`

  it.each([
    ['0 21 * * *', 'Every day at 21:00'],
    ['30 7 * * 1-5', 'Weekdays at 07:30'],
    ['0 18 * * 5', 'Every Friday at 18:00'],
    ['0 9 * * 7', 'Every Sunday at 09:00'],
    ['0 9 15 * *', 'Monthly on day 15 at 09:00'],
    ['0 * * * *', 'At the top of every hour'],
    ['5 * * * *', 'Every hour at :05'],
    ['*/15 * * * *', 'Every 15 minutes'],
    // The backend stores every interval in minutes.
    ['every 120m', 'Every 2 hours'],
    ['every 45m', 'Every 45 minutes'],
    ['every 2880m', 'Every 2 days'],
    ['every 2h', 'Every 2 hours'],
    ['every 1d', 'Every 1 days']
  ])('reads %s as "%s"', (expr, sentence) => {
    expect(describeSchedule(expr, copy, clock)).toBe(sentence)
  })

  it.each(['', '0 9 * * 1,3,5', 'once in 30m', 'once at 2026-12-01 09:00'])(
    'has no sentence for %j, so the caller shows the expression',
    expr => {
      expect(describeSchedule(expr, copy, clock)).toBe('')
    }
  )

  it('names a weekday it has no word for rather than dropping it', () => {
    expect(describeSchedule('0 9 * * 3', copy, clock)).toBe('Every day 3 at 09:00')
  })
})
