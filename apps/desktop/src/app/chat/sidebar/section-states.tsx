import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useI18n } from '@/i18n'
import { FolderPlus, Folders, Pin } from '@/lib/icons'
import { cn } from '@/lib/utils'

export function SidebarSessionSkeletons() {
  return (
    <div aria-hidden="true" className="grid gap-px">
      {['w-32', 'w-40', 'w-28', 'w-36', 'w-24'].map((width, i) => (
        <div
          className="grid min-h-(--sidebar-row-height) grid-cols-[minmax(0,1fr)_1.5rem] items-center rounded-md pl-2"
          key={`${width}-${i}`}
        >
          <Skeleton className={cn('h-3 rounded-sm', width)} />
          <Skeleton className="mx-auto size-3.5 rounded-sm opacity-60" />
        </div>
      ))}
    </div>
  )
}

export function SidebarBlankState({ onAddProject }: { onAddProject: () => void }) {
  const { t } = useI18n()
  const s = t.sidebar

  return (
    <div className="grid min-h-0 flex-1 place-items-center px-4 text-center">
      <div className="flex flex-col items-center gap-2">
        <Folders className="size-5 text-(--ui-text-quaternary)" />
        <p className="text-xs text-(--ui-text-tertiary)">{s.noSessions}</p>
        <Button className="mt-0.5 text-(--ui-text-secondary)" onClick={onAddProject} size="sm" variant="ghost">
          <FolderPlus />
          {s.projects.addButton}
        </Button>
      </div>
    </div>
  )
}

// The project list with nothing in it yet: one quiet row that says what a
// project is for and adds one — a folder, picked straight from the OS dialog.
export function SidebarProjectsEmptyState({ onAdd }: { onAdd: () => void }) {
  const { t } = useI18n()
  const p = t.sidebar.projects

  return (
    <button
      className="row-hover flex min-h-(--sidebar-row-height) w-full items-center gap-1.5 rounded-(--radius-control) pl-3 pr-2 text-left"
      onClick={onAdd}
      type="button"
    >
      <span className="grid size-3.5 shrink-0 place-items-center text-(--icon-muted)">
        <FolderPlus className="size-3.5" />
      </span>
      <span className="min-w-0 truncate text-sm text-(--text-secondary)">{p.emptyHint}</span>
    </button>
  )
}

export function SidebarPinnedEmptyState() {
  const { t } = useI18n()

  return (
    <div className="flex min-h-(--sidebar-row-height) items-center gap-1.5 rounded-lg pl-2 text-xs text-(--ui-text-tertiary)">
      <span className="grid w-3.5 shrink-0 place-items-center text-(--ui-text-quaternary)">
        <Pin className="size-3" />
      </span>
      <span>{t.sidebar.shiftClickHint}</span>
    </div>
  )
}
