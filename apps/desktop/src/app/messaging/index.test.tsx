// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MessagingPlatformInfo } from '@/types/hermes'

const getMessagingPlatforms = vi.fn()
const updateMessagingPlatform = vi.fn()
const getPairing = vi.fn()
const approvePairing = vi.fn()
const revokePairing = vi.fn()
const openExternalLink = vi.fn()

vi.mock('@/hermes', () => ({
  approvePairing: (platformId: string, requestId: string) => approvePairing(platformId, requestId),
  getMessagingPlatforms: () => getMessagingPlatforms(),
  getPairing: () => getPairing(),
  revokePairing: (platformId: string, userId: string) => revokePairing(platformId, userId),
  setApiRequestProfile: vi.fn(),
  updateMessagingPlatform: (id: string, body: unknown) => updateMessagingPlatform(id, body)
}))

vi.mock('@/lib/external-link', () => ({
  openExternalLink: (href: string) => openExternalLink(href)
}))

vi.mock('@/store/notifications', () => ({
  notify: vi.fn(),
  notifyError: vi.fn()
}))

vi.mock('@/store/system-actions', () => ({
  runGatewayRestart: vi.fn()
}))

function platform(patch: Partial<MessagingPlatformInfo> = {}): MessagingPlatformInfo {
  return {
    configured: false,
    description: 'A platform.',
    docs_url: '',
    enabled: false,
    env_vars: [],
    gateway_running: true,
    id: 'teams',
    name: 'Microsoft Teams',
    state: 'disabled',
    ...patch
  }
}

