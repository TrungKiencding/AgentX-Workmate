// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest'

// agentx:// deep links: `agentx://mcp/<slug>` (the hub's "Mở trong Workmate",
// the hub's decision §9.1 #17) opens the MCP store on that hub server's card;
// `agentx://blueprint/<key>` still becomes a reviewable /blueprint command.

vi.mock('@/store/updates', () => ({
  openUpdatesWindow: vi.fn(),
  startUpdatePoller: vi.fn(),
  stopUpdatePoller: vi.fn()
}))
vi.mock('@/store/webmate', () => ({ startWebmateWatcher: vi.fn(), stopWebmateWatcher: vi.fn() }))
vi.mock('@/store/native-notifications', () => ({ respondToApprovalAction: vi.fn() }))
vi.mock('@/store/projects', () => ({ openFolderAsProject: vi.fn() }))
vi.mock('@/app/chat/close-tab', () => ({ closeActiveTab: vi.fn() }))
vi.mock('@/app/open-session', () => ({ openSession: vi.fn() }))

const requestComposerInsert = vi.fn()
const requestComposerFocus = vi.fn()

vi.mock('../../chat/composer/focus', () => ({
  requestComposerFocus: (...args: unknown[]) => requestComposerFocus(...args),
  requestComposerInsert: (...args: unknown[]) => requestComposerInsert(...args)
}))

type DeepLink = { kind: string; name: string; params: Record<string, string> }
type Navigate = Mock<(to: string, options?: { replace?: boolean }) => void>

async function mount() {
  const { useDesktopIntegrations } = await import('./use-desktop-integrations')
  let deliver: ((payload: DeepLink) => void) | undefined
  const signalDeepLinkReady = vi.fn().mockResolvedValue({ ok: true })

  Object.assign(window, {
    agentxDesktop: {
      onDeepLink: (callback: (payload: DeepLink) => void) => {
        deliver = callback

        return () => {
          deliver = undefined
        }
      },
      signalDeepLinkReady
    }
  })

  const props = (navigate: Navigate) => ({
    chatOpen: false,
    hasPreview: false,
    locationPathname: '/skills',
    navigate,
    refreshSessions: vi.fn(),
    resumeExhaustedSessionId: null,
    routedSessionId: null,
    runtimeIdByStoredSessionId: { current: new Map<string, string>() }
  })

  const first: Navigate = vi.fn()
  const hook = renderHook(p => useDesktopIntegrations(p), { initialProps: props(first) })

  return {
    deliver: (payload: DeepLink) => deliver!(payload),
    first,
    rerender: (navigate: Navigate) => hook.rerender(props(navigate)),
    signalDeepLinkReady
  }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('agentx:// deep links', () => {
  it('`agentx://mcp/<slug>` opens the MCP store on that hub server, through the latest navigate', async () => {
    const app = await mount()

    app.deliver({ kind: 'mcp', name: 'github', params: {} })
    expect(app.first).toHaveBeenCalledWith('/skills?tab=mcp&hub=github')

    // A later render's navigate is the one used; the subscription (and the ready signal) stays one.
    const later: Navigate = vi.fn()
    app.rerender(later)
    app.deliver({ kind: 'mcp', name: 'crm-noi-bo', params: {} })
    expect(later).toHaveBeenCalledWith('/skills?tab=mcp&hub=crm-noi-bo')
    expect(app.signalDeepLinkReady).toHaveBeenCalledTimes(1)
    expect(requestComposerInsert).not.toHaveBeenCalled()
  })

  it('a name no hub slug can have goes nowhere — a link is outside input', async () => {
    const app = await mount()

    for (const name of ['', 'GitHub', '../settings', 'git hub', 'a'.repeat(65), 'x?tab=hub']) {
      app.deliver({ kind: 'mcp', name, params: {} })
    }

    expect(app.first).not.toHaveBeenCalled()
    expect(requestComposerInsert).not.toHaveBeenCalled()
  })

  it('`agentx://blueprint/<key>` still lands in the composer as a reviewable command', async () => {
    const app = await mount()

    app.deliver({ kind: 'blueprint', name: 'morning-brief', params: { time: '08:00' } })

    expect(requestComposerInsert).toHaveBeenCalledWith('/blueprint morning-brief time=08:00', {
      mode: 'block',
      target: 'main'
    })
    expect(app.first).not.toHaveBeenCalled()
  })

  it('names where each link leads', async () => {
    const { hubServerLinkTarget } = await import('./use-desktop-integrations')

    expect(hubServerLinkTarget('github')).toBe('/skills?tab=mcp&hub=github')
    expect(hubServerLinkTarget('a'.repeat(64))).toBe(`/skills?tab=mcp&hub=${'a'.repeat(64)}`)
    expect(hubServerLinkTarget(undefined)).toBeNull()
    expect(hubServerLinkTarget('Git-Hub')).toBeNull()
    expect(hubServerLinkTarget('github&hub=other')).toBeNull()
  })
})
