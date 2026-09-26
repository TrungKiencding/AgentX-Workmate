import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusPill } from '@/components/ui/status-pill'
import {
  StoreCard,
  StoreCardDescription,
  StoreCardFooter,
  StoreCardHeader,
  StoreCardMeta,
  StoreCardTags
} from '@/components/ui/store-card'
import { TagChip } from '@/components/ui/tag-chip'
import { getActionStatus, installMcpCatalogEntry, type McpCatalogEntry, removeHubMcpServer } from '@/hermes'
import { type Translations, useI18n } from '@/i18n'
import { ExternalLink, Lock } from '@/lib/icons'
import { notify, notifyError } from '@/store/notifications'

import { McpAvatar } from './mcp-avatar'
import {
  gatewayPath,
  MCP_GATEWAY_KEY,
  type McpGatewayEndpoint,
  type McpGatewayListing,
  type McpGatewayRefusal,
  serverTitle,
  shippedCopy
} from './mcp-model'

// Cadence for polling a background (git-bootstrap) catalog install to completion.
const CATALOG_INSTALL_POLL_MS = 1500

/** What a catalog entry is installed by: the name, or `agentx-hub/<slug>` for an AgentX Hub server. */
export const catalogKey = (entry: McpCatalogEntry) => entry.id ?? entry.name

/** A catalog entry as people read it: AgentX's own copy for a shipped server, else its name as words. */
export const catalogTitle = (entry: McpCatalogEntry, t: Translations): string =>
  (entry.origin === 'hub' ? null : shippedCopy(entry.name, t)?.label) ?? serverTitle(entry.name)

/**
 * Installing from the catalog — the shipped servers and the AgentX Hub's —
 * shared by every card in the MCP segment, so one install runs at a time and
 * a connected server's "Cập nhật" / "Thay bằng bản Hub…" runs the same path.
 * Credentials are asked inline on the card, never shown once stored: the
 * first "Kết nối" on an entry that needs values opens its fields, the second
 * installs with them. A git-backed entry clones in the background; the card
 * stays busy until that action ends, and a non-zero exit is a failure.
 */
export function useCatalogInstall(onInstalled: () => void) {
  const { t } = useI18n()
  const m = t.settings.mcp
  const [installing, setInstalling] = useState<null | string>(null)
  const [envDrafts, setEnvDrafts] = useState<Record<string, Record<string, string>>>({})
  const [envOpenFor, setEnvOpenFor] = useState<null | string>(null)

  const install = async (entry: McpCatalogEntry, { askCredentials = true }: { askCredentials?: boolean } = {}) => {
    const key = catalogKey(entry)
    const required = entry.required_env.filter(env => env.required)
    const draft = envDrafts[key] ?? {}

    // Reveal the credential prompt first; only error once it's shown and unfilled.
    // An installed server (an update, a replace) already has its values here.
    if (askCredentials && !entry.installed && required.some(env => !draft[env.name]?.trim())) {
      if (envOpenFor !== key) {
        setEnvOpenFor(key)

        return
      }

      notify({ kind: 'error', title: m.catalogEnvPrompt(catalogTitle(entry, t)), message: m.catalogEnvRequired })

      return
    }

    setInstalling(key)

    try {
      const res = await installMcpCatalogEntry(key, draft)

      if (res.background && res.action) {
        for (;;) {
          const status = await getActionStatus(res.action, 1)

          if (!status.running) {
            if (status.exit_code !== 0) {
              throw new Error(m.catalogInstallFailed(catalogTitle(entry, t)))
            }

            break
          }

          await new Promise(resolve => setTimeout(resolve, CATALOG_INSTALL_POLL_MS))
        }
      }

      // Said as what happened: a first connect (an OAuth server still waits for
      // its sign-in, on its card), an update, or an edited copy replaced.
      const title = catalogTitle(entry, t)

      notify({
        kind: 'success',
        title: entry.installed
          ? entry.modified
            ? m.hubReplaced(title)
            : m.hubUpdated(title)
          : entry.auth_type === 'oauth'
            ? m.catalogAddedNeedsSignIn(title)
            : m.catalogInstallStarted(title),
        message: res.registered === false ? m.hubNotRegistered : ''
      })
      setEnvOpenFor(null)
      onInstalled()
    } catch (err) {
      notifyError(err, m.catalogInstallFailed(catalogTitle(entry, t)))
    } finally {
      setInstalling(null)
    }
  }

  /** An AgentX Hub server leaves through the hub's own removal, so the hub hears it. */
  const removeFromHub = async (entry: McpCatalogEntry) => {
    if (!entry.slug) {
      return
    }

    setInstalling(catalogKey(entry))

    try {
      await removeHubMcpServer(entry.slug)
      notify({ kind: 'success', title: m.hubRemoved(catalogTitle(entry, t)), message: '' })
      onInstalled()
    } finally {
      setInstalling(null)
    }
  }

  const setEnvValue = (entry: McpCatalogEntry, name: string, value: string) => {
    const key = catalogKey(entry)

    setEnvDrafts(prev => ({ ...prev, [key]: { ...prev[key], [name]: value } }))
  }

  return { envDrafts, envOpenFor, install, installing, removeFromHub, setEnvValue }
}

