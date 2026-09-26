import { useState } from 'react'

import { PageLoader } from '@/components/page-loader'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  focusDialogContent
} from '@/components/ui/dialog'
import { DisclosureRow } from '@/components/ui/disclosure-row'
import { StatusPill } from '@/components/ui/status-pill'
import { Switch } from '@/components/ui/switch'
import { TagChip } from '@/components/ui/tag-chip'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { ExternalLink, Lock } from '@/lib/icons'
import { isToolEnabled } from '@/lib/mcp-tool-filter'
import { cn } from '@/lib/utils'

import { McpAvatar } from './mcp-avatar'
import { McpLogs } from './mcp-logs'
import { capabilitySummary, enabledToolCount, launchLine, type McpServerView, serverEnabled } from './mcp-model'
import { ServerSourceTag, ServerStatusPill } from './mcp-server-card'
import { TechnicalDetailRow, TechnicalDetails } from './technical-details'

/** The first line of a failure, trimmed — enough to say why, never a stack dump. */
function reasonLine(error: string | undefined): string {
  const first = (error ?? '').split('\n').find(line => line.trim()) ?? ''

  return first.length > 220 ? `${first.slice(0, 217)}…` : first
}

// One connection's whole story, opened from its card: what it does and where
// it came from, what stands between it and working (a sign-in, a key the
// server refused, an error — each with its way out), the tools it gives AgentX
// (each one a toggle), the hub's word on it for a hub server (who vouches, the
// version, an update or a replacement, the tools kept off), and the technical
// tail folded away — the launch line, the logs, a jump into mcp.json. The
// switch sits in the footer beside "Kiểm tra lại" and "Gỡ kết nối", so a
// person who came to read can also decide.
export function McpServerDialog({
  onClose,
  view,
  ...props
}: ServerDetailProps & { onClose: () => void; view: McpServerView | null }) {
  return (
    <Dialog onOpenChange={open => !open && onClose()} open={view !== null}>
      {/* No input to land in: autofocus would put the first tool chip under a
          focus ring and open its tooltip before the pointer ever moved. */}
      <DialogContent className="max-w-2xl" data-testid="mcp-server-detail" onOpenAutoFocus={focusDialogContent}>
        {/* Keyed by server: a different connection starts with its logs folded (the tail polls only while shown). */}
        {view && <ServerDetail key={view.name} view={view} {...props} />}
      </DialogContent>
    </Dialog>
  )
}

interface ServerDetailProps {
  authing: boolean
  busy: boolean
  onAuthenticate: () => void
  onEditConfig: () => void
  onOpenHub: (url: string) => void
  onProbe: () => void
  onRemove: () => void
  onReplace: () => void
  onToggle: (enabled: boolean) => void
  /** Turn one tool on or off — the state asked for, so a double click cannot flip it back. */
  onSetTool: (toolName: string, on: boolean) => void
  onUpdate: () => void
  updating: boolean
}

