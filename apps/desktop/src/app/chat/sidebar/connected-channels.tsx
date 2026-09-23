import { PlatformAvatar } from '@/app/messaging/platform-icon'
import { cn } from '@/lib/utils'
import type { MessagingPlatformInfo } from '@/types/hermes'

export function connectedMessagingPlatforms(platforms: MessagingPlatformInfo[] | null): MessagingPlatformInfo[] {
  return (platforms ?? []).filter(platform => platform.enabled && platform.state === 'connected')
}

export function ConnectedChannels({
  activePlatformId,
  label,
  onOpen,
  platforms
}: {
  activePlatformId?: null | string
  label: string
  onOpen: (platformId: string) => void
  platforms: MessagingPlatformInfo[] | null
}) {
  const connected = connectedMessagingPlatforms(platforms)

  if (connected.length === 0) {
    return null
  }

  return (
    <section className="mt-3 border-t border-(--ui-stroke-tertiary) pt-3" data-slot="connected-channels">
      <h2 className="px-2 pb-1.5 text-xs font-medium text-(--ui-text-tertiary)">{label}</h2>
      <div className="grid gap-0.5">
        {connected.map(platform => {
          const active = platform.id === activePlatformId

          const destination =
            platform.destination?.label || platform.home_channel?.name || platform.home_channel?.chat_id

          return (
            <button
              aria-current={active ? 'page' : undefined}
              className={cn(
                'relative flex min-h-10 w-full items-center gap-2.5 rounded-(--radius-control) px-2 py-1.5 text-left transition-colors duration-(--dur-micro) [-webkit-app-region:no-drag]',
                active
                  ? 'bg-(--ui-row-active-background) text-foreground before:absolute before:inset-y-2 before:left-0 before:w-(--ui-row-active-bar-width) before:rounded-full before:bg-(--ui-row-active-bar) before:content-[""]'
                  : 'text-(--ui-text-secondary) hover:bg-(--ui-control-hover-background) hover:text-foreground'
              )}
              key={platform.id}
              onClick={() => onOpen(platform.id)}
              type="button"
            >
              <PlatformAvatar platformId={platform.id} platformName={platform.name} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{platform.name}</span>
                <span className="block truncate text-xs text-(--ui-text-tertiary)">{destination || platform.name}</span>
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
