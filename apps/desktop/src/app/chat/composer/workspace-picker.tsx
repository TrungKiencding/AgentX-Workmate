import { useStore } from '@nanostores/react'
import { useMemo, useState } from 'react'

import { sidebarProjects, type SidebarProjectTree } from '@/app/chat/sidebar/projects/workspace-groups'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator
} from '@/components/ui/command'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { displayPath, pathLeaf, tailPath } from '@/lib/display-path'
import { Check, ChevronDown, Copy, Folder, FolderOff, FolderOpen, MessagePlus } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { $dismissedAutoProjectIds, filterVisibleProjects } from '@/store/layout'
import {
  $projectTree,
  chooseDraftFolder,
  copyPath,
  projectRootCwd,
  requestStartWorkSession,
  revealPath,
  setDraftWorkspace
} from '@/store/projects'

// The "where" of the context bar under the composer (Quiet Tool spec §5.8): an
// inline control — no frame, no chip — that names the folder this chat works
// in. Before the first message it is a picker; once the chat exists its folder
// is settled, and the control only offers to show it, copy it, or start a new
// chat there.
const INLINE_CONTROL = cn(
  'h-7 max-w-64 shrink-0 gap-1.5 rounded-md px-2 text-sm font-normal',
  'text-(--text-secondary) hover:bg-(--bg-hover) hover:text-(--text-primary) data-[state=open]:bg-(--bg-hover)'
)

