import { describe, expect, it } from 'vitest'

import { en } from '@/i18n/en'
import type { McpCatalogEntry } from '@/types/hermes'

import { catalogTitle } from './mcp-catalog'
import {
  canAuthenticate,
  catalogMatchFor,
  customDescription,
  describeServer,
  filterStdioSections,
  gatewayNeedsSignIn,
  type McpGatewayEndpoint,
  type McpGatewayListing,
  mergeServers,
  parseServersDoc,
  scanServerBlocks,
  serverTitle,
  statusOf,
  withEnabled,
  withStarterEntry,
  wrapDoc
} from './mcp-model'

const m = en.settings.mcp

function entry(overrides: Partial<McpCatalogEntry> = {}): McpCatalogEntry {
  return {
    name: 'linear',
    description: 'Find, create, and update Linear issues, projects, and comments.',
    source: 'https://linear.app',
    transport: 'http',
    auth_type: 'oauth',
    required_env: [],
    command: null,
    args: [],
    url: 'https://mcp.linear.app/mcp',
    install_url: null,
    install_ref: null,
    bootstrap: [],
    default_enabled: null,
    post_install: '',
    needs_install: false,
    installed: false,
    enabled: false,
    origin: 'official',
    id: 'linear',
    ...overrides
  }
}

function endpoint(overrides: Partial<McpGatewayEndpoint> = {}): McpGatewayEndpoint {
  return {
    kind: 'server',
    ref: 'tracker',
    label: 'Tracker',
    url: 'https://hub.test/gw/s/tracker',
    status: 'ready',
    tools: 4,
    added: null,
    ...overrides
  }
}

describe('the mcp.json document', () => {
  it('reads the ecosystem wrapper, a bare map, and `type` as `transport`', () => {
    expect(parseServersDoc('{"mcpServers": {"a": {"url": "https://a.test", "type": "http"}}}')).toEqual({
      a: { transport: 'http', url: 'https://a.test' }
    })
    expect(parseServersDoc('{"b": {"command": "npx"}}')).toEqual({ b: { command: 'npx' } })
    // An explicit transport wins over `type`.
    expect(parseServersDoc('{"c": {"url": "u", "type": "sse", "transport": "http"}}').c).toEqual({
      url: 'u',
      type: 'sse',
      transport: 'http'
    })
  })

  it('refuses a document that is not a map of named servers', () => {
    expect(() => parseServersDoc('[]')).toThrow('Expected a JSON object')
    expect(() => parseServersDoc('{"command": "npx"}')).toThrow(/so it has a name/)
    expect(() => parseServersDoc('{')).toThrow()
  })

  it('round-trips through the editor document', () => {
    const servers = { a: { command: 'npx', args: ['-y', 'x'] }, b: { url: 'https://b.test', enabled: false } }

    expect(parseServersDoc(wrapDoc(servers))).toEqual(servers)
  })

  it('finds each server block, tolerating a document mid-edit', () => {
    const text = wrapDoc({ one: { command: 'a', args: ['{"}'] }, two: { url: 'https://x' } })
    const blocks = scanServerBlocks(text)

    expect(blocks.map(block => block.name)).toEqual(['one', 'two'])
    expect(text.slice(blocks[1].from, blocks[1].to)).toBe('"two": {\n      "url": "https://x"\n    }')
    // Mid-edit: the block being typed runs to the end of the text, so the
    // cursor inside it still belongs to it.
    const partial = '{"mcpServers": {"one": {"command": "a"}, "two": {"url": '
    const found = scanServerBlocks(partial)
    expect(found.map(block => block.name)).toEqual(['one', 'two'])
    expect(found[1].to).toBe(partial.length)
  })

  it('saves the person’s edits over the config as it is now, never over work that landed meanwhile', () => {
    const base = { a: { command: 'a' }, b: { url: 'https://b' }, c: { command: 'c' }, gone: { command: 'g' } }
    // In the editor: edited `a`, removed `c`, added `mine`; `b` and `gone` untouched.
    const mine = { a: { command: 'a2' }, b: { url: 'https://b' }, gone: { command: 'g' }, mine: { command: 'm' } }

    // On disk meanwhile: `b` signed in, `a` changed by the hub, `new` installed, `gone` removed.
    const theirs = {
      a: { command: 'a-hub' },
      b: { url: 'https://b', auth: 'oauth' },
      c: { command: 'c' },
      new: { url: 'https://new' }
    }

    const merged = mergeServers(base, mine, theirs)

    expect(merged).toEqual({
      a: { command: 'a2' }, // edited here: the person's version
      b: { url: 'https://b', auth: 'oauth' }, // untouched: disk's, with the sign-in
      mine: { command: 'm' }, // added here
      new: { url: 'https://new' } // installed meanwhile: kept
    })
    // Removed here (`c`) and removed on disk (`gone`) both stay removed; the draft's order leads.
    expect(Object.keys(merged)).toEqual(['a', 'b', 'mine', 'new'])
  })

  it('adds a starter entry under the first free key', () => {
    expect(withStarterEntry({}).key).toBe('my-server')
    const next = withStarterEntry({ 'my-server': {}, 'my-server-2': {} })
    expect(next.key).toBe('my-server-3')
    expect(Object.keys(next.entries)).toEqual(['my-server', 'my-server-2', 'my-server-3'])
  })

  it('switches a server off with `enabled: false` and on by dropping the key', () => {
    expect(withEnabled({ command: 'x' }, false)).toEqual({ command: 'x', enabled: false })
    expect(withEnabled({ command: 'x', enabled: false }, true)).toEqual({ command: 'x' })
  })
})

