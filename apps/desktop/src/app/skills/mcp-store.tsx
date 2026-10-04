import { useStore } from '@nanostores/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type * as React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'

import type { CodeEditorApi } from '@/components/chat/code-editor'
import { PageLoader } from '@/components/page-loader'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ErrorBanner } from '@/components/ui/error-state'
import { StoreCardShelf } from '@/components/ui/store-card'
import {
  authMcpServer,
  getMcpCatalog,
  getMcpOAuthFlow,
  type HermesGateway,
  type McpCatalogEntry,
  type McpTestResult,
  removeHubMcpServer,
  saveMcpServers,
  testMcpServer
} from '@/hermes'
import { useI18n } from '@/i18n'
import { Loader2, MoreHorizontal, Plus, RefreshCw } from '@/lib/icons'
import { completeMcpDesktopOAuth } from '@/lib/mcp-dashboard-oauth'
import { isToolEnabled, toggleToolInServer } from '@/lib/mcp-tool-filter'
import { normalize } from '@/lib/text'
import { notify, notifyError } from '@/store/notifications'
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'
import { $activeSessionId } from '@/store/session'
import type { HermesConfigRecord, McpCatalogResponse } from '@/types/hermes'

import { AGENTX_CONFIG_KEY, setHermesConfigCache, useHermesConfigRecord } from '../hooks/use-config-record'
import { useOnProfileSwitch } from '../hooks/use-on-profile-switch'
import { PanelEmpty } from '../overlays/panel'

import type { HubSync } from './hub-status'
import {
  catalogKey,
  CatalogServerCard,
  catalogTitle,
  GatewayEndpointCard,
  HubGatewayCard,
  useCatalogInstall,
  useGatewayEndpoints
} from './mcp-catalog'
import { McpConfigDialog } from './mcp-config-dialog'
import { McpLogsDialog } from './mcp-logs'
import {
  describeServer,
  gatewayNeedsSignIn,
  getServers,
  isHubSlug,
  MCP_CATALOG_KEY,
  MCP_GATEWAY_KEY,
  type McpGatewayEndpoint,
  type McpServers,
  type McpServerView,
  mergeServers,
  parseServersDoc,
  type Probe,
  PROBE_TTL_MS,
  probeCache,
  probeKey,
  scanServerBlocks,
  serverEnabled,
  serverFingerprint,
  shippedCopy,
  withEnabled,
  withStarterEntry,
  wrapDoc
} from './mcp-model'
import { McpServerCard } from './mcp-server-card'
import { McpServerDialog } from './mcp-server-dialog'
import { StoreBar, StoreNotice, StoreSource, syncedAt } from './store-tab'

const NO_ENTRIES: McpCatalogEntry[] = []
const NO_ENDPOINTS: McpGatewayEndpoint[] = []

/** How long the card a link pointed at stays marked. */
export const HUB_SPOTLIGHT_MS = 4000

/**
 * Kho tiện ích → MCP: every connection this machine has, and every one it
 * could add, as store cards on named shelves — "Đã kết nối" (what AgentX can
 * reach now, with its live state and the verb that fixes it), then what can
 * be added: from the person's AgentX Hub — one shelf, each server set up in
 * one place, the hub's or this machine's, whichever the hub says (its
 * decision §9.1 #17) — the toolsets they gathered there, and the servers
 * AgentX itself recommends. The technical surfaces — the whole mcp.json, the
 * logs — open on demand from the bar's ⋯ and from a connection's own detail;
 * they are never the first thing a person reads. A link to one hub server
 * (`?hub=<slug>`, from `agentx://mcp/<slug>`) brings its card into view.
 *
 * State is the old connections tab's, carried over whole: the shared config
 * cache (whole-map replace, never a deep merge), probes cached per profile and
 * exact config, a profile switch that blocks every write until the new
 * profile's config lands, and an mcp.json draft that async completions patch
 * instead of clobbering.
 */
