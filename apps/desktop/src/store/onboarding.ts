import { atom } from 'nanostores'

import type { DesktopAccountLiteLlm, DesktopAccountProvisionResult, DesktopAgentxKeyFailure } from '@/global'
import { getGlobalModelOptions } from '@/hermes'
import { translateNow, translationsNow } from '@/i18n'
import { agentxKeyMessage } from '@/lib/agentx-key'
import { asLicense } from '@/lib/license'
import { isProviderSetupErrorMessage } from '@/lib/provider-setup-errors'
import { evaluateRuntimeReadiness, type RuntimeReadinessResult } from '@/lib/runtime-readiness'
import { setMainModelAssignment } from '@/store/cron-model-impact'
import { $license } from '@/store/license'
import { notify, notifyError } from '@/store/notifications'
import {
  $webmateGuide,
  clearWebmateGuide,
  isWebmateAvailable,
  loadWebmatePrefs,
  refreshWebmateStatus,
  scanWebmateBrowsers,
  setWebmatePrefs
} from '@/store/webmate'
import type { ModelOptionProvider } from '@/types/hermes'

export type OnboardingFlow =
  | { status: 'idle' }
  | {
      // After successful credential acquisition, before completing
      // onboarding: show the user which model they're getting and let
      // them change it. providerSlug is the model.options slug for the
      // just-authenticated provider (used to persist the chosen model
      // via /api/model/set). The change-model UI uses the existing
      // ModelPickerDialog, which fetches its own model list from
      // /api/model/options — no need to cache the list here.
      currentModel: string
      label: string
      providerSlug: string
      saving: boolean
      status: 'confirming_model'
    }
  | {
      // The "Kết nối trình duyệt" step right after the model card: scan the
      // machine's browsers, walk the person through loading the AgentX WebMate
      // folder, and finish on its own when the extension connects. The step's
      // own state (browsers, chosen profile, live connection) lives in
      // store/webmate.ts; this entry only marks where the flow stands.
      status: 'connecting_browser'
    }
  | {
      // "AgentX AI Gateway" was picked: the main process is asking the backend
      // for this account's gateway key — the same provisioning sign-in runs.
      status: 'connecting_gateway'
    }
  | {
      message: string
      status: 'error'
      // Set when the AgentX AI Gateway card failed. `failure` is what the keys
      // service said when the key itself could not be issued; null when the
      // key came through and the connection after it did not.
      gateway?: { failure: DesktopAgentxKeyFailure | null }
    }

export interface DesktopOnboardingState {
  /** null until the first runtime check resolves. Seeded from localStorage so
   *  returning users skip the boot overlay entirely instead of flashing it
   *  every reload. */
  configured: boolean | null
  flow: OnboardingFlow
  reason: null | string
  requested: boolean
  /** Setup was skipped; AI is still unavailable until the gateway is connected. */
  firstRunSkipped: boolean
  /** The user reopened gateway setup from Settings → Account. */
  manual: boolean
}

export interface OnboardingContext {
  onCompleted?: () => void
  profile?: string
  requestGateway: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>
}

const CONFIGURED_CACHE_KEY = 'agentx-desktop-onboarded-v1'
const SKIP_CACHE_KEY = 'agentx-onboarding-skipped-v1'
export const DEFAULT_ONBOARDING_REASON = 'No inference provider is configured.'
export const DEFAULT_MANUAL_ONBOARDING_REASON = 'Connect AgentX AI Gateway.'

function readCachedConfigured(): boolean | null {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    return window.localStorage.getItem(CONFIGURED_CACHE_KEY) === '1' ? true : null
  } catch {
    return null
  }
}

function writeCachedConfigured(value: boolean) {
  if (typeof window === 'undefined') {
    return
  }

  try {
    if (value) {
      window.localStorage.setItem(CONFIGURED_CACHE_KEY, '1')
    } else {
      window.localStorage.removeItem(CONFIGURED_CACHE_KEY)
    }
  } catch {
    // localStorage unavailable — degrade silently.
  }
}

function readCachedSkipped(): boolean {
  if (typeof window === 'undefined') {
    return false
  }

  try {
    return window.localStorage.getItem(SKIP_CACHE_KEY) === '1'
  } catch {
    return false
  }
}

function writeCachedSkipped(value: boolean) {
  if (typeof window === 'undefined') {
    return
  }

  try {
    if (value) {
      window.localStorage.setItem(SKIP_CACHE_KEY, '1')
    } else {
      window.localStorage.removeItem(SKIP_CACHE_KEY)
    }
  } catch {
    // localStorage unavailable — degrade silently.
  }
}

const INITIAL: DesktopOnboardingState = {
  configured: readCachedConfigured(),
  flow: { status: 'idle' },
  reason: null,
  requested: false,
  firstRunSkipped: readCachedSkipped(),
  manual: false
}