function ServerDetail({ view: v, ...props }: ServerDetailProps & { view: McpServerView }) {
  const { t } = useI18n()
  const m = t.settings.mcp
  const [logsShown, setLogsShown] = useState(false)
  const enabled = serverEnabled(v.server)
  const probe = v.probe && v.probe !== 'probing' ? v.probe : null
  const hub = v.hubEntry
  const blocked = hub?.blocked_tools ?? []
  const hubUpdate = hub?.update_available && hub.version ? hub.version : null

  const trust = hub
    ? hub.trust === 'curated'
      ? m.hubTrustCurated
      : hub.trust === 'private'
        ? m.hubTrustPrivate
        : m.hubTrustReviewed
    : null

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex flex-wrap items-center gap-2.5">
          <McpAvatar name={v.name} size="lg" status={v.status} />
          <span className="min-w-0 truncate">{v.title}</span>
          <ServerStatusPill canAuth={v.canAuth} status={v.status} t={t} />
        </DialogTitle>
        <DialogDescription className="text-base">{v.description}</DialogDescription>
      </DialogHeader>

      <div className="grid gap-4">
        {(v.source === 'hub' || v.source === 'gateway') && (
          <div className="flex flex-wrap items-center gap-1.5">
            <ServerSourceTag view={v} />
            {trust && <TagChip>{trust}</TagChip>}
            {hub?.verified && <TagChip>{m.hubVerified}</TagChip>}
            {hub?.verdict === 'caution' && <StatusPill tone="warn">{m.hubVerdictCaution}</StatusPill>}
            {hubUpdate && <StatusPill tone="warn">{m.hubUpdateAvailable(hubUpdate)}</StatusPill>}
            {hub?.page && (
              <Button onClick={() => props.onOpenHub(hub.page!)} size="sm" variant="text">
                <ExternalLink aria-hidden className="size-3.5" />
                {m.hubOpen}
              </Button>
            )}
          </div>
        )}

        {/* What stands between it and working, with the way out. */}
        {v.status === 'probing' ? (
          <PageLoader className="min-h-16" label={m.statusChecking} />
        ) : v.status === 'needs-auth' ? (
          <div className="grid gap-2 rounded-(--radius-card) bg-(--ui-bg-quinary) p-3" data-testid="mcp-server-auth">
            <p className="text-sm text-(--ui-text-secondary)">{v.canAuth ? m.signInHint(v.title) : m.keyRefused}</p>
            <div className="flex flex-wrap gap-2">
              {v.canAuth ? (
                <Button disabled={props.authing} loading={props.authing} onClick={props.onAuthenticate} size="sm">
                  {props.authing ? m.waitingForBrowser : m.authenticate}
                </Button>
              ) : (
                <Button onClick={props.onEditConfig} size="sm" variant="secondary">
                  {m.editInConfig}
                </Button>
              )}
            </div>
          </div>
        ) : v.status === 'error' ? (
          <div className="grid gap-2 rounded-(--radius-card) bg-(--ui-bg-quinary) p-3" data-testid="mcp-server-error">
            <p className="text-sm text-(--ui-text-secondary)">{m.errorHint}</p>
            {probe?.error && (
              <p className="font-mono text-xs break-words text-(--ui-text-tertiary)">{reasonLine(probe.error)}</p>
            )}
            <div className="flex flex-wrap gap-2">
              {v.canAuth && (
                <Button disabled={props.authing} loading={props.authing} onClick={props.onAuthenticate} size="sm">
                  {props.authing ? m.waitingForBrowser : m.authenticate}
                </Button>
              )}
              <Button onClick={props.onProbe} size="sm" variant="secondary">
                {t.common.retry}
              </Button>
            </div>
          </div>
        ) : null}

        {/* The hub's word on a hub server: tools kept off, an edit here, the newer version. */}
        {hub && (blocked.length > 0 || hub.modified || hubUpdate) && (
          <div className="grid gap-2">
            {blocked.length > 0 && (
              <p className="flex items-start gap-1.5 text-sm text-(--ui-yellow)" data-testid="mcp-hub-blocked-detail">
                <Lock aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                {m.hubBlocked(blocked.length, blocked.join(', '))}
              </p>
            )}
            {hub.modified && <p className="text-sm text-(--ui-text-secondary)">{m.hubModified}</p>}
            <div className="flex flex-wrap gap-2">
              {hub.modified ? (
                <Button disabled={props.busy} onClick={props.onReplace} size="sm" variant="secondary">
                  {m.hubReplace}
                </Button>
              ) : (
                hubUpdate && (
                  <Button disabled={props.busy} loading={props.updating} onClick={props.onUpdate} size="sm">
                    {m.hubUpdate(hubUpdate)}
                  </Button>
                )
              )}
            </div>
          </div>
        )}

        {/* The tools it gives AgentX: each one a toggle, struck through when off. */}
        {probe?.ok && (
          <section aria-label={m.toolsHeading} className="grid gap-1.5">
            <div className="flex items-baseline gap-2">
              <h3 className="text-sm font-semibold text-(--ui-text-secondary)">{m.toolsHeading}</h3>
              {probe.tools.length > 0 && (
                <span className="text-xs tabular-nums text-(--ui-text-tertiary)" data-testid="mcp-server-tools-count">
                  {m.toolsEnabledOf(enabledToolCount(probe, v.server), probe.tools.length)}
                </span>
              )}
            </div>
            {probe.tools.length === 0 ? (
              <p className="text-sm text-(--ui-text-tertiary)">{m.noTools}</p>
            ) : (
              <>
                <p className="text-xs text-(--ui-text-tertiary)">{m.toolsHint}</p>
                <div className="flex flex-wrap gap-1">
                  {probe.tools.map(tool => {
                    const on = isToolEnabled(v.server, tool.name)

                    const chip = (
                      <button
                        aria-label={on ? m.disableTool(tool.name) : m.enableTool(tool.name)}
                        aria-pressed={on}
                        className={cn(
                          'cursor-pointer rounded-md px-1.5 py-1 font-mono text-xs text-(--ui-text-tertiary) transition-colors duration-(--dur-micro) hover:text-foreground disabled:cursor-default',
                          on ? 'bg-(--ui-bg-quinary)' : 'line-through opacity-70'
                        )}
                        disabled={props.busy}
                        onClick={() => props.onSetTool(tool.name, !on)}
                        type="button"
                      >
                        {tool.name}
                      </button>
                    )

                    // What the tool does, from the server, on hover — the chip is its name.
                    return tool.description ? (
                      <Tip key={tool.name} label={tool.description}>
                        {chip}
                      </Tip>
                    ) : (
                      <span key={tool.name}>{chip}</span>
                    )
                  })}
                </div>
              </>
            )}
          </section>
        )}

        <TechnicalDetails>
          <TechnicalDetailRow label={m.configName} value={<span className="font-mono">{v.name}</span>} />
          {v.source === 'gateway' && <p className="text-sm text-(--ui-text-tertiary)">{m.gatewayTokenNote}</p>}
          <TechnicalDetailRow
            label={m.launchLabel}
            value={<span className="font-mono break-all">{launchLine(v.server) || '—'}</span>}
          />
          {typeof v.server.transport === 'string' && (
            <TechnicalDetailRow
              label={m.transportLabel}
              value={<span className="font-mono">{v.server.transport}</span>}
            />
          )}
          {probe?.ok && ((probe.prompts ?? 0) > 0 || (probe.resources ?? 0) > 0) && (
            <TechnicalDetailRow label={m.capabilitiesLabel} value={capabilitySummary(m, probe, v.server)} />
          )}
          <div>
            <Button onClick={props.onEditConfig} size="sm" variant="textStrong">
              {m.editInConfig}
            </Button>
          </div>
        </TechnicalDetails>

        <div>
          <DisclosureRow onToggle={() => setLogsShown(open => !open)} open={logsShown}>
            {m.logsTitle}
          </DisclosureRow>
          {logsShown && <McpLogs className="mt-1.5 pl-5" server={v.name} />}
        </div>
      </div>

      <DialogFooter className="items-center sm:justify-between">
        <label className="flex items-center gap-2 text-sm text-(--ui-text-secondary)">
          <Switch
            aria-label={enabled ? m.disableServer(v.title) : m.enableServer(v.title)}
            checked={enabled}
            className="cursor-pointer"
            disabled={props.busy}
            onCheckedChange={props.onToggle}
            size="md"
          />
          {enabled ? m.serverOn : m.serverOff}
        </label>
        <span className="flex items-center gap-2">
          <Button
            className="text-destructive hover:text-destructive"
            data-testid="mcp-server-remove"
            disabled={props.busy}
            onClick={props.onRemove}
            size="sm"
            variant="ghost"
          >
            {m.removeConnection}
          </Button>
          {/* A problem carries its own way out above; this is the plain re-check. */}
          {(v.status === 'ok' || v.status === 'unknown') && (
            <Button onClick={props.onProbe} size="sm" variant="outline">
              {m.recheck}
            </Button>
          )}
        </span>
      </DialogFooter>
    </>
  )
}
