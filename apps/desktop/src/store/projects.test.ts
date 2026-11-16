import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NO_PROJECT_ID, type SidebarProjectTree } from '@/app/chat/sidebar/projects/workspace-groups'
import { $dismissedAutoProjectIds, $sidebarWorkspaceNodeOpen } from '@/store/layout'
import { $activeGatewayProfile } from '@/store/profile'
import {
  $activeSessionId,
  $currentBranch,
  $currentCwd,
  $newChatWorkspaceTarget,
  $selectedStoredSessionId,
  $sessions,
  applyConfiguredDefaultProjectDir,
  setNewChatWorkspaceTarget
} from '@/store/session'

import {
  $activeProjectId,
  $projects,
  $projectScope,
  $projectsRpcAvailable,
  $projectTree,
  $removedSessionIds,
  $sessionMutationsInFlight,
  $startWorkSessionRequest,
  $worktreeRefreshToken,
  addFolderToProject,
  ALL_PROJECTS,
  beginSessionMutation,
  chooseDraftFolder,
  createProject,
  endSessionMutation,
  ensureProjectForFolder,
  enterProject,
  exitProjectScope,
  followActiveSessionCwd,
  goToProject,
  openFolderAsProject,
  pickProjectFolder,
  projectNameForCwd,
  projectNodeKey,
  refreshProjects,
  refreshProjectTree,
  refreshWorktrees,
  renameProjectOrAdopt,
  resolveNewSessionCwd,
  scanAndRecordRepos,
  setDraftWorkspace,
  tombstoneSessions
} from './projects'

vi.mock('@/i18n', () => ({
  translateNow: (key: string, ...args: unknown[]) => (args.length ? `${key}(${args.join(', ')})` : key)
}))

vi.mock('@/store/notifications', () => ({
  notify: vi.fn(),
  notifyError: vi.fn()
}))

vi.mock('@/lib/desktop-fs', () => ({
  desktopDefaultCwd: vi.fn(),
  isDesktopFsRemoteMode: vi.fn(),
  selectDesktopPaths: vi.fn(),
  writeDesktopFileText: vi.fn()
}))

vi.mock('@/store/gateway', () => ({
  $gateway: atom(null),
  activeGateway: vi.fn(),
  ensureActiveGatewayOpen: vi.fn()
}))

vi.mock('@/lib/desktop-git', () => ({ desktopGit: vi.fn() }))

vi.mock('@/hermes', () => ({
  getHermesConfig: vi.fn(),
  getProfiles: vi.fn(),
  setApiRequestProfile: vi.fn(),
  STARTUP_REQUEST_TIMEOUT_MS: 1000
}))

const fs = await import('@/lib/desktop-fs')
const desktopDefaultCwd = vi.mocked(fs.desktopDefaultCwd)
const isDesktopFsRemoteMode = vi.mocked(fs.isDesktopFsRemoteMode)
const selectDesktopPaths = vi.mocked(fs.selectDesktopPaths)

const gw = await import('@/store/gateway')
const activeGateway = vi.mocked(gw.activeGateway)
const gatewayAtom = gw.$gateway

const git = await import('@/lib/desktop-git')
const desktopGit = vi.mocked(git.desktopGit)

const agentx = await import('@/hermes')
const getHermesConfig = vi.mocked(agentx.getHermesConfig)
const notifications = await import('@/store/notifications')
const notify = vi.mocked(notifications.notify)
const notifyError = vi.mocked(notifications.notifyError)

function deferred<T>() {
  let resolve!: (value: T) => void

  const promise = new Promise<T>(done => {
    resolve = done
  })

  return { promise, resolve }
}

// A gateway whose projects.* answers come from `handlers` (by method), with
// list/tree reads echoing the cached atoms so reconciles don't wipe them.
function fakeGateway(handlers: Record<string, (params: Record<string, unknown>) => unknown> = {}) {
  const request = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    if (handlers[method]) {
      return handlers[method](params)
    }

    if (method === 'projects.list') {
      return { active_id: null, projects: $projects.get() }
    }

    if (method === 'projects.tree') {
      return { active_id: null, projects: $projectTree.get(), scoped_session_ids: [] }
    }

    return {}
  })

  activeGateway.mockReturnValue({ connectionState: 'open', request } as never)

  return request
}

