import { useStore } from '@nanostores/react'

import { Button } from '@/components/ui/button'
import { StatusPill, type StatusPillTone } from '@/components/ui/status-pill'
import type { DesktopLicenseState } from '@/global'
import { useI18n } from '@/i18n'
import { fmtCalendarDay } from '@/lib/time'
import { $license, checkLicenseNow, licenseCheckFailed } from '@/store/license'

import { ListRow } from './primitives'

const STATE_TONE: Record<DesktopLicenseState, StatusPillTone> = {
  active: 'good',
  expired: 'bad',
  grace: 'warn',
  none: 'muted',
  revoked: 'bad',
  scheduled: 'info'
}

/**
 * Settings → Account: this person's AgentX license — the plan, its state, the
 * day that matters, whom to ask — and "Check again".
 *
 * Shown whenever a license is known, enforced or not: with enforcement off the
 * plan is still worth knowing, it just blocks nothing. Hidden while none is
 * known, which is how an SSO that predates licensing reads.
 */
export function LicenseRow() {
  const state = useStore($license)
  const { t } = useI18n()
  const copy = t.license
  const { license } = state

  if (!license) {
    return null
  }

  const plan = license.plan?.name?.trim() || license.plan?.slug?.trim() || ''
  // A plan that has not started is about its first day as much as its last.
  const startsOn = license.state === 'scheduled' && license.starts_on ? fmtCalendarDay(license.starts_on) : ''
  const lastDay = license.state !== 'none' && license.last_day ? fmtCalendarDay(license.last_day) : ''

  const description = [plan, startsOn && copy.startsOn(startsOn), lastDay && copy.lastDay(lastDay)]
    .filter(Boolean)
    .join(' · ')

  const contact = (license.contact ?? '').trim()
  const checkFailed = licenseCheckFailed(state)

  return (
    <ListRow
      action={
        <Button disabled={state.checking} onClick={() => void checkLicenseNow()} variant="outline">
          {state.checking ? copy.checking : copy.checkAgain}
        </Button>
      }
      below={
        contact || checkFailed ? (
          <div className="mt-1 grid gap-1 text-sm text-(--ui-text-tertiary)">
            {contact && <p data-selectable-text="true">{copy.contactLine(contact)}</p>}
            {checkFailed && <p role="status">{copy.checkFailed}</p>}
          </div>
        ) : undefined
      }
      description={description || undefined}
      title={
        <span className="inline-flex flex-wrap items-center gap-2">
          {copy.title}
          <StatusPill tone={STATE_TONE[license.state] ?? 'muted'}>
            {copy.states[license.state] ?? license.state}
          </StatusPill>
        </span>
      }
    />
  )
}
