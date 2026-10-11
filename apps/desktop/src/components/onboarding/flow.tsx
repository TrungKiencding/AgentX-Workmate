import { useStore } from '@nanostores/react'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { AgentxKeyFailureNotice } from '@/components/agentx-key-failure'
import { ModelPickerDialog } from '@/components/model-picker'
import { Button } from '@/components/ui/button'
import { ErrorIcon } from '@/components/ui/error-state'
import { Loader } from '@/components/ui/loader'
import { getGlobalModelOptions } from '@/hermes'
import { useI18n } from '@/i18n'
import { agentxKeyContact, agentxKeySupportLine } from '@/lib/agentx-key'
import { RefreshCw } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { $agentxKeyGate } from '@/store/agentx-key'
import { $license } from '@/store/license'
import {
  connectAgentxGateway,
  dismissFirstRunOnboarding,
  type OnboardingContext,
  type OnboardingFlow,
  setOnboardingModel
} from '@/store/onboarding'

import { DecodedLabel, GlyphText, HackeryButton, useScramble } from './glyph'

export function FlowPanel({
  ctx,
  flow,
  leaving,
  onBegin
}: {
  ctx: OnboardingContext
  flow: OnboardingFlow
  leaving: boolean
  onBegin: () => void
}) {
  const { t } = useI18n()

  if (flow.status === 'connecting_gateway') {
    return <Status>{t.onboarding.gatewayConnecting}</Status>
  }

  if (flow.status === 'confirming_model') {
    return <ConfirmingModelPanel flow={flow} leaving={leaving} onBegin={onBegin} profile={ctx.profile} />
  }

  if (flow.status === 'error') {
    return <ErrorPanel ctx={ctx} flow={flow} />
  }

  return null
}

function ErrorPanel({ ctx, flow }: { ctx: OnboardingContext; flow: Extract<OnboardingFlow, { status: 'error' }> }) {
  const { t } = useI18n()
  const gate = useStore($agentxKeyGate)
  const { license } = useStore($license)
  const keyFailure = flow.gateway?.failure ?? null

  // The gateway card failing: the key gate's own reason and support details
  // when the key itself was refused; otherwise what went wrong after it, and —
  // where no other provider is on offer — whom to contact.
  const body = keyFailure ? (
    <AgentxKeyFailureNotice account={gate.account} failure={keyFailure} />
  ) : (
    <div className="grid gap-2">
      <div className="flex items-center gap-1.5 text-sm text-destructive">
        <ErrorIcon className="shrink-0" size="0.875rem" />
        <span>{flow.message || t.onboarding.signInFailed}</span>
      </div>
      {flow.gateway ? (
        <p className="text-sm text-foreground">{agentxKeySupportLine(agentxKeyContact(null, license), t.agentxKey)}</p>
      ) : null}
    </div>
  )

  return (
    <div className="grid gap-3">
      {body}
      <div className="flex justify-end gap-2">
        <Button onClick={dismissFirstRunOnboarding} variant="outline">
          {t.common.skip}
        </Button>
        <Button onClick={() => void connectAgentxGateway(ctx)}>
          <RefreshCw />
          {t.agentxKey.retry}
        </Button>
      </div>
    </div>
  )
}

function ConfirmingModelPanel({
  flow,
  leaving,
  onBegin,
  profile
}: {
  flow: Extract<OnboardingFlow, { status: 'confirming_model' }>
  leaving: boolean
  onBegin: () => void
  profile?: string
}) {
  const { t } = useI18n()
  const scrambledModel = useScramble(flow.currentModel, leaving)
  const scrambledBegin = useScramble(t.onboarding.startChatting, leaving)
  // Local state controls whether the model picker dialog is open.
  // We reuse the existing ModelPickerDialog component (the same picker
  // available from the chat shell) rather than building an inline
  // dropdown — gives us gateway model search and
  // a familiar UI for users who'll see this picker again later.
  const [pickerOpen, setPickerOpen] = useState(false)

  // Pull pricing + tier for the just-picked default so the confirm card
  // shows the same $/Mtok + Free/Pro info the picker and CLI do.
  const options = useQuery({
    queryKey: ['onboarding-model-options', flow.providerSlug],
    queryFn: () => getGlobalModelOptions({ includeUnconfigured: true, explicitOnly: false })
  })

  const providerRow = options.data?.providers?.find(
    p => String(p.slug).toLowerCase() === flow.providerSlug.toLowerCase()
  )

  const price = providerRow?.pricing?.[flow.currentModel]
  const freeTier = providerRow?.free_tier

  return (
    <div className="grid place-items-center gap-7 py-6 text-center">
      <DecodedLabel leaving={leaving} text={t.onboarding.connectedProvider(flow.label)} />

      <div
        className={cn(
          'grid justify-items-center gap-1.5 transition duration-[360ms] ease-out',
          leaving ? 'opacity-0 saturate-0' : 'opacity-100 saturate-100'
        )}
      >
        <div className="flex items-center gap-2">
          <span className="font-mono text-2xs uppercase tracking-label text-(--ui-text-tertiary)">
            {t.onboarding.defaultModel}
          </span>
          {freeTier === true && (
            <span className="rounded-sm bg-(--ui-green)/15 px-1 py-0.5 text-2xs font-semibold uppercase tracking-label text-(--ui-green)">
              {t.onboarding.freeTier}
            </span>
          )}
          {freeTier === false && (
            <span className="rounded-sm bg-primary/15 px-1 py-0.5 text-2xs font-semibold uppercase tracking-label text-primary">
              {t.onboarding.pro}
            </span>
          )}
        </div>
        <p className="font-mono text-base">
          <GlyphText text={scrambledModel} />
        </p>
        {price && (price.input || price.output) && (
          <p className="font-mono text-xs text-muted-foreground">
            {price.free ? t.onboarding.free : t.onboarding.price(price.input || '?', price.output || '?')}
          </p>
        )}
        <Button
          className="mt-0.5 text-xs"
          disabled={flow.saving}
          onClick={() => setPickerOpen(true)}
          size="inline"
          variant="text"
        >
          {t.onboarding.change}
        </Button>
      </div>

      <div
        className={cn(
          'transition duration-[360ms] ease-out',
          leaving ? 'opacity-0 saturate-0' : 'opacity-100 saturate-100'
        )}
      >
        <HackeryButton
          disabled={flow.saving}
          label={<GlyphText text={scrambledBegin} />}
          loading={flow.saving}
          onClick={onBegin}
        />
      </div>

      {/*
        ModelPickerDialog's content sits on the modal rung, which is below the
        onboarding overlay — it would render underneath and swallow pointer
        events. Lift it to the rung above onboarding. Its own dim-backdrop
        layer stays on the modal-backdrop rung: onboarding already dims the
        rest of the screen, so a second backdrop would double up.
      */}
      {/* On a gateway-only first run the change stays among the gateway's own
          models, with no way out to another provider from here. */}
      <ModelPickerDialog
        contentClassName="z-(--z-onboarding-popover)"
        currentModel={flow.currentModel}
        currentProvider={flow.providerSlug}
        onlyProviders={[flow.providerSlug]}
        onOpenChange={setPickerOpen}
        onSelect={({ model }) => {
          void setOnboardingModel(model)
          setPickerOpen(false)
        }}
        open={pickerOpen}
        profile={profile}
      />
    </div>
  )
}

export function Status({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 py-1 text-sm text-muted-foreground" role="status">
      <Loader className="size-7" type="lemniscate-bloom" />
      {children}
    </div>
  )
}
