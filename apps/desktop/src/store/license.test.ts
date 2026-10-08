import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopLicense, DesktopLicenseView } from '@/global'
import { FALLBACK_LOCALE } from '@/i18n'
import { setRuntimeI18nLocale } from '@/i18n/runtime'

const notifySpy = vi.fn()
const notifyErrorSpy = vi.fn()

vi.mock('@/store/notifications', () => ({
  notify: (...args: unknown[]) => notifySpy(...args),
  notifyError: (...args: unknown[]) => notifyErrorSpy(...args)
}))

let secondary = false

vi.mock('@/store/windows', () => ({ isSecondaryWindow: () => secondary }))

const {
  $license,
  $licenseBanner,
  $licenseReadOnly,
  aiBlockedMessage,
  checkLicenseNow,
  ensureAiAllowed,
  licenseCheckFailed,
  LicenseRefusedError,
  licenseRefusalMessage,
  noteLicenseRefusal,
  notifyAiError,
  notifyLicenseRefusal,
  refreshLicense,
  refuseAiAction,
  startLicenseSync
} = await import('./license')

const original = window.agentxDesktop

function license(overrides: Partial<DesktopLicense> = {}): DesktopLicense {
  return {
    access: 'full',
    contact: 'it@astralx.com.vn',
    days_left: 120,
    enforced: true,
    last_day: '2027-05-31',
    notice: null,
    plan: { name: 'Pilot 2026', slug: 'pilot-2026' },
    read_only_from: '2027-06-08',
    reminder: null,
    state: 'active',
    ...overrides
  }
}

const READ_ONLY = license({ access: 'read_only', notice: 'read_only', state: 'expired' })
const EXPIRING = license({ days_left: 7, last_day: '2027-01-31', notice: 'expiring', reminder: 7 })

function view(value: DesktopLicense | null, overrides: Partial<DesktopLicenseView> = {}): DesktopLicenseView {
  return { account: 'kien', detail: '', license: value, status: 'cached', ...overrides }
}

interface BridgeStub {
  get: ReturnType<typeof vi.fn>
  refresh: ReturnType<typeof vi.fn>
  onChanged: ReturnType<typeof vi.fn>
  emit: (next: DesktopLicenseView) => void
}

function stubBridge(answer: DesktopLicenseView = view(null)): BridgeStub {
  let listener: ((next: DesktopLicenseView) => void) | null = null

  const bridge = {
    get: vi.fn(async () => answer),
    onChanged: vi.fn((callback: (next: DesktopLicenseView) => void) => {
      listener = callback

      return () => {
        listener = null
      }
    }),
    refresh: vi.fn(async () => ({ ...answer, status: 'ok' }))
  }

  Object.defineProperty(window, 'agentxDesktop', { configurable: true, value: { license: bridge } })

  return { ...bridge, emit: next => listener?.(next) }
}

beforeEach(() => {
  setRuntimeI18nLocale('vi')
  notifySpy.mockReset()
  notifyErrorSpy.mockReset()
  secondary = false
  window.localStorage.clear()
  $license.set({ account: null, available: false, checking: false, lastCheck: null, license: null, loaded: false })
})

afterEach(() => {
  Object.defineProperty(window, 'agentxDesktop', { configurable: true, value: original })
  setRuntimeI18nLocale(FALLBACK_LOCALE)
})