describe('what a connection is doing', () => {
  it('reads off, checking, working, needs sign-in and failed', () => {
    expect(statusOf({ enabled: false }, { ok: true, tools: [] })).toBe('off')
    expect(statusOf({}, 'probing')).toBe('probing')
    expect(statusOf({}, undefined)).toBe('unknown')
    expect(statusOf({}, { ok: true, tools: [] })).toBe('ok')
    expect(statusOf({}, { ok: false, error: 'HTTP 401 Unauthorized', tools: [] })).toBe('needs-auth')
    expect(statusOf({}, { ok: false, error: 'spawn npx ENOENT', tools: [] })).toBe('error')
  })

  it('offers the browser sign-in only to OAuth-shaped remote servers', () => {
    expect(canAuthenticate({ url: 'https://x', auth: 'oauth' }, 'error')).toBe(true)
    expect(canAuthenticate({ url: 'https://x' }, 'needs-auth')).toBe(true)
    expect(canAuthenticate({ url: 'https://x' }, 'error')).toBe(false)
    // A key in the headers was refused: that is a bad key, not a sign-in.
    expect(canAuthenticate({ url: 'https://x', headers: { Authorization: 'Bearer k' } }, 'needs-auth')).toBe(false)
    expect(canAuthenticate({ command: 'npx' }, 'needs-auth')).toBe(false)
  })
})

