import type { DesktopLicense } from '@/global'
import type { Translations } from '@/i18n'
import { fmtCalendarDay } from '@/lib/time'

/**
 * The words for one AgentX license, shared by every surface that shows it —
 * the composer banner, Settings → Account, the reminder, a refused turn, the
 * onboarding gateway card — so they all say the same thing. Pure: the caller
 * passes the copy (`t.license`) and the app's display language decides the
 * dates (`fmtCalendarDay`).
 *
 * Only the calendar days the service sends for people to read are shown
 * (`starts_on`, `last_day`, `read_only_from`); the instants beside them are
 * for machines.
 */

export type LicenseCopy = Translations['license']

/** The code a turn refused for the license carries (hermes_cli/account_license.py). */
export const LICENSE_READ_ONLY_CODE = 'license_read_only'

const day = (value: null | string | undefined): string => (value ? fmtCalendarDay(value) : '')

const planName = (license: DesktopLicense): string => license.plan?.name?.trim() || license.plan?.slug?.trim() || ''

const contactOf = (license: DesktopLicense): string => (license.contact ?? '').trim()

/** Something shaped like a license, or null — a refused turn's payload is outside input. */
export function asLicense(value: unknown): DesktopLicense | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const candidate = value as Partial<DesktopLicense>

  return typeof candidate.state === 'string' && typeof candidate.access === 'string'
    ? (candidate as DesktopLicense)
    : null
}

/** Why this license leaves the person read-only, without whom to ask. */
export function licenseReadOnlyReason(license: DesktopLicense, copy: LicenseCopy): string {
  const plan = planName(license)

  switch (license.state) {
    case 'none':
      return copy.readOnlyNone

    case 'revoked':
      return copy.readOnlyRevoked
    case 'scheduled': {
      const startsOn = day(license.starts_on)

      return plan && startsOn ? copy.readOnlyScheduled(plan, startsOn) : copy.readOnlyGeneric
    }

    case 'expired': {
      const lastDay = day(license.last_day)

      return plan && lastDay ? copy.readOnlyExpired(plan, lastDay) : copy.readOnlyGeneric
    }

    default:
      return copy.readOnlyGeneric
  }
}

/** The read-only reason and, when there is one, whom to ask. */
export function licenseReadOnlyMessage(license: DesktopLicense, copy: LicenseCopy): string {
  const contact = contactOf(license)
  const reason = licenseReadOnlyReason(license, copy)

  return contact ? `${reason} ${copy.contactReissue(contact)}` : reason
}

/** The grace-period warning (the person can still use AI) and whom to ask. */
export function licenseGraceMessage(license: DesktopLicense, copy: LicenseCopy): string {
  const contact = contactOf(license)
  const warning = copy.grace(planName(license), day(license.last_day), day(license.read_only_from))

  return contact ? `${warning} ${copy.contactRenew(contact)}` : warning
}

/** The "your plan ends soon" reminder and whom to ask. */
export function licenseExpiringMessage(license: DesktopLicense, copy: LicenseCopy): string {
  const contact = contactOf(license)
  const reminder = copy.expiring(planName(license), day(license.last_day), license.days_left ?? 0)

  return contact ? `${reminder} ${copy.contactRenew(contact)}` : reminder
}

/**
 * What the composer banner shows now, if anything. `grace` warns (sending still
 * works); `read_only` explains the lock. Null while not enforced, and for the
 * reminder, which is a toast.
 */
export function licenseBannerKind(license: DesktopLicense | null): 'grace' | 'read_only' | null {
  if (!license) {
    return null
  }

  if (license.access === 'read_only') {
    return 'read_only'
  }

  return license.notice === 'grace' ? 'grace' : null
}

/**
 * Which reminder this is, so it is shown once per person, plan, last day and
 * threshold — across launches, and again when the plan is renewed and later
 * runs out a second time. Null when there is nothing to remind about.
 */
export function licenseReminderKey(account: null | string, license: DesktopLicense | null): null | string {
  if (!license || license.notice !== 'expiring' || license.reminder == null) {
    return null
  }

  return [account ?? '', license.plan?.slug ?? '', license.last_day ?? '', String(license.reminder)].join('|')
}