const underPath = (parent: string, child: string): boolean =>
  child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`)

/** The listed project whose folder holds `cwd` (longest match), if any. */
export function projectForCwd(projects: readonly SidebarProjectTree[], cwd: string): SidebarProjectTree | undefined {
  const target = cwd.trim()
  let best: SidebarProjectTree | undefined
  let bestLen = -1

  if (!target) {
    return undefined
  }

  for (const project of projects) {
    const paths = [project.path, ...project.repos.map(repo => repo.path)]

    for (const path of paths) {
      const root = (path ?? '').trim()

      if (root && underPath(root, target) && root.length > bestLen) {
        best = project
        bestLen = root.length
      }
    }
  }

  return best
}

/**
 * What the control calls a folder: its project's name when the folder IS that
 * project (or sits inside a named one), else the folder's own name. An auto
 * project only names its own root — one that happens to contain the folder
 * (say, a chat once ran in the home directory) says nothing about it.
 */
export function workspaceLabel(projects: readonly SidebarProjectTree[], cwd: string): string {
  const project = projectForCwd(projects, cwd)

  if (project && (!project.isAuto || projectRootCwd(project) === cwd.trim())) {
    return project.label
  }

  return pathLeaf(cwd) || cwd
}

/**
 * The folders a new chat can be pointed at: the projects people chat in, most
 * recent activity first, then the repos the disk scan found that no chat has
 * used yet. Shared by this picker and the home surface's folder card, so the
 * two always offer the same folders in the same order.
 */
export function pickableWorkspaces(projects: readonly SidebarProjectTree[]): {
  discovered: SidebarProjectTree[]
  recent: SidebarProjectTree[]
} {
  const byActivity = [...projects]
    .filter(project => !project.isNoProject && projectRootCwd(project))
    .sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0) || a.label.localeCompare(b.label))

  const listed = new Set(sidebarProjects(byActivity).map(project => project.id))

  return {
    discovered: byActivity.filter(project => !listed.has(project.id)),
    recent: byActivity.filter(project => listed.has(project.id))
  }
}

interface WorkspacePickerProps {
  /** The folder this composer's chat works in ('' = none). */
  cwd: string
  /** True before the chat's first message: the folder can still be chosen. */
  draft: boolean
}

export function WorkspacePicker({ cwd, draft }: WorkspacePickerProps) {
  const { t } = useI18n()
  const copy = t.composer.workspace
  const tree = useStore($projectTree)
  const dismissed = useStore($dismissedAutoProjectIds)
  const projects = useMemo(() => filterVisibleProjects(tree, dismissed), [tree, dismissed])
  const folder = cwd.trim()
  const label = folder ? workspaceLabel(projects, folder) : copy.none

  if (!draft) {
    // A chat with no folder has nothing to show here.
    return folder ? <SessionWorkspaceMenu cwd={folder} label={label} /> : null
  }

  return <DraftWorkspacePicker cwd={folder} label={label} projects={projects} />
}

function TriggerLabel({ empty, label }: { empty: boolean; label: string }) {
  return (
    <>
      <Folder className={cn('size-4 shrink-0', empty ? 'text-(--icon-muted)' : 'text-(--icon-default)')} />
      <span className={cn('truncate', empty && 'text-(--text-tertiary)')}>{label}</span>
      <ChevronDown className="size-3 shrink-0 opacity-60" />
    </>
  )
}

function DraftWorkspacePicker({
  cwd,
  label,
  projects
}: {
  cwd: string
  label: string
  projects: readonly SidebarProjectTree[]
}) {
  const { t } = useI18n()
  const copy = t.composer.workspace
  const [open, setOpen] = useState(false)

  const { discovered, recent } = useMemo(() => pickableWorkspaces(projects), [projects])

  const current = projectForCwd(projects, cwd)

  const choose = (path: null | string) => {
    setOpen(false)
    setDraftWorkspace(path)
  }

  const item = (project: SidebarProjectTree) => {
    const root = projectRootCwd(project)
    const selected = current?.id === project.id

    return (
      <CommandItem
        key={project.id}
        keywords={[project.label, root]}
        onSelect={() => choose(root)}
        value={`project:${project.id}`}
      >
        <span
          className="grid size-4.5 shrink-0 place-items-center"
          style={project.color ? { color: project.color } : undefined}
        >
          <Codicon name={project.icon || 'folder'} size="0.9375rem" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{project.label}</span>
          <span className="truncate text-xs text-(--text-tertiary)">{tailPath(root, 38)}</span>
        </span>
        {selected && <Check className="size-4 shrink-0 text-(--text-primary)" />}
      </CommandItem>
    )
  }

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <Tip label={cwd ? copy.chosen(displayPath(cwd)) : copy.chooseHint} side="top">
        <PopoverTrigger asChild>
          <Button aria-label={copy.pickerLabel} className={INLINE_CONTROL} type="button" variant="ghost">
            <TriggerLabel empty={!cwd} label={label} />
          </Button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent align="start" className="w-80 p-0" side="top" sideOffset={8}>
        <Command loop>
          <CommandInput autoFocus placeholder={copy.search} />
          <CommandList className="max-h-80">
            <CommandEmpty>{copy.noMatch}</CommandEmpty>
            {recent.length > 0 && <CommandGroup heading={copy.projects}>{recent.map(item)}</CommandGroup>}
            {discovered.length > 0 && <CommandGroup heading={copy.discovered}>{discovered.map(item)}</CommandGroup>}
            <CommandSeparator alwaysRender />
            <CommandGroup forceMount>
              <CommandItem
                forceMount
                onSelect={() => {
                  setOpen(false)
                  void chooseDraftFolder()
                }}
                value="action:choose-folder"
              >
                <FolderOpen />
                <span>{copy.chooseOther}</span>
              </CommandItem>
              {cwd && (
                <CommandItem forceMount onSelect={() => choose(null)} value="action:no-folder">
                  <FolderOff />
                  <span>{copy.noFolder}</span>
                </CommandItem>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function SessionWorkspaceMenu({ cwd, label }: { cwd: string; label: string }) {
  const { t } = useI18n()
  const copy = t.composer.workspace

  return (
    <DropdownMenu>
      <Tip label={copy.settled(displayPath(cwd))} side="top">
        <DropdownMenuTrigger asChild>
          <Button aria-label={copy.menuLabel(label)} className={INLINE_CONTROL} type="button" variant="ghost">
            <TriggerLabel empty={false} label={label} />
          </Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="start" className="w-64" side="top" sideOffset={8}>
        <DropdownMenuLabel className="truncate" title={cwd}>
          {displayPath(cwd)}
        </DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => requestStartWorkSession(cwd, undefined, { openTab: true })}>
          <MessagePlus />
          <span>{copy.newChatHere}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void revealPath(cwd)}>
          <FolderOpen />
          <span>{t.sidebar.projects.reveal}</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void copyPath(cwd)}>
          <Copy />
          <span>{t.sidebar.projects.copyPath}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
