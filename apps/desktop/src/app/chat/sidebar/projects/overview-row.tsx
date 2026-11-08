import type * as React from 'react'
import { useRef } from 'react'

import { Codicon } from '@/components/ui/codicon'
import { DisclosureCaret } from '@/components/ui/disclosure-caret'
import type { SessionInfo } from '@/hermes'
import { useI18n } from '@/i18n'
import { ArrowLeft } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { projectNodeKey } from '@/store/projects'

import {
  SIDEBAR_LEAD_ICON_SIZE,
  SidebarRowBody,
  SidebarRowGrab,
  SidebarRowLabel,
  SidebarRowLead,
  SidebarRowLeadGlyph,
  SidebarRowNest,
  SidebarRowShell
} from '../chrome'

import { latestProjectSessions, PROJECT_PREVIEW_COUNT, useWorkspaceNodeOpen } from './model'
import { ProjectContextMenu, ProjectMenu } from './project-menu'
import type { SidebarProjectTree } from './workspace-groups'
import { WorkspaceAddButton } from './workspace-header'

// A bare color dot (no icon) or an icon glyph — tinted by `color` when set, else
// the lead's default tertiary. A project left on the default glyph reads as a
// folder that opens with its row, the way a file manager's sidebar does.
export function projectIcon({ color, icon, isNoProject }: SidebarProjectTree, open = false) {
  if (color && !icon) {
    return (
      <SidebarRowLeadGlyph>
        <span aria-hidden="true" className="size-1.5 rounded-full" style={{ backgroundColor: color }} />
      </SidebarRowLeadGlyph>
    )
  }

  const fallback = isNoProject ? 'home' : open ? 'folder-opened' : 'folder'

  return (
    <SidebarRowLeadGlyph style={color ? { color } : undefined}>
      <Codicon name={icon || fallback} size={SIDEBAR_LEAD_ICON_SIZE} />
    </SidebarRowLeadGlyph>
  )
}

export function ProjectBackRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <SidebarRowShell>
      <SidebarRowBody
        className="group/back w-full text-(--ui-text-tertiary) opacity-40 hover:text-foreground"
        onClick={onClick}
      >
        <SidebarRowLead>
          <SidebarRowLeadGlyph>
            <ArrowLeft className="size-3.5" />
          </SidebarRowLeadGlyph>
        </SidebarRowLead>
        <SidebarRowLabel className="text-xs underline-offset-4 group-hover/back:underline">{label}</SidebarRowLabel>
      </SidebarRowBody>
    </SidebarRowShell>
  )
}

// A quiet text row under an open project: "show all N chats" (drills in) or the
// empty note. Indented with the chats, in caption ink, so it reads as part of
// the list rather than another chat.
function ProjectFootRow({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) {
  const className = 'flex h-8 w-full min-w-0 items-center rounded-(--radius-control) pl-3 text-left text-sm'

  if (!onClick) {
    return <div className={cn(className, 'text-(--text-tertiary)')}>{children}</div>
  }

  return (
    <button
      className={cn(
        className,
        'bg-transparent text-(--text-secondary) transition-colors duration-(--dur-micro) hover:bg-(--bg-hover) hover:text-(--text-primary)'
      )}
      onClick={onClick}
      type="button"
    >
      <span className="truncate">{children}</span>
    </button>
  )
}

interface ProjectOverviewRowProps {
  project: SidebarProjectTree
  onEnter?: (id: string) => void
  onNewSession?: (path: null | string) => void
  renderRows?: (sessions: SessionInfo[]) => React.ReactNode
  previewSessions?: SessionInfo[]
  reorderable?: boolean
  dragging?: boolean
  dragHandleProps?: React.HTMLAttributes<HTMLElement>
  ref?: React.Ref<HTMLDivElement>
  style?: React.CSSProperties
}

// One project in the sidebar: the whole row opens and closes it (collapsed by
// default, remembered per project), its most recent chats nest underneath, and
// "show all" drills into the full list. "+" starts a chat in its folder; the
// kebab and a right-click carry the rest.
export function ProjectOverviewRow({
  project,
  onEnter,
  onNewSession,
  renderRows,
  previewSessions,
  reorderable = false,
  dragging = false,
  dragHandleProps,
  ref,
  style
}: ProjectOverviewRowProps) {
  const { t } = useI18n()
  const s = t.sidebar
  const [open, toggleOpen] = useWorkspaceNodeOpen(projectNodeKey(project.id), false)
  // The appearance popover anchors here (the full row) so it opens flush with
  // the sidebar's content edge regardless of which side the sidebar is on.
  const rowRef = useRef<HTMLDivElement>(null)
  const fetched = (previewSessions ?? []).slice(0, PROJECT_PREVIEW_COUNT)
  const preview = fetched.length ? fetched : latestProjectSessions(project, PROJECT_PREVIEW_COUNT)
  const hidden = Math.max(0, project.sessionCount - preview.length)

  const lead = reorderable ? (
    <SidebarRowGrab
      ariaLabel={s.projects.reorder(project.label)}
      dragging={dragging}
      dragHandleProps={dragHandleProps}
      leadClassName="overflow-visible"
    >
      {projectIcon(project, open)}
    </SidebarRowGrab>
  ) : (
    <SidebarRowLead>{projectIcon(project, open)}</SidebarRowLead>
  )

  const shell = (
    <SidebarRowShell
      actions={
        <>
          {/* Home has no folder to start a chat in and no record to rename. */}
          {onNewSession && !project.isNoProject && (
            <WorkspaceAddButton label={s.newSessionIn(project.label)} onClick={() => onNewSession(project.path)} />
          )}
          {!project.isNoProject && <ProjectMenu anchorRef={rowRef} project={project} />}
        </>
      }
      className={cn(
        'group/workspace row-hover',
        dragging && 'cursor-grabbing bg-(--ui-sidebar-surface-background)'
      )}
      ref={rowRef}
    >
      <SidebarRowBody
        aria-expanded={open}
        aria-label={s.projects.toggle(project.label, !open)}
        className="w-full"
        onClick={toggleOpen}
      >
        {lead}
        <SidebarRowLabel>{project.label}</SidebarRowLabel>
        <DisclosureCaret
          className="text-(--icon-muted) opacity-0 transition group-hover/workspace:opacity-100 group-focus-within/workspace:opacity-100"
          open={open}
        />
      </SidebarRowBody>
    </SidebarRowShell>
  )

  return (
    <div className={cn(dragging && 'relative z-10')} ref={ref} style={style}>
      {/* Home has no per-project actions, so it gets no right-click menu. */}
      {project.isNoProject ? shell : <ProjectContextMenu project={project}>{shell}</ProjectContextMenu>}
      {open && (
        <SidebarRowNest>
          {preview.length > 0 ? (
            renderRows?.(preview)
          ) : (
            <ProjectFootRow>{s.projectEmpty}</ProjectFootRow>
          )}
          {hidden > 0 && onEnter && (
            <ProjectFootRow onClick={() => onEnter(project.id)}>{s.projects.showAll(project.sessionCount)}</ProjectFootRow>
          )}
        </SidebarRowNest>
      )}
    </div>
  )
}