export type CatalogInstall = ReturnType<typeof useCatalogInstall>

/** The values an entry needs, typed on its card (never shown once stored). */
function CredentialFields({ entry, install }: { entry: McpCatalogEntry; install: CatalogInstall }) {
  const key = catalogKey(entry)
  const draft = install.envDrafts[key] ?? {}

  if (install.envOpenFor !== key || entry.required_env.length === 0) {
    return null
  }

  return (
    <div className="grid gap-2" data-testid="mcp-credentials">
      {entry.required_env.map(env => (
        <label className="grid gap-1" key={env.name}>
          <span className="text-xs text-(--ui-text-tertiary)">
            {env.prompt || env.name}
            {env.required ? ' *' : ''}
          </span>
          {/* The author's prompt says what it wants; the name is what the server reads the value as. */}
          {env.prompt && env.prompt !== env.name && (
            <span className="font-mono text-xs text-(--ui-text-tertiary)">{env.name}</span>
          )}
          <Input
            onChange={event => install.setEnvValue(entry, env.name, event.currentTarget.value)}
            size="sm"
            type="password"
            value={draft[env.name] ?? ''}
          />
        </label>
      ))}
    </div>
  )
}

/** What connecting it takes, in words — never "stdio", "OAuth" or "API key" on the tile. */
function AccessTags({ entry }: { entry: McpCatalogEntry }) {
  const { t } = useI18n()
  const m = t.settings.mcp

  return (
    <>
      {entry.auth_type === 'oauth' && <TagChip>{m.needsAccount}</TagChip>}
      {entry.auth_type === 'api_key' && <TagChip>{m.needsKey}</TagChip>}
      {entry.transport === 'stdio' && <TagChip>{m.runsLocal}</TagChip>}
      {entry.needs_install && !entry.installed && <TagChip>{m.catalogNeedsInstall}</TagChip>}
    </>
  )
}

// One server the catalog offers — shipped with AgentX, or approved for this
// person on their AgentX Hub. Same card as a skill in the store: what it is,
// what connecting it takes, and one verb. Connected, it says so and stays put;
// the connection itself is managed from its card on "Đã kết nối".
export function CatalogServerCard({
  entry,
  install,
  onOpenHub
}: {
  entry: McpCatalogEntry
  install: CatalogInstall
  onOpenHub: (url: string) => void
}) {
  const { t } = useI18n()
  const m = t.settings.mcp
  const hub = entry.origin === 'hub'
  const copy = hub ? null : shippedCopy(entry.name, t)
  const key = catalogKey(entry)

  const trust = hub
    ? entry.trust === 'curated'
      ? m.hubTrustCurated
      : entry.trust === 'private'
        ? m.hubTrustPrivate
        : m.hubTrustReviewed
    : null

  return (
    <StoreCard
      data-catalog-id={key}
      data-hub-slug={entry.slug}
      data-testid={hub ? 'mcp-hub-entry' : 'mcp-catalog-entry'}
    >
      <StoreCardHeader
        glyph={<McpAvatar name={entry.name} />}
        meta={
          hub &&
          entry.version && (
            <span className="shrink-0 font-mono text-xs text-(--ui-text-tertiary)">{`v${entry.version}`}</span>
          )
        }
        title={catalogTitle(entry, t)}
      />
      <StoreCardDescription>{copy?.description ?? entry.description}</StoreCardDescription>
      {/* No "Đã xác minh" here: the hub's shelf lists only servers whose
          signatures hold, so on this tile it would say nothing. Who vouches
          for it (curated, reviewed, yours) is the tag that differs. */}
      <StoreCardTags>
        {trust && <TagChip>{trust}</TagChip>}
        {hub && entry.verdict === 'caution' && <StatusPill tone="warn">{m.hubVerdictCaution}</StatusPill>}
        <AccessTags entry={entry} />
      </StoreCardTags>
      {entry.name_taken && <p className="text-xs text-(--ui-text-secondary)">{m.hubNameTaken}</p>}
      {(entry.blocked_tools?.length ?? 0) > 0 && !entry.installed && (
        <p className="flex items-center gap-1 text-xs text-(--ui-yellow)">
          <Lock aria-hidden className="size-3.5 shrink-0" />
          {m.hubBlockedShort(entry.blocked_tools!.length)}
        </p>
      )}
      <CredentialFields entry={entry} install={install} />
      <StoreCardFooter
        end={
          entry.installed ? (
            <StatusPill data-testid="mcp-catalog-connected" size="md" tone="good">
              {m.connectedPill}
            </StatusPill>
          ) : (
            <Button
              disabled={install.installing !== null || entry.name_taken}
              loading={install.installing === key}
              onClick={() => void install.install(entry)}
              size="sm"
            >
              {m.connect}
            </Button>
          )
        }
      >
        {entry.page && (
          <Button onClick={() => onOpenHub(entry.page!)} size="sm" variant="text">
            <ExternalLink aria-hidden className="size-3.5" />
            {m.hubOpen}
          </Button>
        )}
      </StoreCardFooter>
    </StoreCard>
  )
}

