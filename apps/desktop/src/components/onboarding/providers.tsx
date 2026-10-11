import { useI18n } from '@/i18n'
import { ChevronRight } from '@/lib/icons'
import { AGENTX_GATEWAY_LABEL } from '@/store/onboarding'

const assetPath = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\/+/, '')}`

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
        </div>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{t.onboarding.gatewayPitch}</p>
      </div>
      <ChevronRight className="size-4 shrink-0 text-primary transition group-hover:translate-x-0.5" />
    </button>
  )
}
