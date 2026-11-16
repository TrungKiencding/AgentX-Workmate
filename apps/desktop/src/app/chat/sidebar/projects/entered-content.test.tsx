import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { SessionInfo } from '@/hermes'
import { I18nProvider } from '@/i18n'

import { EnteredProjectContent } from './entered-content'
import type { SidebarProjectTree } from './workspace-groups'

afterEach(cleanup)

const chat = (id: string) => ({ id, title: id }) as unknown as SessionInfo
const renderRows = (rows: SessionInfo[]) => rows.map(row => <div key={row.id}>{row.title}</div>)

const project = (laneLabel: string): SidebarProjectTree => ({
  id: 'p_1',
  label: 'Báo cáo quý 3',
  path: '/work/bao-cao',
  repos: [
    {
      groups: [
        {
          id: '/work/bao-cao::branch::main',
          isMain: true,
          label: laneLabel,
          path: '/work/bao-cao',
          sessions: [chat('Tóm tắt doanh thu'), chat('Biểu đồ chi phí')]
        }
      ],
      id: '/work/bao-cao',
      label: 'bao-cao',
      path: '/work/bao-cao',
      sessionCount: 2
    }
  ],
  sessionCount: 2
})

const renderContent = (tree: SidebarProjectTree) =>
  render(
    <I18nProvider configClient={null}>
      <EnteredProjectContent project={tree} renderRows={renderRows} />
    </I18nProvider>
  )

describe('EnteredProjectContent', () => {
  it('lists a plain folder’s chats directly — no branch header repeating the folder name', () => {
    renderContent(project('bao-cao'))

    expect(screen.getByText('Tóm tắt doanh thu')).toBeTruthy()
    expect(screen.getByText('Biểu đồ chi phí')).toBeTruthy()
    expect(screen.queryByTitle(/^bao-cao /)).toBeNull()
  })

  it('a git repo keeps its branch lane', () => {
    renderContent(project('main'))

    // The lane label keeps its tail pinned in its own span; its title is whole.
    expect(screen.getByTitle(/^main /)).toBeTruthy()
    expect(screen.getByText('Tóm tắt doanh thu')).toBeTruthy()
  })
})
