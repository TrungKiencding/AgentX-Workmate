import './sign-in-overlay.css'

import { useStore } from '@nanostores/react'
import { Dialog } from 'radix-ui'
import { lazy, Suspense, useId, useState } from 'react'

import { BrandGlyph } from '@/components/brand-glyph'
import { BrandMark } from '@/components/brand-mark'
import { Button } from '@/components/ui/button'
import { Loader } from '@/components/ui/loader'
import { useI18n } from '@/i18n'
import { AlertCircle, ArrowRight, Check, ChevronLeft, Globe, LogIn } from '@/lib/icons'
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
 * Non-dismissable by design — Escape cannot dismiss it and there is no close button. There is
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
  const hintId = useId()

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

  return (
    <Dialog.Root open>
      <Dialog.Content
        asChild
        {...(view === 'connect' ? { 'aria-describedby': undefined } : {})}
        onEscapeKeyDown={event => event.preventDefault()}
      >
        <div aria-modal="true" className="sign-in-screen fixed inset-0 z-(--z-setup) bg-background text-foreground">
          {view === 'connect' ? (
            <div className="flex max-h-[86vh] w-full max-w-[46rem] flex-col overflow-hidden rounded-xl border border-(--stroke-nous) bg-card shadow-nous">
              <div className="flex items-center justify-between gap-4 px-4 pt-4">
                <Button onClick={() => setView('sign-in')} size="sm" variant="text">
                  <ChevronLeft aria-hidden="true" className="rtl:rotate-180" />
                  {copy.back}
                </Button>
                <Dialog.Title asChild>
                  <h2 className="text-base font-semibold">{copy.gatewaySettings}</h2>
                </Dialog.Title>
              </div>
              <div className="min-h-0 flex-1 pt-4">
                <Suspense fallback={<Loader className="mx-auto my-16 size-6 text-(--ui-text-tertiary)" />}>
                  <GatewaySettings embedded />
                </Suspense>
              </div>
            </div>
          ) : (
            <div className="sign-in-layout rounded-(--radius-overlay) border border-(--stroke-nous) bg-card shadow-nous">
              <section aria-label="AgentX Workmate" className="sign-in-brand">
                <div className="sign-in-wordmark">
                  <BrandMark className="size-10" />
                  <span className="text-lg font-semibold tracking-tight">
                    AgentX <span className="font-normal">Workmate</span>
                  </span>
                </div>
                <div className="sign-in-intro">
                  <p className="text-base font-medium text-primary">{copy.signInEyebrow}</p>
                  <p className="sign-in-headline text-3xl font-semibold tracking-tight">
                    <span>{copy.signInHeroLead}</span>
                    <span className="text-primary">{copy.signInHeroAccent}</span>
                  </p>
                  <p className="sign-in-lede text-md text-(--ui-text-secondary)">{copy.signInHeroDescription}</p>
                </div>
                <BrandGlyph className="sign-in-brand-art" />
              </section>

              <section className="sign-in-form">
                <div>
                  <Dialog.Title asChild>
                    <h1 className="text-2xl font-semibold tracking-tight text-balance">{copy.keycloakTitle}</h1>
                  </Dialog.Title>
                  <Dialog.Description asChild>
                    <p className="mt-3 text-md text-(--ui-text-secondary) text-pretty">{copy.keycloakDescription}</p>
                  </Dialog.Description>
                </div>
                <div className="mt-8 grid gap-4">
                  <Button
                    aria-describedby={hintId}
                    className="w-full font-semibold"
                    disabled={busy || done}
                    onClick={() => void signIn()}
                    size="xl"
                  >
                    {done ? (
                      <Check aria-hidden="true" />
                    ) : busy ? (
                      <Loader aria-hidden="true" className="size-4 text-current" variant="ring" />
                    ) : (
                      <LogIn aria-hidden="true" />
                    )}
                    {done ? copy.keycloakSignedIn : busy ? copy.keycloakSigningIn : copy.signInWithAgentX}
                    {!busy && !done ? <ArrowRight aria-hidden="true" className="ms-auto rtl:rotate-180" /> : null}
                  </Button>
                  <div className="flex items-start gap-2.5 text-base text-(--ui-text-secondary)" id={hintId}>
                    <Globe aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                    <p className="text-justify text-pretty">{copy.keycloakSignInHint}</p>
                  </div>
                </div>

                {error ? (
                  <div className="mt-5 flex items-start gap-2 text-base text-destructive" role="alert">
                    <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                    <span className="min-w-0 wrap-anywhere">{error}</span>
                  </div>
                ) : null}

                <div aria-atomic="true" aria-live="polite">
                  {busy || done ? (
                    <p className="mt-5 text-base text-(--ui-text-secondary)">
                      {done ? copy.keycloakReconnecting : copy.signInBrowserHint}
                    </p>
                  ) : null}
                </div>

                <div className="mt-8 border-t border-(--ui-stroke-tertiary) pt-5">
                  <Button disabled={busy || done} onClick={() => setView('connect')} size="sm" variant="text">
                    {copy.gatewaySettings}
                  </Button>
                </div>
              </section>
            </div>
          )}
        </div>
      </Dialog.Content>
    </Dialog.Root>
  )
}
