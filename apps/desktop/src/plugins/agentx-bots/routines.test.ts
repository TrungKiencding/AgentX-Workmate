import { describe, expect, it } from 'vitest'

import {
  composeSchedule,
  defaultSchedule,
  describeSchedule,
  hasControlChars,
  previewSchedule,
  repeatCount,
  routineActive,
  routineTitle,
  type ScheduleState
} from './routines'
import { textFor } from './test-utils'

const vi = textFor('vi')
const en = textFor('en')
const state = (patch: Partial<ScheduleState>): ScheduleState => ({ ...defaultSchedule(), ...patch })

describe('composeSchedule', () => {
  it.each([
    [{ freq: 'daily', time: '08:30' }, '30 8 * * *'],
    [{ freq: 'weekdays', time: '18:00' }, '0 18 * * 1-5'],
    [{ freq: 'weekly', time: '09:00', weekday: '0' }, '0 9 * * 0'],
    [{ freq: 'monthly', time: '07:30', monthday: '15' }, '30 7 15 * *'],
    [{ freq: 'hourly' }, 'every 1h'],
    [{ freq: 'interval', intervalN: '3', intervalUnit: 'd' }, 'every 3d'],
    [{ freq: 'once', onceN: '45', onceUnit: 'm' }, '45m'],
    [{ freq: 'advanced', raw: '  0 9 * * 1  ' }, '0 9 * * 1']
  ] as const)('%o → %s', (patch, expected) => {
    expect(composeSchedule(state(patch))).toBe(expected)
  })

  it('clamps nonsense input to something schedulable', () => {
    expect(composeSchedule(state({ freq: 'monthly', monthday: '31' }))).toBe('0 8 28 * *')
    expect(composeSchedule(state({ freq: 'interval', intervalN: '0' }))).toBe('every 1h')
    expect(composeSchedule(state({ freq: 'daily', time: 'garbage' }))).toBe('0 8 * * *')
    expect(composeSchedule(state({ freq: 'advanced', raw: '' }))).toBe('')
  })
})

describe('repeatCount', () => {
  it('only applies to recurring picks', () => {
    expect(repeatCount(state({ freq: 'daily', repeatN: '5' }))).toBe(5)
    expect(repeatCount(state({ freq: 'daily', repeatN: '' }))).toBeNull()
    expect(repeatCount(state({ freq: 'once', repeatN: '5' }))).toBeNull()
    expect(repeatCount(state({ freq: 'advanced', repeatN: '5' }))).toBeNull()
  })
})

describe('describeSchedule', () => {
  it('speaks plain Vietnamese for every form the picker produces', () => {
    expect(describeSchedule('30 8 * * *', vi)).toBe('Mỗi ngày lúc 08:30')
    expect(describeSchedule('0 18 * * 1-5', vi)).toBe('Thứ Hai – Thứ Sáu lúc 18:00')
    expect(describeSchedule('0 9 * * 0', vi)).toBe('Mỗi Chủ Nhật lúc 09:00')
    expect(describeSchedule('30 7 15 * *', vi)).toBe('Ngày 15 hằng tháng lúc 07:30')
  })

  it('reads the backend display forms', () => {
    expect(describeSchedule('every 60m', vi)).toBe('Mỗi giờ')
    expect(describeSchedule('every 180m', vi)).toBe('Mỗi 3 giờ')
    expect(describeSchedule('every 2880m', vi)).toBe('Mỗi 2 ngày')
    expect(describeSchedule('every 45m', vi)).toBe('Mỗi 45 phút')
    expect(describeSchedule('once in 30m', vi)).toBe('Một lần, sau 30 phút')
    expect(describeSchedule('once at 2026-11-06 09:00', vi)).toBe('Một lần, 2026-11-06 09:00')
  })

  it('falls back to the raw expression it cannot phrase', () => {
    expect(describeSchedule('*/5 * * * *', en)).toBe('Custom: */5 * * * *')
    expect(describeSchedule('', en)).toBe('')
  })

  it('previews the repeat cap', () => {
    expect(previewSchedule(state({ freq: 'daily', time: '08:00', repeatN: '3' }), en)).toBe(
      'Every day at 08:00, 3 times'
    )
  })
})

describe('job helpers', () => {
  it('strips the old [bot:name] prefix from titles', () => {
    expect(routineTitle({ name: '[bot:writer] Morning brief' }, 'Untitled')).toBe('Morning brief')
    expect(routineTitle({ name: '' }, 'Untitled')).toBe('Untitled')
  })

  it('treats disabled or paused jobs as inactive', () => {
    expect(routineActive({ enabled: true, state: 'scheduled' })).toBe(true)
    expect(routineActive({ enabled: false })).toBe(false)
    expect(routineActive({ state: 'paused' })).toBe(false)
  })

  it('rejects NUL bytes', () => {
    expect(hasControlChars('ok', 'fine')).toBe(false)
    expect(hasControlChars('bad\0')).toBe(true)
  })
})
