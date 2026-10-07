import type { McpMissingCommand, McpTestResult } from '@/hermes'
import type { Translations } from '@/i18n'
import { countEnabledTools } from '@/lib/mcp-tool-filter'
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'
import type { HermesConfigRecord, HubStateView, McpCatalogEntry } from '@/types/hermes'

// The MCP segment's data layer, UI-free: the mcp.json document the editor
// speaks, what a configured server's live state is, and how a configured
// server finds its catalog entry. The segment (`mcp-store.tsx`) and its cards
// and dialogs render from these; tests exercise them without a DOM.

export type McpServers = Record<string, Record<string, unknown>>

// The editor always speaks the ecosystem's mcp.json document format — names
// are the JSON keys, transport is inferred from `command` vs `url` — so any
// README's "add this to your mcp.json" snippet pastes verbatim. Storage stays
// the config.yaml `mcp_servers` map (CLI/TUI untouched).
export const STARTER_ENTRY = {
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/dir']
}

const pretty = (value: unknown) => JSON.stringify(value, null, 2)

export const wrapDoc = (entries: McpServers) => pretty({ mcpServers: entries })

const isServerShape = (value: Record<string, unknown>) =>
  typeof value.command === 'string' || typeof value.url === 'string'

// Cursor/Claude write `type`; AgentX reads `transport`. Normalize on the way
// in so pasted configs behave identically under the CLI/TUI loader.
function normalizeEntry(entry: Record<string, unknown>): Record<string, unknown> {
  if (typeof entry.type === 'string' && entry.transport === undefined) {
    const { type, ...rest } = entry

    return { ...rest, transport: type }
  }

  return entry
}

/** Accepts `{"mcpServers": {...}}` (ecosystem), a bare name→config map, or throws. */
export function parseServersDoc(raw: string): McpServers {
  const parsed = JSON.parse(raw) as unknown

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected a JSON object')
  }

  const doc = parsed as Record<string, unknown>

  if (isServerShape(doc)) {
    throw new Error('Wrap the server in {"mcpServers": {"name": …}} so it has a name')
  }

  const wrapper = doc.mcpServers ?? doc.mcp_servers

  const map =
    wrapper && typeof wrapper === 'object' && !Array.isArray(wrapper) ? (wrapper as McpServers) : (doc as McpServers)

  return Object.fromEntries(Object.entries(map).map(([name, entry]) => [name, normalizeEntry(entry)]))
}

export function getServers(config: HermesConfigRecord | null): McpServers {
  const raw = config?.mcp_servers

  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as McpServers) : {}
}

// The runtime gate is `enabled: false` — the same flag `agentx mcp` and the
// agent's MCP loader read.
export const serverEnabled = (server: Record<string, unknown>) => server.enabled !== false

/** The config with the `enabled` flag set: on drops the key, off writes `false`. */
export function withEnabled(server: Record<string, unknown>, enabled: boolean): Record<string, unknown> {
  const next = { ...server }

  if (enabled) {
    delete next.enabled
  } else {
    next.enabled = false
  }

  return next
}

const sameEntry = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * What an mcp.json save writes: the person's edits laid over the config as it
 * is now. `base` is the config the draft was seeded from, `mine` the draft,
 * `theirs` the config on disk at save time. Work that finished while the
 * draft was open — a sign-in writing `auth: oauth`, an install, the hub sync,
 * a gateway add — changed `theirs`, not the draft; a whole-map save of the
 * draft alone would undo it. So: a server the person added, removed or
 * changed in the editor takes their version; every other server takes the
 * one on disk (a server that appeared meanwhile is kept, one removed
 * meanwhile stays removed). The draft's order leads, then disk's newcomers.
 */
export function mergeServers(base: McpServers, mine: McpServers, theirs: McpServers): McpServers {
  const merged: McpServers = {}

  for (const [name, entry] of Object.entries(mine)) {
    if (!(name in base) || !sameEntry(base[name], entry)) {
      merged[name] = entry
    } else if (name in theirs) {
      merged[name] = theirs[name]
    }
  }

  for (const [name, entry] of Object.entries(theirs)) {
    if (!(name in merged) && !(name in mine) && !(name in base)) {
      merged[name] = entry
    }
  }

  return merged
}

/** A starter entry under the first free `my-server[-n]` key, for "Thêm thủ công". */
export function withStarterEntry(base: McpServers): { entries: McpServers; key: string } {
  let key = 'my-server'

  for (let i = 2; key in base; i++) {
    key = `my-server-${i}`
  }

  return { entries: { ...base, [key]: STARTER_ENTRY }, key }
}

