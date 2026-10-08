import { useStore } from '@nanostores/react'

import { StatusRow } from '@/components/chat/status-row'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
import { licenseBannerKind, licenseGraceMessage, licenseReadOnlyMessage } from '@/lib/license'
import { $license, checkLicenseNow, licenseCheckFailed } from '@/store/license'

/**
 * The AgentX license in the composer's status stack, while it has something
 * to say. In the grace period it warns — sending still works. Read-only, it
 * says why the composer is locked and whom to ask, with "Check again" for the
 * moment somebody renews the plan (the main process otherwise re-checks on its
 * own every half hour).
 *
 * Not per-session like the billing wall: a license is the person's, so every
 * composer shows it. The sentence wraps rather than truncates — the contact at
 * its end is the part the person needs.
 */
export function LicenseBanner() {
  const state = useStore($license)
  const { checking, license } = state
  const { t } = useI18n()
  const kind = licenseBannerKind(license)

  if (!license || !kind) {
    return null
  }

  const readOnly = kind === 'read_only'

  return (
    <StatusRow
      leading={
        <Codicon
          aria-hidden
          className={readOnly ? 'text-destructive/85' : 'text-(--ui-yellow)'}
          name={readOnly ? 'lock' : 'warning'}
          size="0.8rem"
        />
      }
      trailing={
        <Button
          className="text-foreground/90 hover:text-foreground"
          disabled={checking}
          onClick={() => void checkLicenseNow()}
          size="micro"
          type="button"
          variant="text"
        >
          {checking ? t.license.checking : t.license.checkAgain}
        </Button>
      }
      trailingVisible
    >
      <span className="grid min-w-0 gap-0.5 text-xs leading-4">
        <span className="text-foreground/92" role="status">
          {readOnly ? licenseReadOnlyMessage(license, t.license) : licenseGraceMessage(license, t.license)}
        </span>
        {/* A check that could not reach the service must not look like one
            that confirmed the license. */}
        {licenseCheckFailed(state) && <span className="text-muted-foreground/80">{t.license.checkFailed}</span>}
      </span>
    </StatusRow>
  )
}