const treeNode = (
  over: Partial<SidebarProjectTree> & Pick<SidebarProjectTree, 'id' | 'label'>
): SidebarProjectTree => ({
  path: null,
  repos: [],
  sessionCount: 0,
  ...over
})

describe('project scope', () => {
  beforeEach(() => {
    window.localStorage.clear()
    $projectScope.set(ALL_PROJECTS)
  })

  it('defaults to ALL_PROJECTS', () => {
    expect($projectScope.get()).toBe(ALL_PROJECTS)
  })

  it('enterProject scopes the sidebar to the project id', () => {
    // setActiveProject fires best-effort (no gateway in test → it rejects and is
    // swallowed); the synchronous scope change is what matters here.
    enterProject('p_123')
    expect($projectScope.get()).toBe('p_123')
  })

  it('exitProjectScope returns to the overview', () => {
    enterProject('p_123')
    exitProjectScope()
    expect($projectScope.get()).toBe(ALL_PROJECTS)
  })

  it('entering the synthetic Home bucket still scopes (no active pin)', () => {
    enterProject(NO_PROJECT_ID)
    expect($projectScope.get()).toBe(NO_PROJECT_ID)
  })

  it('persists the scope to localStorage', () => {
    enterProject('p_abc')
    expect(window.localStorage.getItem('agentx.desktop.projectScope')).toBe('p_abc')
  })
})

describe('resolveNewSessionCwd', () => {
  beforeEach(() => {
    $projectScope.set(ALL_PROJECTS)
    applyConfiguredDefaultProjectDir('/home/user/configured')
    $currentCwd.set('')
    $selectedStoredSessionId.set(null)
    $sessions.set([])
    // Reset focused-session projections by clearing the inputs they read.
    // $focusedStoredSessionId falls back to $selectedStoredSessionId.
    // $focusedSessionState needs a runtime — leave it empty via no session states.
  })

  afterEach(() => {
    applyConfiguredDefaultProjectDir(null)
    $projectScope.set(ALL_PROJECTS)
    $currentCwd.set('')
    $selectedStoredSessionId.set(null)
    $sessions.set([])
  })

  it('starts a chat detached inside Home, ignoring the configured default dir', () => {
    // Attaching the default dir here would move the new chat out of Home the
    // moment it was created — "no folder" is what the bucket means.
    enterProject(NO_PROJECT_ID)

    expect(resolveNewSessionCwd()).toBe('')
  })

  it('still falls back to the configured default outside Home', () => {
    expect(resolveNewSessionCwd()).toBe('/home/user/configured')
  })

  it('inherits the focused session workspace when not drilled into a project', () => {
    // Simulate a primary session whose stored row carries a project cwd —
    // the common case: you're in a chat that has a pwd, hit ⌘N/⌘T, and
    // expect the new draft to stay in that project without sidebar drill-in.
    $selectedStoredSessionId.set('sess-a')
    $sessions.set([
      {
        archived: false,
        cwd: '/Users/me/www/agentx-agent',
        ended_at: null,
        id: 'sess-a',
        input_tokens: 0,
        is_active: true,
        last_active: 0,
        message_count: 1,
        model: null,
        output_tokens: 0,
        started_at: 0,
        title: 'work'
      } as never
    ])

    expect(resolveNewSessionCwd()).toBe('/Users/me/www/agentx-agent')
  })

  it('does not re-attach a remembered cwd when the focused session is detached', () => {
    $currentCwd.set('/Users/me/stale-remembered')
    $selectedStoredSessionId.set('sess-detached')
    $sessions.set([
      {
        archived: false,
        cwd: null,
        ended_at: null,
        id: 'sess-detached',
        input_tokens: 0,
        is_active: true,
        last_active: 0,
        message_count: 1,
        model: null,
        output_tokens: 0,
        started_at: 0,
        title: 'loose'
      } as never
    ])

    // Focused session has no workspace → fall through to configured default,
    // not the stale $currentCwd from an earlier chat.
    expect(resolveNewSessionCwd()).toBe('/home/user/configured')
  })
})

