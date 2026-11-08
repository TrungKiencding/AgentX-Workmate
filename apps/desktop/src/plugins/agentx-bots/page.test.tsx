import { host, queryClient } from '@agentx/plugin-sdk'
import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'

// The loader registers a plugin's bundles at boot; do the same here so the
// page renders its real copy (English in tests) instead of message keys.
// eslint-disable-next-line no-restricted-imports -- test harness, not plugin code
import { registerPluginLocales } from '@/i18n/plugin-i18n'

import { composeSoul } from './agent-dialog'
import { BOTS_LOCALES } from './i18n'
import { $selection, BotsPage } from './page'
import { $botMeta, PLUGIN_ID, resetBotState } from './state'
import type { Bot, CronJob } from './types'

let disposeLocales: () => void

beforeAll(() => {
  disposeLocales = registerPluginLocales(PLUGIN_ID, BOTS_LOCALES)
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.releasePointerCapture = vi.fn()
  // Radix Select measures its trigger; jsdom has no ResizeObserver.
  globalThis.ResizeObserver ??= class {
    disconnect() {}
    observe() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver
})

afterAll(() => disposeLocales())

let roster: Bot[]
let jobs: Record<string, CronJob[]>
let request: MockInstance
let sessions: Record<string, Array<Record<string, unknown>>>

beforeEach(() => {
  resetBotState()
  $selection.set(null)
  queryClient.clear()
  roster = [
    { name: 'default', is_default: true, model: 'mock-model', skill_count: 12 },
    {
      name: 'writer',
      description: 'Soạn bài đăng',
      last_session: {
        id: 's1',
        last_active: Date.now() / 1000 - 3600,
        preview: 'Message from 🤖 Nghiên cứu (@nghien-cuu): số liệu đây'
      }
    },
    { name: 'nghien-cuu', description: 'Tìm hiểu' }
  ]
  jobs = {
    writer: [
      {
        job_id: 'j1',
        name: 'Bản tin sáng',
        schedule: '0 8 * * *',
        enabled: true,
        state: 'scheduled',
        next_run_at: new Date(Date.now() + 3_600_000).toISOString()
      }
    ]
  }
  sessions = {}
  $botMeta.set({
    writer: { title: 'Biên tập', group: 'Marketing' },
    'nghien-cuu': { title: 'Nghiên cứu', group: 'Marketing' }
  })

  request = vi
    .spyOn(host, 'requestPrimary')
    .mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
      switch (method) {
        case 'profiles.list':
          return { profiles: roster, bot_mode_protocol: true } as never

        case 'cron.manage':
          return (params.action === 'list' ? { jobs: jobs[String(params.profile)] ?? [] } : { ok: true }) as never

        case 'session.list':
          return { sessions: sessions[String(params.profile)] ?? [] } as never

        case 'image.generate':
          return { available: false } as never

        case 'profiles.create':

        case 'profiles.configure':
          return { applied: { ui_meta: true } } as never

        default:
          return {} as never
      }
    })
  vi.spyOn(host, 'refreshProfiles').mockResolvedValue(undefined)
  vi.spyOn(host, 'warmProfile').mockImplementation(() => undefined)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const renderPage = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <BotsPage />
    </QueryClientProvider>
  )