export const $desktopOnboarding = atom<DesktopOnboardingState>(INITIAL)

let gatewayAttempt = 0

const patch = (update: Partial<DesktopOnboardingState>) =>
  $desktopOnboarding.set({ ...$desktopOnboarding.get(), ...update })

const setFlow = (flow: OnboardingFlow) => patch(flow.status === 'idle' ? { flow } : { flow, reason: null })

async function checkRuntime(ctx: OnboardingContext, requestedProvider?: string): Promise<RuntimeReadinessResult> {
  return evaluateRuntimeReadiness(ctx.requestGateway, {
    defaultReason: DEFAULT_ONBOARDING_REASON,
    requestedProvider,
    unknownReady: false
  })
}

function shouldPreserveConfiguredOnFallback(runtime: RuntimeReadinessResult, state: DesktopOnboardingState): boolean {
  // Non-authoritative transport fallback only — keep a previously verified
  // configured state instead of forcing the blocking onboarding overlay.
  return runtime.source === 'fallback' && state.configured === true && !state.requested
}

// Resolve a default only from the gateway row that provisioning just wrote.
async function fetchProviderDefaultModel(
  preferredSlugs: string[],
  // Set for the account's own AgentX AI Gateway; `model` is the one
  // provisioning opens a fresh account on. See the branch below for what changes.
  accountGateway: { model?: string }
): Promise<null | { providerSlug: string; defaultModel: string }> {
  let options

  try {
    options = await getGlobalModelOptions({ includeUnconfigured: true, explicitOnly: false })
  } catch {
    return null
  }

  const providers = options?.providers ?? []

  if (providers.length === 0) {
    return null
  }

  const lower = preferredSlugs.map(s => s.toLowerCase())

  const matched = providers.find((p: ModelOptionProvider) => lower.includes(String(p.slug).toLowerCase()))

  if (!matched) {
    return null
  }

  const models = matched.models ?? []

  const current = String(options.provider ?? '').toLowerCase()
  const kept = current && lower.includes(current) ? (options.model ?? '').trim() : ''
  const defaultModel = kept || accountGateway.model?.trim() || String(models[0] ?? '')

  return defaultModel ? { providerSlug: String(matched.slug), defaultModel } : null
}

// Persist the gateway model, then verify the runtime before confirming setup.
async function completeWithModelConfirm(
  ctx: OnboardingContext,
  providerLabel: string,
  preferredSlugs: string[],
  onFail: (reason: null | string) => void,
  { accountGateway, active }: { accountGateway: { model?: string }; active: () => boolean }
) {
  await ctx.requestGateway('reload.env').catch(() => undefined)

  const defaults = await fetchProviderDefaultModel(preferredSlugs, accountGateway)

  if (!active()) {
    return
  }

  if (defaults) {
    // Persist the chosen provider/model before the runtime gate so a stale
    // config provider (e.g. anthropic from a prior failed setup) cannot make
    // setup.runtime_check validate the wrong backend after gateway setup.
    try {
      await setMainModelAssignment({
        provider: defaults.providerSlug,
        model: defaults.defaultModel
      })

      if (!active()) {
        return
      }
    } catch (error) {
      if (!active()) {
        return
      }
      onFail(error instanceof Error ? error.message : translateNow('onboarding.messages.couldNotSaveModel'))

      return
    }
  }

  const runtime = await checkRuntime(ctx, preferredSlugs[0])

  if (!active()) {
    return
  }

  if (!runtime.ready) {
    onFail(runtime.reason)

    return
  }

  if (!defaults) {
    onFail(null)

    return
  }

  setFlow({
    status: 'confirming_model',
    providerSlug: defaults.providerSlug,
    currentModel: defaults.defaultModel,
    label: providerLabel,
    saving: false
  })
}

function providerResolutionFailure(reason: null | string) {
  const detail = reason?.trim()
  const base = translateNow('onboarding.messages.providerUnresolved')

  return detail ? `${base} ${detail}` : base
}

export function requestDesktopOnboarding(reason = DEFAULT_ONBOARDING_REASON) {
  patch({ reason: reason.trim() || DEFAULT_ONBOARDING_REASON, requested: true })
}

export function requestDesktopOnboardingForCredentialWarning(reason: null | string | undefined) {
  const warning = reason?.trim()

  if (!warning || !isProviderSetupErrorMessage(warning)) {
    return
  }

  requestDesktopOnboarding(warning)
}

// Reconnect the account's gateway from Settings → Account.
export function startManualOnboarding(reason: null | string = null) {
  gatewayAttempt += 1
  patch({ manual: true, requested: true, reason, flow: { status: 'idle' } })
}