describe('projectNameForCwd', () => {
  beforeEach(() => {
    $projectTree.set([])
  })

  it('names the explicit project owning the cwd (longest path match)', () => {
    $projectTree.set([
      treeNode({ id: 'p_web', label: 'Website', path: '/repos/website' }),
      treeNode({ id: 'p_api', label: 'API', path: '/repos/api' })
    ])

    expect(projectNameForCwd('/repos/website/src/app')).toBe('Website')
  })

  it('matches nested repo and worktree paths, not just the project root', () => {
    $projectTree.set([
      treeNode({
        id: 'p_mono',
        label: 'Monorepo',
        path: '/repos/mono',
        repos: [
          {
            id: 'r1',
            label: 'mono',
            path: '/repos/mono',
            sessionCount: 0,
            groups: [{ id: 'g1', label: 'feature', path: '/elsewhere/mono-feature', sessions: [] }]
          }
        ]
      })
    ])

    // A linked worktree lives OUTSIDE the project root but still belongs to it.
    expect(projectNameForCwd('/elsewhere/mono-feature/src')).toBe('Monorepo')
  })

  it('ignores auto-projects and the No-project bucket (no named identity)', () => {
    $projectTree.set([
      treeNode({ id: '/repos/loose', label: 'loose', path: '/repos/loose', isAuto: true }),
      treeNode({ id: '__no_project__', label: 'No project', path: null, isNoProject: true })
    ])

    expect(projectNameForCwd('/repos/loose/src')).toBeNull()
  })

  it('returns null for a cwd in no project and for a blank cwd', () => {
    $projectTree.set([treeNode({ id: 'p_web', label: 'Website', path: '/repos/website' })])

    expect(projectNameForCwd('/somewhere/else')).toBeNull()
    expect(projectNameForCwd('')).toBeNull()
  })
})

describe('worktree refresh', () => {
  it('refreshWorktrees bumps the probe token so useRepoWorktreeMap refetches', () => {
    const before = $worktreeRefreshToken.get()
    refreshWorktrees()
    expect($worktreeRefreshToken.get()).toBe(before + 1)
  })
})

describe('pickProjectFolder', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uses the remote-aware directory picker locally', async () => {
    isDesktopFsRemoteMode.mockReturnValue(false)
    selectDesktopPaths.mockResolvedValue(['/local/repo'])

    await expect(pickProjectFolder()).resolves.toBe('/local/repo')
    expect(selectDesktopPaths).toHaveBeenCalledWith({ defaultPath: undefined, directories: true, multiple: false })
  })

  it('seeds the picker with the backend cwd on a remote gateway', async () => {
    isDesktopFsRemoteMode.mockReturnValue(true)
    desktopDefaultCwd.mockResolvedValue({ branch: 'main', cwd: '/backend/work' })
    selectDesktopPaths.mockResolvedValue(['/backend/work/repo'])

    await expect(pickProjectFolder()).resolves.toBe('/backend/work/repo')
    expect(selectDesktopPaths).toHaveBeenCalledWith({
      defaultPath: '/backend/work',
      directories: true,
      multiple: false
    })
  })

  it('returns null when the picker is cancelled (empty selection)', async () => {
    isDesktopFsRemoteMode.mockReturnValue(false)
    selectDesktopPaths.mockResolvedValue([])

    await expect(pickProjectFolder()).resolves.toBeNull()
  })
})