beforeEach(() => {
  window.localStorage.clear()

  for (const id of ['teams', 'telegram']) {
    window.localStorage.setItem(`agentx-desktop:global:messaging-guide:v1:${id}`, 'seen')
  }

  updateMessagingPlatform.mockResolvedValue({ ok: true, platform: 'teams' })
  getPairing.mockResolvedValue({ approved: [], pending: [] })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

async function renderMessaging() {
  const { MessagingView } = await import('./index')
  let result: ReturnType<typeof render>
  await act(async () => {
    result = render(
      <MemoryRouter>
        <MessagingView />
      </MemoryRouter>
    )
  })

  return result!
}

describe('MessagingView setup-guide link', () => {
  it('shows and opens the connected bot destination', async () => {
    const botUrl = 'https://t.me/agentx_bot'
    getMessagingPlatforms.mockResolvedValue({
      platforms: [
        platform({
          configured: true,
          destination: { kind: 'bot', label: '@agentx_bot', url: botUrl },
          enabled: true,
          id: 'telegram',
          name: 'Telegram',
          state: 'connected'
        })
      ]
    })

    await renderMessaging()

    expect(await screen.findByText('@agentx_bot')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open in app' }))
    await waitFor(() => expect(openExternalLink).toHaveBeenCalledWith(botUrl))
  })

  it('hides the setup-guide button for a plugin platform with no docs URL', async () => {
    // Teams (and other plugin platforms) ship an empty docs_url. Rendering an
    // anchor with href="" let Electron resolve it to the app's own packaged
    // index.html and fail with an OS "file not found" dialog. The button must
    // simply not appear when there is no guide to open.
    getMessagingPlatforms.mockResolvedValue({ platforms: [platform({ docs_url: '' })] })

    await renderMessaging()

    expect((await screen.findAllByText('Microsoft Teams')).length).toBeGreaterThan(0)
    expect(screen.queryByText('Open setup guide')).toBeNull()
  })

  it('opens a real docs URL through the validated external opener', async () => {
    const docsUrl =
      'https://github.com/TrungKiencding/AgentX-Workmate/blob/main/website/docs/user-guide/messaging/teams.md'

    getMessagingPlatforms.mockResolvedValue({ platforms: [platform({ docs_url: docsUrl })] })

    await renderMessaging()

    const link = await screen.findByText('Open setup guide')
    await act(async () => {
      fireEvent.click(link)
    })

    await waitFor(() => expect(openExternalLink).toHaveBeenCalledWith(docsUrl))
  })
})

describe('MessagingView pairing', () => {
  const pendingUser = {
    age_minutes: 3,
    platform: 'teams',
    request_id: 'a1b2c3d4e5f60718',
    user_id: '7712345',
    user_name: 'Bee'
  }

  it('approves the listed request by its request id, never by a code', async () => {
    // The whole point of the request-id grant path: the UI can only ever send
    // the server-side row id, because the one-time code is never returned by
    // the API. Posting anything derived from the code could not be approved.
    getMessagingPlatforms.mockResolvedValue({ platforms: [platform()] })
    getPairing.mockResolvedValue({ approved: [], pending: [pendingUser] })
    approvePairing.mockResolvedValue({ ok: true, user: { user_id: '7712345', user_name: 'Bee' } })

    await renderMessaging()

    const approve = await screen.findByRole('button', { name: 'Allow' })
    await act(async () => {
      fireEvent.click(approve)
    })

    await waitFor(() => expect(approvePairing).toHaveBeenCalledWith('teams', 'a1b2c3d4e5f60718'))
  })

  it('restores the pending row when approval fails', async () => {
    // Optimistic removal must not silently swallow the request: a failed
    // approve has to leave the operator something to retry.
    getMessagingPlatforms.mockResolvedValue({ platforms: [platform()] })
    getPairing.mockResolvedValue({ approved: [], pending: [pendingUser] })
    approvePairing.mockRejectedValue(new Error('500 boom'))

    await renderMessaging()

    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Allow' }))
    })

    expect(await screen.findByRole('button', { name: 'Allow' })).toBeTruthy()
    // The banner phrases the request as one sentence, so match by substring.
    expect(screen.getAllByText(/Bee/).length).toBeGreaterThan(0)
  })

  it('explains an expired request and drops the dead row', async () => {
    // A 404 is a row that aged out (or was handled elsewhere). The operator
    // gets a localized next step instead of the backend's English, and the
    // authoritative refetch removes the row so it cannot be clicked again.
    const { notify, notifyError } = await import('@/store/notifications')
    getMessagingPlatforms.mockResolvedValue({ platforms: [platform()] })
    getPairing.mockResolvedValueOnce({ approved: [], pending: [pendingUser] })
    getPairing.mockResolvedValue({ approved: [], pending: [] })
    approvePairing.mockRejectedValue(
      new Error("404: Pairing request or code not found or expired for platform 'teams'.")
    )

    await renderMessaging()

    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Allow' }))
    })

    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'error', message: expect.stringContaining('expired') })
      )
    )
    expect(notifyError).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull())
  })

  it('shows no pairing affordance when nobody is waiting', async () => {
    // Approvals are rare; an always-present empty state would be permanent
    // chrome on a page that is otherwise about credentials.
    getMessagingPlatforms.mockResolvedValue({ platforms: [platform()] })
    getPairing.mockResolvedValue({ approved: [], pending: [] })

    await renderMessaging()

    expect((await screen.findAllByText('Microsoft Teams')).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull()
    expect(screen.queryByText(/Pending requests/)).toBeNull()
  })

  it('still renders platforms when the pairing endpoint fails', async () => {
    // An older backend without the endpoint must not blank the page.
    getMessagingPlatforms.mockResolvedValue({ platforms: [platform()] })
    getPairing.mockRejectedValue(new Error('404 not found'))

    await renderMessaging()

    expect((await screen.findAllByText('Microsoft Teams')).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull()
  })

  it('refetches pending rows on pairing.changed, not on platforms.changed', async () => {
    // The two signals are not interchangeable: platforms.changed tracks
    // connect/disconnect health via gateway_state.json, which a new pairing
    // request never moves. Riding it would leave someone invisible in the
    // pending list until an unrelated reconnect happened to fire.
    const { $changeEventsAvailable, $pairingChangeTick, $platformsChangeTick } = await import('@/store/live-sync')

    getMessagingPlatforms.mockResolvedValue({ platforms: [platform()] })
    getPairing.mockResolvedValue({ approved: [], pending: [] })

    await renderMessaging()
    await act(async () => {
      $changeEventsAvailable.set(true)
    })
    getPairing.mockClear()

    // Someone DMs the bot: the store moves, the watcher ticks pairing.changed.
    getPairing.mockResolvedValue({ approved: [], pending: [pendingUser] })
    await act(async () => {
      $pairingChangeTick.set($pairingChangeTick.get() + 1)
    })

    await waitFor(() => expect(getPairing).toHaveBeenCalled())
    expect(await screen.findByRole('button', { name: 'Allow' })).toBeTruthy()

    // A platform health tick alone must not be what fetches pairing.
    getPairing.mockClear()
    await act(async () => {
      $platformsChangeTick.set($platformsChangeTick.get() + 1)
    })
    expect(getPairing).not.toHaveBeenCalled()
  })
})

const telegramFields = [
  {
    advanced: false,
    key: 'TELEGRAM_BOT_TOKEN',
    required: true,
    is_password: true,
    description: '',
    prompt: 'Token',
    is_set: false,
    redacted_value: null,
    url: 'https://t.me/BotFather'
  },
  {
    advanced: false,
    key: 'TELEGRAM_ALLOWED_USERS',
    required: false,
    is_password: false,
    description: '',
    prompt: 'Users',
    is_set: false,
    redacted_value: null,
    url: null
  },
  {
    advanced: false,
    key: 'TELEGRAM_PROXY',
    required: false,
    is_password: false,
    description: '',
    prompt: 'Proxy',
    is_set: false,
    redacted_value: null,
    url: null
  }
]

function mockTelegramGuide() {
  window.localStorage.removeItem('agentx-desktop:global:messaging-guide:v1:telegram')
  getMessagingPlatforms.mockResolvedValue({
    platforms: [
      platform({
        id: 'telegram',
        name: 'Telegram',
        env_vars: telegramFields,
        docs_url: 'https://core.telegram.org/bots/tutorial'
      })
    ]
  })
}

const coach = () => screen.getByRole('region', { name: 'Connection guide' })
const continueGuide = () => fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

