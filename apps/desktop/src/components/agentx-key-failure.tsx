import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import type { DesktopAgentxKeyFailure, DesktopAgentxKeyGate } from '@/global'
import { useI18n } from '@/i18n'
import {
  agentxKeyContact,
  agentxKeyNeedsSupportLine,
  agentxKeyReason,
  agentxKeyReport,
  agentxKeySupportLine
} from '@/lib/agentx-key'
import { AlertCircle, Check, Copy } from '@/lib/icons'
import { $license } from '@/store/license'

const COPIED_FLASH_MS = 1500

/** The app's version for the error report; '' until (or unless) the bridge answers. */
function useAppVersion(): string {
  const [appVersion, setAppVersion] = useState('')

  useEffect(() => {
    let cancelled = false

    void Promise.resolve()
      .then(() => window.agentxDesktop?.getVersion?.())
      .then(version => {
        if (!cancelled && version?.appVersion) {
          setAppVersion(version.appVersion)
        }
      })
      .catch(() => undefined)

    return () => {
      cancelled = true
    }
  }, [])

  return appVersion
}

/**
 * Why an AgentX key could not be issued, and whom to tell — the same block on
 * the key gate and on the onboarding gateway card. The reason is this app's
 * sentence; the service's own words sit under "Error details", with a copy
 * button, for the person support will ask.
 */
export function AgentxKeyFailureNotice({
  account = null,
  attempts = 1,
  failure
}: {
  account?: DesktopAgentxKeyGate['account']
  attempts?: number
  failure: DesktopAgentxKeyFailure | null
}) {
  const { t } = useI18n()
  const { license } = useStore($license)
  const appVersion = useAppVersion()
  const [copied, setCopied] = useState(false)
  const copy = t.agentxKey
  const report = agentxKeyReport({ appVersion, state: { account, attempts, failure } })

  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(report)
      setCopied(true)
      window.setTimeout(() => setCopied(false), COPIED_FLASH_MS)
    } catch {
      // Clipboard refused: the details are on screen to read out instead.
    }
  }

  return (
    <div className="grid gap-3">
      <div className="flex items-start gap-2 text-sm text-destructive" role="alert">
        <AlertCircle className="mt-0.5 size-4 shrink-0" />
        <span>{agentxKeyReason(failure, copy, t.license)}</span>
      </div>
      {agentxKeyNeedsSupportLine(failure) ? (
        <p className="text-sm text-foreground">{agentxKeySupportLine(agentxKeyContact(failure, license), copy)}</p>
      ) : null}
      <details className="rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-tertiary)/40 px-3 py-2 text-xs">
        <summary className="cursor-pointer select-none text-muted-foreground">{copy.details}</summary>
        <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-[0.6875rem] leading-relaxed text-muted-foreground">
          {report}
        </pre>
        <Button className="mt-2" onClick={() => void copyReport()} size="xs" type="button" variant="outline">
          {copied ? <Check /> : <Copy />}
          {copied ? copy.copied : copy.copyDetails}
        </Button>
      </details>
    </div>
  )
}