describe('createProject', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    $sidebarWorkspaceNodeOpen.set({})
    $activeProjectId.set(null)
    $projectsRpcAvailable.set(null)
  })

  it('creates the project and opens its row in the sidebar', async () => {
    const created = { folders: [], id: 'p_new', name: 'Demo', primary_path: '/srv/demo' }

    const request = vi.fn(async (method: string) => {
      if (method === 'projects.create') {
        return { project: created }
      }

      // Reconcile (fire-and-forget) re-reads list + tree; echo the project back
      // so the optimistic state survives instead of being wiped to empty.
      return { active_id: 'p_new', projects: [created], scoped_session_ids: [] }
    })

    activeGateway.mockReturnValue({ connectionState: 'open', request } as never)

    const result = await createProject({ folders: ['/srv/demo'], name: 'Demo', use: true })

    expect(result).toEqual(created)
    expect(request).toHaveBeenCalledWith('projects.create', expect.objectContaining({ name: 'Demo' }))
    expect($sidebarWorkspaceNodeOpen.get()[projectNodeKey('p_new')]).toBe(true)
    expect($activeProjectId.get()).toBe('p_new')
  })

  it('marks the backend stale and surfaces a friendly error when projects.create is missing', async () => {
    activeGateway.mockReturnValue({
      connectionState: 'open',
      request: vi.fn().mockRejectedValue(new Error('unknown method: projects.create'))
    } as never)

    await expect(createProject({ folders: ['/srv/demo'], name: 'Demo' })).rejects.toThrow(
      'sidebar.projects.staleBackend'
    )
    expect($projectsRpcAvailable.get()).toBe(false)
  })
})

describe('projects RPC capability', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    $projectsRpcAvailable.set(null)
  })

  it('marks the backend stale when projects.list is missing', async () => {
    activeGateway.mockReturnValue({
      connectionState: 'open',
      request: vi.fn().mockRejectedValue(new Error('unknown method: projects.list'))
    } as never)

    await refreshProjects()

    expect($projectsRpcAvailable.get()).toBe(false)
  })

  it('still opens a folder as a plain workspace when the backend predates projects', async () => {
    const missing = (method: string) => () => {
      throw new Error(`unknown method: ${method}`)
    }

    fakeGateway({
      'projects.create': missing('projects.create'),
      'projects.list': missing('projects.list'),
      'projects.tree': missing('projects.tree')
    })

    await openFolderAsProject('/srv/legacy')

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'warning', message: 'sidebar.projects.staleBackend' })
    )
    expect($startWorkSessionRequest.get()).toMatchObject({ openTab: true, path: '/srv/legacy' })
  })
})

describe('repository discovery policy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    $activeGatewayProfile.set('default')
    isDesktopFsRemoteMode.mockReturnValue(false)
  })

  function gatewayWith(request: ReturnType<typeof vi.fn>) {
    const gateway = { connectionState: 'open', request }
    activeGateway.mockReturnValue(gateway as never)
    gatewayAtom.set(gateway as never)

    return gateway
  }

  it('records disabled policy without invoking the filesystem scanner', async () => {
    const request = vi.fn(async (method: string) =>
      method === 'projects.tree'
        ? { active_id: null, projects: [], scoped_session_ids: [] }
        : { accepted: false, repos: [] }
    )

    gatewayWith(request)
    const scanRepos = vi.fn()
    desktopGit.mockReturnValue({ scanRepos } as never)
    getHermesConfig.mockResolvedValue({
      desktop: {
        repo_scan_enabled: false,
        repo_scan_exclude_paths: [],
        repo_scan_roots: []
      }
    })

    await scanAndRecordRepos()

    expect(scanRepos).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledWith('projects.record_repos', {
      discovery_policy: { enabled: false, exclude_paths: [], roots: [] },
      repos: []
    })
  })

  it('passes custom roots and exclusions to Electron and records on the origin gateway', async () => {
    const request = vi.fn(async (method: string) =>
      method === 'projects.tree'
        ? { active_id: null, projects: [], scoped_session_ids: [] }
        : { accepted: true, repos: [] }
    )

    gatewayWith(request)
    const scanRepos = vi.fn().mockResolvedValue([{ label: 'repo', root: '/work/repo' }])
    desktopGit.mockReturnValue({ scanRepos } as never)
    getHermesConfig.mockResolvedValue({
      desktop: {
        repo_scan_enabled: true,
        repo_scan_exclude_paths: ['/work/vendor'],
        repo_scan_roots: ['/work']
      }
    })

    await scanAndRecordRepos()

    expect(getHermesConfig).toHaveBeenCalledWith('default')
    expect(scanRepos).toHaveBeenCalledWith(['/work'], {
      enabled: true,
      excludePaths: ['/work/vendor']
    })
    expect(request).toHaveBeenCalledWith('projects.record_repos', {
      discovery_policy: {
        enabled: true,
        exclude_paths: ['/work/vendor'],
        roots: ['/work']
      },
      repos: [{ label: 'repo', root: '/work/repo' }]
    })
  })

  it('does not scan the local filesystem for remote connections', async () => {
    isDesktopFsRemoteMode.mockReturnValue(true)
    const scanRepos = vi.fn()
    desktopGit.mockReturnValue({ scanRepos } as never)

    await scanAndRecordRepos(true)

    expect(scanRepos).not.toHaveBeenCalled()
    expect(getHermesConfig).not.toHaveBeenCalled()
  })
})

