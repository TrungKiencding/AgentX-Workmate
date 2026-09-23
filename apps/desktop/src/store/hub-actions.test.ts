import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as HermesApi from '@/hermes'
import { queryClient } from '@/lib/query-client'
import type { SkillHubCatalogResponse } from '@/types/hermes'

const getActionStatus = vi.fn()
const installSkillFromHub = vi.fn()
const tickSkillHub = vi.fn()
const uninstallSkillFromHub = vi.fn()

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<typeof HermesApi>()),
  getActionStatus: (name: string) => getActionStatus(name),
  installSkillFromHub: (identifier: string) => installSkillFromHub(identifier),
  tickSkillHub: () => tickSkillHub(),
  uninstallSkillFromHub: (name: string) => uninstallSkillFromHub(name)
}))

import { $hubInstalledOverride, HUB_CATALOG_KEY, installHubSkill, uninstallHubSkill } from '@/store/hub-actions'

const REPORT = 'agentx-hub/vneb-report'

// The catalogue as the backend answers after the action: it read the
// installed map as it answered, so the action is already in it.
const CATALOG: SkillHubCatalogResponse = {
  skills: [],
  installed: {},
  fetched_at: 1_780_000_000,
  stale: false,
  authenticated: false,
  hub_url: 'https://skills.astralx.com.vn',
  error: ''
}

beforeEach(() => {
  installSkillFromHub.mockResolvedValue({ ok: true, pid: 1, name: 'skills-install-vneb-report' })
  uninstallSkillFromHub.mockResolvedValue({ ok: true, pid: 2, name: 'skills-uninstall-vneb-report' })
  getActionStatus.mockResolvedValue({ name: 'skills-install-vneb-report', running: false, exit_code: 0, lines: [] })
  tickSkillHub.mockResolvedValue({ status: 'signed_out', detail: '' })
})

afterEach(() => {
  vi.clearAllMocks()
  queryClient.clear()
  $hubInstalledOverride.set({})
})

describe('the optimistic installed flip', () => {
  it('stands until the catalogue answers — not through another query or a failed refetch', async () => {
    await installHubSkill(REPORT)
    expect($hubInstalledOverride.get()).toEqual({ [REPORT]: true })

    // The skills list answering is not the catalogue answering…
    queryClient.setQueryData(['skills-list'], [])
    // …and a catalogue refetch that fails leaves the flip as the best knowledge.
    await expect(
      queryClient.fetchQuery({ queryKey: HUB_CATALOG_KEY, queryFn: () => Promise.reject(new Error('offline')) })
    ).rejects.toThrow('offline')
    expect($hubInstalledOverride.get()).toEqual({ [REPORT]: true })

    // The catalogue's answer takes over.
    await queryClient.fetchQuery({ queryKey: HUB_CATALOG_KEY, queryFn: async () => CATALOG })
    expect($hubInstalledOverride.get()).toEqual({})
  })

  it('gives way to the answer "Sync now" writes into the catalogue too', async () => {
    await uninstallHubSkill(REPORT, 'vneb-report')
    expect($hubInstalledOverride.get()).toEqual({ [REPORT]: false })

    queryClient.setQueryData(HUB_CATALOG_KEY, CATALOG)
    expect($hubInstalledOverride.get()).toEqual({})
  })
})