/**
 * The person's AgentX Gateway endpoints (Agent Hub P5.8), and adding one:
 * the hub hands this machine a token (the signed-in session asks), the backend
 * keeps it in .env and writes the entry; the hub sync renews it. Default
 * profile only — every other profile gets no listing at all.
 */
export function useGatewayEndpoints(profile: string, onAdded: () => void) {
  const { t } = useI18n()
  const m = t.settings.mcp
  const [adding, setAdding] = useState<null | string>(null)
  const enabled = profile === 'default'

  const query = useQuery({
    enabled,
    queryKey: [MCP_GATEWAY_KEY, profile],
    queryFn: () => window.agentxDesktop.api<McpGatewayListing>({ path: gatewayPath(profile) }),
    retry: false
  })

  const add = async (endpoint: McpGatewayEndpoint) => {
    setAdding(endpoint.ref)

    try {
      const res = await window.agentxDesktop.api<McpGatewayRefusal | { ok: true; name: string; url: string }>({
        path: gatewayPath(profile, '/add'),
        method: 'POST',
        body: { kind: endpoint.kind, ref: endpoint.ref },
        timeoutMs: 30_000
      })

      if (!res.ok) {
        const signIn = res.status === 'sign_in' || res.status === 'reauth'

        notify({
          kind: 'error',
          title: signIn ? m.gatewaySignIn : m.gatewayAddFailed(endpoint.label),
          message: signIn ? '' : res.detail
        })

        return
      }

      notify({ kind: 'success', title: m.gatewayAdded(endpoint.label), message: '' })
      void query.refetch()
      onAdded()
    } catch (err) {
      notifyError(err, m.gatewayAddFailed(endpoint.label))
    } finally {
      setAdding(null)
    }
  }

  return { add, adding, listing: enabled ? query.data : undefined, query }
}

// One endpoint of the person's gateway: a server or a whole toolset they set
// up on the hub, one sign-in for all of it. Its readiness is the hub's word;
// "Kết nối" adds it here.
export function GatewayEndpointCard({
  adding,
  busy,
  endpoint,
  onAdd,
  onOpenHub
}: {
  adding: boolean
  busy: boolean
  endpoint: McpGatewayEndpoint
  onAdd: () => void
  onOpenHub: (url: string) => void
}) {
  const { t } = useI18n()
  const m = t.settings.mcp
  const ready = endpoint.status === 'ready'

  return (
    <StoreCard data-ref={endpoint.ref} data-testid="mcp-gateway-endpoint">
      <StoreCardHeader
        glyph={<McpAvatar name={endpoint.label} />}
        meta={
          !ready && (
            <StatusPill tone={endpoint.status === 'unavailable' ? 'bad' : 'warn'}>
              {m.gatewayStatus[endpoint.status]}
            </StatusPill>
          )
        }
        title={endpoint.label}
      />
      <StoreCardDescription>
        {endpoint.kind === 'toolset' ? m.gatewayToolsetDesc : m.gatewayServerDesc}
      </StoreCardDescription>
      <StoreCardTags>
        <TagChip>{endpoint.kind === 'toolset' ? m.gatewayToolset : m.gatewayServer}</TagChip>
      </StoreCardTags>
      <StoreCardFooter
        end={
          <>
            {ready && endpoint.tools > 0 && <StoreCardMeta>{m.toolCount(endpoint.tools)}</StoreCardMeta>}
            {endpoint.added ? (
              <StatusPill size="md" tone="good">
                {m.connectedPill}
              </StatusPill>
            ) : (
              <Button disabled={busy} loading={adding} onClick={onAdd} size="sm">
                {m.connect}
              </Button>
            )}
          </>
        }
      >
        {!ready && endpoint.connect_url && (
          <Button onClick={() => onOpenHub(endpoint.connect_url!)} size="sm" variant="text">
            <ExternalLink aria-hidden className="size-3.5" />
            {m.hubOpen}
          </Button>
        )}
      </StoreCardFooter>
    </StoreCard>
  )
}
