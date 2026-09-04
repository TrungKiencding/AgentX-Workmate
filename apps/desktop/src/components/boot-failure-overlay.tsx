import { useStore } from '@nanostores/react'
import { type ComponentProps, lazy, type ReactNode, Suspense, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ErrorState } from '@/components/ui/error-state'
import { Loader } from '@/components/ui/loader'
import { LogView } from '@/components/ui/log-view'
import type { DesktopConnectionConfig } from '@/global'
import { useI18n } from '@/i18n'
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileText,
  iconSize,
  Loader2,
  LogIn,
  RefreshCw,
  SlidersHorizontal,
  Wrench
} from '@/lib/icons'
import { $desktopBoot } from '@/store/boot'
import { notify, notifyError } from '@/store/notifications'
import { $desktopOnboarding } from '@/store/onboarding'

import { classifyBootFailure } from './boot-failure-kind'
import type { RemoteReauth } from './boot-failure-reauth'
import {
  deriveProviderShape,
  isKeycloakSignInFailure,
  isRemoteConfig,
  isRemoteReauthFailure,
  signInLabel,
  sshFailureMessage
} from './boot-failure-reauth'

// The recovery "Gateway settings" view embeds the real Settings → Gateway panel
// (identical URL/auth/test/save controls — no parallel form to drift). Lazy so
// it stays out of the always-mounted overlay's bundle until opened.
const GatewaySettings = lazy(() =>
  import('@/app/settings/gateway-settings').then(module => ({ default: module.GatewaySettings }))
)

type BusyAction = 'local' | 'repair' | 'retry' | 'signin' | null
type RecoveryView = 'connect' | 'recovery'

const COPIED_RESET_MS = 2000

// A remote gateway whose access cookie has lapsed (e.g. the dashboard
// restarted on the remote box) boots into this overlay with a reauth-shaped
// error. The local-recovery buttons (Retry resets the local bootstrap latch;
// Repair re-runs the installer) are no-ops for that case — the only fix is to
// re-establish the remote session. The detection + copy helpers live in
// ./boot-failure-reauth so they're unit-testable without a React render.

