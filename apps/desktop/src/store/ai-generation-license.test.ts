import { JsonRpcError } from '@agentx/shared'
import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopLicense } from '@/global'
import { FALLBACK_LOCALE, TRANSLATIONS } from '@/i18n'
import { setRuntimeI18nLocale } from '@/i18n/runtime'
import { licenseReadOnlyMessage } from '@/lib/license'

// Generations started from the UI outside the chat — a project idea, a pet —
// stop with the license's reason while the AgentX license is read-only, and
// a refusal the backend answered (the license turned read-only meanwhile)
// reads the same and locks the UI.

const notifySpy = vi.fn()
const request = vi.fn()

vi.mock('@/store/notifications', () => ({
  notify: (...args: unknown[]) => notifySpy(...args),
  notifyError: vi.fn()
}))
vi.mock('@/store/native-notifications', () => ({ dispatchNativeNotification: vi.fn() }))
vi.mock('@/store/gateway', () => ({
  $gateway: atom(null),
  activeGateway: () => ({ connectionState: 'open', request: (...args: unknown[]) => request(...args) }),
  ensureActiveGatewayOpen: vi.fn()
}))
vi.mock('@/hermes', () => ({
  getHermesConfig: vi.fn(),
  getProfiles: vi.fn(),
  setApiRequestProfile: vi.fn(),
  STARTUP_REQUEST_TIMEOUT_MS: 1000
}))
vi.mock('@/lib/desktop-fs', () => ({
  desktopDefaultCwd: vi.fn(),
  isDesktopFsRemoteMode: vi.fn(),
  selectDesktopPaths: vi.fn(),
  writeDesktopFileText: vi.fn()
}))
vi.mock('@/lib/desktop-git', () => ({ desktopGit: vi.fn() }))

const { $license, $licenseReadOnly } = await import('./license')
const { generateProjectIdea } = await import('./projects')

const { $petGenError, $petGenPreview, $petGenSelected, $petGenStatus, $petGenToken, generateDrafts, hatchSelected } =
  await import('./pet-generate')

const READ_ONLY: DesktopLicense = {
  access: 'read_only',
  contact: 'it@astralx.com.vn',
  enforced: true,
  notice: 'read_only',
  plan: { name: 'Pilot 2026', slug: 'pilot-2026' },
  state: 'revoked'
}

const ACTIVE: DesktopLicense = { ...READ_ONLY, access: 'full', notice: null, state: 'active' }

const REASON = licenseReadOnlyMessage(READ_ONLY, TRANSLATIONS.en.license)

function useLicense(license: DesktopLicense | null) {
  $license.set({ account: 'kien', available: true, checking: false, lastCheck: null, license, loaded: true })
}

function backendRefusal() {
  return new JsonRpcError({
    code: 4403,
    data: { code: 'license_read_only', license: READ_ONLY },
    message: 'read-only (backend wording)'
  })
}

const original = window.agentxDesktop

beforeEach(() => {
  setRuntimeI18nLocale('en')
  notifySpy.mockReset()
  request.mockReset()
  $petGenError.set(null)
  $petGenStatus.set('idle')
  $petGenPreview.set(null)
  // Re-reading the license after a refusal goes through the preload bridge.
  Object.defineProperty(window, 'agentxDesktop', {
    configurable: true,
    value: { license: { get: async () => ({ account: 'kien', detail: '', license: READ_ONLY, status: 'cached' }) } }
  })
})

afterEach(() => {
  Object.defineProperty(window, 'agentxDesktop', { configurable: true, value: original })
  useLicense(null)
  setRuntimeI18nLocale(FALLBACK_LOCALE)
})

describe('a project idea', () => {
  it('is not asked for while read-only', async () => {
    useLicense(READ_ONLY)

    await expect(generateProjectIdea('Atlas')).resolves.toBe('')
    expect(request).not.toHaveBeenCalled()
  })

  it('a refusal on the way says why and locks the UI; other failures stay quiet', async () => {
    useLicense(ACTIVE)
    request.mockRejectedValueOnce(backendRefusal())

    await expect(generateProjectIdea('Atlas')).resolves.toBe('')

    expect(notifySpy).toHaveBeenCalledWith(expect.objectContaining({ kind: 'warning', message: REASON }))
    expect($licenseReadOnly.get()).toBe(true)

    useLicense(ACTIVE)
    notifySpy.mockReset()
    request.mockRejectedValueOnce(new Error('model overloaded'))

    await expect(generateProjectIdea('Atlas')).resolves.toBe('')
    expect(notifySpy).not.toHaveBeenCalled()
  })
})

describe('a pet', () => {
  it('drafts are not generated while read-only, and the current preview is kept', async () => {
    useLicense(READ_ONLY)
    $petGenPreview.set({ slug: 'kept' } as never)

    await expect(generateDrafts(request, { prompt: 'a small fox' })).resolves.toBe(false)

    expect(request).not.toHaveBeenCalled()
    expect($petGenStatus.get()).toBe('error')
    expect($petGenError.get()).toBe(REASON)
    expect($petGenPreview.get()).toEqual({ slug: 'kept' })
  })

  it('a draft is not hatched while read-only', async () => {
    useLicense(READ_ONLY)
    $petGenToken.set('t1')
    $petGenSelected.set(0)

    await expect(hatchSelected(request, { name: 'Fox' })).resolves.toBe(false)

    expect(request).not.toHaveBeenCalled()
    expect($petGenError.get()).toBe(REASON)
  })

  it("a refusal on the way reads in this app's words and locks the UI", async () => {
    useLicense(ACTIVE)
    request.mockRejectedValueOnce(backendRefusal())

    await expect(generateDrafts(request, { prompt: 'a small fox' })).resolves.toBe(false)

    expect($petGenError.get()).toBe(REASON)
    expect($licenseReadOnly.get()).toBe(true)
  })
})
