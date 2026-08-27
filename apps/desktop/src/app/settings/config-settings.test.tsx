import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, waitFor } from '@testing-library/react'
import { atom } from 'nanostores'
import { act, StrictMode } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HermesConfigRecord } from '@/types/hermes'

// The draft is seeded from the shared config query. These tests pin HOW that
// seeding survives a profile switch — the page used to sit on its skeleton
// forever once the draft was dropped (see the effect in config-settings.tsx).

const $activeGatewayProfile = atom('default')
const getHermesConfigRecord = vi.fn()
const getHermesConfigSchema = vi.fn()

vi.mock('@/store/profile', () => ({ $activeGatewayProfile }))

vi.mock('@/hermes', () => ({
  getElevenLabsVoices: () => Promise.resolve({ available: false, voices: [] }),
  getHermesConfigRecord: () => getHermesConfigRecord(),
  getHermesConfigSchema: () => getHermesConfigSchema(),
  saveHermesConfig: () => Promise.resolve({ ok: true })
}))

vi.mock('@/store/projects', () => ({
  repoDiscoveryPolicyFromConfig: () => ({}),
  repoDiscoveryPolicySignature: () => 'signature',
  scanAndRecordRepos: vi.fn()
}))

// Heavy siblings the workspace section never renders — stubbed so the test
// exercises the seeding path, not their own fetch chains.
vi.mock('./model-settings', () => ({
  ModelSettings: () => null,
  ModelSettingsSkeleton: () => null
}))

vi.mock('./memory/connect', () => ({ MemoryConnect: () => null }))
vi.mock('./memory/provider-config-panel', () => ({ ProviderConfigPanel: () => null }))

const { ConfigSettings } = await import('./config-settings')

const configFor = (cwd: string): HermesConfigRecord => ({ terminal: { cwd } }) as unknown as HermesConfigRecord

const SCHEMA = { fields: { 'terminal.cwd': { category: 'workspace', type: 'string' } } }

function renderWorkspace() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  const view = render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <ConfigSettings activeSectionId="workspace" importInputRef={{ current: null }} />
      </QueryClientProvider>
    </MemoryRouter>
  )

  return { ...view, client }
}

const skeletonCount = (container: HTMLElement) => container.querySelectorAll('.animate-pulse').length

const cwdInput = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('input')).find(input => input.value.startsWith('/tmp/'))

beforeEach(() => {
  $activeGatewayProfile.set('default')
  getHermesConfigSchema.mockResolvedValue(SCHEMA)
  getHermesConfigRecord.mockResolvedValue(configFor('/tmp/profile-a'))
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ConfigSettings draft seeding', () => {
  it('seeds the draft from the loaded record', async () => {
    const { container } = renderWorkspace()

    await waitFor(() => expect(cwdInput(container)?.value).toBe('/tmp/profile-a'))
    expect(skeletonCount(container)).toBe(0)
  })

  // StrictMode runs effects setup → cleanup → setup. The page must survive that
  // without any help from a refetch: nothing changed, so nothing is dropped.
  it('survives StrictMode’s simulated remount', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    const { container } = render(
      <StrictMode>
        <MemoryRouter>
          <QueryClientProvider client={client}>
            <ConfigSettings activeSectionId="workspace" importInputRef={{ current: null }} />
          </QueryClientProvider>
        </MemoryRouter>
      </StrictMode>
    )

    await waitFor(() => expect(cwdInput(container)?.value).toBe('/tmp/profile-a'))
    expect(skeletonCount(container)).toBe(0)
  })

  // The production half of the same bug: a switch drops the draft, and the
  // refetch that follows returns data DEEP-EQUAL to what's cached. React
  // Query's structural sharing hands back the identical object, so an
  // identity-keyed seed effect never re-runs — the page stayed on its skeleton
  // forever. Only `dataUpdatedAt` moves, so the seed must key on that.
  it('re-seeds after a profile switch whose refetch returns identical data', async () => {
    const { container, client } = renderWorkspace()

    await waitFor(() => expect(cwdInput(container)?.value).toBe('/tmp/profile-a'))

    const seeded = client.getQueryData(['agentx-config-record'])

    await act(async () => {
      $activeGatewayProfile.set('work')
    })

    // The draft is dropped: the page waits rather than showing profile A's data.
    expect(cwdInput(container)).toBeUndefined()
    expect(skeletonCount(container)).toBeGreaterThan(0)

    // The profile switch invalidates the shared record; this refetch resolves
    // with an equal-but-not-same object, exactly like a same-config profile.
    getHermesConfigRecord.mockResolvedValue(configFor('/tmp/profile-a'))
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['agentx-config-record'] })
    })

    // Structural sharing kept the reference — proving the effect can't rely on it.
    expect(client.getQueryData(['agentx-config-record'])).toBe(seeded)
    await waitFor(() => expect(cwdInput(container)?.value).toBe('/tmp/profile-a'))
    expect(skeletonCount(container)).toBe(0)
  })

  it('re-seeds from the new profile’s data, never from the stale record', async () => {
    const { container, client } = renderWorkspace()

    await waitFor(() => expect(cwdInput(container)?.value).toBe('/tmp/profile-a'))

    getHermesConfigRecord.mockResolvedValue(configFor('/tmp/profile-b'))

    await act(async () => {
      $activeGatewayProfile.set('work')
    })

    // Still profile A in the cache at this instant — the draft must NOT take it.
    expect(cwdInput(container)).toBeUndefined()

    await act(async () => {
      await client.invalidateQueries({ queryKey: ['agentx-config-record'] })
    })

    await waitFor(() => expect(cwdInput(container)?.value).toBe('/tmp/profile-b'))
  })
})
