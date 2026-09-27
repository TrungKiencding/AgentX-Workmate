import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

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
  type HubServerUse,
  hubServerUse,
  MCP_GATEWAY_KEY,
  type McpGatewayEndpoint,
  type McpGatewayListing,
  type McpGatewayRefusal,
  serverTitle,
  shippedCopy
} from './mcp-model'

// Cadence for polling a background (git-bootstrap) catalog install to completion.
const CATALOG_INSTALL_POLL_MS = 1500

/** The card a link pointed at (`?hub=<slug>`), marked a moment so the eye lands on it. */
const SPOTLIGHT_CLASS = 'border-(--ui-accent) bg-(--ui-bg-quaternary)'

/** What a catalog entry is installed by: the name, or `agentx-hub/<slug>` for an AgentX Hub server. */
export const catalogKey = (entry: McpCatalogEntry) => entry.id ?? entry.name

/**
 * A catalog entry as people read it: an AgentX Hub server's name as the hub
 * shows it, AgentX's own copy for a shipped server, else its name as words
 * (a hub slug can carry its publisher's name — never the first choice).
 */
export const catalogTitle = (entry: McpCatalogEntry, t: Translations): string =>
  (entry.origin === 'hub' ? entry.title : shippedCopy(entry.name, t)?.label) || serverTitle(entry.name)

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

/**
 * What connecting it takes, in words — never "stdio", "OAuth" or "API key" on
 * the tile. A hub server whose provider takes no sign-in through the hub says
 * where its account is signed in: here, on this machine (the hub's decision
 * §9.1 #17 — the one place it is set up).
 */
