// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { McpGatewayListing } from './mcp-tab'

// The MCP tab's AgentX Gateway section (Agent Hub P5.8): the person's gateway
// endpoints on the hub, each added to Workmate in one click — this machine's
// token and the entry come from the local backend (`/api/mcp/gateway*`) — and
// what stands in the way said in words: signed out, the gateway closed, the
// token lapsed with nothing here to renew it ("open Workmate to sign in again").

const notify = vi.fn()
const notifyError = vi.fn()

vi.mock('@/store/notifications', () => ({
  notify: (...args: unknown[]) => notify(...args),
  notifyError: (...args: unknown[]) => notifyError(...args)
}))

const api = vi.fn()

function listing(overrides: Partial<McpGatewayListing> = {}): McpGatewayListing {
  return {
    available: true,
    reason: null,
    session: true,
    endpoints: [
      {
        kind: 'server',
        ref: 'tracker',
        label: 'Tracker',
        url: 'https://hub.test/gw/s/tracker',
        status: 'ready',
        tools: 4,
        added: null
      },
      {
        kind: 'toolset',
        ref: 'ts_abcdefghij',
        label: 'Dự án',
        url: 'https://hub.test/gw/t/ts_abcdefghij',
        status: 'needs_connection',
        tools: 0,
        added: null
      }
    ],
    device: { entries: 0, token: false, expires_at: null, days_left: null, state: 'none' },
    ...overrides
  }
}

async function renderGateway(profile = 'default') {
  const { GatewayEndpoints } = await import('./mcp-tab')
  const onAdded = vi.fn()
  await act(async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <GatewayEndpoints onAdded={onAdded} profile={profile} />
      </QueryClientProvider>
    )
  })

  return { onAdded }
}

beforeEach(() => {
  Object.assign(window, { agentxDesktop: { ...(window as { agentxDesktop?: object }).agentxDesktop, api } })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('McpTab — AgentX Gateway', () => {
  it('lists my endpoints and adds one to Workmate in a click', async () => {
    let added: null | string = null
    api.mockImplementation(async (request: { path: string; method?: string; body?: unknown }) => {
      if (request.path === '/api/mcp/gateway') {
        return listing({
          endpoints: listing().endpoints.map(e => (e.ref === 'tracker' ? { ...e, added } : e)),
          device: added
            ? { entries: 1, token: true, expires_at: '2026-12-24T00:00:00Z', days_left: 89, state: 'ok' }
            : listing().device
        })
      }

      if (request.path === '/api/mcp/gateway/add') {
        added = 'agentx-tracker'

        return { ok: true, name: 'agentx-tracker', url: 'https://hub.test/gw/s/tracker' }
      }

      throw new Error(`unexpected ${request.path}`)
    })
    const { onAdded } = await renderGateway()
    const rows = await screen.findAllByTestId('mcp-gateway-endpoint')
    expect(rows.map(row => row.getAttribute('data-ref'))).toEqual(['tracker', 'ts_abcdefghij'])
    expect(within(rows[0]).getByText('Ready · 4 tools')).toBeTruthy()
    expect(within(rows[1]).getByText('Connect it on the hub')).toBeTruthy()
    expect(within(rows[1]).getByText('Toolset')).toBeTruthy()
    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Add to Workmate' }))
    await waitFor(() => expect(onAdded).toHaveBeenCalled())
    expect(api).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/api/mcp/gateway/add',
        method: 'POST',
        body: { kind: 'server', ref: 'tracker' }
      })
    )
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'success', title: 'Tracker added through the gateway' })
    )
    await waitFor(() =>
      expect(within(screen.getAllByTestId('mcp-gateway-endpoint')[0]).getByText('Added')).toBeTruthy()
    )
    expect(screen.getByTestId('mcp-gateway-token').textContent).toContain('89 more days')
  })

  it('says to open Workmate and sign in again when the token lapsed and nothing here renews it', async () => {
    api.mockResolvedValue(
      listing({
        session: false,
        device: { entries: 1, token: true, expires_at: '2026-09-01T00:00:00Z', days_left: 0, state: 'expired' }
      })
    )
    await renderGateway()
    expect((await screen.findByTestId('mcp-gateway-signin')).textContent).toBe(
      'Open Workmate to sign in again: the gateway token of this machine has expired.'
    )
    expect(screen.queryByTestId('mcp-gateway-token')).toBeNull()
  })

  it('says why a refused add did not happen', async () => {
    api.mockImplementation(async (request: { path: string }) =>
      request.path === '/api/mcp/gateway'
        ? listing()
        : {
            ok: false,
            status: 'sign_in',
            code: 'sign_in_required',
            detail: 'the hub gives a gateway token to a signed-in session only'
          }
    )
    const { onAdded } = await renderGateway()
    fireEvent.click(
      within((await screen.findAllByTestId('mcp-gateway-endpoint'))[0]).getByRole('button', { name: 'Add to Workmate' })
    )
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'error', title: expect.stringContaining('sign in again') })
      )
    )
    expect(onAdded).not.toHaveBeenCalled()
  })

  it('says the hub is out of reach, signed out, or its gateway closed — and stays away from other profiles', async () => {
    api.mockResolvedValue(listing({ available: false, reason: 'offline', endpoints: [] }))
    await renderGateway()
    expect(await screen.findByTestId('mcp-gateway-offline')).toBeTruthy()
    cleanup()
    api.mockResolvedValue(listing({ available: false, reason: 'signed_out', endpoints: [] }))
    await renderGateway()
    expect((await screen.findByTestId('mcp-gateway-unavailable')).textContent).toContain('Sign in to AgentX Hub')
    cleanup()
    api.mockResolvedValue(listing({ available: false, reason: 'gateway_off', endpoints: [] }))
    await renderGateway()
    expect((await screen.findByTestId('mcp-gateway-unavailable')).textContent).toBe(
      'The gateway is not open on this hub.'
    )
    cleanup()
    api.mockClear()
    await renderGateway('work')
    expect(screen.queryByTestId('mcp-gateway')).toBeNull()
  })
})