describe('project tree profile isolation', () => {
  it('does not publish a late response from the previous profile', async () => {
    let resolveA: ((value: unknown) => void) | undefined

    const responseA = new Promise(resolve => {
      resolveA = resolve
    })

    const gatewayA = { connectionState: 'open', request: vi.fn(() => responseA) }

    const gatewayB = {
      connectionState: 'open',
      request: vi.fn().mockResolvedValue({
        active_id: null,
        projects: [{ id: 'profile-b', label: 'Profile B', path: null, repos: [], sessionCount: 0 }],
        scoped_session_ids: []
      })
    }

    let current = gatewayA
    activeGateway.mockImplementation(() => current as never)
    gatewayAtom.set(gatewayA as never)

    const pendingA = refreshProjectTree()
    current = gatewayB
    $activeGatewayProfile.set('profile-b')
    gatewayAtom.set(gatewayB as never)
    await refreshProjectTree()
    resolveA?.({
      active_id: null,
      projects: [{ id: 'profile-a', label: 'Profile A', path: null, repos: [], sessionCount: 0 }],
      scoped_session_ids: []
    })
    await pendingA

    expect($projectTree.get().map(project => project.id)).toEqual(['profile-b'])
  })
})

describe('tombstone pruning', () => {
  const openGatewayReturning = (scopedIds: string[]) => {
    const gateway = {
      connectionState: 'open',
      request: vi.fn().mockResolvedValue({ active_id: null, projects: [], scoped_session_ids: scopedIds })
    }

    activeGateway.mockImplementation(() => gateway as never)
    gatewayAtom.set(gateway as never)

    return gateway
  }

  beforeEach(() => {
    $removedSessionIds.set(new Set())
    $sessionMutationsInFlight.set(new Set())
  })

  it('keeps an in-flight delete tombstone even when the backend snapshot omits it', async () => {
    // Optimistic delete: hide the row, mark the RPC as in flight.
    tombstoneSessions(['sess-1'])
    beginSessionMutation(['sess-1'])

    // A projects.tree refresh races the pending delete: the id is already gone
    // from scope, but the RPC hasn't landed — the tombstone must survive so the
    // row doesn't flash back.
    openGatewayReturning([])
    await refreshProjectTree()

    expect($removedSessionIds.get().has('sess-1')).toBe(true)
  })

  it('prunes the tombstone once the mutation settles and scope no longer lists it', async () => {
    tombstoneSessions(['sess-1'])
    beginSessionMutation(['sess-1'])
    openGatewayReturning([])
    await refreshProjectTree()

    // Delete RPC settled; the next refresh with the id absent from scope drops it.
    endSessionMutation(['sess-1'])
    await refreshProjectTree()

    expect($removedSessionIds.get().has('sess-1')).toBe(false)
  })
})