const NEEDS_AUTH_RE = /\b(401|unauthorized|forbidden|invalid[_ ]?token|authentication|oauth)\b/i

// Shared cache key for the MCP catalog — feeds the store shelves and the
// description of configured servers; invalidated after an install.
export const MCP_CATALOG_KEY = ['mcp-catalog'] as const

// Probe results outlive the component: each probe is a REAL connect/disconnect
// (stdio servers get spawned!), so re-entering the page must not re-probe the
// fleet. Manual refresh / auth / toggle-on bypass the cache.
export const PROBE_TTL_MS = 5 * 60_000
export const probeCache = new Map<string, { at: number; result: McpTestResult }>()

// A probe is only valid for one (profile, exact-config) pair. Keying the cache
// by a fingerprint of the connection-relevant fields — plus the active profile
// — means a same-name edit (url/command/env change) or a same-named server in
// another profile MISSES the cache instead of showing a stale probe.
export const serverFingerprint = (server: Record<string, unknown>): string =>
  JSON.stringify([server.url, server.command, server.args, server.env, server.headers, server.transport, server.auth])

export const probeKey = (name: string, server: Record<string, unknown> | undefined): string =>
  `${normalizeProfileKey($activeGatewayProfile.get())}::${name}::${serverFingerprint(server ?? {})}`

export type Probe = McpTestResult | 'probing'

// 'missing-runtime': the server's command (or the runtime it needs, uv for
// `uvx`) is not on this machine, so nothing was started — a setup problem to
// fix here, not a connection that failed.
export type ServerStatus = 'off' | 'probing' | 'ok' | 'needs-auth' | 'missing-runtime' | 'error' | 'unknown'

export function statusOf(server: Record<string, unknown>, probe: Probe | undefined): ServerStatus {
  if (!serverEnabled(server)) {
    return 'off'
  }

  if (probe === 'probing') {
    return 'probing'
  }

  if (!probe) {
    return 'unknown'
  }

  if (probe.ok) {
    return 'ok'
  }

  if (probe.missing) {
    return 'missing-runtime'
  }

  return NEEDS_AUTH_RE.test(probe.error ?? '') ? 'needs-auth' : 'error'
}

/** The command a failed probe found missing, with what to call it: the runtime when known (`uv`), else the command. */
export function missingCommandOf(probe: Probe | undefined): (McpMissingCommand & { label: string }) | null {
  const missing = probe && probe !== 'probing' && !probe.ok ? probe.missing : undefined

  return missing ? { ...missing, label: missing.runtime || missing.command } : null
}

/**
 * Whether "Đăng nhập" may run the browser OAuth flow for this server. Only
 * OAuth-shaped servers qualify: one with `headers` uses an API key or bearer,
 * so a 401 there means a bad key — routing it through the browser flow would
 * wrongly rewrite its config to `auth: oauth`. An explicit `auth: oauth` can
 * sign in again on any failure; an auth-less HTTP server may try OAuth on a 401.
 */
export function canAuthenticate(server: Record<string, unknown>, status: ServerStatus): boolean {
  const hasHeaderAuth = !!server.headers && typeof server.headers === 'object'

  return (
    typeof server.url === 'string' &&
    !hasHeaderAuth &&
    (server.auth === 'oauth' ? status === 'needs-auth' || status === 'error' : !server.auth && status === 'needs-auth')
  )
}

/** The tools this server actually registers: the probe's list through the include/exclude filter. */
export const enabledToolCount = (probe: McpTestResult, server: Record<string, unknown>): number =>
  countEnabledTools(
    server,
    probe.tools.map(tool => tool.name)
  )

/** What the probe found beyond tools ("25 công cụ, 1 prompt, 103 tài nguyên"), for the detail. */
export function capabilitySummary(
  m: Translations['settings']['mcp'],
  probe: McpTestResult,
  server: Record<string, unknown>
): string {
  return m.capabilitySummary(enabledToolCount(probe, server), probe.prompts ?? 0, probe.resources ?? 0)
}

/** The launch line a technical reader checks: the URL, or the command and its arguments. */
export function launchLine(server: Record<string, unknown>): string {
  if (typeof server.url === 'string') {
    return server.url
  }

  const args = Array.isArray(server.args) ? server.args.filter((arg): arg is string => typeof arg === 'string') : []

  return [typeof server.command === 'string' ? server.command : '', ...args].join(' ').trim()
}

/**
 * A connection added by hand, in words: that the person added it, and where
 * it runs — this machine, or a host. The description line of a card that has
 * no catalog copy to lean on.
 */