function AccessTags({ entry }: { entry: McpCatalogEntry }) {
  const { t } = useI18n()
  const m = t.settings.mcp

  return (
    <>
      {entry.auth_type === 'oauth' && (
        <TagChip>{entry.route?.reason === 'sign_in_local' ? m.signInHere : m.needsAccount}</TagChip>
      )}
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
  onOpenHub,
  spotlight = false
}: {
  entry: McpCatalogEntry
  install: CatalogInstall
  onOpenHub: (url: string) => void
  spotlight?: boolean
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
      className={spotlight ? SPOTLIGHT_CLASS : undefined}
      data-catalog-id={key}
      data-hub-slug={entry.slug}
      data-spotlight={spotlight || undefined}
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
 * While a server is waited for, the store asks whether it can be added: soon at
 * first — connecting on the hub takes a minute or less — then less and less
 * often, and at once whenever Workmate comes back to the front (the person back
 * from the browser). The hub's own word (`mcp.connection.connected`) usually
 * gets there first: the sync adds it and the shelf follows.
 */
export const GATEWAY_WAIT_CHECK_MS = 3000
export const GATEWAY_WAIT_CHECK_MAX_MS = 30_000

/** What adding an endpoint answers: added, the hub's page to connect on first, or a refusal. */
type GatewayAddAnswer =
  | McpGatewayRefusal
  | { code: string; connect_url: string; detail: string; ok: false; status: 'connect' }
  | { name: string; ok: true; url: string }

/**
 * The person's AgentX Gateway endpoints (Agent Hub P5.8) — every server of the
 * hub set up there, with where they stand with it, and their toolsets (the
 * hub's decision §9.1 #17) — and adding one: the hub hands this machine a
 * token (the signed-in session asks), the backend keeps it in .env and writes
 * the entry; the hub sync renews it. A server whose account is not connected
 * yet is never asked for here: "Kết nối" opens the hub's connect page in the
 * browser and the store waits (`GATEWAY_WAIT_CHECK_MS`), and the server is
 * added as soon as the hub serves it. Default profile only — every other
 * profile gets no listing.
 */
export function useGatewayEndpoints(profile: string, onAdded: () => void, openExternal: (url: string) => void) {
  const { t } = useI18n()
  const m = t.settings.mcp
  const [adding, setAdding] = useState<null | string>(null)
  const enabled = profile === 'default'
  // The check the wait timer runs: the one of the latest render (its profile, its callbacks).
  const checkRef = useRef<() => Promise<void>>(async () => undefined)

  const query = useQuery({
    enabled,
    queryKey: [MCP_GATEWAY_KEY, profile],
    queryFn: () => window.agentxDesktop.api<McpGatewayListing>({ path: gatewayPath(profile) }),
    retry: false
  })

  const add = async (kind: McpGatewayEndpoint['kind'], ref: string, label: string) => {
    setAdding(ref)

    try {
      const res = await window.agentxDesktop.api<GatewayAddAnswer>({
        path: gatewayPath(profile, '/add'),
        method: 'POST',
        body: { kind, ref },
        timeoutMs: 30_000
      })

      if (!res.ok && res.status === 'connect') {
        // Its account is the hub's to hold: the person connects there, once, and the store waits for it.
        openExternal(res.connect_url)
        notify({ kind: 'info', title: m.hubConnectOpened(label), message: m.hubConnectOpenedBody })
        void query.refetch()

        return
      }

      if (!res.ok) {
        const signIn = res.status === 'sign_in' || res.status === 'reauth'

        notify({
          kind: 'error',
          title: signIn ? m.gatewaySignIn : m.gatewayAddFailed(label),
          message: signIn ? '' : res.detail
        })

        return
      }

      notify({ kind: 'success', title: kind === 'server' ? m.hubAdded(label) : m.gatewayAdded(label), message: '' })
      void query.refetch()
      onAdded()
    } catch (err) {
      notifyError(err, m.gatewayAddFailed(label))
    } finally {
      setAdding(null)
    }
  }

  // Asked while a server is waited for: added the moment the hub serves it. Never throws — a check that could not
  // ask is simply asked again.
  const check = async () => {
    try {
      const res = await window.agentxDesktop.api<{ added: { label: string; name: string; slug: string }[] }>({
        path: gatewayPath(profile, '/waiting/check'),
        method: 'POST',
        timeoutMs: 30_000
      })

      for (const server of res.added) {
        notify({ kind: 'success', title: m.hubAdded(server.label), message: '' })
      }

      if (res.added.length > 0) {
        onAdded()
      }
    } catch {
      // The next check asks again.
    }

    void query.refetch()
  }

  checkRef.current = check

  const cancel = async (slug: string) => {
    try {
      await window.agentxDesktop.api<{ ok: boolean }>({
        path: gatewayPath(profile, `/waiting/${encodeURIComponent(slug)}`),
        method: 'DELETE'
      })
    } catch (err) {
      notifyError(err, t.common.failed)
    }

    void query.refetch()
  }

  const waiting = enabled ? (query.data?.waiting?.length ?? 0) : 0

  useEffect(() => {
    if (waiting === 0) {
      return
    }

    let delay = GATEWAY_WAIT_CHECK_MS
    let timer: number | undefined
    let stopped = false
    let asking = false

    const later = () => {
      timer = window.setTimeout(() => void ask(), delay)
      delay = Math.min(Math.round(delay * 1.5), GATEWAY_WAIT_CHECK_MAX_MS)
    }

    // One check at a time: a focus while one is out waits for its answer.
    const ask = async () => {
      if (asking || stopped) {
        return
      }

      asking = true
      window.clearTimeout(timer)
      await checkRef.current()
      asking = false

      if (!stopped) {
        later()
      }
    }

    // Back from the browser: asked at once, and soon again after.
    const onFocus = () => {
      delay = GATEWAY_WAIT_CHECK_MS
      void ask()
    }

    later()
    window.addEventListener('focus', onFocus)

    return () => {
      stopped = true
      window.clearTimeout(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [waiting])

  return { add, adding, cancel, listing: enabled ? query.data : undefined, query }
}

export type GatewayEndpoints = ReturnType<typeof useGatewayEndpoints>

/**
 * One AgentX Hub server set up on the hub (the hub's decision §9.1 #17), on
 * the "Từ AgentX Hub" shelf beside the ones set up here: the same store card,
 * with where the person stands with it on the hub and **one** verb — "Thêm"
 * (the hub serves it to them: added as its gateway endpoint, nothing asked),
 * "Kết nối" / "Kết nối lại" (the hub's page opens; Workmate adds it once they
 * are connected — or, here already, it works again once they are), or, while
 * it waits, "Mở lại trang" and "Huỷ". Nothing on it ever asks for a key: the
 * hub holds the account.
 */
export function HubGatewayCard({
  entry,
  gateway,
  onOpenHub,
  spotlight = false
}: {
  entry: McpCatalogEntry
  gateway: GatewayEndpoints
  onOpenHub: (url: string) => void
  spotlight?: boolean
}) {
  const { t } = useI18n()
  const m = t.settings.mcp
  const { endpoint, reason, use, wait } = hubServerUse(entry, gateway.listing)
  const slug = entry.slug ?? ''
  const title = catalogTitle(entry, t)
  const busy = gateway.adding !== null || Boolean(entry.name_taken)

  const trust =
    entry.trust === 'curated' ? m.hubTrustCurated : entry.trust === 'private' ? m.hubTrustPrivate : m.hubTrustReviewed

  const line: Record<HubServerUse, null | string> = {
    add: endpoint?.credential === 'shared' ? m.hubUse.shared : m.hubUse.ready,
    connect: m.hubUse.connect,
    installed: null,
    reconnect: m.hubUse.reconnect,
    unavailable: reason === 'no_tools' ? m.hubUse.noTools : m.hubUse.unavailable,
    unknown: m.hubUse.unknown,
    waiting: m.hubUse.waiting
  }

  const verb = use === 'add' ? m.hubAdd : use === 'connect' ? m.connect : use === 'reconnect' ? m.hubReconnect : null

  // Here already: its account is fixed on the hub, where the entry reaches it — nothing to add or wait for.
  const act = () =>
    entry.installed && endpoint?.connect_url ? onOpenHub(endpoint.connect_url) : void gateway.add('server', slug, title)

  return (
    <StoreCard
      className={spotlight ? SPOTLIGHT_CLASS : undefined}
      data-hub-slug={slug}
      data-spotlight={spotlight || undefined}
      data-testid="mcp-hub-entry"
      data-use={use}
    >
      <StoreCardHeader
        glyph={<McpAvatar name={entry.name} />}
        meta={
          entry.version && (
            <span className="shrink-0 font-mono text-xs text-(--ui-text-tertiary)">{`v${entry.version}`}</span>
          )
        }
        title={title}
      />
      <StoreCardDescription>{entry.description}</StoreCardDescription>
      <StoreCardTags>
        <TagChip>{trust}</TagChip>
        {entry.verdict === 'caution' && <StatusPill tone="warn">{m.hubVerdictCaution}</StatusPill>}
        <TagChip>{m.viaHub}</TagChip>
      </StoreCardTags>
      {entry.name_taken && <p className="text-xs text-(--ui-text-secondary)">{m.hubNameTaken}</p>}
      {line[use] && (
        <p
          className={use === 'waiting' ? 'text-xs text-(--ui-text-secondary)' : 'text-xs text-(--ui-text-tertiary)'}
          data-testid="mcp-hub-use"
        >
          {line[use]}
        </p>
      )}
      <StoreCardFooter
        end={
          use === 'installed' ? (
            <StatusPill data-testid="mcp-catalog-connected" size="md" tone="good">
              {m.connectedPill}
            </StatusPill>
          ) : use === 'waiting' ? (
            <Button data-testid="mcp-hub-cancel" onClick={() => void gateway.cancel(slug)} size="sm" variant="ghost">
              {m.hubWaitingCancel}
            </Button>
          ) : verb ? (
            <Button
              data-testid="mcp-hub-action"
              disabled={busy}
              loading={gateway.adding === slug}
              onClick={act}
              size="sm"
            >
              {verb}
            </Button>
          ) : null
        }
      >
        {use === 'waiting' && wait ? (
          <Button data-testid="mcp-hub-reopen" onClick={() => onOpenHub(wait.connect_url)} size="sm" variant="text">
            <ExternalLink aria-hidden className="size-3.5" />
            {m.hubWaitingOpen}
          </Button>
        ) : (
          entry.page && (
            <Button onClick={() => onOpenHub(entry.page!)} size="sm" variant="text">
              <ExternalLink aria-hidden className="size-3.5" />
              {m.hubOpen}
            </Button>
          )
        )}
      </StoreCardFooter>
    </StoreCard>
  )
}

// One toolset of the person's gateway: several servers they gathered on the
// hub behind one endpoint, one sign-in for all of it. Its readiness is the
// hub's word; "Kết nối" adds it here. (A server of the hub has its own card on
// the hub's shelf, `HubGatewayCard`.)
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
      <StoreCardDescription>{m.gatewayToolsetDesc}</StoreCardDescription>
      <StoreCardTags>
        <TagChip>{m.gatewayToolset}</TagChip>
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