describe('the new chat\'s folder (setDraftWorkspace)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    $activeSessionId.set(null)
    $currentCwd.set('')
    $currentBranch.set('')
    setNewChatWorkspaceTarget(undefined)
  })

  afterEach(() => {
    $currentCwd.set('')
    $currentBranch.set('')
    setNewChatWorkspaceTarget(undefined)
  })

  it('points the draft at the folder, then adopts the backend\'s normalized path and branch', async () => {
    const info = deferred<{ branch?: string; cwd?: string }>()
    fakeGateway({ 'config.get': () => info.promise })

    setDraftWorkspace('/work/site')

    expect($newChatWorkspaceTarget.get()).toBe('/work/site')
    expect($currentCwd.get()).toBe('/work/site')

    info.resolve({ branch: 'main', cwd: '/real/work/site' })
    await vi.waitFor(() => expect($currentBranch.get()).toBe('main'))

    expect($currentCwd.get()).toBe('/real/work/site')
    expect($newChatWorkspaceTarget.get()).toBe('/real/work/site')
  })

  it('null starts the chat with no folder, and a late answer for an older pick changes nothing', async () => {
    const info = deferred<{ branch?: string; cwd?: string }>()
    fakeGateway({ 'config.get': () => info.promise })

    setDraftWorkspace('/stale')
    setDraftWorkspace(null)

    expect($newChatWorkspaceTarget.get()).toBeNull()
    expect($currentCwd.get()).toBe('')

    info.resolve({ branch: 'main', cwd: '/stale-normalized' })
    await Promise.resolve()
    await Promise.resolve()

    expect($newChatWorkspaceTarget.get()).toBeNull()
    expect($currentCwd.get()).toBe('')
    expect($currentBranch.get()).toBe('')
  })

  it('ignores the answer once the chat has started', async () => {
    const info = deferred<{ branch?: string; cwd?: string }>()
    fakeGateway({ 'config.get': () => info.promise })

    setDraftWorkspace('/work/site')
    $activeSessionId.set('runtime-1')
    info.resolve({ branch: 'dev', cwd: '/elsewhere' })
    await Promise.resolve()
    await Promise.resolve()

    expect($currentCwd.get()).toBe('/work/site')
    expect($currentBranch.get()).toBe('')
    $activeSessionId.set(null)
  })

  it('"Open another folder…" keeps the pick as a project and points the draft at it', async () => {
    isDesktopFsRemoteMode.mockReturnValue(false)
    selectDesktopPaths.mockResolvedValue(['/work/new-client'])
    $projects.set([])
    $projectTree.set([])

    const request = fakeGateway({
      'config.get': () => ({}),
      'projects.create': params => ({
        project: { folders: [{ path: '/work/new-client' }], id: 'p_client', name: params.name }
      })
    })

    await expect(chooseDraftFolder()).resolves.toBe('/work/new-client')

    expect($newChatWorkspaceTarget.get()).toBe('/work/new-client')
    expect(request).toHaveBeenCalledWith(
      'projects.create',
      expect.objectContaining({ folders: ['/work/new-client'], name: 'new-client' })
    )
  })

  it('a cancelled picker leaves the draft alone', async () => {
    isDesktopFsRemoteMode.mockReturnValue(false)
    selectDesktopPaths.mockResolvedValue([])
    setDraftWorkspace(null)

    await expect(chooseDraftFolder()).resolves.toBeNull()
    expect($newChatWorkspaceTarget.get()).toBeNull()
  })
})