export function customDescription(server: Record<string, unknown>, m: Translations['settings']['mcp']): string {
  if (typeof server.url === 'string') {
    try {
      const url = new URL(server.url)

      return url.hostname === '127.0.0.1' || url.hostname === 'localhost' ? m.customLocal : m.customAt(url.host)
    } catch {
      return m.customRemote
    }
  }

  return m.customLocal
}

// ---------------------------------------------------------------------------
// Names and copy
// ---------------------------------------------------------------------------

/** "my-server" → "My Server": the config key, read as a name. */
export const serverTitle = (name: string): string =>
  name.replace(/[-_]+/g, ' ').replace(/\b\p{L}/gu, letter => letter.toUpperCase())

/** Hand-written copy for the servers AgentX ships in its catalog, keyed by manifest name. */
export function shippedCopy(name: string, t: Translations): null | { description: string; label: string } {
  return t.settings.mcp.catalogCopy[name.toLowerCase()] ?? null
}

// ---------------------------------------------------------------------------
// Catalog ↔ configured server
// ---------------------------------------------------------------------------

/**
 * The catalog entry a configured server was installed from, or null for one
 * added by hand. The backend already decided ownership (`installed` is only
 * true for the entry that owns the name — a hub entry whose name another
 * server holds reads `name_taken`), so the name is the join.
 */
export function installedEntryFor(name: string, entries: readonly McpCatalogEntry[]): McpCatalogEntry | null {
  return entries.find(entry => entry.installed && entry.name === name) ?? null
}

/**
 * The catalog entry that describes a configured server — the one it was
 * installed from, else one with the same name or the same remote URL — so a
 * server pasted by hand from a README still reads as what it is. A shared
 * launcher (`npx`, `uvx`, `node`) says nothing about which server runs, so a
 * command alone never matches.
 */
export function catalogMatchFor(
  name: string,
  server: Record<string, unknown>,
  entries: readonly McpCatalogEntry[]
): McpCatalogEntry | null {
  const lower = name.toLowerCase()
  const url = typeof server.url === 'string' ? server.url : null

  return (
    installedEntryFor(name, entries) ??
    entries.find(entry => entry.name.toLowerCase() === lower || (url !== null && entry.url === url)) ??
    null
  )
}

/** Where a configured server came from — what its card is tagged with, and who may update or remove it. */
export type ServerSource = 'custom' | 'gateway' | 'hub' | 'shipped'

/** Everything a card and its dialog say about one configured server, resolved once. */
export interface McpServerView {
  name: string
  server: Record<string, unknown>
  probe: Probe | undefined
  status: ServerStatus
  title: string
  description: string
  source: ServerSource
  /** The AgentX Hub entry it was installed from (updates, trust, blocked tools, removal through the hub). */
  hubEntry: McpCatalogEntry | null
  /** The gateway endpoint it was added from. */
  gatewayEndpoint: McpGatewayEndpoint | null
  /** What AgentX Hub last said of it (the hub's decision §9.1 #18): kept off by the hub, no longer published… */
  hubState: HubStateView | null
  canAuth: boolean
}

export function describeServer({
  endpoints,
  entries,
  hubStates = {},
  name,
  probe,
  server,
  t
}: {
  endpoints: readonly McpGatewayEndpoint[]
  entries: readonly McpCatalogEntry[]
  /** What the hub last said of each hub server here, by its name here. */
  hubStates?: Readonly<Record<string, HubStateView>>
  name: string
  probe: Probe | undefined
  server: Record<string, unknown>
  t: Translations
}): McpServerView {
  const m = t.settings.mcp
  const status = statusOf(server, probe)
  const installed = installedEntryFor(name, entries)
  const hubEntry = installed?.origin === 'hub' ? installed : null
  const gatewayEndpoint = endpoints.find(endpoint => endpoint.added === name) ?? null
  const described = installed ?? catalogMatchFor(name, server, entries)
  const copy = described && described.origin !== 'hub' ? shippedCopy(described.name, t) : null

  const source: ServerSource = hubEntry ? 'hub' : gatewayEndpoint ? 'gateway' : installed ? 'shipped' : 'custom'

  const title = gatewayEndpoint?.label || hubEntry?.title || (installed && copy?.label) || serverTitle(name)

  // A toolset is the person's own gathering: said as one. A server of the hub reads as the hub describes it.
  const description =
    (gatewayEndpoint?.kind === 'toolset' && m.gatewayToolsetDesc) ||
    copy?.description ||
    described?.description ||
    (gatewayEndpoint && m.gatewayServerDesc) ||
    customDescription(server, m)

  return {
    canAuth: canAuthenticate(server, status),
    description,
    gatewayEndpoint,
    hubEntry,
    hubState: hubStates[name] ?? null,
    name,
    probe,
    server,
    source,
    status,
    title
  }
}

