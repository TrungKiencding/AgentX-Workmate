import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $petInfo, setPetInfo } from './pet'
import {
  $petCatalogStatus,
  $petGallery,
  $petGalleryStatus,
  adoptPet,
  type GatewayRequest,
  loadPetGallery,
  resetPetGallery
} from './pet-gallery'

function localGallery() {
  return {
    enabled: true,
    active: 'boba',
    pets: [{ slug: 'boba', displayName: 'Boba', installed: true }]
  }
}

describe('pet gallery pet.info sync', () => {
  beforeEach(() => {
    resetPetGallery()
    setPetInfo({ enabled: false })
  })

  afterEach(() => {
    resetPetGallery()
    setPetInfo({ enabled: false })
    vi.restoreAllMocks()
  })

  it('uses pet.info.meta and keeps the cached spritesheet when the revision is current', async () => {
    setPetInfo({
      enabled: true,
      slug: 'boba',
      displayName: 'Old Boba',
      scale: 0.33,
      spritesheetBase64: 'large-sprite-payload',
      spritesheetRevision: '100:2048',
      frameW: 192,
      frameH: 208
    })

    const requestMock = vi.fn(async (method: string) => {
      if (method === 'pet.gallery') {
        return localGallery()
      }

      if (method === 'pet.info.meta') {
        return {
          enabled: true,
          slug: 'boba',
          displayName: 'Boba',
          scale: 0.5,
          spritesheetRevision: '100:2048'
        }
      }

      if (method === 'pet.info') {
        throw new Error('full pet.info should not be called for an unchanged sprite')
      }

      throw new Error(`unexpected method: ${method}`)
    })

    const request = requestMock as unknown as GatewayRequest

    await loadPetGallery(request)

    const methods = requestMock.mock.calls.map(([method]) => method)
    expect(methods).toContain('pet.info.meta')
    expect(methods).not.toContain('pet.info')
    expect($petInfo.get()).toMatchObject({
      enabled: true,
      slug: 'boba',
      displayName: 'Boba',
      scale: 0.5,
      spritesheetBase64: 'large-sprite-payload',
      spritesheetRevision: '100:2048',
      frameW: 192,
      frameH: 208
    })
  })

  it('fetches full pet.info when metadata reports a new spritesheet revision', async () => {
    setPetInfo({
      enabled: true,
      slug: 'boba',
      displayName: 'Boba',
      scale: 0.33,
      spritesheetBase64: 'old-sprite-payload',
      spritesheetRevision: '100:2048'
    })

    const requestMock = vi.fn(async (method: string) => {
      if (method === 'pet.gallery') {
        return localGallery()
      }

      if (method === 'pet.info.meta') {
        return {
          enabled: true,
          slug: 'boba',
          displayName: 'Boba',
          scale: 0.33,
          spritesheetRevision: '101:4096'
        }
      }

      if (method === 'pet.info') {
        return {
          enabled: true,
          slug: 'boba',
          displayName: 'Boba',
          scale: 0.33,
          spritesheetBase64: 'new-sprite-payload',
          spritesheetRevision: '101:4096'
        }
      }

      throw new Error(`unexpected method: ${method}`)
    })

    const request = requestMock as unknown as GatewayRequest

    await loadPetGallery(request)

    const methods = requestMock.mock.calls.map(([method]) => method)
    expect(methods).toContain('pet.info.meta')
    expect(methods).toContain('pet.info')
    expect($petInfo.get().spritesheetBase64).toBe('new-sprite-payload')
    expect($petInfo.get().spritesheetRevision).toBe('101:4096')
  })

  it('falls back to full pet.info when an older gateway lacks metadata', async () => {
    const requestMock = vi.fn(async (method: string) => {
      if (method === 'pet.gallery') {
        return localGallery()
      }

      if (method === 'pet.info.meta') {
        throw new Error('JSON-RPC -32601: Method not found')
      }

      if (method === 'pet.info') {
        return {
          enabled: true,
          slug: 'boba',
          displayName: 'Boba from legacy gateway',
          scale: 0.4,
          spritesheetBase64: 'legacy-full-payload',
          spritesheetRevision: '99:1024'
        }
      }

      throw new Error(`unexpected method: ${method}`)
    })

    const request = requestMock as unknown as GatewayRequest

    await loadPetGallery(request)

    const methods = requestMock.mock.calls.map(([method]) => method)
    expect(methods).toContain('pet.info.meta')
    expect(methods).toContain('pet.info')
    expect($petInfo.get()).toMatchObject({
      enabled: true,
      slug: 'boba',
      displayName: 'Boba from legacy gateway',
      spritesheetBase64: 'legacy-full-payload',
      spritesheetRevision: '99:1024'
    })
  })

  it('keeps mutation sync on metadata when the selected pet sprite is unchanged', async () => {
    $petGallery.set(localGallery())
    setPetInfo({
      enabled: true,
      slug: 'boba',
      displayName: 'Boba',
      scale: 0.33,
      spritesheetBase64: 'large-sprite-payload',
      spritesheetRevision: '100:2048'
    })

    const requestMock = vi.fn(async (method: string) => {
      if (method === 'pet.select') {
        return { ok: true, slug: 'boba', displayName: 'Boba' }
      }

      if (method === 'pet.info.meta') {
        return {
          enabled: true,
          slug: 'boba',
          displayName: 'Boba',
          scale: 0.33,
          spritesheetRevision: '100:2048'
        }
      }

      if (method === 'pet.info') {
        throw new Error('full pet.info should not be called after an unchanged select')
      }

      throw new Error(`unexpected method: ${method}`)
    })

    const request = requestMock as unknown as GatewayRequest

    await expect(adoptPet(request, 'boba', 'Could not adopt pet.')).resolves.toBe(true)

    const methods = requestMock.mock.calls.map(([method]) => method)
    expect(methods).toEqual(['pet.select', 'pet.info.meta'])
    expect($petInfo.get().spritesheetBase64).toBe('large-sprite-payload')
  })
})

