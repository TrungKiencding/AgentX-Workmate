import { useStore } from '@nanostores/react'

import { useI18n } from '@/i18n'
import { licenseReadOnlyMessage } from '@/lib/license'
import { $license } from '@/store/license'

/**
 * Why AI actions are unavailable right now, or null while they may be used.
 *
 * Non-null while the AgentX license is read-only: the reason and whom to ask,
 * in the display language — what a disabled AI control (read aloud, a sparkle
 * "generate" button) shows as its tooltip.
 */
export function useAiBlockedReason(): null | string {
  const { license } = useStore($license)
  const { t } = useI18n()

  return license?.access === 'read_only' ? licenseReadOnlyMessage(license, t.license) : null
}
