import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { DesktopLicense } from '@/global'
import { FALLBACK_LOCALE, TRANSLATIONS } from '@/i18n'
import { setRuntimeI18nLocale } from '@/i18n/runtime'

import {
  asLicense,
  licenseBannerKind,
  licenseExpiringMessage,
  licenseGraceMessage,
  licenseReadOnlyMessage,
  licenseReadOnlyReason,
  licenseReminderKey
} from './license'
import { fmtCalendarDay } from './time'

const vi = TRANSLATIONS.vi.license
const en = TRANSLATIONS.en.license

function license(overrides: Partial<DesktopLicense> = {}): DesktopLicense {
  return {
    access: 'full',
    contact: 'it@astralx.com.vn',
    days_left: 7,
    enforced: true,
    last_day: '2026-12-31',
    notice: 'expiring',
    plan: { name: 'Pilot nội bộ 2026', slug: 'pilot-2026' },
    read_only_from: '2027-01-08',
    reminder: 7,
    starts_on: '2026-10-15',
    state: 'active',
    warn_days: [14, 7, 1],
    ...overrides
  }
}

describe('license sentences', () => {
  beforeEach(() => setRuntimeI18nLocale('vi'))
  afterEach(() => setRuntimeI18nLocale(FALLBACK_LOCALE))

  it('explains each read-only state in Vietnamese, with dd/MM/yyyy days', () => {
    expect(licenseReadOnlyReason(license({ access: 'read_only', plan: null, state: 'none' }), vi)).toBe(
      'Tài khoản chưa được cấp giấy phép AgentX.'
    )
    expect(licenseReadOnlyReason(license({ access: 'read_only', state: 'scheduled' }), vi)).toBe(
      'Gói Pilot nội bộ 2026 bắt đầu từ ngày 15/10/2026.'
    )
    expect(licenseReadOnlyReason(license({ access: 'read_only', state: 'expired' }), vi)).toBe(
      'Gói Pilot nội bộ 2026 đã hết hạn ngày 31/12/2026. Workmate đang ở chế độ chỉ xem.'
    )
    expect(licenseReadOnlyReason(license({ access: 'read_only', state: 'revoked' }), vi)).toBe(
      'Giấy phép AgentX của bạn đã bị thu hồi. Workmate đang ở chế độ chỉ xem.'
    )
  })

  it('adds whom to ask, and only when there is somebody', () => {
    const revoked = license({ access: 'read_only', state: 'revoked' })

    expect(licenseReadOnlyMessage(revoked, vi)).toBe(
      'Giấy phép AgentX của bạn đã bị thu hồi. Workmate đang ở chế độ chỉ xem. ' +
        'Liên hệ it@astralx.com.vn để được cấp lại hoặc gia hạn.'
    )
    expect(licenseReadOnlyMessage({ ...revoked, contact: '  ' }, vi)).toBe(licenseReadOnlyReason(revoked, vi))
  })

  it('warns through the grace period with the day read-only begins', () => {
    expect(licenseGraceMessage(license({ notice: 'grace', state: 'grace' }), vi)).toBe(
      'Gói Pilot nội bộ 2026 đã hết hạn ngày 31/12/2026. Từ ngày 08/01/2027, Workmate chuyển sang chế độ chỉ xem. ' +
        'Liên hệ it@astralx.com.vn để gia hạn.'
    )
  })

  it('reminds with the days left', () => {
    expect(licenseExpiringMessage(license({ contact: '' }), vi)).toBe(
      'Gói Pilot nội bộ 2026 hết hạn ngày 31/12/2026 (còn 7 ngày).'
    )
  })

  it('reads naturally in English', () => {
    setRuntimeI18nLocale('en')

    expect(licenseReadOnlyMessage(license({ access: 'read_only', contact: '', state: 'expired' }), en)).toBe(
      'Your Pilot nội bộ 2026 plan expired on Dec 31, 2026. Workmate is in read-only mode.'
    )
    expect(licenseExpiringMessage(license({ contact: '', days_left: 1 }), en)).toBe(
      'Your Pilot nội bộ 2026 plan expires on Dec 31, 2026 (1 day left).'
    )
    expect(licenseExpiringMessage(license({ days_left: 14 }), en)).toBe(
      'Your Pilot nội bộ 2026 plan expires on Dec 31, 2026 (14 days left). Contact it@astralx.com.vn to renew.'
    )
  })

  it('falls back to the general sentence when a reason is missing its facts', () => {
    expect(licenseReadOnlyReason(license({ access: 'read_only', last_day: null, state: 'expired' }), vi)).toBe(
      vi.readOnlyGeneric
    )
    expect(licenseReadOnlyReason(license({ access: 'read_only', plan: null, state: 'scheduled' }), vi)).toBe(
      vi.readOnlyGeneric
    )
  })
})

describe('what the composer banner shows', () => {
  it('locks for read-only, warns for grace, and says nothing otherwise', () => {
    expect(licenseBannerKind(null)).toBeNull()
    expect(licenseBannerKind(license({ access: 'read_only', notice: 'read_only', state: 'expired' }))).toBe('read_only')
    expect(licenseBannerKind(license({ notice: 'grace', state: 'grace' }))).toBe('grace')
    // A reminder is a toast, not a banner.
    expect(licenseBannerKind(license())).toBeNull()
    // Not enforced: the service never sets a notice, and nothing is shown.
    expect(licenseBannerKind(license({ enforced: false, notice: null, state: 'grace' }))).toBeNull()
  })
})

describe('the reminder key', () => {
  it('names the person, the plan, its last day and the threshold', () => {
    expect(licenseReminderKey('kien', license())).toBe('kien|pilot-2026|2026-12-31|7')
    expect(licenseReminderKey(null, license({ reminder: 1 }))).toBe('|pilot-2026|2026-12-31|1')
  })

  it('is null when there is nothing to remind about', () => {
    expect(licenseReminderKey('kien', null)).toBeNull()
    expect(licenseReminderKey('kien', license({ notice: null }))).toBeNull()
    expect(licenseReminderKey('kien', license({ reminder: null }))).toBeNull()
    expect(licenseReminderKey('kien', license({ notice: 'grace', state: 'grace' }))).toBeNull()
  })
})

describe('asLicense', () => {
  it('accepts only something shaped like a license', () => {
    expect(asLicense(null)).toBeNull()
    expect(asLicense('expired')).toBeNull()
    expect(asLicense([])).toBeNull()
    expect(asLicense({ state: 'expired' })).toBeNull()
    expect(asLicense(license())).toEqual(license())
  })
})

describe('fmtCalendarDay', () => {
  afterEach(() => setRuntimeI18nLocale(FALLBACK_LOCALE))

  it('writes the day as sent, whatever the machine time zone', () => {
    setRuntimeI18nLocale('vi')

    expect(fmtCalendarDay('2026-12-31')).toBe('31/12/2026')
    expect(fmtCalendarDay('2027-01-08')).toBe('08/01/2027')

    setRuntimeI18nLocale('en')

    expect(fmtCalendarDay('2027-01-08')).toBe('Jan 8, 2027')
  })

  it('refuses what is not a calendar day', () => {
    expect(fmtCalendarDay('')).toBe('')
    expect(fmtCalendarDay('31/12/2026')).toBe('')
    expect(fmtCalendarDay('2026-02-31')).toBe('')
    expect(fmtCalendarDay('2026-12-31T00:00:00+07:00')).toBe('')
  })
})
