import { useStore } from '@nanostores/react'
import { useMemo } from 'react'

import type { SidebarProjectTree } from '@/app/chat/sidebar/projects/workspace-groups'
import { Codicon } from '@/components/ui/codicon'
import { IconTile, tintFor } from '@/components/ui/icon-tile'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { displayPath, pathLeaf } from '@/lib/display-path'
import { Check, FolderOff, Plus } from '@/lib/icons'
import { $dismissedAutoProjectIds, filterVisibleProjects } from '@/store/layout'
import { $projectTree, chooseDraftFolder, projectRootCwd, setDraftWorkspace } from '@/store/projects'

import { pickableWorkspaces, projectForCwd } from './composer/workspace-picker'

/** Three folders, as the platform's own "recents" lists keep it: enough to
 *  pick up yesterday's work, few enough to read at a glance. */
const SHOWN_FOLDERS = 3

export type HomeWorkspaceRow =
  | { kind: 'folder'; key: string; label: string; path: string; project?: SidebarProjectTree; selected: boolean }
  | { kind: 'none'; key: 'none'; selected: boolean }

/**
 * The rows of the home surface's folder card: the most recently used folders
 * (the composer picker's own order), the one this new chat is pointed at
 * always among them and checked, then "no folder". Pure, so the selection
 * rule is testable without a renderer.
 */
export function homeWorkspaceRows(projects: readonly SidebarProjectTree[], cwd: string): HomeWorkspaceRow[] {
  const here = cwd.trim()
  const { discovered, recent } = pickableWorkspaces(projects)
  const owner = here ? projectForCwd(projects, here) : undefined
  // An auto project only stands for its own root — one that merely contains
  // the folder (a chat once ran in the home directory) says nothing about it.
  const current = owner && (!owner.isAuto || projectRootCwd(owner) === here) ? owner : undefined

  let shown = [...recent, ...discovered].slice(0, SHOWN_FOLDERS)

  if (current && !shown.some(project => project.id === current.id)) {
    shown = [...shown.slice(0, SHOWN_FOLDERS - 1), current]
  }

  const rows: HomeWorkspaceRow[] = shown.map(project => ({
    key: project.id,
    kind: 'folder',
    label: project.label,
    path: projectRootCwd(project),
    project,
    selected: current?.id === project.id
  }))

  // A folder no project names yet: it is still where this chat will work.
  // It takes the LAST slot, not the first — picking a listed folder then
  // leaves every row above it where it was, instead of sliding them all up
  // under the pointer.
  if (here && !current) {
    rows.splice(SHOWN_FOLDERS - 1)
    rows.push({ key: `path:${here}`, kind: 'folder', label: pathLeaf(here) || here, path: here, selected: true })
  }

  rows.push({ key: 'none', kind: 'none', selected: !here })

  return rows
}

function FolderTile({ project, label }: { label: string; project?: SidebarProjectTree }) {
  return (
    <IconTile
      size="sm"
      style={project?.color ? ({ '--tile-tint': project.color } as React.CSSProperties) : undefined}
      tint={tintFor(label)}
    >
      <Codicon name={project?.icon || 'folder'} size="0.875rem" />
    </IconTile>
  )
}

/**
 * Where the new chat works, chosen on the home surface itself — a short inset
 * list in the platform's grouped style. The same choice the context bar under the composer offers (it
 * shows the same folders in the same order); this is the version you see
 * before you have looked for it.
 */
export function HomeWorkspaces({ cwd }: { cwd: string }) {
  const { t } = useI18n()
  const copy = t.composer.workspace
  const tree = useStore($projectTree)
  const dismissed = useStore($dismissedAutoProjectIds)
  const projects = useMemo(() => filterVisibleProjects(tree, dismissed), [tree, dismissed])
  const rows = useMemo(() => homeWorkspaceRows(projects, cwd), [projects, cwd])

  return (
    <div className="home-workspaces intro-enter" style={{ '--intro-step': 2 } as React.CSSProperties}>
      <div aria-label={copy.pickerLabel} className="home-workspaces-sheet" role="group">
        {rows.map(row => {
          const choose = () => setDraftWorkspace(row.kind === 'folder' ? row.path : null)

          // The full path on hover, for two folders that share a name.
          return (
            <Tip key={row.key} label={row.kind === 'folder' ? displayPath(row.path) : undefined} side="right">
              <button
                aria-pressed={row.selected}
                className="home-workspace-row"
                data-system={row.kind === 'none' ? '' : undefined}
                onClick={choose}
                type="button"
              >
                {row.kind === 'folder' ? (
                  <FolderTile label={row.label} project={row.project} />
                ) : (
                  <IconTile size="sm" tint="graphite">
                    <FolderOff />
                  </IconTile>
                )}
                <span className="truncate">{row.kind === 'folder' ? row.label : copy.noFolder}</span>
                {row.selected ? <Check className="home-workspace-check" /> : <span />}
              </button>
            </Tip>
          )
        })}
        <button className="home-workspace-row" data-action="" onClick={() => void chooseDraftFolder()} type="button">
          <IconTile size="sm" tint="blue">
            <Plus />
          </IconTile>
          <span className="truncate">{copy.chooseOther}</span>
          <span />
        </button>
      </div>
      <p className="home-workspaces-footnote">{copy.chooseHint}</p>
    </div>
  )
}