describe('adding a folder as a project', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()
    $projectScope.set(ALL_PROJECTS)
    $projectsRpcAvailable.set(null)
    $projects.set([])
    $projectTree.set([])
    $sidebarWorkspaceNodeOpen.set({})
    $dismissedAutoProjectIds.set([])
  })

  it('reuses the explicit project that already covers the folder', async () => {
    $projects.set([{ folders: [{ path: '/work/acme' }], id: 'p_acme', name: 'Acme' } as never])
    const request = fakeGateway()

    await expect(ensureProjectForFolder('/work/acme/reports')).resolves.toBe('p_acme')

    expect(request).not.toHaveBeenCalledWith('projects.create', expect.anything())
    expect($sidebarWorkspaceNodeOpen.get()[projectNodeKey('p_acme')]).toBe(true)
  })

  it('does not let an auto project that merely contains the folder swallow it', async () => {
    // A chat once ran in the home directory, so an auto project sits there.
    $projectTree.set([treeNode({ id: '/Users/me', isAuto: true, label: 'me', path: '/Users/me', sessionCount: 3 })])

    const request = fakeGateway({
      'projects.create': () => ({ project: { folders: [{ path: '/Users/me/clients' }], id: 'p_c', name: 'clients' } })
    })

    await expect(ensureProjectForFolder('/Users/me/clients')).resolves.toBe('p_c')
    expect(request).toHaveBeenCalledWith('projects.create', expect.objectContaining({ name: 'clients' }))
  })

  it('the sidebar "+" leaves a drilled-in view, adds the folder and opens a chat in it', async () => {
    $projectScope.set('p_other')
    isDesktopFsRemoteMode.mockReturnValue(false)
    selectDesktopPaths.mockResolvedValue(['/work/brand'])

    fakeGateway({
      'projects.create': () => ({ project: { folders: [{ path: '/work/brand' }], id: 'p_brand', name: 'brand' } })
    })

    await openFolderAsProject()

    expect($projectScope.get()).toBe(ALL_PROJECTS)
    expect($sidebarWorkspaceNodeOpen.get()[projectNodeKey('p_brand')]).toBe(true)
    expect($startWorkSessionRequest.get()).toMatchObject({ openTab: true, path: '/work/brand' })
  })

  it('a cancelled picker does nothing', async () => {
    isDesktopFsRemoteMode.mockReturnValue(false)
    selectDesktopPaths.mockResolvedValue([])
    const before = $startWorkSessionRequest.get()
    const request = fakeGateway()

    await openFolderAsProject()

    expect(request).not.toHaveBeenCalled()
    expect($startWorkSessionRequest.get()).toBe(before)
  })

  it('a chat moving into a folder whose auto project was hidden brings the project back', async () => {
    $dismissedAutoProjectIds.set(['/work/old'])
    $projectTree.set([treeNode({ id: '/work/old', isAuto: true, label: 'old', path: '/work/old', sessionCount: 1 })])
    fakeGateway()

    await followActiveSessionCwd('/work/old')

    expect($dismissedAutoProjectIds.get()).toEqual([])
    expect($sidebarWorkspaceNodeOpen.get()[projectNodeKey('/work/old')]).toBe(true)
  })
})

describe('a project row\'s "Add folder…"', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isDesktopFsRemoteMode.mockReturnValue(false)
    $projects.set([{ folders: [{ path: '/work/acme' }], id: 'p_acme', name: 'Acme' } as never])
    $projectTree.set([treeNode({ id: 'p_acme', label: 'Acme', path: '/work/acme' })])
  })

  it('goes straight to the picker and says what it added', async () => {
    selectDesktopPaths.mockResolvedValue(['/shared/acme-assets'])
    const request = fakeGateway()

    await addFolderToProject({ id: 'p_acme', name: 'Acme' })

    expect(request).toHaveBeenCalledWith(
      'projects.add_folder',
      expect.objectContaining({ id: 'p_acme', path: '/shared/acme-assets' })
    )
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'success', message: 'sidebar.projects.folderAdded(acme-assets, Acme)' })
    )
  })

  it('writes nothing when the picker is cancelled', async () => {
    selectDesktopPaths.mockResolvedValue([])
    const request = fakeGateway()

    await addFolderToProject({ id: 'p_acme', name: 'Acme' })

    expect(request).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it('a refused write rolls the folder back and says so', async () => {
    selectDesktopPaths.mockResolvedValue(['/shared/acme-assets'])

    fakeGateway({
      'projects.add_folder': () => {
        throw new Error('nope')
      }
    })

    await addFolderToProject({ id: 'p_acme', name: 'Acme' })

    expect(notifyError).toHaveBeenCalledWith(expect.any(Error), 'sidebar.projects.addFolderFailed')
    expect($projects.get()[0]?.folders).toEqual([{ path: '/work/acme' }])
  })
})