describe('mirroring the main process', () => {
  it('starts from what the backend knows and follows every change', async () => {
    const bridge = stubBridge(view(license()))

    const stop = startLicenseSync()
    await vi.waitFor(() => expect($license.get().loaded).toBe(true))

    expect($license.get().license?.state).toBe('active')
    expect($licenseReadOnly.get()).toBe(false)

    bridge.emit(view(READ_ONLY))

    expect($licenseReadOnly.get()).toBe(true)
    expect($licenseBanner.get()).toBe('read_only')

    stop()
    bridge.emit(view(license()))
    expect($licenseReadOnly.get()).toBe(true)
  })

  it('a build without the bridge knows nothing and locks nothing', () => {
    Object.defineProperty(window, 'agentxDesktop', { configurable: true, value: {} })

    startLicenseSync()

    expect($license.get()).toMatchObject({ license: null, loaded: true })
    expect($licenseReadOnly.get()).toBe(false)
    expect($licenseBanner.get()).toBeNull()
  })

  it('treats "the backend could not be asked" as no news', async () => {
    // A turn was just refused for the license, but main cannot reach the
    // backend right now and still holds an older, full license.
    stubBridge(view(license(), { status: 'unavailable' }))
    $license.set({ ...$license.get(), license: READ_ONLY, loaded: true })

    await refreshLicense()

    expect($licenseReadOnly.get()).toBe(true)
  })

  it('clears what it knew when somebody signs out', async () => {
    const bridge = stubBridge(view(READ_ONLY))
    const stop = startLicenseSync()
    await vi.waitFor(() => expect($licenseReadOnly.get()).toBe(true))

    bridge.emit(view(null, { account: null, status: 'signed_out' }))
    stop()

    expect($license.get().license).toBeNull()
    expect($licenseReadOnly.get()).toBe(false)
  })

  it('an answer that is not a license is no license', async () => {
    stubBridge(view({ state: 'expired' } as unknown as DesktopLicense))

    await refreshLicense()

    expect($license.get().license).toBeNull()
  })
})

describe('check again', () => {
  it('asks the keys service and reports how it went', async () => {
    const bridge = stubBridge(view(READ_ONLY))

    const pending = checkLicenseNow()

    expect($license.get().checking).toBe(true)

    const state = await pending

    expect(bridge.refresh).toHaveBeenCalledTimes(1)
    expect(state.checking).toBe(false)
    expect(state.lastCheck).toBe('ok')
    expect(licenseCheckFailed(state)).toBe(false)
  })

  it('an unreachable service keeps the license and says the check failed', async () => {
    const bridge = stubBridge(view(READ_ONLY))
    bridge.refresh.mockResolvedValueOnce(view(READ_ONLY, { status: 'offline' }))

    const state = await checkLicenseNow()

    expect(state.license?.state).toBe('expired')
    expect(licenseCheckFailed(state)).toBe(true)
  })

  it('a bridge that throws is an unavailable check, not a crash', async () => {
    const bridge = stubBridge(view(READ_ONLY))
    bridge.refresh.mockRejectedValueOnce(new Error('main is gone'))
    $license.set({ ...$license.get(), license: READ_ONLY })

    const state = await checkLicenseNow()

    expect(state.lastCheck).toBe('unavailable')
    expect(state.license?.state).toBe('expired')
  })
})

describe('a turn refused for the license', () => {
  it('locks at once, then re-reads through the main process', async () => {
    const bridge = stubBridge(view(READ_ONLY))

    noteLicenseRefusal(READ_ONLY)

    expect($licenseReadOnly.get()).toBe(true)
    await vi.waitFor(() => expect(bridge.get).toHaveBeenCalledTimes(1))
  })

  it('a refusal without a readable license still re-reads', async () => {
    const bridge = stubBridge(view(READ_ONLY))

    noteLicenseRefusal('nonsense')

    await vi.waitFor(() => expect($licenseReadOnly.get()).toBe(true))
    expect(bridge.get).toHaveBeenCalledTimes(1)
  })
})

describe('the reminder before a plan ends', () => {
  it('is raised once, with the plan, the day and the days left', async () => {
    stubBridge(view(EXPIRING))

    await refreshLicense()
    await refreshLicense()

    expect(notifySpy).toHaveBeenCalledTimes(1)
    expect(notifySpy.mock.calls[0][0]).toMatchObject({
      kind: 'warning',
      message: 'Gói Pilot 2026 hết hạn ngày 31/01/2027 (còn 7 ngày). Liên hệ it@astralx.com.vn để gia hạn.',
      scope: 'app'
    })
  })

  it('is remembered across launches', async () => {
    stubBridge(view(EXPIRING))
    await refreshLicense()

    // A relaunch: the store starts over, the storage does not.
    $license.set({ account: null, available: false, checking: false, lastCheck: null, license: null, loaded: false })
    await refreshLicense()

    expect(notifySpy).toHaveBeenCalledTimes(1)
  })

  it('comes back at the next threshold, and for the next person', async () => {
    const bridge = stubBridge(view(EXPIRING))
    const stop = startLicenseSync()
    await vi.waitFor(() => expect(notifySpy).toHaveBeenCalledTimes(1))

    bridge.emit(view({ ...EXPIRING, days_left: 1, reminder: 1 }))
    bridge.emit(view(EXPIRING, { account: 'lan' }))
    stop()

    expect(notifySpy).toHaveBeenCalledTimes(3)
  })

  it('is raised by the main window only', async () => {
    secondary = true
    stubBridge(view(EXPIRING))

    await refreshLicense()

    expect(notifySpy).not.toHaveBeenCalled()
  })

  it('is not raised without a notice — nothing is enforced', async () => {
    stubBridge(view({ ...EXPIRING, enforced: false, notice: null }))

    await refreshLicense()

    expect(notifySpy).not.toHaveBeenCalled()
  })
})