export function closeManualOnboarding() {
  gatewayAttempt += 1
  patch({ manual: false, requested: false, flow: { status: 'idle' } })
}

export function completeDesktopOnboarding() {
  gatewayAttempt += 1
  writeCachedConfigured(true)
  // Clear the earlier skip now that the gateway is connected.
  writeCachedSkipped(false)
  $desktopOnboarding.set({
    configured: true,
    flow: { status: 'idle' },
    reason: null,
    requested: false,
    firstRunSkipped: false,
    manual: false
  })
}

// Persist a skipped setup without claiming that AI is configured.
export function dismissFirstRunOnboarding() {
  gatewayAttempt += 1
  writeCachedSkipped(true)
  patch({ firstRunSkipped: true, requested: false, manual: false, flow: { status: 'idle' } })
}

export async function refreshOnboarding(ctx: OnboardingContext) {
  if ($desktopOnboarding.get().manual) {
    return false
  }

  const runtime = await checkRuntime(ctx)

  if (runtime.ready) {
    completeDesktopOnboarding()
    ctx.onCompleted?.()

    return true
  }

  const state = $desktopOnboarding.get()

  if (shouldPreserveConfiguredOnFallback(runtime, state)) {
    // Gateway probes timed out but the user was already configured — don't
    // downgrade to the blocking onboarding overlay. Surface a non-blocking
    // notification with a stable id so repeated calls during an outage dedup
    // instead of stacking toasts.
    notify({
      id: 'runtime-not-ready',
      kind: 'error',
      title: translateNow('onboarding.messages.runtimeNotReadyTitle'),
      message: translateNow('onboarding.messages.runtimeNotReadyBody')
    })

    return false
  }

  const reason = runtime.reason || state.reason || DEFAULT_ONBOARDING_REASON

  writeCachedConfigured(false)
  patch({ configured: false, reason })

  return false
}

export function cancelOnboardingFlow() {
  gatewayAttempt += 1
  setFlow({ status: 'idle' })
}

export const AGENTX_GATEWAY_LABEL = 'AgentX AI Gateway'

// The `providers:` key provisioning writes (the accounts.litellm.provider_name
// default), for a result that does not name one.
const AGENTX_GATEWAY_PROVIDER = 'litellm'

// These statuses need an administrator to finish gateway setup.
const GATEWAY_NOT_SET_UP = new Set(['disabled', 'unconfigured'])

/** What the keys service said, in the shape the key gate and this card share. */
function gatewayFailure(litellm: DesktopAccountLiteLlm | undefined): DesktopAgentxKeyFailure {
  return {
    code: litellm?.code ?? '',
    detail: litellm?.detail?.trim() ?? '',
    license: asLicense(litellm?.license),
    // No answer at all: nobody signed in, a lapsed session, or a backend that
    // timed out — the main process reports all three the same way.
    status: litellm?.status || 'no-answer'
  }
}

// Product language for a key the backend could not hand over: the same reason
// the key gate gives (lib/agentx-key.ts), then whom to contact. The operator
// prose in `detail` stays out of the sentence; the card offers it as error
// details for support.
function gatewayFailureMessage(failure: DesktopAgentxKeyFailure): string {
  if (GATEWAY_NOT_SET_UP.has(failure.status)) {
    return translateNow('onboarding.messages.gatewayNotSetUp')
  }

  const copy = translationsNow()

  return agentxKeyMessage(failure, copy.agentxKey, copy.license, $license.get().license)
}

// "AgentX AI Gateway" on the picker: run on the models that come with the
// signed-in AgentX account. Provisioning is the call sign-in already makes — it
// reuses a live key or collects this account's key from the service, and writes
// providers.<slug> — so picking the card is safe to repeat, and it never
// rotates. Provisioning also reconciles any former main-provider choice.
export async function connectAgentxGateway(ctx: OnboardingContext) {
  const attempt = ++gatewayAttempt
  const active = () => attempt === gatewayAttempt && $desktopOnboarding.get().flow.status === 'connecting_gateway'
  setFlow({ status: 'connecting_gateway' })

  let result: DesktopAccountProvisionResult | null = null

  try {
    result = (await window.agentxDesktop?.account?.provision()) ?? null
  } catch {
    result = null
  }

  // Closed or cancelled while the key was on its way: the person has moved on.
  if (!active()) {
    return
  }

  const litellm = result?.litellm

  if (!result?.ok || !litellm?.ok) {
    const failure = gatewayFailure(litellm)

    setFlow({
      gateway: { failure },
      message: gatewayFailureMessage(failure),
      status: 'error'
    })

    return
  }

  const provider = litellm.provider.trim() || AGENTX_GATEWAY_PROVIDER

  await completeWithModelConfirm(
    ctx,
    AGENTX_GATEWAY_LABEL,
    // The picker lists a `providers:` entry under its bare key; the durable
    // `custom:` form is what grouped custom-endpoint rows carry.
    [provider, `custom:${provider}`],
    reason => setFlow({ gateway: { failure: null }, message: providerResolutionFailure(reason), status: 'error' }),
    // Same pick provisioning makes for a fresh account; an older backend sends
    // no default_model, and the first granted model stands in.
    { accountGateway: { model: litellm.default_model || litellm.models[0] }, active }
  )
}

