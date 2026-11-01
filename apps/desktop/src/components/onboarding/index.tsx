import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Progress } from '@/components/ui/progress'
import { useI18n } from '@/i18n'
import { bootPhaseLabel } from '@/lib/boot-phase-label'
import { isProviderSetupErrorMessage } from '@/lib/provider-setup-errors'
import { cn } from '@/lib/utils'
import { $desktopBoot, type DesktopBootState } from '@/store/boot'
import {
  $desktopOnboarding,
  advanceFromModelConfirm,
  closeManualOnboarding,
  completeBrowserStep,
  confirmOnboardingModel,
  connectAgentxGateway,
  DEFAULT_MANUAL_ONBOARDING_REASON,
  DEFAULT_ONBOARDING_REASON,
  dismissFirstRunOnboarding,
  type OnboardingContext,
  refreshOnboarding
} from '@/store/onboarding'

import { BrowserStepPanel } from './browser-step'
import { FlowPanel } from './flow'
import { GatewayProviderRow } from './providers'

interface DesktopOnboardingOverlayProps {
  enabled: boolean
  onCompleted?: () => void
  profile: string
  requestGateway: OnboardingContext['requestGateway']
}

// Exit choreography, mirroring the gateway "connecting" overlay's timing:
// text-out (360ms: CONNECTED fades down, rest scrambles+fades) → hold (300ms)
// → surface-out (520ms, held back by [transition-delay:660ms]). Finalize after.
const ONBOARDING_EXIT_MS = 1180

export function DesktopOnboardingOverlay({
  enabled,
  onCompleted,
  profile,
  requestGateway
}: DesktopOnboardingOverlayProps) {
  const { t } = useI18n()
  const onboarding = useStore($desktopOnboarding)
  const boot = useStore($desktopBoot)
  const ctxRef = useRef<OnboardingContext>({ requestGateway, onCompleted, profile })
  ctxRef.current = { requestGateway, onCompleted, profile }

  const ctx = useMemo<OnboardingContext>(
    () => ({
      requestGateway: (...args) => ctxRef.current.requestGateway(...args),
      onCompleted: () => ctxRef.current.onCompleted?.(),
      get profile() {
        return ctxRef.current.profile
      }
    }),
    []
  )

  // Cinematic exit: dissolve the panel + overlay (revealing the chat behind),
  // THEN finalize so the unmount lands after the fade — mirrors the connecting
  // overlay's exit choreography instead of cutting instantly. `complete` is
  // whichever store action ends the flow from the step we are leaving.
  const [leaving, setLeaving] = useState(false)

  const leaveThen = (complete: () => void) => {
    if (leaving) {
      return
    }

    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

    if (reduce) {
      complete()

      return
    }

    setLeaving(true)
    window.setTimeout(complete, ONBOARDING_EXIT_MS)
  }

  // "Bắt đầu" on the model card: on to the browser step when this desktop can
  // offer it (the card stays put — no exit choreography between two steps),
  // otherwise finish the way the model card always did.
  const beginFromModel = () => {
    void advanceFromModelConfirm().then(next => {
      if (next === 'done') {
        leaveThen(() => confirmOnboardingModel(ctx))
      }
    })
  }

  const finishBrowserStep = (choice: 'connected' | 'later' | 'never') =>
    leaveThen(() => completeBrowserStep(ctx, choice))

  useEffect(() => {
    if (enabled || onboarding.requested) {
      void refreshOnboarding(ctx)
    }
  }, [ctx, enabled, onboarding.requested])

  // Mount from frame 1 so we replace the boot overlay seamlessly. The
  // configured field stays null until the runtime check resolves; only then
  // do we know whether to dismiss (true) or surface the picker (false).
  // Manual gateway reconnection shows the overlay regardless of readiness.
  if (onboarding.configured === true && !onboarding.manual) {
    return null
  }

  // Skipping setup leaves the app usable without marking inference ready.
  if (onboarding.firstRunSkipped && !onboarding.manual) {
    return null
  }

  const { flow } = onboarding
  // Show the launch reason only when it's a meaningful, caller-supplied prompt —
  // suppress the generic defaults (useless noise) and provider-setup errors
  // (those are surfaced by FlowPanel, not as a banner).
  const rawReason = onboarding.reason?.trim() || null

  const reason =
    rawReason &&
    !isProviderSetupErrorMessage(rawReason) &&
    rawReason !== DEFAULT_ONBOARDING_REASON &&
    rawReason !== DEFAULT_MANUAL_ONBOARDING_REASON
      ? rawReason
      : null

  // In manual mode the app is already configured, so the flow is "ready"
  // immediately — no runtime gate needed. Otherwise wait for the readiness
  // check (configured === false) before showing the picker.
  const ready = onboarding.manual || (enabled && onboarding.configured === false)
  const showPicker = flow.status === 'idle'
  // The final "you're in" screen drops the card chrome and floats centered on
  // the surface — same bare, cinematic treatment as the connecting overlay.
  const bare = ready && !showPicker && flow.status === 'confirming_model'

  return (
    <div
      className={cn(
        'fixed inset-0 z-(--z-onboarding) flex items-center justify-center bg-(--ui-chat-surface-background) p-6 transition-opacity duration-[520ms] ease-out',
        // On the bare confirm screen, hold the surface (text-out + hold) so the
        // per-element exit plays before it dissolves.
        bare && leaving ? '[transition-delay:660ms]' : '',
        leaving ? 'pointer-events-none opacity-0' : 'opacity-100'
      )}
    >
      <div
        className={cn(
          'relative w-full max-w-[45rem] transition-[transform,opacity,filter] duration-500 ease-out',
          bare
            ? ''
            : 'overflow-hidden rounded-xl border border-(--stroke-nous) bg-(--ui-chat-bubble-background) shadow-nous',
          // Bare confirm screen orchestrates its own per-element exit; the
          // carded states use the simple lift/blur dissolve.
          leaving && !bare
            ? '-translate-y-1 scale-[0.985] opacity-0 blur-[2px]'
            : 'translate-y-0 scale-100 opacity-100 blur-0'
        )}
      >
        {showPicker || !ready ? <Header /> : null}
        {onboarding.manual ? (
          <Button
            aria-label={t.common.close}
            className="absolute right-3 top-3 z-10 text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground"
            onClick={() => closeManualOnboarding()}
            size="icon-sm"
            variant="ghost"
          >
            <Codicon name="close" size="1rem" />
          </Button>
        ) : null}
        <div className="grid gap-3 p-5">
          {reason ? <ReasonNotice reason={reason} /> : null}
          {ready ? (
            showPicker ? (
              <Picker ctx={ctx} />
            ) : flow.status === 'connecting_browser' ? (
              <BrowserStepPanel leaving={leaving} onFinish={finishBrowserStep} />
            ) : (
              <FlowPanel ctx={ctx} flow={flow} leaving={leaving} onBegin={beginFromModel} />
            )
          ) : (
            <Preparing boot={boot} />
          )}
        </div>
      </div>
    </div>
  )
}