// ---------------------------------------------------------------------------
// The mcp.json editor: cursor → server block
// ---------------------------------------------------------------------------

export interface ServerBlock {
  from: number
  name: string
  to: number
}

/**
 * A tolerant character walker (not JSON.parse — it must work mid-edit) that
 * finds each server's key+object range inside the mcpServers container, so
 * the editor can highlight the block under the cursor and a deep link can
 * place the cursor in one server's block.
 */
export function scanServerBlocks(text: string): ServerBlock[] {
  const skipString = (index: number): number => {
    let i = index + 1

    while (i < text.length) {
      if (text[i] === '\\') {
        i += 2
      } else if (text[i] === '"') {
        return i + 1
      } else {
        i++
      }
    }

    return i
  }

  // Container: the object after "mcpServers"/"mcp_servers", else the doc root.
  let start = -1
  const wrapper = /"mcpServers"|"mcp_servers"/.exec(text)

  if (wrapper) {
    let i = wrapper.index + wrapper[0].length

    while (i < text.length && text[i] !== '{') {
      i++
    }

    start = i
  } else {
    start = text.indexOf('{')
  }

  if (start < 0 || text[start] !== '{') {
    return []
  }

  const blocks: ServerBlock[] = []
  let i = start + 1

  while (i < text.length) {
    const ch = text[i]

    if (ch === '}') {
      break
    }

    if (ch !== '"') {
      i++

      continue
    }

    const keyStart = i
    const keyEnd = skipString(i)
    const name = text.slice(keyStart + 1, keyEnd - 1)
    i = keyEnd

    while (i < text.length && text[i] !== ':') {
      i++
    }

    i++

    while (i < text.length && /\s/.test(text[i])) {
      i++
    }

    if (text[i] === '{') {
      let depth = 0
      let j = i

      while (j < text.length) {
        const c = text[j]

        if (c === '"') {
          j = skipString(j)

          continue
        }

        if (c === '{') {
          depth++
        } else if (c === '}') {
          depth--

          if (depth === 0) {
            j++

            break
          }
        }

        j++
      }

      blocks.push({ from: keyStart, name, to: j })
      i = j
    } else {
      // Non-object value — skip to the next sibling.
      while (i < text.length && text[i] !== ',' && text[i] !== '}') {
        if (text[i] === '"') {
          i = skipString(i)

          continue
        }

        i++
      }
    }
  }

  return blocks
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

const STDIO_MARKER_RE = /^===== \[.*\] starting MCP server '(.+)' =====$/

// Keep only the stdio-log sections belonging to one server. The shared file
// has no per-line tags — sections start at that server's session marker and
// run until the next marker (any server's).
export function filterStdioSections(lines: string[], server: string): string[] {
  const out: string[] = []
  let inSection = false

  for (const line of lines) {
    const marker = STDIO_MARKER_RE.exec(line.trim())

    if (marker) {
      inSection = marker[1] === server
    }

    if (inSection) {
      out.push(line)
    }
  }

  return out
}

// ---------------------------------------------------------------------------
// AgentX Gateway (Agent Hub P5.8)
// ---------------------------------------------------------------------------

// The person's AgentX Gateway endpoints: a server or a toolset of theirs on
// the hub, reached through the hub's gateway with this machine's token —
// "Kết nối" asks the hub for that token (the signed-in session does), keeps it
// in .env and writes the entry; the hub sync renews it. Default profile only,
// like the hub's servers. Calls the local backend directly (`/api/mcp/gateway*`).
export interface McpGatewayEndpoint {
  kind: 'server' | 'toolset'
  ref: string
  label: string
  url: string
  status: 'ready' | 'partial' | 'needs_connection' | 'needs_reauth' | 'unavailable'
  tools: number
  connect_url?: null | string
  added: null | string
  /** Why the gateway does not serve it (`unavailable`), or what it waits for. */
  reason?: null | string
  /** A server's: whose account the gateway calls it with — the person's own, or one shared with them. */
  credential?: 'own' | 'shared' | null
  /** A server's: where the hub sets it up (the hub's decision §9.1 #17). */
  route?: McpHubRoute | null
  /** A server's, no longer published: until when the gateway still serves it (the hub's decision §9.1 #18). */
  server_status?: string
  serving_until?: null | string
}

/**
 * Where the hub sets one of its servers up (the hub's decision §9.1 #17): on the
 * hub — its key or its sign-in kept there, added here as its gateway endpoint,
 * nothing asked here — or on this machine, installed from its manifest.
 */
export interface McpHubRoute {
  via: 'gateway' | 'local'
  reason: null | string
}

/** A server the person went to connect on the hub from here: added as soon as the hub serves it. */
export interface McpGatewayWait {
  slug: string
  label: string
  until: number
  connect_url: string
}

/**
 * What a card of a hub server set up on the hub offers (the hub's decision
 * §9.1 #17), from where the person stands with it on the hub: `installed` (here
 * already), `waiting` (they went to connect it on the hub), `add` (the hub
 * serves it to them: added at a click, nothing asked), `connect` / `reconnect`
 * (their account there first — Workmate opens the hub's page; `reconnect` also
 * when it is here already and its account on the hub lapsed: it works again
 * the moment they sign in there), `unavailable` (the gateway does not serve it
 * now, `reason`), `unknown` (the hub could not be asked: the store says why
 * above its shelves).
 */
export type HubServerUse = 'add' | 'connect' | 'installed' | 'reconnect' | 'unavailable' | 'unknown' | 'waiting'

/** A hub server's slug, as the hub makes them: lowercase letters and digits joined by single dashes, at most 64. */
export function isHubSlug(value: string): boolean {
  return value.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
}

/** A gateway endpoint the person's account on the hub no longer reaches (or never did): connected on the hub, it works. */
export function gatewayLapsed(endpoint: McpGatewayEndpoint | null | undefined): boolean {
  return endpoint?.status === 'needs_connection' || endpoint?.status === 'needs_reauth'
}

export function hubServerUse(
  entry: McpCatalogEntry,
  listing: McpGatewayListing | undefined
): { endpoint: McpGatewayEndpoint | null; reason: null | string; use: HubServerUse; wait: McpGatewayWait | null } {
  const endpoint = listing?.endpoints.find(item => item.kind === 'server' && item.ref === entry.slug) ?? null
  const wait = listing?.waiting?.find(item => item.slug === entry.slug) ?? null

  if (entry.installed) {
    // Here as its gateway endpoint (`added`), with an account on the hub that lapsed: signing in there again fixes it.
    // One installed here from its manifest before the hub set it up keeps its own values: the hub's account is not its.
    return {
      endpoint,
      reason: null,
      use: endpoint?.added && gatewayLapsed(endpoint) ? 'reconnect' : 'installed',
      wait: null
    }
  }

  if (wait) {
    return { endpoint, reason: null, use: 'waiting', wait }
  }

  if (!listing?.available || !endpoint) {
    return { endpoint, reason: null, use: 'unknown', wait: null }
  }

  if (endpoint.status === 'ready') {
    // Served, but with no tool the hub approved yet: adding it would bring nothing.
    return endpoint.tools > 0
      ? { endpoint, reason: null, use: 'add', wait: null }
      : { endpoint, reason: 'no_tools', use: 'unavailable', wait: null }
  }

  if (gatewayLapsed(endpoint)) {
    return { endpoint, reason: null, use: endpoint.status === 'needs_reauth' ? 'reconnect' : 'connect', wait: null }
  }

  return { endpoint, reason: endpoint.reason ?? null, use: 'unavailable', wait: null }
}

/** A refusal, as the gateway routes answer one. */
export interface McpGatewayRefusal {
  ok: false
  status: 'error' | 'not_found' | 'offline' | 'reauth' | 'sign_in'
  code: string
  detail: string
}

export interface McpGatewayListing {
  available: boolean
  reason: 'error' | 'gateway_off' | 'offline' | 'profile' | 'reauth' | 'sign_in' | 'signed_out' | null
  error?: McpGatewayRefusal
  endpoints: McpGatewayEndpoint[]
  /** The servers the person went to connect on the hub from here (the hub's decision §9.1 #17). */
  waiting?: McpGatewayWait[]
  session?: boolean
  device: null | {
    entries: number
    token: boolean
    expires_at: null | string
    days_left: null | number
    state: 'expired' | 'none' | 'ok' | 'renew'
  }
}

export const MCP_GATEWAY_KEY = 'mcp-gateway'

export function gatewayPath(profile: string, tail = ''): string {
  return `/api/mcp/gateway${tail}${profile === 'default' ? '' : `?profile=${encodeURIComponent(profile)}`}`
}

/**
 * The token lapsed and nothing here can renew it (no signed-in session), or
 * the hub refused the session: every gateway entry on this machine stops
 * working until the person signs in again.
 */
export function gatewayNeedsSignIn(listing: McpGatewayListing | undefined): boolean {
  const device = listing?.device

  return (
    Boolean(device && device.entries > 0 && device.state === 'expired' && !listing?.session) ||
    listing?.reason === 'reauth' ||
    listing?.reason === 'sign_in'
  )
}