describe('MessagingView guided setup', () => {
  it('opens once, skips without saving, replays from help, and retains unsaved fields', async () => {
    mockTelegramGuide()
    await renderMessaging()
    expect(coach()).toBeTruthy()
    expect(screen.getByText(/Guide · 1\//)).toBeTruthy()
    continueGuide()
    const token = screen.getByLabelText('Bot token')
    expect(token.getAttribute('type')).toBe('password')
    fireEvent.change(token, { target: { value: 'my-private-token' } })
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    expect(screen.queryByRole('region', { name: 'Connection guide' })).toBeNull()
    expect((screen.getByLabelText('Bot token') as HTMLInputElement).value).toBe('my-private-token')
    expect(updateMessagingPlatform).not.toHaveBeenCalled()
    expect(JSON.stringify(window.localStorage)).not.toContain('my-private-token')

    fireEvent.click(screen.getByRole('button', { name: 'Help with Bot token' }))
    expect(coach().textContent).toContain('HTTP API')
    expect((screen.getByLabelText('Bot token') as HTMLInputElement).value).toBe('my-private-token')
    fireEvent.keyDown(coach(), { key: 'Escape' })
    expect(window.document.activeElement).toBe(screen.getByRole('button', { name: 'Show step-by-step guide' }))

    cleanup()
    await renderMessaging()
    expect(screen.queryByRole('region', { name: 'Connection guide' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show step-by-step guide' }))
    expect(coach()).toBeTruthy()
    expect(screen.getByText(/Guide · 1\//)).toBeTruthy()
  })

  it('walks required, optional, and advanced fields without mutating configuration', async () => {
    mockTelegramGuide()
    await renderMessaging()
    continueGuide()
    expect(screen.getByLabelText('Bot token')).toBeTruthy()
    continueGuide()
    expect(screen.getByLabelText('Who may message the bot')).toBeTruthy()
    expect(coach().textContent).toContain('does not grant access to everyone')
    continueGuide()
    expect(screen.getByLabelText('Proxy URL')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByLabelText('Who may message the bot')).toBeTruthy()
    continueGuide()
    continueGuide()
    expect(screen.getByRole('switch', { name: 'Enable Telegram' })).toBeTruthy()
    continueGuide()
    expect(screen.getByText('Send a test message')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Finish guide' }))
    expect(screen.queryByRole('region', { name: 'Connection guide' })).toBeNull()
    expect(updateMessagingPlatform).not.toHaveBeenCalled()
  })

  it('saves through the existing API while guided, leaving completion user-controlled', async () => {
    mockTelegramGuide()
    await renderMessaging()
    continueGuide()
    fireEvent.change(screen.getByLabelText('Bot token'), { target: { value: '  test-credential  ' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    })
    expect(updateMessagingPlatform).toHaveBeenCalledWith('telegram', { env: { TELEGRAM_BOT_TOKEN: 'test-credential' } })
    expect(coach()).toBeTruthy()
    expect(screen.getByLabelText('Bot token')).toBeTruthy()
  })

  it('opens the platform section of the landing docs and the actual credential source', async () => {
    mockTelegramGuide()
    await renderMessaging()
    fireEvent.click(screen.getByRole('button', { name: 'Illustrated guide' }))
    expect(openExternalLink).toHaveBeenCalledWith(
      'https://agentx-landingpage.astralx.com.vn/docs/kenh-tin-nhan/#telegram'
    )
    continueGuide()
    fireEvent.click(screen.getByRole('link', { name: 'Open docs' }))
    expect(openExternalLink).toHaveBeenCalledWith('https://t.me/BotFather')
  })

  it('resets the coach when selecting a different platform, keeping each form’s edits', async () => {
    mockTelegramGuide()
    getMessagingPlatforms.mockResolvedValue({
      platforms: [
        platform({ id: 'telegram', name: 'Telegram', env_vars: telegramFields }),
        platform({ id: 'slack', name: 'Slack' })
      ]
    })
    await renderMessaging()
    continueGuide()
    fireEvent.change(screen.getByLabelText('Bot token'), { target: { value: 'telegram-draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Slack' }))
    expect(screen.getByText(/Guide · 1\//)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Telegram' }))
    expect(screen.queryByRole('region', { name: 'Connection guide' })).toBeNull()
    expect((screen.getByLabelText('Bot token') as HTMLInputElement).value).toBe('telegram-draft')
  })

  it('supports a no-credential channel and restricted storage', async () => {
    window.localStorage.clear()

    const write = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('Storage unavailable')
    })

    getMessagingPlatforms.mockResolvedValue({ platforms: [platform()] })

    try {
      await renderMessaging()
      expect(screen.getByText('Guide · 1/3')).toBeTruthy()
      continueGuide()
      expect(screen.getByRole('switch', { name: 'Enable Microsoft Teams' })).toBeTruthy()
      continueGuide()
      fireEvent.click(screen.getByRole('button', { name: 'Finish guide' }))
      expect(screen.queryByRole('region', { name: 'Connection guide' })).toBeNull()
    } finally {
      write.mockRestore()
    }
  })
})