describe('naming and describing a connection', () => {
  it('reads a config key as a name', () => {
    expect(serverTitle('my-server')).toBe('My Server')
    expect(serverTitle('ghi_chu')).toBe('Ghi Chu')
  })

  it('says a hand-added connection was added by hand, and where it runs', () => {
    expect(customDescription({ command: 'npx' }, m)).toBe(m.customLocal)
    expect(customDescription({ url: 'http://127.0.0.1:8000/mcp' }, m)).toBe(m.customLocal)
    expect(customDescription({ url: 'https://mcp.example.com/mcp' }, m)).toBe(m.customAt('mcp.example.com'))
    expect(customDescription({ url: 'not a url' }, m)).toBe(m.customRemote)
  })

  it('matches a catalog entry by install, name or URL — never by a shared launcher', () => {
    const shipped = [
      entry(),
      entry({ name: 'figma', url: 'https://mcp.figma.com/mcp', id: 'figma' }),
      entry({ name: 'hubby', command: 'npx', url: null, origin: 'hub', id: 'agentx-hub/hubby' })
    ]

    expect(catalogMatchFor('linear', { url: 'x' }, shipped)?.name).toBe('linear')
    expect(catalogMatchFor('my-figma', { url: 'https://mcp.figma.com/mcp' }, shipped)?.name).toBe('figma')
    // Another npx server is not "hubby" just because both start with npx.
    expect(catalogMatchFor('notes', { command: 'npx', args: ['-y', 'notes'] }, shipped)).toBeNull()
  })

  it('resolves source, title and description once for a card and its dialog', () => {
    const catalog = [
      entry({ installed: true, enabled: true }),
      entry({
        name: 'tracker-hub',
        origin: 'hub',
        id: 'agentx-hub/tracker-hub',
        slug: 'tracker-hub',
        installed: true,
        description: 'Issues from the hub.'
      })
    ]

    const view = (name: string, server: Record<string, unknown>, endpoints: McpGatewayEndpoint[] = []) =>
      describeServer({ endpoints, entries: catalog, name, probe: undefined, server, t: en })

    const shipped = view('linear', { url: 'https://mcp.linear.app/mcp', auth: 'oauth' })
    expect(shipped).toMatchObject({ source: 'shipped', title: 'Linear', status: 'unknown' })
    expect(shipped.description).toBe(en.settings.mcp.catalogCopy.linear.description)

    const hub = view('tracker-hub', { command: 'npx' })
    expect(hub).toMatchObject({ source: 'hub', title: 'Tracker Hub', description: 'Issues from the hub.' })
    expect(hub.hubEntry?.slug).toBe('tracker-hub')

    const gateway = view('agentx-tracker', { url: 'https://hub.test/gw/s/tracker' }, [
      endpoint({ added: 'agentx-tracker' })
    ])

    expect(gateway).toMatchObject({ source: 'gateway', title: 'Tracker', description: m.gatewayServerDesc })

    const custom = view('ghi-chu', { command: '/usr/bin/python3', enabled: false })
    expect(custom).toMatchObject({ source: 'custom', title: 'Ghi Chu', status: 'off', description: m.customLocal })
  })

  it('names a hub server as the hub does, not by the slug it runs by (a slug can carry its publisher’s name)', () => {
    const named = entry({
      name: 'crm-noi-bo-tacgia-c',
      origin: 'hub',
      id: 'agentx-hub/crm-noi-bo-tacgia-c',
      slug: 'crm-noi-bo-tacgia-c',
      installed: true,
      title: 'CRM nội bộ (gói)'
    })

    const unnamed = entry({
      name: 'untitled-hub',
      origin: 'hub',
      id: 'agentx-hub/untitled-hub',
      slug: 'untitled-hub',
      installed: true,
      title: null
    })

    const view = (name: string) =>
      describeServer({
        endpoints: [],
        entries: [named, unnamed],
        name,
        probe: undefined,
        server: { command: 'npx' },
        t: en
      })

    expect(view('crm-noi-bo-tacgia-c').title).toBe('CRM nội bộ (gói)')
    expect(catalogTitle(named, en)).toBe('CRM nội bộ (gói)')
    // A hub that sends no name: the slug as words, as before.
    expect(view('untitled-hub').title).toBe('Untitled Hub')
    expect(catalogTitle(unnamed, en)).toBe('Untitled Hub')
  })
})

describe('logs and the gateway', () => {
  it('keeps only one server’s sections of the shared stdio log', () => {
    const lines = [
      "===== [10:00] starting MCP server 'a' =====",
      'a says hi',
      "===== [10:01] starting MCP server 'b' =====",
      'b says hi',
      "===== [10:02] starting MCP server 'a' =====",
      'a again'
    ]

    expect(filterStdioSections(lines, 'a')).toEqual([lines[0], lines[1], lines[4], lines[5]])
  })

  it('asks for a new sign-in only when the gateway entries here stopped working', () => {
    const listing = (overrides: Partial<McpGatewayListing>): McpGatewayListing => ({
      available: true,
      reason: null,
      endpoints: [],
      session: true,
      device: { entries: 1, token: true, expires_at: null, days_left: 0, state: 'expired' },
      ...overrides
    })

    // The session renews an expired token by itself.
    expect(gatewayNeedsSignIn(listing({}))).toBe(false)
    expect(gatewayNeedsSignIn(listing({ session: false }))).toBe(true)
    expect(gatewayNeedsSignIn(listing({ reason: 'reauth' }))).toBe(true)
    // Nothing added here: nothing is broken.
    expect(
      gatewayNeedsSignIn(
        listing({
          session: false,
          device: { entries: 0, token: false, expires_at: null, days_left: null, state: 'none' }
        })
      )
    ).toBe(false)
    expect(gatewayNeedsSignIn(undefined)).toBe(false)
  })
})
