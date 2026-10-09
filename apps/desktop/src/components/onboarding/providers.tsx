import { RowButton } from '@/components/ui/row-button'
import { useI18n } from '@/i18n'
import { Check, ChevronRight, Terminal } from '@/lib/icons'
import { AGENTX_GATEWAY_LABEL } from '@/store/onboarding'
import type { OAuthProvider } from '@/types/hermes'

const PROVIDER_DISPLAY: Record<string, { order: number; title: string }> = {
  'openai-codex': { order: 0, title: 'ChatGPT or Codex Subscription' },
  'minimax-oauth': { order: 1, title: 'MiniMax' },
  'qwen-oauth': { order: 2, title: 'Qwen Code' },
  'xai-oauth': { order: 3, title: 'xAI Grok' },
  // Both Anthropic entries sit at the bottom: the API-key path first, then
  // the subscription OAuth path (only works with extra usage credits).
  anthropic: { order: 4, title: 'Anthropic API Key' },
  'claude-code': { order: 5, title: 'Anthropic OAuth: Required Extra Usage Credits to Use Subscription' }
}

// Sign-ins the backend still lists — the CLI offers them — that no desktop
// picker does. Nous Portal's subscription is not how Workmate reaches models:
// the account's own AgentX AI Gateway key is (GatewayProviderRow), so a Nous
// row would only be a second, wrong answer to the same question.
const HIDDEN_PROVIDER_IDS = new Set(['nous'])

const assetPath = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\/+/, '')}`

export const providerTitle = (p: OAuthProvider) => PROVIDER_DISPLAY[p.id]?.title ?? p.name
const orderOf = (p: OAuthProvider) => PROVIDER_DISPLAY[p.id]?.order ?? 99

/** The sign-in providers a picker offers: hidden ones dropped, curated order first, then by name. */
export const pickerProviders = (providers: OAuthProvider[]) =>
  providers
    .filter(p => !HIDDEN_PROVIDER_IDS.has(p.id))
    .sort((a, b) => orderOf(a) - orderOf(b) || a.name.localeCompare(b.name))

/**
 * The recommended first row: the models that come with the person's AgentX
 * account, reached through its AgentX AI Gateway key. It is not a sign-in the
 * backend lists, so it carries no status of its own — picking it asks the
 * desktop for the account's key (see `connectAgentxGateway`).
 */
export function GatewayProviderRow({ onSelect }: { onSelect: () => void }) {
  const { t } = useI18n()

  return (
    <button
      className="group relative flex w-full items-center justify-between gap-4 rounded-(--radius-card) bg-primary/[0.06] px-3 py-2.5 text-left transition-colors hover:bg-primary/10"
      onClick={onSelect}
      type="button"
    >
      <span aria-hidden className="arc-border arc-reverse arc-nous" />
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <img alt="" className="size-5 shrink-0 rounded" src={assetPath('apple-touch-icon.png')} />
          <span className="text-[length:var(--conversation-text-font-size)] font-semibold">{AGENTX_GATEWAY_LABEL}</span>
          <span className="inline-flex items-center gap-1.5 bg-primary px-2 py-0.5 text-2xs font-semibold uppercase tracking-label text-primary-foreground">
            <span aria-hidden="true" className="dither inline-block size-2 shrink-0" />
            {t.onboarding.recommended}
          </span>
        </div>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{t.onboarding.gatewayPitch}</p>
      </div>
      <ChevronRight className="size-4 shrink-0 text-primary transition group-hover:translate-x-0.5" />
    </button>
  )
}

function ConnectedTag() {
  const { t } = useI18n()

  return (
    <span className="inline-flex items-center gap-1 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
      <Check className="size-3" />
      {t.onboarding.connected}
    </span>
  )
}

const PROVIDER_ROW_CLASS =
  'group flex w-full items-center justify-between gap-3 rounded-(--radius-control) px-3 py-2.5 text-left transition-colors hover:bg-(--ui-control-hover-background)'

/** Quick-key row for API-key providers (Fireworks #2 after the gateway card, OpenRouter further down). */
export function KeyProviderRow({ onClick, pitch, title }: { onClick: () => void; pitch: string; title: string }) {
  return (
    <RowButton className={PROVIDER_ROW_CLASS} onClick={onClick}>
      <div className="min-w-0">
        <span className="text-[length:var(--conversation-text-font-size)] font-semibold">{title}</span>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{pitch}</p>
      </div>
      <ChevronRight className="size-4 text-muted-foreground transition group-hover:text-foreground" />
    </RowButton>
  )
}

export function FireworksProviderRow({ onClick }: { onClick: () => void }) {
  const { t } = useI18n()

  return <KeyProviderRow onClick={onClick} pitch={t.onboarding.fireworksPitch} title="Fireworks AI" />
}

export function OpenRouterProviderRow({ onClick }: { onClick: () => void }) {
  const { t } = useI18n()

  return <KeyProviderRow onClick={onClick} pitch={t.onboarding.openRouterPitch} title="OpenRouter" />
}

export function ProviderRow({
  onSelect,
  provider
}: {
  onSelect: (provider: OAuthProvider) => void
  provider: OAuthProvider
}) {
  const { t } = useI18n()
  const loggedIn = provider.status?.logged_in
  const Trail = provider.flow === 'external' ? Terminal : ChevronRight

  return (
    <RowButton className={PROVIDER_ROW_CLASS} onClick={() => onSelect(provider)}>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[length:var(--conversation-text-font-size)] font-semibold">
            {providerTitle(provider)}
          </span>
          {loggedIn ? <ConnectedTag /> : null}
        </div>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{t.onboarding.flowSubtitles[provider.flow]}</p>
      </div>
      <Trail className="size-4 text-muted-foreground transition group-hover:text-foreground" />
    </RowButton>
  )
}
