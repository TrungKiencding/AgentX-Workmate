// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { en } from '@/i18n/en'
import type { MessagingPlatformInfo, WhatsAppOnboardingSession } from '@/types/hermes'

const getMessagingPlatforms = vi.fn()
const getPairing = vi.fn()
const startWhatsAppLink = vi.fn()
const getWhatsAppLink = vi.fn()
const applyWhatsAppLink = vi.fn()
const cancelWhatsAppLink = vi.fn()
const notify = vi.fn()

vi.mock('@/hermes', () => ({
  applyWhatsAppLink: (id: string, mode: string) => applyWhatsAppLink(id, mode),
  approvePairing: vi.fn(),
  cancelWhatsAppLink: (id: string) => cancelWhatsAppLink(id),
  getMessagingPlatforms: () => getMessagingPlatforms(),
  getPairing: () => getPairing(),
  getWhatsAppLink: (id: string) => getWhatsAppLink(id),
  revokePairing: vi.fn(),
  setApiRequestProfile: vi.fn(),
  startWhatsAppLink: (body: unknown) => startWhatsAppLink(body),
  updateMessagingPlatform: vi.fn()
}))

vi.mock('qrcode', () => ({
  toDataURL: vi.fn(async (payload: string) => `data:image/png;base64,${btoa(payload)}`)
}))

vi.mock('@/lib/external-link', () => ({ openExternalLink: vi.fn() }))

vi.mock('@/store/notifications', () => ({
  notify: (input: unknown) => notify(input),
  notifyError: vi.fn(),
  readableError: (error: unknown, fallback: string) => ({
    message: error instanceof Error ? error.message : fallback
  })
}))

vi.mock('@/store/system-actions', () => ({ runGatewayRestart: vi.fn() }))

const copy = en.messaging.whatsapp

function whatsapp(patch: Partial<MessagingPlatformInfo> = {}): MessagingPlatformInfo {
  return {
    configured: false,
    description: 'WhatsApp',
    docs_url: 'https://faq.whatsapp.com/1317564962315842',
    enabled: false,
    env_vars: [],
    gateway_running: true,
    id: 'whatsapp',
    name: 'WhatsApp',
    state: 'disabled',
    whatsapp_setup: { allowed_users_set: false, home_channel_set: false, linked: false, mode: '' },
    ...patch
  }
}

function session(patch: Partial<WhatsAppOnboardingSession> = {}): WhatsAppOnboardingSession {
  return {
    account_id: null,
    account_name: null,
    account_phone: null,
    allowed_users: '',
    error: null,
    expires_at: '2099-01-01T00:00:00Z',
    mode: 'self-chat',
    pairing_id: 'pair-1',
    qr_payload: null,
    status: 'starting',
    ...patch
  }
}

beforeEach(() => {
  window.localStorage.clear()
  // The coach opens on first visit; most tests read the full form.
  window.localStorage.setItem('agentx-desktop:global:messaging-guide:v1:whatsapp', 'seen')
  getPairing.mockResolvedValue({ approved: [], pending: [] })
  cancelWhatsAppLink.mockResolvedValue({ ok: true })
  applyWhatsAppLink.mockResolvedValue({ needs_restart: false, ok: true, restart_started: true })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
})

async function renderMessaging() {
  const { MessagingView } = await import('./index')
  let result: ReturnType<typeof render>
  await act(async () => {
    result = render(
      <MemoryRouter initialEntries={['/messaging?platform=whatsapp']}>
        <MessagingView />
      </MemoryRouter>
    )
  })

  return result!
}

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