// User picked a different model from the dropdown on the confirm card.
// Persists immediately so the displayed value is always what's on disk.
export async function setOnboardingModel(model: string) {
  const { flow } = $desktopOnboarding.get()

  if (flow.status !== 'confirming_model' || flow.saving) {
    return
  }

  // Optimistic update so the dropdown feels instant; revert on failure.
  const previous = flow.currentModel
  const pending = { ...flow, currentModel: model, saving: true }
  setFlow(pending)

  try {
    await setMainModelAssignment({
      provider: flow.providerSlug,
      model
    })
    const current = $desktopOnboarding.get().flow

    if (current === pending) {
      setFlow({ ...current, currentModel: model, saving: false })
    }
  } catch (error) {
    notifyError(error, translateNow('onboarding.messages.couldNotChangeModel'))
    const current = $desktopOnboarding.get().flow

    if (current === pending) {
      setFlow({ ...current, currentModel: previous, saving: false })
    }
  }
}

// User clicked "Start chatting" on the confirm card. Finalizes onboarding
// — the model was already persisted by completeWithModelConfirm (or by
// setOnboardingModel if they changed it), so all that's left is to mark
// onboarding done and unblock the rest of the app.
export function confirmOnboardingModel(ctx: OnboardingContext) {
  const { flow } = $desktopOnboarding.get()

  if (flow.status !== 'confirming_model') {
    return
  }

  // The confirmation card already showed the connection succeeded.
  completeDesktopOnboarding()
  ctx.onCompleted?.()
}

// Whether the first-run flow should show the "Kết nối trình duyệt" step after
// the model card. Not on the web dashboard (no desktop bridge), not for someone
// who chose "Đừng hỏi lại", not when a Workmate-installed extension is already
// connected, and never in the manual gateway-reconnection flow of a configured app.
export async function shouldOfferBrowserStep(): Promise<boolean> {
  if ($desktopOnboarding.get().manual || !isWebmateAvailable()) {
    return false
  }

  const prefs = await loadWebmatePrefs()

  if (prefs?.prompt === 'never') {
    return false
  }

  const status = await refreshWebmateStatus()

  return !(status?.connected && status.installType === 'workmate')
}

// "Bắt đầu" on the model card. Either moves on to the browser step (and kicks
// off the scan so the list is ready when the panel paints) or reports 'done'
// so the caller can finish onboarding with its exit choreography. The card's
// button is held while the decision is made so a double click cannot advance
// twice.
export async function advanceFromModelConfirm(): Promise<'browser' | 'done'> {
  const { flow } = $desktopOnboarding.get()

  if (flow.status !== 'confirming_model' || flow.saving) {
    return 'done'
  }

  setFlow({ ...flow, saving: true })

  let offer = false

  try {
    offer = await shouldOfferBrowserStep()
  } catch {
    offer = false
  }

  const current = $desktopOnboarding.get().flow

  if (current.status !== 'confirming_model') {
    return 'done'
  }

  if (!offer) {
    setFlow({ ...current, saving: false })

    return 'done'
  }

  setFlow({ status: 'connecting_browser' })
  void scanWebmateBrowsers()

  return 'browser'
}

// Leaving the browser step, whichever way: the person connected a browser,
// deferred ("Để sau" — asked again next time the card comes up), or opted out
// ("Đừng hỏi lại"). The choice is remembered in the machine-level prefs the
// main process keeps; onboarding itself completes exactly as after the model
// card.
export function completeBrowserStep(ctx: OnboardingContext, choice: 'connected' | 'later' | 'never') {
  const { flow } = $desktopOnboarding.get()

  if (flow.status !== 'connecting_browser') {
    return
  }

  // A window flow that ended connected records mode 'window' so Settings and
  // the next launch know which door the person took.
  const windowFlow = $webmateGuide.get()?.kind === 'window'

  void setWebmatePrefs(
    choice === 'later'
      ? { prompt: 'later' }
      : choice === 'never'
        ? { prompt: 'never' }
        : { prompt: null, mode: windowFlow ? 'window' : 'browser' }
  )
  clearWebmateGuide()
  completeDesktopOnboarding()
  ctx.onCompleted?.()
}