// The launch reason is a prompt ("why am I seeing this"), not an error. Only
// rendered for meaningful caller-supplied reasons (defaults are filtered out
// upstream), so it never shows the generic "no provider configured" noise.
function ReasonNotice({ reason }: { reason: string }) {
  return (
    <div className="rounded-2xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-tertiary)/40 px-4 py-3 text-sm text-muted-foreground">
      {reason}
    </div>
  )
}

function Preparing({ boot }: { boot: DesktopBootState }) {
  const { t } = useI18n()
  const progress = Math.max(2, Math.min(100, Math.round(boot.progress)))
  const hasError = Boolean(boot.error)
  const installing = boot.phase.startsWith('runtime.')

  return (
    <div className="grid gap-3" role="status">
      <p className="text-sm text-muted-foreground">
        {installing ? t.onboarding.preparingInstall : t.onboarding.starting}
      </p>
      <Progress
        aria-label={installing ? t.onboarding.preparingInstall : t.onboarding.starting}
        destructive={hasError}
        size="lg"
        value={progress / 100}
      />
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span className="truncate">{bootPhaseLabel(t, boot)}</span>
        <span>{progress}%</span>
      </div>
      {hasError ? <p className="text-xs text-destructive">{boot.error}</p> : null}
    </div>
  )
}

function Header() {
  const { t } = useI18n()

  return (
    <div className="px-6 pb-2 pt-6">
      {/* text-display (spec §3.6): the onboarding title is one of the rare
          24px moments — sans, weight 500, no colour block behind it. */}
      <h2 className="text-2xl font-medium text-balance text-(--text-primary)">{t.onboarding.headerTitle}</h2>
      <p className="mt-1.5 max-w-xl text-base text-pretty text-(--text-secondary)">{t.onboarding.gatewayHeaderDesc}</p>
    </div>
  )
}

export function Picker({ ctx }: { ctx: OnboardingContext }) {
  const { t } = useI18n()
  const { manual } = useStore($desktopOnboarding)

  return (
    <div className="grid gap-3">
      <GatewayProviderRow onSelect={() => void connectAgentxGateway(ctx)} />
      {manual ? null : (
        <div className="flex justify-center">
          <Button onClick={dismissFirstRunOnboarding} size="xs" variant="text">
            {t.common.skip}
          </Button>
        </div>
      )}
    </div>
  )
}