describe('WhatsApp in-app QR linking', () => {
  it('shows the QR, then saves and enables the moment the phone scans it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    getMessagingPlatforms.mockResolvedValue({ platforms: [whatsapp()] })
    startWhatsAppLink.mockResolvedValue(session({ status: 'installing' }))
    getWhatsAppLink
      .mockResolvedValueOnce(session({ qr_payload: 'https://wa.me/settings/linked_devices#2@abc', status: 'waiting' }))
      .mockResolvedValueOnce(session({ account_name: 'Lan', account_phone: '84901234567', status: 'connected' }))

    await renderMessaging()

    // Step 1 is the phone link, not a terminal command.
    expect(await screen.findByText(copy.step1Title)).toBeTruthy()
    expect(screen.queryByText(/agentx whatsapp/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: copy.showQr }))
    await waitFor(() => expect(startWhatsAppLink).toHaveBeenCalledWith({ mode: 'self-chat', relink: false }))
    expect(await screen.findByText(copy.preparing)).toBeTruthy()

    await tick(2000)
    const qr = await screen.findByAltText(copy.qrAlt)
    expect(qr.getAttribute('src')).toContain('data:image/png;base64,')
    expect(screen.getByText(copy.scanSteps[2])).toBeTruthy()

    await tick(2000)
    await waitFor(() => expect(applyWhatsAppLink).toHaveBeenCalledWith('pair-1', 'self-chat'))
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ detail: '+84901234567 · Lan', kind: 'success', title: copy.linkedToast })
      )
    )
    // The page re-reads the platform so step 1 flips to "linked".
    await waitFor(() => expect(getMessagingPlatforms).toHaveBeenCalledTimes(2))
    // A run that completed through apply is not cancelled afterwards.
    expect(cancelWhatsAppLink).not.toHaveBeenCalled()
  })

  it('links with a separate bot number when that mode is chosen', async () => {
    getMessagingPlatforms.mockResolvedValue({ platforms: [whatsapp()] })
    startWhatsAppLink.mockResolvedValue(session({ mode: 'bot' }))
    getWhatsAppLink.mockResolvedValue(session({ mode: 'bot' }))

    await renderMessaging()

    fireEvent.click(await screen.findByRole('radio', { name: new RegExp(copy.modeBot) }))
    fireEvent.click(screen.getByRole('button', { name: copy.showQr }))

    await waitFor(() => expect(startWhatsAppLink).toHaveBeenCalledWith({ mode: 'bot', relink: false }))
  })

  it('ends the pairing run when the person cancels or leaves the page', async () => {
    getMessagingPlatforms.mockResolvedValue({ platforms: [whatsapp()] })
    startWhatsAppLink.mockResolvedValue(session({ qr_payload: 'qr-1', status: 'waiting' }))
    getWhatsAppLink.mockResolvedValue(session({ qr_payload: 'qr-1', status: 'waiting' }))

    const view = await renderMessaging()

    fireEvent.click(await screen.findByRole('button', { name: copy.showQr }))
    expect(await screen.findByAltText(copy.qrAlt)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: en.common.cancel }))
    await waitFor(() => expect(cancelWhatsAppLink).toHaveBeenCalledWith('pair-1'))
    expect(await screen.findByRole('button', { name: copy.showQr })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: copy.showQr }))
    expect(await screen.findByAltText(copy.qrAlt)).toBeTruthy()
    cancelWhatsAppLink.mockClear()

    view.unmount()
    expect(cancelWhatsAppLink).toHaveBeenCalledWith('pair-1')
  })

  it('walks a beginner through who may message, not the values Workmate writes itself', async () => {
    window.localStorage.removeItem('agentx-desktop:global:messaging-guide:v1:whatsapp')

    const field = (key: string, advanced: boolean) => ({
      advanced,
      description: '',
      is_password: false,
      is_set: false,
      key,
      prompt: key,
      redacted_value: null,
      required: false,
      url: null
    })

    getMessagingPlatforms.mockResolvedValue({
      platforms: [
        whatsapp({
          env_vars: [
            field('WHATSAPP_ENABLED', true),
            field('WHATSAPP_MODE', true),
            field('WHATSAPP_DM_POLICY', true),
            field('WHATSAPP_ALLOWED_USERS', false)
          ]
        })
      ]
    })

    await renderMessaging()

    // link phone → who may message → turn on → test
    expect(await screen.findByText('Guide · 1/4')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.common.continue }))
    expect(screen.getByLabelText(en.messaging.fieldCopy.WHATSAPP_ALLOWED_USERS.label!)).toBeTruthy()

    // The full form still offers them under Advanced.
    fireEvent.click(screen.getByRole('button', { name: en.messaging.guide.skip }))
    expect(screen.getByText(en.messaging.advanced(3))).toBeTruthy()
  })

  it('keeps the same QR run when moving between the coach and the full form', async () => {
    window.localStorage.removeItem('agentx-desktop:global:messaging-guide:v1:whatsapp')
    getMessagingPlatforms.mockResolvedValue({ platforms: [whatsapp()] })
    startWhatsAppLink.mockResolvedValue(session({ qr_payload: 'qr-1', status: 'waiting' }))
    getWhatsAppLink.mockResolvedValue(session({ qr_payload: 'qr-1', status: 'waiting' }))

    await renderMessaging()

    // First visit opens the coach on the link step, with the QR action in it.
    expect(await screen.findByRole('region', { name: en.messaging.guide.title })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: copy.showQr }))
    expect(await screen.findByAltText(copy.qrAlt)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: en.messaging.guide.skip }))

    // The full form shows the very same QR; nothing was cancelled or restarted.
    expect(await screen.findByAltText(copy.qrAlt)).toBeTruthy()
    expect(cancelWhatsAppLink).not.toHaveBeenCalled()
    expect(startWhatsAppLink).toHaveBeenCalledTimes(1)
  })

  it('says the code expired when the backend no longer knows the run', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    getMessagingPlatforms.mockResolvedValue({ platforms: [whatsapp()] })
    startWhatsAppLink.mockResolvedValue(session({ qr_payload: 'qr-1', status: 'waiting' }))
    getWhatsAppLink.mockRejectedValue(
      new Error('Error invoking remote method \'agentx:api\': Error: 410: {"detail":"x"}')
    )

    await renderMessaging()

    fireEvent.click(await screen.findByRole('button', { name: copy.showQr }))
    await tick(2000)

    expect(await screen.findByText(copy.errors.expired)).toBeTruthy()
    expect(screen.getByRole('button', { name: copy.retry })).toBeTruthy()
  })

  it('keeps polling through a transient error instead of dropping the QR', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    getMessagingPlatforms.mockResolvedValue({ platforms: [whatsapp()] })
    startWhatsAppLink.mockResolvedValue(session({ qr_payload: 'qr-1', status: 'waiting' }))
    getWhatsAppLink
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValue(session({ qr_payload: 'qr-2', status: 'waiting' }))

    await renderMessaging()

    fireEvent.click(await screen.findByRole('button', { name: copy.showQr }))
    await tick(2000)
    expect(screen.getByAltText(copy.qrAlt)).toBeTruthy()
    await tick(2000)

    await waitFor(() => expect(screen.getByAltText(copy.qrAlt).getAttribute('src')).toContain(btoa('qr-2')))
    expect(getWhatsAppLink).toHaveBeenCalledTimes(2)
  })

  it('a late 410 for a cancelled run does not end the run that replaced it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    getMessagingPlatforms.mockResolvedValue({ platforms: [whatsapp()] })
    startWhatsAppLink
      .mockResolvedValueOnce(session({ pairing_id: 'pair-1', qr_payload: 'qr-1', status: 'waiting' }))
      .mockResolvedValueOnce(session({ pairing_id: 'pair-2', qr_payload: 'qr-2', status: 'waiting' }))

    let rejectOld: (error: Error) => void = () => undefined
    getWhatsAppLink.mockImplementation((id: string) =>
      id === 'pair-1'
        ? new Promise((_resolve, reject) => {
            rejectOld = reject
          })
        : Promise.resolve(session({ pairing_id: 'pair-2', qr_payload: 'qr-2', status: 'waiting' }))
    )

    await renderMessaging()

    fireEvent.click(await screen.findByRole('button', { name: copy.showQr }))
    expect(await screen.findByAltText(copy.qrAlt)).toBeTruthy()
    // The poll for pair-1 is now in flight.
    await tick(2000)
    expect(getWhatsAppLink).toHaveBeenCalledWith('pair-1')

    fireEvent.click(screen.getByRole('button', { name: en.common.cancel }))
    fireEvent.click(await screen.findByRole('button', { name: copy.showQr }))
    await waitFor(() => expect(screen.getByAltText(copy.qrAlt).getAttribute('src')).toContain(btoa('qr-2')))

    // The old run's request finally answers: the backend no longer knows it.
    await act(async () => {
      rejectOld(new Error('Error invoking remote method \'agentx:api\': Error: 410: {"detail":"x"}'))
    })

    expect(screen.queryByText(copy.errors.expired)).toBeNull()
    expect(screen.getByAltText(copy.qrAlt).getAttribute('src')).toContain(btoa('qr-2'))
    expect(cancelWhatsAppLink).not.toHaveBeenCalledWith('pair-2')
  })

  it('a late successful answer for a cancelled run does not replace the new QR', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    getMessagingPlatforms.mockResolvedValue({ platforms: [whatsapp()] })
    startWhatsAppLink
      .mockResolvedValueOnce(session({ pairing_id: 'pair-1', qr_payload: 'qr-1', status: 'waiting' }))
      .mockResolvedValueOnce(session({ pairing_id: 'pair-2', qr_payload: 'qr-2', status: 'waiting' }))

    let resolveOld: (value: WhatsAppOnboardingSession) => void = () => undefined
    getWhatsAppLink.mockImplementation((id: string) =>
      id === 'pair-1'
        ? new Promise(resolve => {
            resolveOld = resolve
          })
        : Promise.resolve(session({ pairing_id: 'pair-2', qr_payload: 'qr-2', status: 'waiting' }))
    )

    await renderMessaging()

    fireEvent.click(await screen.findByRole('button', { name: copy.showQr }))
    expect(await screen.findByAltText(copy.qrAlt)).toBeTruthy()
    await tick(2000)
    expect(getWhatsAppLink).toHaveBeenCalledWith('pair-1')

    fireEvent.click(screen.getByRole('button', { name: en.common.cancel }))
    fireEvent.click(await screen.findByRole('button', { name: copy.showQr }))
    await waitFor(() => expect(screen.getByAltText(copy.qrAlt).getAttribute('src')).toContain(btoa('qr-2')))

    // The old run's poll answers late with the OLD QR.
    await act(async () => {
      resolveOld(session({ pairing_id: 'pair-1', qr_payload: 'qr-1-rotated', status: 'waiting' }))
    })
    await tick(100)

    expect(screen.getByAltText(copy.qrAlt).getAttribute('src')).toContain(btoa('qr-2'))
    expect(screen.getByAltText(copy.qrAlt).getAttribute('src')).not.toContain(btoa('qr-1-rotated'))
  })

  it('a start that answers after Cancel does not take over the screen', async () => {
    getMessagingPlatforms.mockResolvedValue({ platforms: [whatsapp()] })

    let resolveFirst: (value: WhatsAppOnboardingSession) => void = () => undefined
    startWhatsAppLink
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveFirst = resolve
          })
      )
      .mockResolvedValueOnce(session({ pairing_id: 'pair-2', qr_payload: 'qr-2', status: 'waiting' }))
    getWhatsAppLink.mockResolvedValue(session({ pairing_id: 'pair-2', qr_payload: 'qr-2', status: 'waiting' }))

    await renderMessaging()

    fireEvent.click(await screen.findByRole('button', { name: copy.showQr }))
    fireEvent.click(await screen.findByRole('button', { name: en.common.cancel }))
    fireEvent.click(await screen.findByRole('button', { name: copy.showQr }))
    await waitFor(() => expect(screen.getByAltText(copy.qrAlt).getAttribute('src')).toContain(btoa('qr-2')))

    await act(async () => {
      resolveFirst(session({ pairing_id: 'pair-1', qr_payload: 'qr-1', status: 'waiting' }))
    })

    // The stale run is ended on the backend; the new one stays on screen.
    await waitFor(() => expect(cancelWhatsAppLink).toHaveBeenCalledWith('pair-1'))
    expect(screen.getByAltText(copy.qrAlt).getAttribute('src')).toContain(btoa('qr-2'))
    expect(cancelWhatsAppLink).not.toHaveBeenCalledWith('pair-2')
  })

  it('turns a bridge failure into an action a non-technical owner can take', async () => {
    getMessagingPlatforms.mockResolvedValue({ platforms: [whatsapp()] })
    startWhatsAppLink.mockResolvedValue(
      session({ error: 'Node.js was not found. WhatsApp setup needs Node.js.', status: 'error' })
    )

    await renderMessaging()

    fireEvent.click(await screen.findByRole('button', { name: copy.showQr }))

    expect(await screen.findByText(copy.errors.noNode)).toBeTruthy()
    expect(cancelWhatsAppLink).toHaveBeenCalledWith('pair-1')
  })

  it('shows the linked number and re-links only after confirmation', async () => {
    getMessagingPlatforms.mockResolvedValue({
      platforms: [
        whatsapp({
          configured: true,
          enabled: true,
          error_code: 'whatsapp_bridge_exited',
          error_message: 'WhatsApp bridge process exited unexpectedly (code 1).',
          state: 'fatal',
          whatsapp_setup: {
            account_name: 'Shop',
            account_phone: '84901234567',
            allowed_users_set: true,
            home_channel_set: false,
            linked: true,
            mode: 'bot'
          }
        })
      ]
    })
    startWhatsAppLink.mockResolvedValue(session({ mode: 'bot', qr_payload: 'qr-new', status: 'waiting' }))
    getWhatsAppLink.mockResolvedValue(session({ mode: 'bot', qr_payload: 'qr-new', status: 'waiting' }))

    await renderMessaging()

    expect(await screen.findByText(copy.linkedTo('+84901234567 · Shop'))).toBeTruthy()
    expect(screen.getByText(copy.tryBot)).toBeTruthy()
    // The English terminal sentence is retold with the in-app remedy.
    expect(screen.getByText(copy.errors.bridgeExited)).toBeTruthy()
    expect(screen.queryByText(/exited unexpectedly/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: copy.relink }))
    expect(startWhatsAppLink).not.toHaveBeenCalled()

    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain(copy.relinkBody)

    const confirm = within(dialog)
      .getAllByRole('button')
      .find(button => button.textContent?.includes(copy.relink))

    fireEvent.click(confirm!)

    await waitFor(() => expect(startWhatsAppLink).toHaveBeenCalledWith({ mode: 'bot', relink: true }))
    expect(await screen.findByAltText(copy.qrAlt)).toBeTruthy()
  })

  it('does not offer re-linking while the linked number is live', async () => {
    getMessagingPlatforms.mockResolvedValue({
      platforms: [
        whatsapp({
          configured: true,
          enabled: true,
          state: 'connected',
          whatsapp_setup: {
            account_phone: '84901234567',
            allowed_users_set: true,
            home_channel_set: false,
            linked: true,
            mode: 'self-chat'
          }
        })
      ]
    })

    await renderMessaging()

    expect(await screen.findByText(copy.trySelf)).toBeTruthy()
    expect((screen.getByRole('button', { name: copy.relink }) as HTMLButtonElement).disabled).toBe(true)
    // Self-chat needs no allowlist work: step 2 says so instead of talking
    // about strangers and pairing codes.
    expect(screen.getByText(copy.step2BodySelf)).toBeTruthy()
    expect(screen.queryByText(copy.step2Body)).toBeNull()
  })

  it('explains a 409 from the backend instead of showing raw JSON', async () => {
    getMessagingPlatforms.mockResolvedValue({ platforms: [whatsapp()] })
    startWhatsAppLink.mockRejectedValue(
      new Error('Error: 409: {"detail":"WhatsApp is connected. Turn the connection off before linking again."}')
    )

    await renderMessaging()

    fireEvent.click(await screen.findByRole('button', { name: copy.showQr }))

    expect(await screen.findByText(copy.relinkConnected)).toBeTruthy()
  })
})