describe('AI work outside the composer', () => {
  const REASON =
    'Gói Pilot 2026 đã hết hạn ngày 31/05/2027. Workmate đang ở chế độ chỉ xem. ' +
    'Liên hệ it@astralx.com.vn để được cấp lại hoặc gia hạn.'

  function readOnly() {
    $license.set({ ...$license.get(), license: READ_ONLY, loaded: true })
  }

  it('may run while nothing is known or the license covers AI', () => {
    expect(aiBlockedMessage()).toBeNull()
    expect(() => ensureAiAllowed()).not.toThrow()

    $license.set({ ...$license.get(), license: license(), loaded: true })

    expect(aiBlockedMessage()).toBeNull()
    expect(() => ensureAiAllowed()).not.toThrow()
    expect(refuseAiAction('Voice')).toBe(false)
    expect(notifySpy).not.toHaveBeenCalled()
  })

  it('is refused while read-only, before anything is sent, with the reason', () => {
    stubBridge(view(READ_ONLY))
    readOnly()

    expect(aiBlockedMessage()).toBe(REASON)
    expect(() => ensureAiAllowed()).toThrow(LicenseRefusedError)

    try {
      ensureAiAllowed()
    } catch (error) {
      expect((error as Error).message).toBe(REASON)
      // The shape the backend's refusal has, so one check recognises both.
      expect((error as InstanceType<typeof LicenseRefusedError>).data).toEqual({
        code: 'license_read_only',
        license: READ_ONLY
      })
    }
  })

  it('a refusal from the backend locks this window at once and reads in its words', async () => {
    const bridge = stubBridge(view(READ_ONLY))
    const error = Object.assign(new Error('backend text'), { data: { code: 'license_read_only', license: READ_ONLY } })

    expect(licenseRefusalMessage(error)).toBe(REASON)
    expect($licenseReadOnly.get()).toBe(true)
    await vi.waitFor(() => expect(bridge.get).toHaveBeenCalled())
  })

  it('anything else is not a refusal', () => {
    expect(licenseRefusalMessage(new Error('Transcription failed'))).toBeNull()
    expect(notifyLicenseRefusal(new Error('Transcription failed'), 'Dictation')).toBe(false)
    expect(notifySpy).not.toHaveBeenCalled()
  })

  it('a refusal is a warning that keeps the whole reason; other failures stay errors', () => {
    stubBridge(view(READ_ONLY))
    readOnly()

    notifyAiError(new LicenseRefusedError(READ_ONLY), 'Đọc to')

    expect(notifySpy).toHaveBeenCalledWith({ id: 'license-refusal', kind: 'warning', message: REASON, title: 'Đọc to' })
    expect(notifyErrorSpy).not.toHaveBeenCalled()

    const failure = new Error('ElevenLabs STT API error')
    notifyAiError(failure, 'Đọc to')

    expect(notifyErrorSpy).toHaveBeenCalledWith(failure, 'Đọc to')
  })

  it('an action the person just started stops with the reason', () => {
    stubBridge(view(READ_ONLY))
    readOnly()

    expect(refuseAiAction('Giọng nói')).toBe(true)
    expect(notifySpy).toHaveBeenCalledWith(expect.objectContaining({ kind: 'warning', message: REASON }))
  })
})