// 2026-11 pilot: Settings → Thú cưng showed "couldn't reach petdex" on a fresh
// install and nothing the user did brought the list back. Local pets load first
// and were an empty list; that empty snapshot counted as the finished gallery.
describe('pet gallery petdex catalog', () => {
  const CATALOG_PET = {
    slug: 'boba',
    displayName: 'Boba',
    installed: false,
    spritesheetUrl: 'https://assets.petdex.dev/curated/boba/spritesheet.webp'
  }

  beforeEach(() => {
    resetPetGallery()
    setPetInfo({ enabled: false })
  })

  afterEach(() => {
    resetPetGallery()
    setPetInfo({ enabled: false })
  })

  function gateway(catalog: () => Promise<unknown>) {
    const calls: { method: string; params?: Record<string, unknown>; timeoutMs?: number }[] = []

    const request = (async (method: string, params?: Record<string, unknown>, timeoutMs?: number) => {
      calls.push({ method, params, timeoutMs })

      if (method === 'pet.info.meta') {
        return { enabled: false }
      }

      if (method === 'pet.gallery') {
        return params?.localOnly ? { enabled: false, active: '', pets: [], catalog: 'skipped' } : catalog()
      }

      throw new Error(`unexpected method: ${method}`)
    }) as unknown as GatewayRequest

    return { calls, request }
  }

  it('reports the catalog as loading — not unreachable — while only the empty local list has arrived', async () => {
    let release: (value: unknown) => void = () => undefined
    const { request } = gateway(() => new Promise(resolve => (release = resolve)))

    const load = loadPetGallery(request)
    await vi.waitFor(() => expect($petGalleryStatus.get()).toBe('ready'))

    expect($petGallery.get()?.pets).toEqual([])
    expect($petCatalogStatus.get()).toBe('loading')

    release({ enabled: false, active: '', pets: [CATALOG_PET], catalog: 'ok' })
    await load

    expect($petCatalogStatus.get()).toBe('ready')
    expect($petGallery.get()?.pets).toEqual([CATALOG_PET])
  })

  it('marks the catalog failed when the backend could not reach petdex, and retries on the next load', async () => {
    let reachable = false

    const { calls, request } = gateway(async () =>
      reachable
        ? { enabled: false, active: '', pets: [CATALOG_PET], catalog: 'ok' }
        : { enabled: false, active: '', pets: [], catalog: 'unreachable' }
    )

    await loadPetGallery(request)
    expect($petCatalogStatus.get()).toBe('error')
    expect($petGallery.get()?.pets).toEqual([])

    // Reopening the picker (or pressing "Try again") is a plain load — it must
    // ask for the catalog again rather than trust the empty snapshot.
    reachable = true
    await loadPetGallery(request)

    expect($petCatalogStatus.get()).toBe('ready')
    expect($petGallery.get()?.pets).toEqual([CATALOG_PET])
    expect(calls.filter(call => call.method === 'pet.gallery' && !call.params?.localOnly)).toHaveLength(2)
  })

  it('marks the catalog failed when the catalog request itself fails', async () => {
    const { request } = gateway(async () => {
      throw new Error('request timed out: pet.gallery')
    })

    await loadPetGallery(request)

    expect($petGalleryStatus.get()).toBe('ready')
    expect($petCatalogStatus.get()).toBe('error')
  })

  it('reads an outage from a backend that predates the catalog field', async () => {
    const installed = { slug: 'mine', displayName: 'Mine', installed: true, spritesheetUrl: '' }
    const { request } = gateway(async () => ({ enabled: false, active: '', pets: [installed] }))

    await loadPetGallery(request)
    expect($petCatalogStatus.get()).toBe('error')

    const { request: healthy } = gateway(async () => ({ enabled: false, active: '', pets: [CATALOG_PET] }))

    await loadPetGallery(healthy)
    expect($petCatalogStatus.get()).toBe('ready')
  })

  it('does not refetch once the catalog is held', async () => {
    const { calls, request } = gateway(async () => ({ enabled: false, active: '', pets: [CATALOG_PET], catalog: 'ok' }))

    await loadPetGallery(request)
    const before = calls.length
    await loadPetGallery(request)

    expect(calls).toHaveLength(before)
  })

  it('gives the catalog request more than the default RPC timeout', async () => {
    const { calls, request } = gateway(async () => ({ enabled: false, active: '', pets: [CATALOG_PET], catalog: 'ok' }))

    await loadPetGallery(request)

    const catalogCall = calls.find(call => call.method === 'pet.gallery' && !call.params?.localOnly)
    expect(catalogCall?.timeoutMs).toBeGreaterThan(30_000)
  })

  it('keeps the merged catalog on screen while a retry runs', async () => {
    let release: ((value: unknown) => void) | null = null
    let first = true

    const { request } = gateway(() => {
      if (first) {
        first = false

        return Promise.resolve({ enabled: false, active: '', pets: [CATALOG_PET], catalog: 'ok' })
      }

      return new Promise(resolve => (release = resolve))
    })

    await loadPetGallery(request)
    const retry = loadPetGallery(request, { force: true })

    // The local-only answer (an empty list) has landed and the catalog request
    // is in flight: the list on screen must still be the merged one.
    await vi.waitFor(() => expect(release).not.toBeNull())
    expect($petCatalogStatus.get()).toBe('loading')
    expect($petGallery.get()?.pets).toEqual([CATALOG_PET])

    release!({ enabled: false, active: '', pets: [CATALOG_PET], catalog: 'ok' })
    await retry
    expect($petCatalogStatus.get()).toBe('ready')
  })
})
