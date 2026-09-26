import { Button } from '@/components/ui/button'
import { StatusPill } from '@/components/ui/status-pill'
import {
  StoreCard,
  StoreCardDescription,
  StoreCardFooter,
  StoreCardHeader,
  StoreCardMeta,
  StoreCardTags
} from '@/components/ui/store-card'
import { Switch } from '@/components/ui/switch'
import { TagChip } from '@/components/ui/tag-chip'
import { type Translations, useI18n } from '@/i18n'
import { Lock } from '@/lib/icons'

import { McpAvatar } from './mcp-avatar'
import { enabledToolCount, type McpServerView, serverEnabled, type ServerStatus } from './mcp-model'

/**
 * The one pill a connected card carries beside its name: what is wrong, or
 * that it is off. Working is unmarked. A refusal reads "Cần đăng nhập" only
 * where signing in is the fix (`canAuth`); a server that sends its own key
 * had that key refused, and says so.
 */
export function ServerStatusPill({
  canAuth,
  size,
  status,
  t
}: {
  canAuth: boolean
  size?: 'md' | 'sm'
  status: ServerStatus
  t: Translations
}) {
  const m = t.settings.mcp

  switch (status) {
    case 'off':
      return (
        <StatusPill data-testid="mcp-server-status" size={size} tone="muted">
          {t.skills.switchedOff}
        </StatusPill>
      )

    case 'probing':
      return (
        <StatusPill data-testid="mcp-server-status" size={size} tone="info">
          {m.statusChecking}
        </StatusPill>
      )

    case 'needs-auth':
      return (
        <StatusPill data-testid="mcp-server-status" size={size} tone="warn">
          {canAuth ? m.statusNeedsAuth : m.statusKeyRefused}
        </StatusPill>
      )

    case 'error':
      return (
        <StatusPill data-testid="mcp-server-status" size={size} tone="bad">
          {m.statusError}
        </StatusPill>
      )

    default:
      return null
  }
}

/**
 * Where it came from, as a quiet tag: the hub (with the version it runs) or
 * the gateway. A server from AgentX's own catalog is the resting state and
 * stays unmarked; one added by hand says so in its description instead.
 */
export function ServerSourceTag({ view }: { view: McpServerView }) {
  const { t } = useI18n()
  const m = t.settings.mcp

  if (view.source === 'hub') {
    return (
      <TagChip>
        {view.hubEntry?.installed_version ? `${m.sourceHub} · v${view.hubEntry.installed_version}` : m.sourceHub}
      </TagChip>
    )
  }

  return view.source === 'gateway' ? <TagChip>{m.sourceGateway}</TagChip> : null
}

// One connection on this machine, as a store card: its mark with the live dot,
// its name, what is wrong with it (or that it is off) in the one pill slot, the
// switch, what it does, where it came from, and the one verb that fixes what
// is wrong — "Đăng nhập" for an OAuth server that needs it, "Cập nhật" for a
// newer hub version, "Thử lại" after an error. Working, it shows how many
// tools it gives AgentX instead. Tools, logs, the launch line and removal all
// live behind "Chi tiết".
export function McpServerCard({
  authing,
  busy,
  onAuthenticate,
  onDetails,
  onProbe,
  onToggle,
  onUpdate,
  updating,
  view
}: {
  authing: boolean
  busy: boolean
  onAuthenticate: () => void
  onDetails: () => void
  onProbe: () => void
  onToggle: (enabled: boolean) => void
  onUpdate: () => void
  updating: boolean
  view: McpServerView
}) {
  const { t } = useI18n()
  const m = t.settings.mcp
  const enabled = serverEnabled(view.server)
  const hub = view.hubEntry
  const blocked = hub?.blocked_tools ?? []
  const hubUpdate = hub?.update_available && hub.version ? hub.version : null
  const probe = view.probe && view.probe !== 'probing' && view.probe.ok ? view.probe : null

  const verb =
    view.status === 'needs-auth' && view.canAuth ? (
      <Button data-testid="mcp-server-sign-in" disabled={authing} loading={authing} onClick={onAuthenticate} size="sm">
        {authing ? m.waitingForBrowser : m.authenticate}
      </Button>
    ) : hubUpdate && !hub?.modified ? (
      <Button data-testid="mcp-server-update" disabled={busy} loading={updating} onClick={onUpdate} size="sm">
        {m.hubUpdateShort}
      </Button>
    ) : view.status === 'error' ? (
      <Button data-testid="mcp-server-retry" onClick={onProbe} size="sm" variant="secondary">
        {t.common.retry}
      </Button>
    ) : null

  return (
    <StoreCard data-server={view.name} data-testid="mcp-server-card" id={`mcp-server-${view.name}`}>
      <StoreCardHeader
        control={
          <Switch
            aria-label={enabled ? m.disableServer(view.title) : m.enableServer(view.title)}
            checked={enabled}
            className="cursor-pointer"
            disabled={busy}
            onCheckedChange={onToggle}
            size="md"
          />
        }
        dimmed={!enabled}
        glyph={<McpAvatar name={view.name} status={view.status} />}
        meta={<ServerStatusPill canAuth={view.canAuth} status={view.status} t={t} />}
        title={view.title}
      />
      <StoreCardDescription>{view.description}</StoreCardDescription>
      {(view.source === 'hub' || view.source === 'gateway' || hubUpdate || hub?.modified) && (
        <StoreCardTags>
          <ServerSourceTag view={view} />
          {hubUpdate && (
            <StatusPill data-testid="mcp-server-update-available" tone="warn">
              {m.hubUpdateAvailable(hubUpdate)}
            </StatusPill>
          )}
          {hub?.modified && <StatusPill tone="muted">{m.editedHere}</StatusPill>}
        </StoreCardTags>
      )}
      {blocked.length > 0 && (
        <p className="flex items-center gap-1 text-xs text-(--ui-yellow)" data-testid="mcp-hub-blocked">
          <Lock aria-hidden className="size-3.5 shrink-0" />
          {m.hubBlockedShort(blocked.length)}
        </p>
      )}
      <StoreCardFooter
        end={
          <>
            {probe && !verb && (
              <StoreCardMeta data-testid="mcp-server-tools">
                {m.toolCount(enabledToolCount(probe, view.server))}
              </StoreCardMeta>
            )}
            {verb}
          </>
        }
      >
        <Button
          aria-label={t.skills.detailsFor(view.title)}
          data-testid="mcp-server-details"
          onClick={onDetails}
          size="sm"
          variant="text"
        >
          {t.skills.details}
        </Button>
      </StoreCardFooter>
    </StoreCard>
  )
}