// Recovery surface for a hard boot failure (gateway never came up, backend
// exited during startup, bootstrap latched, …). Without this the app shell
// renders dead — "gateway offline", no composer, only a toast — with no way
// to retry, repair the install, switch the gateway, or find the logs.
//
// It explains before it acts: a title and one-sentence reason chosen by
// `classifyBootFailure` (the main process only speaks English), a numbered
// "what to do" list, the action that actually fixes this kind of failure
// first, and everything technical — the raw error, recent logs — folded away
// under "Technical details" so it is there for a support ticket without
// being the first thing a person reads.
export function BootFailureOverlay() {
  const boot = useStore($desktopBoot)
  const onboarding = useStore($desktopOnboarding)
  const { t } = useI18n()
  const [busy, setBusy] = useState<BusyAction>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [showDetails, setShowDetails] = useState(false)
  const [copied, setCopied] = useState(false)
  const [remoteReauth, setRemoteReauth] = useState<RemoteReauth | null>(null)
  const [connectionConfig, setConnectionConfig] = useState<DesktopConnectionConfig | null>(null)
  // A remote/cloud backend that failed to boot is fixable from gateway settings,
  // so the escape hatch earns emphasis (local failures keep it as a quiet ghost).
  const [remoteFailure, setRemoteFailure] = useState(false)
  // Swap the card body to the embedded Gateway settings panel in place of routing
  // to the full Settings page (keeps the user on the recovery surface, no z-index
  // juggling, no second connection form to maintain).
  const [view, setView] = useState<RecoveryView>('recovery')

  // The AgentX sign-in gate is NOT a boot failure — the backend came up fine
  // and is waiting to be told who the user is. It has its own surface
  // (SignInOverlay), which sits at the same z-rung; rendering both would stack
  // two full-screen gates.
  const visible = Boolean(boot.error) && !boot.running && !isKeycloakSignInFailure(boot.error)
  // While first-run onboarding owns the picker/flow we let it surface its own
  // progress; the recovery overlay is for hard failures, which it covers via a
  // higher z-index regardless of onboarding state.
  const suppressed = onboarding.flow.status !== 'idle' && onboarding.flow.status !== 'error'

  useEffect(() => {
    if (!visible) {
      return
    }

    void window.agentxDesktop
      ?.getRecentLogs()
      .then(res => setLogs(res.lines ?? []))
      .catch(() => undefined)
  }, [boot.error, visible])

  // Resolve whether this boot failure is a remote-gateway reauth so we can
  // offer the actionable "Sign in" path instead of the local-only recovery
  // buttons. Runs whenever the overlay becomes visible.
  useEffect(() => {
    if (!visible) {
      setRemoteReauth(null)
      setConnectionConfig(null)
      setRemoteFailure(false)
      setView('recovery')
      setShowDetails(false)

      return
    }

    let cancelled = false

    void (async () => {
      const desktop = window.agentxDesktop

      if (!desktop?.getConnectionConfig) {
        return
      }

      let config: DesktopConnectionConfig

      try {
        config = await desktop.getConnectionConfig()
      } catch {
        return
      }

      if (cancelled) {
        return
      }

      setConnectionConfig(config)
      setRemoteFailure(isRemoteConfig(config))

      if (!isRemoteReauthFailure(config, boot.error)) {
        return
      }

      // Best-effort probe for the provider shape so the button copy matches
      // what the user will see in the login window (password form vs OAuth
      // redirect). Probe failure just keeps the generic copy.
      let shape = deriveProviderShape(null)

      try {
        const probe = await desktop.probeConnectionConfig(config.remoteUrl)
        shape = deriveProviderShape(probe?.providers)
      } catch {
        // Generic copy is fine.
      }

      if (!cancelled) {
        setRemoteReauth({ url: config.remoteUrl, ...shape })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [boot.error, visible])

  if (!visible || suppressed) {
    return null
  }

  // Re-dial the backend and repaint. Clearing the latched failure FIRST is the
  // load-bearing half: main.ts latches a local boot failure so a crash-looping
  // backend isn't respawned on every renderer paint, and a bare reload
  // therefore replays the very same failure. Anything that has genuinely fixed
  // the boot condition — Retry, or a completed sign-in — has to clear the latch
  // or the user lands right back on this screen.
  const restartBoot = async () => {
    await window.agentxDesktop?.resetBootstrap().catch(() => undefined)
    window.location.reload()
  }

  const retry = async () => {
    setBusy('retry')
    await restartBoot()
  }

  const repair = async () => {
    setBusy('repair')
    await window.agentxDesktop?.repairBootstrap().catch(() => undefined)
    window.location.reload()
  }

  const switchToLocalGateway = async () => {
    setBusy('local')
    // Soft apply: tears down the primary and re-dials in place (shell stays).
    await window.agentxDesktop?.applyConnectionConfig({ mode: 'local' }).catch(() => undefined)
    setBusy(null)
  }

  // Clear the OAuth partition first, then open the gateway's login window
  // (username/password form or OAuth redirect — the desktop drives both). A
  // partition-wide sign-out drops stale gateway AND identity-provider cookies so
  // an expired session can't silently bounce us back into the same state. On a
  // successful sign-in the cookie is re-established; reload so boot mints a fresh
  // ticket against a live session.
  const signInRemote = async () => {
    if (!remoteReauth) {
      return
    }

    setBusy('signin')

    try {
      await window.agentxDesktop?.oauthLogoutConnectionConfig?.()
      const result = await window.agentxDesktop?.oauthLoginConnectionConfig(remoteReauth.url)

      if (result?.connected) {
        notify({ kind: 'success', title: t.boot.failure.signedInTitle, message: t.boot.failure.signedInMessage })
        // Signing in is exactly the condition the latched boot failure was
        // waiting on, so clear it — a plain reload would replay the same
        // "sign-in required" error and make a successful sign-in look like it
        // did nothing until the user pressed Retry.
        await restartBoot()

        return
      }

      notify({
        kind: 'warning',
        title: t.boot.failure.signInIncompleteTitle,
        message: t.boot.failure.signInIncompleteMessage
      })
    } catch (err) {
      notifyError(err, t.boot.failure.signInFailed)
    } finally {
      setBusy(null)
    }
  }

  const openLogs = () => void window.agentxDesktop?.revealLogs().catch(() => undefined)
  const copy = t.boot.failure

  // The raw error, exactly as the main process raised it — the one thing a
  // support ticket needs verbatim. SSH failures get their translated shape.
  const detail = sshFailureMessage(connectionConfig, boot.error, t.settings.gateway)

  const copyDetails = async () => {
    const text = logs.length > 0 ? `${detail}\n\n${logs.slice(-40).join('')}` : detail

    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), COPIED_RESET_MS)
    } catch {
      // Some environments forbid clipboard writes; the details stay on screen.
    }
  }

  const label = signInLabel(remoteReauth, {
    identityProvider: copy.identityProvider,
    remoteGateway: copy.signInToRemoteGateway,
    withProvider: copy.signInWithProvider
  })

  // Recovery actions are shaped by the failure kind so the leading (primary)
  // button is the one that actually fixes it: Sign in for a lapsed remote
  // session, Connection settings for any other remote failure (local Retry /
  // Repair can't revive a dead remote — Repair is dropped there), Retry for a
  // local backend.
  type RecoveryVariant = ComponentProps<typeof Button>['variant']
  interface RecoveryAction {
    key: string
    label: string
    onClick: () => void
    icon?: ReactNode
    variant?: RecoveryVariant
    busy?: Exclude<BusyAction, null>
  }

  const settingsAction: RecoveryAction = {
    key: 'settings',
    label: copy.gatewaySettings,
    onClick: () => setView('connect'),
    icon: <SlidersHorizontal />
  }

  const retryAction: RecoveryAction = {
    key: 'retry',
    label: copy.retry,
    onClick: () => void retry(),
    icon: <RefreshCw />,
    busy: 'retry'
  }

  const localAction: RecoveryAction = {
    key: 'local',
    label: copy.useLocalGateway,
    onClick: () => void switchToLocalGateway(),
    variant: 'secondary',
    busy: 'local'
  }

  let actions: RecoveryAction[]
  let title: string
  let description: string
  let steps: readonly string[]
  let hint: null | string = null

  if (remoteReauth) {
    title = copy.remoteTitle
    description = copy.remoteDescription
    steps = [copy.remoteSignInHint(label)]
    actions = [
      {
        key: 'signin',
        label: copy.signOutAndSignIn,
        onClick: () => void signInRemote(),
        icon: <LogIn />,
        busy: 'signin'
      },
      { ...settingsAction, variant: 'secondary' },
      localAction
    ]
  } else if (remoteFailure) {
    title = copy.title
    description = copy.description
    steps = [copy.remoteFailureHint]
    actions = [settingsAction, { ...retryAction, variant: 'secondary' }, localAction]
  } else {
    // Local failure: the kind decides how it is explained; the actions are the
    // same three because every kind is fixed by the same two moves (retry,
    // then repair). Use-local is redundant with Retry here (both re-target
    // local) and is dropped; it stays for remote failures as the fall-back.
    const kind = classifyBootFailure(boot.error)
    const explained = kind === 'unknown' ? null : copy.kinds[kind]

    title = explained?.title ?? copy.title
    description = explained?.description ?? copy.description
    steps = explained?.steps ?? copy.genericSteps
    hint = copy.repairHint
    actions = [
      retryAction,
      {
        key: 'repair',
        label: copy.repairInstall,
        onClick: () => void repair(),
        icon: <Wrench />,
        variant: 'secondary',
        busy: 'repair'
      },
      { ...settingsAction, variant: 'ghost' }
    ]
  }

  if (view === 'connect') {
    return (
      <div className="fixed inset-0 z-(--z-setup) flex items-center justify-center bg-(--ui-chat-surface-background) p-6">
        <div className="flex max-h-[86vh] w-full max-w-[46rem] flex-col overflow-hidden rounded-xl border border-(--stroke-nous) bg-(--ui-chat-bubble-background) shadow-nous">
          {/* Subtle back affordance (projects/overlay idiom): muted → foreground
              on hover, no divider. */}
          <button
            className="flex w-full items-center gap-1.5 px-4 pt-4 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setView('recovery')}
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
    <div className="fixed inset-0 z-(--z-setup) flex items-center justify-center bg-(--ui-chat-surface-background) p-6">
      <div className="max-h-[90vh] w-full max-w-[40rem] overflow-y-auto rounded-xl border border-(--stroke-nous) bg-(--ui-chat-bubble-background) shadow-nous">
        <div className="grid gap-5 p-6 sm:p-7">
          {/* The same three beats as every ErrorState: what broke, why, and
              (below) what to do — the raw message is deliberately not one of
              them. */}
          <ErrorState description={description} title={title} />

          <section
            aria-labelledby="boot-failure-steps"
            className="rounded-(--radius-card) border border-(--ui-stroke-tertiary) bg-(--ui-bg-tertiary)/40 px-4 py-3"
          >
            <h3
              className="text-2xs font-medium uppercase tracking-[0.06em] text-(--ui-text-tertiary)"
              id="boot-failure-steps"
            >
              {copy.whatToDo}
            </h3>
            <ol className="mt-2 grid list-decimal gap-1.5 pl-5 text-sm leading-5 text-(--ui-text-secondary)">
              {steps.map(step => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </section>

          <div className="grid gap-2">
            <div className="flex flex-wrap items-center justify-center gap-2">
              {actions.map((action, index) => (
                <Button
                  disabled={Boolean(busy)}
                  key={action.key}
                  onClick={action.onClick}
                  size={index === 0 ? 'lg' : 'default'}
                  variant={action.variant}
                >
                  {action.busy && busy === action.busy ? <Loader2 className="animate-spin" /> : action.icon}
                  {action.label}
                </Button>
              ))}
            </div>
            {hint ? <p className="text-center text-xs text-muted-foreground">{hint}</p> : null}
          </div>

          {/* Everything a support ticket needs, and nothing a person has to
              read first: the verbatim error plus the last log lines, one
              toggle away, with a copy that grabs both. */}
          <div className="grid gap-2 border-t border-(--ui-stroke-tertiary) pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button
                aria-expanded={showDetails}
                className="-ml-2"
                onClick={() => setShowDetails(v => !v)}
                size="xs"
                type="button"
                variant="text"
              >
                {showDetails ? <ChevronDown className={iconSize.sm} /> : <ChevronRight className={iconSize.sm} />}
                {showDetails ? copy.hideTechnicalDetails : copy.technicalDetails}
              </Button>
              <div className="flex items-center gap-1">
                <Button onClick={() => void copyDetails()} size="xs" type="button" variant="text">
                  {copied ? <Check /> : null}
                  {copied ? copy.copiedDetails : copy.copyDetails}
                </Button>
                <Button onClick={openLogs} size="xs" type="button" variant="text">
                  <FileText />
                  {copy.openLogs}
                </Button>
              </div>
            </div>
            {showDetails ? (
              <div className="grid gap-2">
                <LogView className="max-h-32 select-text">{detail}</LogView>
                {logs.length > 0 ? <LogView className="max-h-48">{logs.slice(-40).join('')}</LogView> : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
