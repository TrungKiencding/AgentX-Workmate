import { useStore } from '@nanostores/react'
import { lazy, Suspense, useState } from 'react'

import { BrandMark } from '@/components/brand-mark'
import { Button } from '@/components/ui/button'
import { Loader } from '@/components/ui/loader'
import { useI18n } from '@/i18n'
import { AlertCircle, Check, ChevronLeft, Loader2, LogIn } from '@/lib/icons'
import { $desktopBoot } from '@/store/boot'
import { $desktopOnboarding } from '@/store/onboarding'

import { shouldShowSignInGate } from './sign-in-gate'

// The gateway panel is only reachable from the quiet escape hatch, so it stays
// out of this screen's bundle until someone opens it.
const GatewaySettings = lazy(() =>
  import('@/app/settings/gateway-settings').then(module => ({ default: module.GatewaySettings }))
)

type View = 'sign-in' | 'connect'

/**
 * The sign-in gate for a locally-gated AgentX Workmate install.
 *
 * This deliberately does NOT reuse BootFailureOverlay. That surface is a
 * crash-recovery console — Retry, Repair install, Open logs, a raw log dump —
 * and it is compact and dense on purpose. Rendering a sign-in prompt through it
 * told the user their app had broken and buried the one thing they could
 * actually do among four things they couldn't. Nothing here has failed: the
 * backend is healthy and waiting to be told who is using it.
 *
 * So the shape is a gate, not an error: the confident scale the install
 * overlay already uses, the product's own mark, one primary action, and no
 * recovery chrome. The gateway escape hatch stays, quiet and subordinate,
 * because someone pointed at the wrong backend still needs a way out.
 *
 * Non-dismissable by design — no Esc handler and no close button. There is
 * nothing behind this screen; the backend refuses to serve an unidentified
 * caller.
 */
export function SignInOverlay() {
  const boot = useStore($desktopBoot)
  const onboarding = useStore($desktopOnboarding)
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [view, setView] = useState<View>('sign-in')

  const copy = t.boot.failure

  const visible = shouldShowSignInGate({
    bootError: boot.error,
    bootRunning: boot.running,
    onboardingStatus: onboarding.flow.status
  })

  if (!visible) {
    return null
  }

  const signIn = async () => {
    setBusy(true)
    setError(null)

    try {
      const result = await window.agentxDesktop?.keycloak?.signIn()

      if (result?.ok) {
        // Stay in the "signing in" state through the reload — flipping back to
        // an idle button for a beat reads as though nothing happened.
        setDone(true)
        // Clearing the latched boot failure is what makes the reload re-dial
        // the backend. main.ts latches local boot failures so a crash-looping
        // backend isn't respawned on every paint; a bare reload would replay
        // the same "sign-in required" error and land the user right back here.
        await window.agentxDesktop?.resetBootstrap().catch(() => undefined)
        window.location.reload()

        return
      }

      setError(result?.error || copy.signInIncompleteMessage)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (view === 'connect') {
    return (
      <div className="fixed inset-0 z-(--z-setup) flex items-center justify-center bg-background/90 p-4 backdrop-blur-md">
        <div className="flex max-h-[86vh] w-full max-w-[46rem] flex-col overflow-hidden rounded-xl border border-(--stroke-nous) bg-card shadow-nous">
          <button
            className="flex w-full items-center gap-1.5 px-4 pt-4 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setView('sign-in')}
            type="button"
          >
            <ChevronLeft className="size-3.5" />
            {copy.back}
          </button>
          <div className="min-h-0 flex-1 pt-4">
            <Suspense fallback={<Loader className="mx-auto my-16 size-6 text-(--ui-text-tertiary)" />}>
              <GatewaySettings embedded />
            </Suspense>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-(--z-setup) flex items-center justify-center bg-background/90 p-4 backdrop-blur-md">
      <div className="flex w-full max-w-xl flex-col rounded-xl border border-(--stroke-nous) bg-card p-8 shadow-nous">
        <div className="flex items-start gap-4">
          <BrandMark className="size-11 shrink-0" />
          <div className="min-w-0">
            <h2 className="text-xl font-semibold tracking-tight">{copy.keycloakTitle}</h2>
            <p className="mt-1.5 text-sm text-muted-foreground">{copy.keycloakDescription}</p>
          </div>
        </div>

        <div className="mt-7 grid gap-2">
          <Button
            className="justify-center font-semibold"
            disabled={busy || done}
            onClick={() => void signIn()}
            size="lg"
          >
            {busy || done ? <Loader2 className="animate-spin" /> : <LogIn />}
            {busy ? copy.keycloakSigningIn : done ? copy.keycloakReconnecting : copy.signInWithAgentX}
          </Button>
          <p className="text-xs text-muted-foreground">{copy.keycloakSignInHint}</p>
        </div>

        {error ? (
          <div className="mt-4 flex items-start gap-2 text-sm text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        {done ? (
          <div className="mt-4 flex items-center gap-2 text-sm text-primary">
            <Check className="size-4 shrink-0" />
            <span>{copy.keycloakReconnecting}</span>
          </div>
        ) : null}

        {/* Subordinate on purpose: someone pointed at the wrong backend still
            needs a way out, but it must not compete with signing in. */}
        <div className="mt-6 flex justify-center">
          <Button disabled={busy || done} onClick={() => setView('connect')} size="xs" variant="text">
            {copy.gatewaySettings}
          </Button>
        </div>
      </div>
    </div>
  )
}
