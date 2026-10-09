import { useStore } from '@nanostores/react'
import { useState } from 'react'

import { AgentxKeyFailureNotice } from '@/components/agentx-key-failure'
import { BrandMark } from '@/components/brand-mark'
import { Button } from '@/components/ui/button'
import { Loader } from '@/components/ui/loader'
import { useI18n } from '@/i18n'
import { Loader2, LogOut, RefreshCw } from '@/lib/icons'
import { signOutKeycloak } from '@/store/account'
import { $agentxKeyGate, retryAgentxKey } from '@/store/agentx-key'

/**
 * The AgentX key gate: a signed-in account whose AgentX AI Gateway key could
 * not be issued.
 *
 * The main process holds the boot until the key is on this machine
 * (electron/agentx-key-gate.ts), so there is no app behind this screen to get
 * back to — and, by design, no other provider to pick, nothing to skip, no
 * close button and no Esc. What is left is what can actually resolve it: try
 * again, sign out (the wrong account), or hand support the reason.
 */
export function AgentxKeyGate() {
  const gate = useStore($agentxKeyGate)
  const { t } = useI18n()
  const [signingOut, setSigningOut] = useState(false)

  if (!gate.required || gate.phase === 'open') {
    return null
  }

  const copy = t.agentxKey
  const busy = gate.phase === 'provisioning'
  const who = gate.account?.email || gate.account?.displayName || ''
  const { failure } = gate

  const signOut = async () => {
    setSigningOut(true)

    try {
      await signOutKeycloak()
    } catch {
      setSigningOut(false)
    }
  }

  return (
    <div
      aria-labelledby="agentx-key-gate-title"
      aria-modal="true"
      className="fixed inset-0 z-(--z-setup) flex items-center justify-center bg-background/90 p-4 backdrop-blur-md"
      role="alertdialog"
    >
      <div className="flex max-h-[90vh] w-full max-w-xl flex-col overflow-y-auto rounded-xl border border-(--stroke-nous) bg-card p-8 shadow-nous">
        <div className="flex items-start gap-4">
          <BrandMark className="size-11 shrink-0" />
          <div className="min-w-0">
            <h2 className="text-xl font-semibold tracking-tight" id="agentx-key-gate-title">
              {failure ? copy.title : copy.provisioning}
            </h2>
            {failure ? <p className="mt-1.5 text-sm text-muted-foreground">{copy.intro}</p> : null}
            {who ? <p className="mt-1.5 text-xs text-muted-foreground">{copy.account(who)}</p> : null}
          </div>
        </div>

        <div className="mt-6">
          {failure ? (
            <AgentxKeyFailureNotice account={gate.account} attempts={gate.attempts} failure={failure} />
          ) : (
            <div className="flex items-center text-muted-foreground" role="status">
              <Loader className="size-6" type="lemniscate-bloom" />
            </div>
          )}
        </div>

        <div className="mt-7 grid gap-2">
          {failure ? (
            <Button
              className="justify-center font-semibold"
              disabled={busy || signingOut}
              onClick={() => void retryAgentxKey()}
              size="lg"
            >
              {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              {busy ? copy.retrying : copy.retry}
            </Button>
          ) : null}
          <div className="flex justify-center">
            <Button disabled={signingOut} onClick={() => void signOut()} size="xs" type="button" variant="text">
              {signingOut ? <Loader2 className="animate-spin" /> : <LogOut />}
              {copy.signOut}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