describe('Assistants page', () => {
  it('lists the main assistant first and opens it by default', async () => {
    renderPage()

    const nav = await screen.findByRole('navigation', { name: 'Assistants' })
    const rows = within(nav).getAllByRole('button')

    expect(rows[0].textContent).toContain('AgentX')
    expect(rows[0].textContent).toContain('Main assistant')
    expect(await screen.findByRole('heading', { level: 2, name: 'AgentX' })).toBeTruthy()
    expect(screen.getByText('@agentx')).toBeTruthy()
  })

  it('shows who sent a bot-to-bot message, and a group room for groups of two or more', async () => {
    renderPage()

    const nav = await screen.findByRole('navigation', { name: 'Assistants' })

    expect(within(nav).getByText('From @nghien-cuu:', { exact: false })).toBeTruthy()
    expect(within(nav).getByText('Marketing')).toBeTruthy()
    expect(within(nav).getByText('Group room')).toBeTruthy()
  })

  it('a group room welcomes with starters and @-mentions a member from the keyboard', async () => {
    renderPage()

    const nav = await screen.findByRole('navigation', { name: 'Assistants' })
    fireEvent.click(within(nav).getByText('Group room'))

    expect(await screen.findByRole('heading', { name: 'Start a discussion with Marketing' })).toBeTruthy()

    const composer = screen.getByRole('combobox', { name: /Message Marketing/ }) as HTMLTextAreaElement
    fireEvent.click(screen.getByRole('button', { name: 'Plan this week’s content together' }))
    expect(composer.value).toBe('Plan this week’s content together')

    composer.focus()
    fireEvent.change(composer, { target: { value: 'Hi @ngh' } })
    composer.setSelectionRange(7, 7)
    fireEvent.select(composer)

    const menu = await screen.findByRole('listbox', { name: 'Mention an assistant' })
    expect(
      within(menu)
        .getAllByRole('option')
        .map(option => option.textContent)
    ).toEqual(['Nghiên cứu@nghien-cuu'])

    fireEvent.keyDown(composer, { key: 'Enter' })
    expect(composer.value).toBe('Hi @nghien-cuu ')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('a selected assistant shows its scheduled tasks in plain words and can pause them', async () => {
    renderPage()

    fireEvent.click((await screen.findAllByRole('button', { name: /^Biên tập/ }))[0])

    expect(await screen.findByText('Bản tin sáng')).toBeTruthy()
    expect(screen.getByText('Every day at 08:00')).toBeTruthy()

    fireEvent.click(screen.getByRole('switch', { name: 'Pause' }))

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('cron.manage', { action: 'pause', name: 'j1', profile: 'writer' })
    )
  })

  it('creates an assistant from a template and stays on the page with it selected', async () => {
    const activate = vi.spyOn(host, 'activateProfile').mockResolvedValue(undefined)
    const open = vi.spyOn(host, 'openSession').mockResolvedValue(undefined)
    renderPage()

    fireEvent.click((await screen.findAllByRole('button', { name: /New assistant/ }))[0])

    const dialog = await screen.findByRole('dialog')

    fireEvent.click(within(dialog).getByRole('button', { name: /Secretary/ }))
    expect(within(dialog).getByDisplayValue('Secretary')).toBeTruthy()
    expect(within(dialog).getByText('Mention it in any chat as @secretary')).toBeTruthy()

    roster = [...roster, { name: 'secretary', description: 'Notes' }]
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Create assistant' }).at(-1)!)

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        'profiles.create',
        expect.objectContaining({ name: 'secretary', clone_from: 'default', share_auth: true })
      )
    )

    const create = request.mock.calls.find(([method]) => method === 'profiles.create')![1] as { soul: string }

    expect(create.soul).toContain('# Secretary')
    expect(create.soul).not.toContain('Messaging other agents')
    expect($botMeta.get().secretary).toMatchObject({ title: 'Secretary', custom: true })
    await waitFor(() => expect($selection.get()).toEqual({ kind: 'bot', name: 'secretary' }))
    // Nothing is sent or opened on the user's behalf.
    expect(open).not.toHaveBeenCalled()
    expect(activate).not.toHaveBeenCalled()
    expect(request.mock.calls.some(([method]) => method === 'prompt.submit' || method === 'session.create')).toBe(false)
  })

  it('"Message" on the main assistant starts an ordinary new chat', async () => {
    const newChat = vi.spyOn(host, 'newChat').mockImplementation(() => undefined)
    const open = vi.spyOn(host, 'openSession').mockResolvedValue(undefined)
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Message' }))

    expect(newChat).toHaveBeenCalledWith('default')
    expect(open).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: 'Recent conversations' })).toBeTruthy()
  })

  it('an assistant lists its main conversation first and never its group-room sessions', async () => {
    sessions.writer = [
      { id: 'g1', title: 'Group: Marketing', preview: '(pass)', last_active: 30, source: 'bot-room' },
      { id: 'side', title: 'Ý tưởng tiêu đề', preview: 'Thử 5 tiêu đề', last_active: 20 },
      { id: 'main', title: 'Bot Chat', preview: 'Bản nháp đây', last_active: 10 }
    ]
    $botMeta.set({ ...$botMeta.get(), writer: { ...$botMeta.get().writer, chat: 'main' } })
    renderPage()

    fireEvent.click((await screen.findAllByRole('button', { name: /^Biên tập/ }))[0])

    const section = (await screen.findByRole('heading', { name: 'Conversations' })).closest('section')!
    await waitFor(() => expect(within(section).getAllByRole('button').length).toBe(2))

    const rows = within(section).getAllByRole('button')

    expect(rows[0].textContent).toContain('Main conversation')
    expect(rows[1].textContent).toContain('Ý tưởng tiêu đề')
    expect(section.textContent).not.toContain('(pass)')
    expect(request).toHaveBeenCalledWith('session.list', { profile: 'writer', limit: 100, strict_profile: true })
  })

  it('a deleted assistant leaves the list and its rooms, even if a stale roster still names it', async () => {
    const remove = vi.spyOn(host, 'deleteProfile').mockResolvedValue(undefined)
    renderPage()

    fireEvent.click((await screen.findAllByRole('button', { name: /^Biên tập/ }))[0])
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'More actions' }), {
      button: 0,
      pointerType: 'mouse'
    })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete assistant…' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(remove).toHaveBeenCalledWith('writer'))

    const nav = await screen.findByRole('navigation', { name: 'Assistants' })
    // The roster mock still lists "writer" (a fetch that raced the delete).
    await waitFor(() => expect(within(nav).queryByText('Biên tập')).toBeNull())
    expect($selection.get()).toBeNull()
  })

  it('refuses a handle another assistant already uses', async () => {
    renderPage()

    fireEvent.click((await screen.findAllByRole('button', { name: /New assistant/ }))[0])

    const dialog = await screen.findByRole('dialog')

    fireEvent.change(within(dialog).getByPlaceholderText('e.g. Mia – Finance'), { target: { value: 'Writer' } })
    // The name alone picks the first free handle…
    expect(within(dialog).getByText('Mention it in any chat as @writer-2')).toBeTruthy()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Advanced options' }))
    fireEvent.change(within(dialog).getByDisplayValue('writer-2'), { target: { value: 'writer' } })

    // …and a typed one that collides blocks the create button.
    expect(within(dialog).getByText('@writer is already taken.')).toBeTruthy()
    expect(
      (within(dialog).getAllByRole('button', { name: 'Create assistant' }).at(-1) as HTMLButtonElement).disabled
    ).toBe(true)
  })

  it('offers no delete for the main assistant', async () => {
    renderPage()

    fireEvent.pointerDown(await screen.findByRole('button', { name: 'More actions' }), {
      button: 0,
      pointerType: 'mouse'
    })

    expect(await screen.findByRole('menuitem', { name: 'Duplicate' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: 'Delete assistant…' })).toBeNull()
  })
})

describe('composeSoul', () => {
  it('writes identity and instructions, never the teammate protocol', () => {
    const soul = composeSoul({
      description: 'Soạn bài',
      handle: 'writer',
      instructions: 'Trả lời ngắn.',
      title: 'Biên tập'
    })

    expect(soul).toContain('# Biên tập')
    expect(soul).toContain('**Role:** Soạn bài')
    expect(soul).toContain('## Instructions\n\nTrả lời ngắn.')
    expect(soul).not.toContain('Messaging other agents')
  })
})