export function McpStore({
  gateway,
  query,
  switcher,
  sync
}: {
  gateway: HermesGateway | null
  query: string
  switcher: React.ReactNode
  sync: HubSync
}) {
  const { locale, t } = useI18n()
  const m = t.settings.mcp
  const queryClient = useQueryClient()
  const activeSessionId = useStore($activeSessionId)

  // Shared config cache (see use-config-record): revisiting the segment paints
  // the cached record instantly; mutations write through `setConfig` and stay
  // visible to the other settings surfaces.
  const {
    data: config,
    isLoading: configLoading,
    isError: configFailed,
    error: configError,
    refetch: refetchConfig,
    dataUpdatedAt: configUpdatedAt,
    errorUpdatedAt: configErroredAt
  } = useHermesConfigRecord()

  const setConfig = setHermesConfigCache

  // True from a profile switch until the config query resettles for the new
  // profile. Until then `config` (and thus `servers`) still holds profile A's
  // data, so any persist would write A's server list into B — block mutations.
  const [profilePending, setProfilePending] = useState(false)
  const staleConfigStamp = useRef<null | number>(null)
  const staleErrorStamp = useRef<null | number>(null)

  const [saving, setSaving] = useState(false)
  const [probes, setProbes] = useState<Record<string, Probe>>({})
  const probesRef = useRef(probes)
  probesRef.current = probes

  // Blocks the browser until an OAuth flow lands a token; reset on profile switch.
  const [authing, setAuthing] = useState<null | string>(null)

  // The mcp.json draft. The dialog is only its view: `docVersion` remounts the
  // editor when the draft is regenerated, `dirty` guards the person's edits
  // from being clobbered, and async completions (a sign-in, an install) patch
  // a dirty draft so the next whole-map save cannot drop what they wrote.
  const [draft, setDraft] = useState('')
  const [dirty, setDirty] = useState(false)
  const [docVersion, setDocVersion] = useState(0)
  const [editorOpen, setEditorOpen] = useState(false)
  const editorApi = useRef<CodeEditorApi | null>(null)
  const [cursor, setCursor] = useState(0)
  // The server block to place the cursor in once the editor has mounted.
  const pendingFocus = useRef<null | string>(null)
  const blocks = useMemo(() => scanServerBlocks(draft), [draft])

  const activeBlock = useMemo(
    () => blocks.find(block => cursor >= block.from && cursor <= block.to) ?? null,
    [blocks, cursor]
  )

  const [detailName, setDetailName] = useState<null | string>(null)
  const [logsOpen, setLogsOpen] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<McpServerView | null>(null)
  const [replaceTarget, setReplaceTarget] = useState<McpCatalogEntry | null>(null)
  const [syncing, setSyncing] = useState(false)

  const servers = useMemo(() => getServers(config ?? null), [config])

  // Config/document order, not alphabetical — the shelf mirrors mcp.json.
  const names = useMemo(() => Object.keys(servers), [servers])

  // Key by active profile — installed/enabled badges are per-profile, so sharing
  // one cache across profiles would flash the previous profile's state on switch.
  const profileKey = normalizeProfileKey(useStore($activeGatewayProfile))

  const catalogQuery = useQuery({
    queryKey: [...MCP_CATALOG_KEY, profileKey],
    queryFn: () => getMcpCatalog(),
    staleTime: 5 * 60_000
  })

  const catalog = catalogQuery.data?.entries ?? NO_ENTRIES
  const hub = catalogQuery.data?.hub ?? null

  // The backend reads the hub session from what the ticks hand it, so a
  // catalogue asked for before the store's first tick finished can answer
  // "signed out" (and list no hub servers) for a person who is signed in.
  // Once that first tick is done the catalogue is asked again — once, whatever
  // it said. If it is still fetching then, the ask waits for it to settle: a
  // first fetch in flight is not cancelled by an invalidation, only joined, so
  // asking at once would just receive the answer taken before the bearer.
  const firstTickDone = useRef(false)
  const wasTicking = useRef(false)
  const askAfterTick = useRef(false)
  const catalogFetching = catalogQuery.isFetching

  // eslint-disable-next-line no-restricted-syntax -- remembers the previous tick state to see one end; mirrors nothing
  useEffect(() => {
    if (wasTicking.current && !sync.ticking && !firstTickDone.current) {
      firstTickDone.current = true
      askAfterTick.current = true
    }

    wasTicking.current = sync.ticking

    if (askAfterTick.current && !catalogFetching) {
      askAfterTick.current = false
      void queryClient.invalidateQueries({ queryKey: [...MCP_CATALOG_KEY, profileKey] })
    }
  }, [catalogFetching, profileKey, queryClient, sync.ticking])

  // Nothing edits or writes mcp.json before the config has loaded (the map
  // would be empty, and a whole-map save of it would remove every server) or
  // while a profile switch is settling (it would be the other profile's).
  const configReady = Boolean(config) && !profilePending

  // The config the draft was seeded from — what a save merges the person's
  // edits against (`mergeServers`), so work that lands while the editor is
  // open is never undone by the save.
  const draftBase = useRef<McpServers>({})

  const resetDraft = (entries: McpServers) => {
    draftBase.current = entries
    setDraft(wrapDoc(entries))
    setDirty(false)
    setDocVersion(version => version + 1)
  }

  // While the editor is open and untouched, it shows the config as it is now:
  // a refetch (the early-boot snapshot that lands before mcp_servers is
  // assembled, a hub sync, a CLI edit) re-seeds it instead of leaving a stale
  // document on screen.
  useEffect(() => {
    if (!editorOpen || dirty || profilePending) {
      return
    }

    if (wrapDoc(servers) !== draft) {
      resetDraft(servers)
    }
  }, [draft, dirty, editorOpen, profilePending, servers])

  // Place the cursor in the requested server's block once the editor has it.
  // eslint-disable-next-line no-restricted-syntax -- consumes a one-shot request ref; mirrors nothing
  useEffect(() => {
    const key = pendingFocus.current

    if (!editorOpen || !key) {
      return
    }

    const block = blocks.find(candidate => candidate.name === key)

    if (!block) {
      return
    }

    let frame = 0
    let tries = 0

    const place = () => {
      if (editorApi.current) {
        editorApi.current.setCursor(block.from + 1, { center: true })
        setCursor(block.from + 1)
        pendingFocus.current = null

        return
      }

      if (tries++ < 30) {
        frame = requestAnimationFrame(place)
      }
    }

    frame = requestAnimationFrame(place)

    return () => cancelAnimationFrame(frame)
  }, [blocks, docVersion, editorOpen])

  // Bumped on every profile switch. Async probe/auth/write completions capture
  // the epoch at call time and bail if it changed, so a slow profile-A request
  // can't write its result into profile B's state after the user switched.
  const profileEpoch = useRef(0)

  // A profile switch invalidates the config query (see store/profile.ts), which
  // refetches the new backend's mcp.json. Reset ALL per-profile view state — the
  // draft (incl. a dirty one, so profile A's edits can't be saved into B), the
  // open dialogs, probes and cursor — so everything reseeds for the new profile.
  // The probe cache is already profile-keyed, so this just forces a re-probe.
  useOnProfileSwitch(() => {
    profileEpoch.current += 1
    setProbes({})
    setCursor(0)
    setAuthing(null)
    setDirty(false)
    setDraft('')
    setDocVersion(version => version + 1)
    setEditorOpen(false)
    setDetailName(null)
    setLogsOpen(false)
    setRemoveTarget(null)
    setReplaceTarget(null)
    pendingFocus.current = null
    draftBase.current = {}
    probedServers.current = {}
    // Mark stale until the config query replaces profile A's data — guards
    // mutations from persisting A's server list into B mid-refetch.
    staleConfigStamp.current = configUpdatedAt
    staleErrorStamp.current = configErroredAt
    setProfilePending(true)
  })

  // Clear once the config query settles for the new profile: dataUpdatedAt bumps
  // on a fresh success, errorUpdatedAt on a fresh failure. Releasing on error too
  // means a failed refetch surfaces the retry UI instead of leaving mutations
  // silently no-op forever.
  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    if (
      profilePending &&
      staleConfigStamp.current !== null &&
      (configUpdatedAt !== staleConfigStamp.current || configErroredAt !== staleErrorStamp.current)
    ) {
      setProfilePending(false)
      staleConfigStamp.current = null
      staleErrorStamp.current = null
    }
  }, [profilePending, configUpdatedAt, configErroredAt])

  // A command-palette jump (`?tab=mcp&server=<name>`) opens that connection's
  // detail, once: the param is dropped as soon as the config can answer, found
  // or not, so a later toggle, refetch or search never opens it again.
  const [searchParams, setSearchParams] = useSearchParams()
  const linkedServer = searchParams.get('server')

  useEffect(() => {
    if (!linkedServer || !configReady) {
      return
    }

    if (linkedServer in servers) {
      setDetailName(linkedServer)
    }

    setSearchParams(
      previous => {
        const next = new URLSearchParams(previous)
        next.delete('server')

        return next
      },
      { replace: true }
    )
  }, [configReady, linkedServer, servers, setSearchParams])

  // A link to one hub server (`?hub=<slug>`: the hub's "Mở trong Workmate",
  // `agentx://mcp/<slug>`) brings its card into view and marks it a moment.
  // The feed on this machine may predate the server: not in it, it is fetched
  // again once. The param is dropped either way, like `?server=`.
  const linkedHub = searchParams.get('hub')
  const [spotlight, setSpotlight] = useState<null | string>(null)
  const [hubRefetch, setHubRefetch] = useState<{ done: boolean; slug: string } | null>(null)
  const catalogLoaded = catalogQuery.data !== undefined

  useEffect(() => {
    if (!linkedHub || !catalogLoaded || (hubRefetch?.slug === linkedHub && !hubRefetch.done)) {
      return
    }

    const valid = isHubSlug(linkedHub)
    const found = valid && catalog.some(entry => entry.origin === 'hub' && entry.slug === linkedHub)

    if (valid && !found && hubRefetch?.slug !== linkedHub) {
      setHubRefetch({ done: false, slug: linkedHub })
      void getMcpCatalog(true)
        .then(data => queryClient.setQueryData<McpCatalogResponse>([...MCP_CATALOG_KEY, profileKey], data))
        .catch(() => undefined)
        .finally(() => setHubRefetch({ done: true, slug: linkedHub }))

      return
    }

    if (found) {
      setSpotlight(linkedHub)
    }

    setSearchParams(
      previous => {
        const next = new URLSearchParams(previous)
        next.delete('hub')

        return next
      },
      { replace: true }
    )
  }, [catalog, catalogLoaded, hubRefetch, linkedHub, profileKey, queryClient, setSearchParams])

  const configLoaded = Boolean(config)

  useEffect(() => {
    if (!spotlight || !configLoaded) {
      return
    }

    document.querySelector(`[data-hub-slug="${spotlight}"]`)?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
    const timer = window.setTimeout(() => setSpotlight(null), HUB_SPOTLIGHT_MS)

    return () => window.clearTimeout(timer)
  }, [configLoaded, spotlight])

  // A connection that left (removed here, by the hub sync, from a terminal)
  // takes its open detail with it — it must not pop back if the name returns.
  useEffect(() => {
    if (detailName && config && !(detailName in servers)) {
      setDetailName(null)
    }
  }, [config, detailName, servers])

  /** The servers as the config cache holds them right now — what the next write builds on. */
  const currentServers = () => getServers(queryClient.getQueryData<HermesConfigRecord>(AGENTX_CONFIG_KEY) ?? null)

  const runProbe = async (serverName: string) => {
    const epoch = profileEpoch.current
    const server = servers[serverName]
    const key = probeKey(serverName, server)
    const fingerprint = serverFingerprint(server ?? {})
    setProbes(current => ({ ...current, [serverName]: 'probing' }))

    // A result speaks for the config it was taken against: if the server's
    // connection changed while this probe ran, the newer probe owns the card.
    const stillCurrent = () =>
      profileEpoch.current === epoch && serverFingerprint(currentServers()[serverName] ?? {}) === fingerprint

    try {
      const result = await testMcpServer(serverName)

      probeCache.set(key, { at: Date.now(), result })

      if (stillCurrent()) {
        setProbes(current => ({ ...current, [serverName]: result }))
      }
    } catch (err) {
      const result = { ok: false, error: err instanceof Error ? err.message : String(err), tools: [] }
      probeCache.set(key, { at: Date.now(), result })

      if (stillCurrent()) {
        setProbes(current => ({ ...current, [serverName]: result }))
      }
    }
  }

  // Config writes reach live sessions immediately — no manual "Reload MCP".
  const silentReload = async () => {
    if (!gateway) {
      return
    }

    try {
      await gateway.request('reload.mcp', { confirm: true, session_id: activeSessionId ?? undefined })
    } catch (err) {
      notifyError(err, m.reloadFailed)
    }
  }

  // First-class OAuth: opens the system browser, blocks until the flow lands a
  // token (verified on disk — a friendly tools/list is not proof), then the
  // auth result doubles as the probe (it carries the tool list).
  const authenticate = async (serverName: string) => {
    const epoch = profileEpoch.current
    setAuthing(serverName)
    setProbes(current => ({ ...current, [serverName]: 'probing' }))

    try {
      const flow = await completeMcpDesktopOAuth({
        serverName,
        start: authMcpServer,
        status: getMcpOAuthFlow,
        openExternal: url => window.agentxDesktop.openExternal(url)
      })

      const result: McpTestResult = { ok: true, tools: flow.tools ?? [] }

      // Bail if the user switched profiles mid-flow — this result is profile A's.
      if (profileEpoch.current !== epoch) {
        return
      }

      // The endpoint persisted `auth: oauth`. Mirror it into the config as it
      // is now — not as it was when the browser opened: a switch flipped while
      // the person was signing in must survive — and cache the probe under
      // that post-auth config, which is the one every later read sees.
      const signedIn = { ...(currentServers()[serverName] ?? servers[serverName]), auth: 'oauth' }
      probeCache.set(probeKey(serverName, signedIn), { at: Date.now(), result })
      setProbes(current => ({ ...current, [serverName]: result }))
      setConfig(record => {
        const current = getServers(record ?? null)

        return record && current[serverName]
          ? { ...record, mcp_servers: { ...current, [serverName]: { ...current[serverName], auth: 'oauth' } } }
          : record
      })

      notify({
        kind: 'success',
        title: m.authenticatedTitle,
        message: m.authenticatedMessage(serverName, result.tools.length)
      })
      void silentReload()
    } catch (err) {
      if (profileEpoch.current !== epoch) {
        return
      }

      setProbes(current => ({
        ...current,
        [serverName]: { ok: false, error: err instanceof Error ? err.message : String(err), tools: [] }
      }))
      notifyError(err, serverName)
    } finally {
      if (profileEpoch.current === epoch) {
        setAuthing(null)
      }
    }
  }

  // It should just know: probe enabled servers as config arrives — but through
  // the cache, so revisiting the store doesn't respawn/reconnect the fleet. A
  // server whose connection changed since it was probed (an update, a replace,
  // an mcp.json edit) is probed again; one that left drops its probe.
  const probedServers = useRef<McpServers>({})

  // eslint-disable-next-line no-restricted-syntax -- keeps the config the probes were taken against, to see what changed; mirrors nothing into render
  useEffect(() => {
    const before = probedServers.current
    probedServers.current = servers

    const gone = Object.keys(before).filter(name => !(name in servers))

    if (gone.length > 0) {
      setProbes(current => Object.fromEntries(Object.entries(current).filter(([name]) => !gone.includes(name))))
    }

    for (const [serverName, server] of Object.entries(servers)) {
      const changed = serverName in before && serverFingerprint(before[serverName]) !== serverFingerprint(server)

      if (!serverEnabled(server) || (probesRef.current[serverName] !== undefined && !changed)) {
        continue
      }

      const cached = probeCache.get(probeKey(serverName, server))

      if (cached && Date.now() - cached.at < PROBE_TTL_MS) {
        setProbes(current => ({ ...current, [serverName]: cached.result }))
      } else {
        void runProbe(serverName)
      }
    }
    // Re-run only when the server set changes; runProbe is recreated every
    // render and adding it would re-probe the fleet on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [servers])

  // Every write to mcp.json goes through here, one after another, each built
  // from the config as the one before it left it: two quick toggles must not
  // both start from the same map and have the second undo the first. Whole-map
  // replace (NOT saveHermesConfig, which deep-merges and so can never delete a
  // server, drop `enabled: false`, or remove a nested field); only after the
  // replace lands is the cache written through and live sessions reloaded.
  // Resolves false when the profile switched meanwhile: the write hit profile
  // A's backend (correct), but the client-side state now belongs to B, so the
  // caller must skip its post-await work. A write that changes which servers
  // exist also moves the catalog's "Đã kết nối" pills and the gateway's added
  // endpoints, so both are asked again.
  const writeQueue = useRef<Promise<unknown>>(Promise.resolve())

  const writeServers = (
    change: (current: McpServers) => McpServers,
    { refreshCatalog }: { refreshCatalog?: boolean } = {}
  ): Promise<boolean> => {
    const epoch = profileEpoch.current

    const run = async () => {
      if (profileEpoch.current !== epoch) {
        return false
      }

      const current = currentServers()
      let next = change(current)
      const saved = await saveMcpServers(next)

      if (profileEpoch.current !== epoch) {
        return false
      }

      // A server AgentX Hub keeps off was saved off whatever the map said: the cache follows the file, and says why.
      const keptOff = (saved?.kept_off ?? []).filter(name => next[name])

      if (keptOff.length > 0) {
        next = { ...next, ...Object.fromEntries(keptOff.map(name => [name, withEnabled(next[name], false)])) }
        notify({ kind: 'warning', message: t.skills.hub.state.keptOff(keptOff.join(', ')) })
      }

      setConfig(record => ({ ...record, mcp_servers: next }))
      void silentReload()

      if (refreshCatalog ?? Object.keys(next).join('\n') !== Object.keys(current).join('\n')) {
        void catalogQuery.refetch()
        void queryClient.invalidateQueries({ queryKey: [MCP_GATEWAY_KEY] })
      }

      return true
    }

    const written = writeQueue.current.then(run, run)
    writeQueue.current = written.catch(() => undefined)

    return written
  }

  // A catalog install (or a gateway add, or a hub removal) changed config.yaml
  // on the backend: the catalog (installed state), the gateway listing and the
  // config are asked again. An open mcp.json draft needs nothing — its save
  // merges over the config as it is then.
  const onCatalogInstalled = async () => {
    void catalogQuery.refetch()
    void queryClient.invalidateQueries({ queryKey: [MCP_GATEWAY_KEY] })
    await refetchConfig()
    void silentReload()
  }

  const openExternal = (url: string) => void window.agentxDesktop.openExternal(url)
  const install = useCatalogInstall(() => void onCatalogInstalled())
  const gatewayEndpoints = useGatewayEndpoints(profileKey, () => void onCatalogInstalled(), openExternal)
  const listing = gatewayEndpoints.listing
  const endpoints = listing?.available ? listing.endpoints : NO_ENDPOINTS

  const setServerEnabled = async (serverName: string, enabled: boolean) => {
    if (profilePending || !servers[serverName]) {
      return
    }

    try {
      const written = await writeServers(current =>
        current[serverName] ? { ...current, [serverName]: withEnabled(current[serverName], enabled) } : current
      )

      if (written && enabled) {
        void runProbe(serverName)
      }
    } catch (err) {
      notifyError(err, m.saveFailed)
    }
  }

  // Per-tool gating writes the server's `tools.include`/`tools.exclude` and
  // persists like any other config change (immediate reload of live sessions).
  // The probe still lists every discovered tool; the filter decides which ones
  // the agent actually registers. `on` is the state the person asked for, so a
  // double click sets it twice rather than flipping it back.
  const setToolEnabled = async (serverName: string, toolName: string, on: boolean) => {
    if (profilePending || !servers[serverName]) {
      return
    }

    try {
      await writeServers(current =>
        current[serverName] && isToolEnabled(current[serverName], toolName) !== on
          ? { ...current, [serverName]: toggleToolInServer(current[serverName], toolName) }
          : current
      )
    } catch (err) {
      notifyError(err, m.saveFailed)
    }
  }

  // Throws on failure: the confirm dialog that asked keeps itself open and says why.
  const removeServer = async (serverName: string) => {
    if (profilePending) {
      return
    }

    setSaving(true)

    try {
      await writeServers(current => {
        const next = { ...current }
        delete next[serverName]

        return next
      })
    } finally {
      setSaving(false)
    }
  }

  const openEditor = ({ focus = null, starter = false }: { focus?: null | string; starter?: boolean } = {}) => {
    if (!configReady) {
      return
    }

    let focusKey = focus

    if (starter) {
      // "Thêm thủ công" seeds a starter entry under a free key — naming happens
      // in the editor, like every other mcp.json.
      let base = servers

      if (dirty) {
        try {
          base = parseServersDoc(draft)
        } catch {
          // Mid-edit: the starter goes onto the config instead.
          base = servers
        }
      } else {
        draftBase.current = servers
      }

      const seeded = withStarterEntry(base)
      setDraft(wrapDoc(seeded.entries))
      setDirty(true)
      setDocVersion(version => version + 1)
      focusKey = seeded.key
    } else if (!dirty) {
      resetDraft(servers)
    }

    pendingFocus.current = focusKey
    setDetailName(null)
    setEditorOpen(true)
  }

  const saveDoc = async () => {
    if (!configReady) {
      return
    }

    let mine: McpServers

    try {
      mine = parseServersDoc(draft)
    } catch (err) {
      notifyError(err, m.invalidJson)

      return
    }

    setSaving(true)

    const base = draftBase.current

    try {
      // The person's edits over the config as it is now: a sign-in, an install
      // or a hub sync that landed while the editor was open stays. An edit to a
      // server's launch can make a hub server "edited here", so the catalog is
      // asked again either way.
      if (!(await writeServers(current => mergeServers(base, mine, current), { refreshCatalog: true }))) {
        return
      }

      resetDraft(currentServers())
      setEditorOpen(false)
      notify({ kind: 'success', title: m.savedTitle, message: m.savedMessage('mcp.json') })
    } catch (err) {
      notifyError(err, m.saveFailed)
    } finally {
      setSaving(false)
    }
  }

  // "Đồng bộ ngay": a tick (the bearer, and what the hub wants here), then the
  // hub's MCP feed fetched now instead of when stale, the gateway listing and
  // the config — one press brings every shelf up to date.
  const syncNow = () => {
    setSyncing(true)
    void sync
      .tick(false)
      .then(() => getMcpCatalog(true))
      .then(data => queryClient.setQueryData<McpCatalogResponse>([...MCP_CATALOG_KEY, profileKey], data))
      .then(() => Promise.all([refetchConfig(), queryClient.invalidateQueries({ queryKey: [MCP_GATEWAY_KEY] })]))
      .catch(err => notifyError(err, m.catalogLoadFailed))
      .finally(() => setSyncing(false))
  }

  // What the hub last said of each of its servers here, by the name it has here.
  const hubStateMap = sync.changes.data?.hub_state?.mcp

  const hubStates = useMemo(
    () => Object.fromEntries(Object.values(hubStateMap ?? {}).map(view => [view.name, view])),
    [hubStateMap]
  )

  // Everything the shelves show, resolved once per render.
  const views = useMemo<McpServerView[]>(
    () =>
      names.map(name =>
        describeServer({ endpoints, entries: catalog, hubStates, name, probe: probes[name], server: servers[name], t })
      ),
    [catalog, endpoints, hubStates, names, probes, servers, t]
  )

  const needle = normalize(query)

  const matches = (...texts: (null | string | undefined)[]) =>
    needle.length === 0 || texts.some(text => text && normalize(text).includes(needle))

  const connected = views.filter(view => matches(view.title, view.name, view.description))

  // One shelf for the hub's servers, whichever place each is set up in: a card never says where before it says what.
  const hubEntries = catalog.filter(
    entry => entry.origin === 'hub' && matches(entry.title, entry.name, entry.description, entry.slug)
  )

  const shipped = catalog.filter(entry => {
    const copy = entry.origin === 'hub' ? null : shippedCopy(entry.name, t)

    return entry.origin !== 'hub' && matches(entry.name, entry.description, copy?.label, copy?.description)
  })

  // A server of the hub has its card on the hub's shelf (the listing only says where the person stands with it).
  const toolsets = endpoints.filter(endpoint => endpoint.kind === 'toolset')
  const toolsetsShown = toolsets.filter(endpoint => matches(endpoint.label, endpoint.ref))

  const available =
    catalog.filter(entry => !entry.installed).length + toolsets.filter(endpoint => !endpoint.added).length

  const untrustedKids = (hub?.notices ?? []).filter(n => n.code === 'hub_key_untrusted').map(n => n.kid ?? '?')
  const unsupported = (catalogQuery.data?.diagnostics ?? []).filter(d => d.kind === 'hub_unsupported').length
  const detailView = detailName ? (views.find(view => view.name === detailName) ?? null) : null
  const device = listing?.device

  // This machine's gateway token, said where its entries are offered: beside the hub's servers set up on the hub,
  // else beside the toolsets.
  const tokenNote = device?.token &&
    device.days_left !== null &&
    device.entries > 0 &&
    !gatewayNeedsSignIn(listing) && <span data-testid="mcp-gateway-token"> {m.gatewayTokenDays(device.days_left)}</span>

  const tokenOnHubShelf = hubEntries.some(entry => entry.route?.via === 'gateway')

  const updateHubEntry = (view: McpServerView) => {
    if (view.hubEntry) {
      void install.install(view.hubEntry, { askCredentials: false })
    }
  }

  const barSource = hub && (
    <StoreSource
      label={
        untrustedKids.length > 0
          ? m.hubKeyUntrustedShort
          : hub.error
            ? t.skills.hub.storeOffline
            : hub.signed_in
              ? t.skills.hub.storeOnline
              : m.hubSignedOutShort
      }
      testId="mcp-hub-state"
      tone={untrustedKids.length > 0 ? 'bad' : hub.error ? 'warn' : hub.signed_in ? 'good' : 'muted'}
      url={hub.hub_url}
    />
  )

  const bar = (
    <StoreBar
      actions={
        <>
          <Button data-testid="mcp-sync" disabled={syncing} onClick={syncNow} size="sm" variant="outline">
            {syncing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw />}
            {syncing ? t.skills.hub.syncing : t.skills.hub.syncNow}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button aria-label={m.moreActions} data-testid="mcp-more" size="icon-sm" variant="ghost">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={4}>
              <DropdownMenuItem disabled={!configReady} onSelect={() => openEditor()}>
                {m.editConfig}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setLogsOpen(true)}>{m.logsAll}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
      line={
        <span data-testid="mcp-store-line">
          {m.storeCounts(names.length, available)}
          {hub?.fetched_at ? (
            <>
              <span className="text-(--ui-text-quaternary)"> · </span>
              {t.skills.hub.lastSync(syncedAt(hub.fetched_at, locale))}
            </>
          ) : null}
        </span>
      }
      source={barSource}
      switcher={switcher}
    >
      {untrustedKids.length > 0 ? (
        <StoreNotice data-testid="mcp-hub-key-untrusted" tone="bad">
          {m.hubKeyUntrusted(untrustedKids.join(', '))}
        </StoreNotice>
      ) : (
        hub?.error && (
          <StoreNotice data-testid="mcp-hub-offline" tone="warn">
            {m.hubOffline}
          </StoreNotice>
        )
      )}
      {gatewayNeedsSignIn(listing) && (
        <StoreNotice data-testid="mcp-gateway-signin" tone="warn">
          {m.gatewaySignIn}
        </StoreNotice>
      )}
      {hub && !hub.signed_in && <StoreNotice data-testid="mcp-hub-signin">{m.hubSignIn}</StoreNotice>}
      {/* The hub answered the gateway listing with an error: said, not hidden.
          A closed gateway or a signed-out hub is not an error — the shelf just
          stays away (the sign-in notice above covers the latter). */}
      {listing?.reason === 'error' && (
        <StoreNotice data-testid="mcp-gateway-failed" tone="warn">
          {m.gatewayListFailed(listing.error?.detail ?? '')}
        </StoreNotice>
      )}
      {unsupported > 0 && <StoreNotice>{m.hubUnsupported(unsupported)}</StoreNotice>}
      {catalogQuery.isError && (
        <StoreNotice data-testid="mcp-catalog-failed" tone="warn">
          {m.catalogLoadFailed}{' '}
          <Button onClick={() => void catalogQuery.refetch()} size="inline" variant="textStrong">
            {t.common.retry}
          </Button>
        </StoreNotice>
      )}
    </StoreBar>
  )

  // Cached data paints instantly; a spinner only ever shows on the first-ever
  // load, and a failed load gets a real retry — never a silent blank pane.
  if (configFailed && !config) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {bar}
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <ErrorBanner className="max-w-sm">
            <span className="flex flex-col gap-2">
              {configError instanceof Error ? configError.message : m.failedLoad}
              <Button className="self-start" onClick={() => void refetchConfig()} size="sm" variant="text">
                {t.common.retry}
              </Button>
            </span>
          </ErrorBanner>
        </div>
      </div>
    )
  }

  const nothingMatches =
    needle.length > 0 && connected.length + hubEntries.length + shipped.length + toolsetsShown.length === 0

  return (
    <div className="flex h-full min-h-0 flex-col">
      {bar}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 [scrollbar-gutter:stable]">
        {!config ? (
          <PageLoader className="min-h-24" label={configLoading ? m.loading : t.skills.loading} />
        ) : nothingMatches ? (
          <PanelEmpty
            description={t.skills.emptyNothingMatches(query.trim())}
            figure="plug"
            title={t.skills.emptyNoneFound(m.nounConnections)}
          />
        ) : (
          <div className="grid gap-6">
            {(needle.length === 0 || connected.length > 0) && (
              <StoreCardShelf
                action={
                  <Button
                    data-testid="mcp-add-manual"
                    disabled={!configReady}
                    onClick={() => openEditor({ starter: true })}
                    size="sm"
                    variant="ghost"
                  >
                    <Plus />
                    {m.addManual}
                  </Button>
                }
                count={connected.length}
                data-testid="mcp-shelf-connected"
                empty={<p className="px-0.5 text-sm text-(--ui-text-tertiary)">{m.connectedEmpty}</p>}
                label={m.shelfConnected}
              >
                {connected.map(view => (
                  <McpServerCard
                    authing={authing === view.name}
                    busy={saving || profilePending}
                    key={view.name}
                    onAuthenticate={() => void authenticate(view.name)}
                    onDetails={() => setDetailName(view.name)}
                    onOpenHub={openExternal}
                    onProbe={() => void runProbe(view.name)}
                    onToggle={checked => void setServerEnabled(view.name, checked)}
                    onUpdate={() => updateHubEntry(view)}
                    updating={view.hubEntry !== null && install.installing === catalogKey(view.hubEntry)}
                    view={view}
                  />
                ))}
              </StoreCardShelf>
            )}

            {catalogQuery.isLoading ? (
              <PageLoader className="min-h-24" label={m.catalogLoading} />
            ) : (
              <>
                {hubEntries.length > 0 && (
                  <StoreCardShelf
                    count={hubEntries.length}
                    data-testid="mcp-hub-catalog"
                    label={m.shelfHub}
                    note={
                      <>
                        {m.hubHint}
                        {tokenOnHubShelf && tokenNote}
                      </>
                    }
                  >
                    {hubEntries.map(entry =>
                      entry.route?.via === 'gateway' ? (
                        <HubGatewayCard
                          entry={entry}
                          gateway={gatewayEndpoints}
                          key={catalogKey(entry)}
                          onOpenHub={openExternal}
                          spotlight={spotlight === entry.slug}
                        />
                      ) : (
                        <CatalogServerCard
                          entry={entry}
                          install={install}
                          key={catalogKey(entry)}
                          onOpenHub={openExternal}
                          spotlight={spotlight === entry.slug}
                        />
                      )
                    )}
                  </StoreCardShelf>
                )}
                {toolsetsShown.length > 0 && (
                  <StoreCardShelf
                    count={toolsetsShown.length}
                    data-testid="mcp-gateway"
                    label={m.shelfToolsets}
                    note={
                      <>
                        {m.toolsetsHint}
                        {!tokenOnHubShelf && tokenNote}
                      </>
                    }
                  >
                    {toolsetsShown.map(endpoint => (
                      <GatewayEndpointCard
                        adding={gatewayEndpoints.adding === endpoint.ref}
                        busy={gatewayEndpoints.adding !== null}
                        endpoint={endpoint}
                        key={`${endpoint.kind}:${endpoint.ref}`}
                        onAdd={() => void gatewayEndpoints.add(endpoint.kind, endpoint.ref, endpoint.label)}
                        onOpenHub={openExternal}
                      />
                    ))}
                  </StoreCardShelf>
                )}
                {shipped.length > 0 && (
                  <StoreCardShelf count={shipped.length} data-testid="mcp-shelf-catalog" label={m.shelfCatalog}>
                    {shipped.map(entry => (
                      <CatalogServerCard
                        entry={entry}
                        install={install}
                        key={catalogKey(entry)}
                        onOpenHub={openExternal}
                      />
                    ))}
                  </StoreCardShelf>
                )}
              </>
            )}
          </div>
        )}
      </div>

      <McpServerDialog
        authing={detailView !== null && authing === detailView.name}
        busy={saving || profilePending}
        onAuthenticate={() => detailView && void authenticate(detailView.name)}
        onClose={() => setDetailName(null)}
        onEditConfig={() => detailView && openEditor({ focus: detailView.name })}
        onOpenHub={openExternal}
        onProbe={() => detailView && void runProbe(detailView.name)}
        onRemove={() => {
          if (detailView) {
            setDetailName(null)
            setRemoveTarget(detailView)
          }
        }}
        onReplace={() => {
          if (detailView?.hubEntry) {
            setDetailName(null)
            setReplaceTarget(detailView.hubEntry)
          }
        }}
        onSetTool={(toolName, on) => detailView && void setToolEnabled(detailView.name, toolName, on)}
        onToggle={checked => detailView && void setServerEnabled(detailView.name, checked)}
        onUpdate={() => detailView && updateHubEntry(detailView)}
        updating={
          detailView !== null && detailView.hubEntry !== null && install.installing === catalogKey(detailView.hubEntry)
        }
        view={detailView}
      />

      <McpConfigDialog
        apiRef={editorApi}
        dirty={dirty}
        docVersion={docVersion}
        draft={draft}
        highlight={activeBlock}
        onChange={next => {
          setDraft(next)
          setDirty(true)
        }}
        onClose={() => setEditorOpen(false)}
        onCursorChange={setCursor}
        onDiscard={() => {
          resetDraft(servers)
          setEditorOpen(false)
        }}
        onSave={() => void saveDoc()}
        open={editorOpen}
        saving={saving}
      />

      <McpLogsDialog onClose={() => setLogsOpen(false)} open={logsOpen} />

      <ConfirmDialog
        confirmLabel={m.removeConnection}
        description={m.removeConfirmDescription}
        destructive
        dismissOnConfirm
        onClose={() => setRemoveTarget(null)}
        onConfirm={async () => {
          if (!removeTarget) {
            return
          }

          // A hub server leaves through the hub's own removal, so the hub hears it — one that left the hub's feed
          // (no longer published, taken down) too: its tokens and cached tools go with it (the hub's decision §9.1 #18).
          if (removeTarget.hubEntry?.slug) {
            await install.removeFromHub(removeTarget.hubEntry)
          } else if (removeTarget.hubState?.slug && removeTarget.source !== 'gateway') {
            await removeHubMcpServer(removeTarget.hubState.slug)
            notify({ kind: 'success', title: m.hubRemoved(removeTarget.title), message: '' })
            await onCatalogInstalled()
          } else {
            await removeServer(removeTarget.name)
          }
        }}
        open={removeTarget !== null}
        title={removeTarget ? m.removeConfirm(removeTarget.title) : ''}
      />

      <ConfirmDialog
        confirmLabel={m.hubReplace.replace('…', '')}
        destructive
        dismissOnConfirm
        onClose={() => setReplaceTarget(null)}
        onConfirm={async () => {
          if (replaceTarget) {
            await install.install(replaceTarget, { askCredentials: false })
          }
        }}
        open={replaceTarget !== null}
        title={replaceTarget ? m.hubReplaceConfirm(catalogTitle(replaceTarget, t)) : ''}
      />
    </div>
  )
}