describe('renaming a project', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    $projects.set([])
    $projectTree.set([])
  })

  it('renames an explicit project in place', async () => {
    $projects.set([{ folders: [], id: 'p_1', name: 'Old' } as never])
    $projectTree.set([treeNode({ id: 'p_1', label: 'Old' })])
    const request = fakeGateway()

    await renameProjectOrAdopt({ mode: 'rename', name: 'Old', projectId: 'p_1' }, '  New  ')

    expect(request).toHaveBeenCalledWith('projects.update', expect.objectContaining({ id: 'p_1', name: 'New' }))
    expect($projectTree.get()[0]?.label).toBe('New')
  })

  it('adopts an auto project as a real one carrying the new name and its look', async () => {
    $projectTree.set([
      treeNode({ color: '#f00', icon: 'rocket', id: '/work/site', isAuto: true, label: 'site', path: '/work/site' })
    ])

    const request = fakeGateway({
      'projects.create': () => ({ project: { folders: [{ path: '/work/site' }], id: 'p_site', name: 'Website' } })
    })

    await renameProjectOrAdopt(
      { adoptPath: '/work/site', mode: 'rename', name: 'site', projectId: '/work/site' },
      'Website'
    )

    expect(request).toHaveBeenCalledWith(
      'projects.create',
      expect.objectContaining({
        color: '#f00',
        folders: ['/work/site'],
        icon: 'rocket',
        name: 'Website',
        primary_path: '/work/site'
      })
    )
  })

  it('a blank name writes nothing', async () => {
    const request = fakeGateway()

    await renameProjectOrAdopt({ mode: 'rename', name: 'Old', projectId: 'p_1' }, '   ')

    expect(request).not.toHaveBeenCalled()
  })
})

describe('going to a project', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()
    $projectScope.set(ALL_PROJECTS)
    $sidebarWorkspaceNodeOpen.set({})
    $projectTree.set([treeNode({ id: 'p_site', label: 'Site', path: '/work/site' })])
  })

  it('opens its row and starts a chat in its folder, leaving any other drilled-in view', () => {
    $projectScope.set('p_other')

    goToProject('p_site')

    expect($projectScope.get()).toBe(ALL_PROJECTS)
    expect($sidebarWorkspaceNodeOpen.get()[projectNodeKey('p_site')]).toBe(true)
    expect($startWorkSessionRequest.get()).toMatchObject({ openTab: true, path: '/work/site' })
  })
})

describe('following the active chat into another folder', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()
    $projectScope.set(ALL_PROJECTS)
    $sidebarWorkspaceNodeOpen.set({})
    $projects.set([])
    $projectTree.set([
      treeNode({ id: 'p_a', label: 'A', path: '/work/a' }),
      treeNode({ id: 'p_b', label: 'B', path: '/work/b' })
    ])
    fakeGateway()
  })

  it('opens the new project\'s row at the overview — it never drills in', async () => {
    await followActiveSessionCwd('/work/b/src')

    expect($projectScope.get()).toBe(ALL_PROJECTS)
    expect($sidebarWorkspaceNodeOpen.get()[projectNodeKey('p_b')]).toBe(true)
  })

  it('moves a drilled-in view along, so the chat stays in sight', async () => {
    $projectScope.set('p_a')

    await followActiveSessionCwd('/work/b')

    expect($projectScope.get()).toBe('p_b')
  })
})
