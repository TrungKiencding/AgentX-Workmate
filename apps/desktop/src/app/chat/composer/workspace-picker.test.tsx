import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type * as Nanostores from 'nanostores'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { SidebarProjectTree } from '@/app/chat/sidebar/projects/workspace-groups'
import { I18nProvider } from '@/i18n'
import { $dismissedAutoProjectIds } from '@/store/layout'

import { workspaceLabel, WorkspacePicker } from './workspace-picker'

// Radix Popover + cmdk reach for ResizeObserver / scrollIntoView / pointer
// capture, none of which jsdom implements.
beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      disconnect() {}
      observe() {}
      unobserve() {}
    }
  )
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.releasePointerCapture = vi.fn()
})

const { $projectTree } = vi.hoisted(() => {
  const { atom } = require('nanostores') as typeof Nanostores

  return { $projectTree: atom<SidebarProjectTree[]>([]) }
})

vi.mock('@/store/projects', () => ({
  $projectTree,
  chooseDraftFolder: vi.fn(async () => null),
  copyPath: vi.fn(),
  projectRootCwd: (project: SidebarProjectTree) =>
    (project.path || project.repos.find(repo => repo.path)?.path || '').trim(),
  requestStartWorkSession: vi.fn(),
  revealPath: vi.fn(),
  setDraftWorkspace: vi.fn()
}))

const store = await import('@/store/projects')

const node = (over: Partial<SidebarProjectTree> & Pick<SidebarProjectTree, 'id' | 'label'>): SidebarProjectTree => ({
  path: over.id,
  repos: [],
  sessionCount: 1,
  ...over
})

const TREE = [
  node({ id: 'p_report', label: 'Báo cáo quý 3', lastActive: 10, path: '/work/bao-cao' }),
  node({ id: 'p_mkt', label: 'Kế hoạch marketing', lastActive: 30, path: '/work/marketing' }),
  node({ id: '/code/site', isAuto: true, label: 'site', lastActive: 20 }),
  node({ id: '/code/scanned', isAuto: true, label: 'scanned', sessionCount: 0 }),
  node({ id: '__no_project__', isNoProject: true, label: 'Home', path: null })
]

const renderPicker = (props: { cwd: string; draft: boolean }) =>
  render(
    <I18nProvider configClient={null}>
      <WorkspacePicker {...props} />
    </I18nProvider>
  )

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  $projectTree.set([])
  $dismissedAutoProjectIds.set([])
})

describe('WorkspacePicker — a new chat', () => {
  it('names the chosen folder by its project', () => {
    $projectTree.set(TREE)
    renderPicker({ cwd: '/work/marketing', draft: true })

    expect(screen.getByRole('button', { name: 'Chọn thư mục làm việc' }).textContent).toContain('Kế hoạch marketing')
  })

  it('asks for a folder when none is chosen', () => {
    renderPicker({ cwd: '', draft: true })

    expect(screen.getByRole('button', { name: 'Chọn thư mục làm việc' }).textContent).toContain('Chọn thư mục')
  })

  it('lists projects by recent activity, then the repos found on disk, and never Home', async () => {
    $projectTree.set(TREE)
    const { baseElement } = renderPicker({ cwd: '/work/marketing', draft: true })

    fireEvent.click(screen.getByRole('button', { name: 'Chọn thư mục làm việc' }))

    await screen.findAllByRole('option')

    // Each cmdk group carries its heading, then its rows.
    const groups = [...baseElement.querySelectorAll<HTMLElement>('[cmdk-group]')]
    const heading = (group: HTMLElement) => group.querySelector('[cmdk-group-heading]')?.textContent

    const names = (group: HTMLElement) =>
      [...group.querySelectorAll('[data-slot="command-item"] .truncate:first-child')].map(item => item.textContent)

    const [projects, discovered] = groups
    expect(heading(projects)).toBe('Dự án')
    expect(names(projects)).toEqual(['Kế hoạch marketing', 'site', 'Báo cáo quý 3'])
    expect(heading(discovered)).toBe('Tìm thấy trên máy')
    expect(names(discovered)).toEqual(['scanned'])
    expect(screen.queryByText('Home')).toBeNull()
  })

  it('picking a project points the new chat at its folder', async () => {
    $projectTree.set(TREE)
    renderPicker({ cwd: '', draft: true })

    fireEvent.click(screen.getByRole('button', { name: 'Chọn thư mục làm việc' }))
    fireEvent.click(await screen.findByText('Báo cáo quý 3'))

    expect(store.setDraftWorkspace).toHaveBeenCalledWith('/work/bao-cao')
  })

  it('offers another folder from disk, and dropping the folder once one is set', async () => {
    $projectTree.set(TREE)
    renderPicker({ cwd: '/work/bao-cao', draft: true })

    fireEvent.click(screen.getByRole('button', { name: 'Chọn thư mục làm việc' }))
    fireEvent.click(await screen.findByText('Không dùng thư mục'))
    expect(store.setDraftWorkspace).toHaveBeenCalledWith(null)

    fireEvent.click(screen.getByRole('button', { name: 'Chọn thư mục làm việc' }))
    fireEvent.click(await screen.findByText('Mở thư mục khác…'))
    expect(store.chooseDraftFolder).toHaveBeenCalled()
  })

  it('a hidden project stays out of the list', async () => {
    $projectTree.set(TREE)
    $dismissedAutoProjectIds.set(['/code/site'])
    renderPicker({ cwd: '', draft: true })

    fireEvent.click(screen.getByRole('button', { name: 'Chọn thư mục làm việc' }))
    await screen.findByText('Báo cáo quý 3')

    expect(screen.queryByText('site')).toBeNull()
  })
})

describe('WorkspacePicker — a chat that has started', () => {
  it('its folder is settled: the control shows it and offers a new chat there', async () => {
    $projectTree.set(TREE)
    renderPicker({ cwd: '/work/bao-cao', draft: false })

    expect(screen.queryByRole('button', { name: 'Chọn thư mục làm việc' })).toBeNull()

    const trigger = screen.getByRole('button', { name: 'Thư mục: Báo cáo quý 3' })
    fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
    fireEvent.pointerUp(trigger, { button: 0, pointerType: 'mouse' })
    fireEvent.click(trigger)

    fireEvent.click(await screen.findByRole('menuitem', { name: 'Trò chuyện mới trong thư mục này' }))
    expect(store.requestStartWorkSession).toHaveBeenCalledWith('/work/bao-cao', undefined, { openTab: true })
  })

  it('a chat with no folder shows nothing', () => {
    const { container } = renderPicker({ cwd: '', draft: false })

    expect(container.querySelector('button')).toBeNull()
  })
})

describe('workspaceLabel', () => {
  it("uses a named project's name for any folder inside it", () => {
    expect(workspaceLabel(TREE, '/work/bao-cao/thang-9')).toBe('Báo cáo quý 3')
  })

  it("an auto project only names its own root — a folder inside it reads as itself", () => {
    const tree = [node({ id: '/Users/me', isAuto: true, label: 'me' })]

    expect(workspaceLabel(tree, '/Users/me')).toBe('me')
    expect(workspaceLabel(tree, '/Users/me/Downloads/invoices')).toBe('invoices')
  })

  it('a folder in no project reads as its own name', () => {
    expect(workspaceLabel(TREE, '/tmp/scratch')).toBe('scratch')
  })
})