describe('WhatsApp link helpers', () => {
  it('reads the HTTP status the desktop API bridge folds into errors', async () => {
    const { httpStatusOf } = await import('./whatsapp-link')

    expect(httpStatusOf(new Error("Error invoking remote method 'agentx:api': Error: 410: {}"))).toBe(410)
    expect(httpStatusOf(new Error('404: Not Found'))).toBe(404)
    expect(httpStatusOf(new Error('socket hang up'))).toBeNull()
  })

  it('formats the linked account for people, not machines', async () => {
    const { formatWhatsAppAccount } = await import('./whatsapp-link')

    expect(formatWhatsAppAccount('84901234567', 'Lan')).toBe('+84901234567 · Lan')
    expect(formatWhatsAppAccount('+84901234567', null)).toBe('+84901234567')
    expect(formatWhatsAppAccount(null, 'Lan')).toBe('Lan')
    expect(formatWhatsAppAccount(null, null)).toBeNull()
  })

  it('maps backend failures to plain-language copy', async () => {
    const { friendlyLinkError } = await import('./whatsapp-link')

    expect(friendlyLinkError('npm was not found. WhatsApp setup needs Node.js and npm.', copy).message).toBe(
      copy.errors.noNode
    )
    expect(friendlyLinkError('npm install failed for WhatsApp bridge: ETIMEDOUT', copy).message).toBe(
      copy.errors.install
    )
    expect(friendlyLinkError('logged_out', copy).message).toBe(copy.errors.loggedOut)
    expect(friendlyLinkError('WhatsApp QR setup expired. Start a new setup.', copy).message).toBe(copy.errors.expired)
    expect(friendlyLinkError('something else', copy)).toEqual({
      detail: 'something else',
      message: copy.errors.generic
    })
  })
})
