import { useStore } from '@nanostores/react'
import { type ReactNode, type PointerEvent as ReactPointerEvent, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { ChevronDown, ChevronUp, MoreVertical, X } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { $paneHeightOverride, $paneState, setPaneHeightOverride } from '@/store/panes'

// Monospace capability chip (tool name, transport, …). Shared by the Skills
// and MCP tabs so the pill reads identically everywhere.
export function ToolChip({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span
      className="rounded-md bg-(--ui-bg-quinary) px-1.5 py-0.5 font-mono text-2xs text-(--ui-text-tertiary)"
      title={title}
    >
      {children}
    </span>
  )
}

// Master–detail page scaffolding (14rem rail, p-2, centered max-w-2xl detail):
// dense uniform rows on the left, roomy inspector on the right. Messaging rides
// it with its own avatar rows; the Tiện ích tabs moved onto card grids
// (`StoreCard`) and keep only the strip, the menu and the docked pane from here.

// `pane` docks a full-bleed work surface (editor, log viewer, terminal) below
// the whole master–detail grid — the app's bottom-pane pattern, page-local.
// `split="wide"` gives list-heavy pages a rail that shares the page with a
// sparse detail; the default 14rem rail suits pages whose detail carries the
// weight (messaging).
export function MasterDetail({
  children,
  pane,
  split = 'rail'
}: {
  children: ReactNode
  pane?: ReactNode
  split?: 'rail' | 'wide'
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className={cn(
          'grid min-h-0 flex-1 grid-cols-1',
          split === 'wide' ? 'sm:grid-cols-[minmax(0,0.75fr)_minmax(0,1fr)]' : 'sm:grid-cols-[14rem_minmax(0,1fr)]'
        )}
      >
        {children}
      </div>
      {pane}
    </div>
  )
}

export function ListColumn({ children, header }: { children: ReactNode; header?: ReactNode }) {
  return (
    <aside className="flex min-h-0 flex-col p-2">
      {header}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">{children}</div>
    </aside>
  )
}

// `footer` pins one quiet caption below the scroll (e.g. "changes apply to
// new sessions") so per-item detail components never repeat it themselves.
// `actionBar` pins a real control row (save/toggle) below the scroll instead.
export function DetailColumn({
  actionBar,
  children,
  footer
}: {
  actionBar?: ReactNode
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <main className="flex min-h-0 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
        <div className="mx-auto max-w-2xl space-y-5 px-5 py-4">{children}</div>
      </div>
      {footer && (
        <div className="mx-auto w-full max-w-2xl shrink-0 px-5 pb-3 pt-1.5 text-right text-xs text-muted-foreground/50">
          {footer}
        </div>
      )}
      {actionBar && (
        <footer className="shrink-0 bg-(--ui-chat-surface-background) px-5 py-2.5">
          <div className="mx-auto flex max-w-2xl flex-wrap items-center gap-2">{actionBar}</div>
        </footer>
      )}
    </main>
  )
}

// Full-bleed docked bottom pane: title strip + actions + close, drag-resizable
// on its top edge like every other pane (height persisted through the same
// pane-state store the terminal uses). No min height — drag (or the chevron)
// collapses it down to just the header. Content swaps freely: JSON editor
// today, stdio/log viewers tomorrow.
const DETAIL_PANE_DEFAULT_BODY_PX = 288
const DETAIL_PANE_MAX_VH = 0.7
const DETAIL_PANE_COLLAPSED_PX = 4

// Quiet icon-button chrome for pane headers, the list-strip menu, per-server
// MCP actions and the JSON editor's format button. Pair it with
// `size="icon-xs"` — the 24px square is the hit-target floor — so the class
// only carries colour; the Button owns the box and the radius. Compose extra
// state (data-[state=open], hover:text-destructive) with cn().
export const ICON_BUTTON = 'text-muted-foreground/70 hover:bg-(--ui-control-active-background) hover:text-foreground'

export function DetailPane({
  actions,
  children,
  defaultCollapsed = false,
  defaultHeight = DETAIL_PANE_DEFAULT_BODY_PX,
  id,
  onClose,
  title
}: {
  actions?: ReactNode
  children: ReactNode
  /** Start collapsed to the header the first time this pane is ever shown.
   *  Only seeds when the id has no saved state — a later expand/collapse
   *  persists and wins, so it's "collapsed by default", not "always collapsed". */
  defaultCollapsed?: boolean
  /** Default body height in px (before any user resize). */
  defaultHeight?: number
  /** Pane-store key — height overrides persist under it. */
  id: string
  /** Omit for permanent panes (collapsible to the header, never removed). */
  onClose?: () => void
  title: ReactNode
}) {
  const { t } = useI18n()
  const override = useStore($paneHeightOverride(id))

  useEffect(() => {
    if (defaultCollapsed && $paneState(id).get() === undefined) {
      setPaneHeightOverride(id, 0)
    }
  }, [defaultCollapsed, id])

  const height = override ?? defaultHeight
  const collapsed = height <= DETAIL_PANE_COLLAPSED_PX
  // Sash drag mirrors the shell's y-axis pane resize: pointer capture on the
  // top edge, clamped to [0, 70vh]; double-click resets to the default.
  const [dragging, setDragging] = useState(false)

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startY = event.clientY
    const startHeight = height
    const max = Math.round(window.innerHeight * DETAIL_PANE_MAX_VH)
    setDragging(true)

    const onMove = (move: globalThis.PointerEvent) => {
      setPaneHeightOverride(id, Math.min(max, Math.max(0, Math.round(startHeight + (startY - move.clientY)))))
    }

    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      setDragging(false)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })
  }

  return (
    <section className="relative flex shrink-0 flex-col border-t border-(--ui-stroke-tertiary) bg-(--ui-chat-surface-background)">
      <div
        className="group/sash absolute inset-x-0 top-0 z-10 h-1 -translate-y-1/2 cursor-row-resize"
        onDoubleClick={() => setPaneHeightOverride(id, undefined)}
        onPointerDown={startDrag}
      >
        <div
          className={cn(
            'absolute inset-x-0 top-1/2 h-px -translate-y-1/2 transition-colors',
            dragging ? 'bg-(--ui-stroke-secondary)' : 'group-hover/sash:bg-(--ui-stroke-secondary)'
          )}
        />
      </div>
      <header className="flex h-9 shrink-0 items-center gap-2 px-3">
        <span className="min-w-0 truncate text-xs font-medium text-foreground">{title}</span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {actions}
          <Tip label={collapsed ? t.common.expand : t.common.collapse}>
            <Button
              aria-expanded={!collapsed}
              aria-label={collapsed ? t.common.expand : t.common.collapse}
              className={ICON_BUTTON}
              onClick={() => setPaneHeightOverride(id, collapsed ? undefined : 0)}
              size="icon-xs"
              variant="ghost"
            >
              {collapsed ? <ChevronUp /> : <ChevronDown />}
            </Button>
          </Tip>
          {onClose && (
            <Button
              aria-label={t.common.close}
              className={ICON_BUTTON}
              onClick={onClose}
              size="icon-xs"
              variant="ghost"
            >
              <X />
            </Button>
          )}
        </div>
      </header>
      <div className="min-h-0 overflow-hidden" style={{ height: collapsed ? 0 : height }}>
        {children}
      </div>
    </section>
  )
}

// One-line control strip pinned above a list or a card grid: sort/primary
// action on the left, a note and the overflow kebab on the right. Tall enough
// for a real 28px button — list-wide actions are boxed controls, not bare
// 11px text.
export function ListStrip({ left, right }: { left?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-1 flex h-8 shrink-0 items-center justify-between gap-2 pl-1 pr-1">
      <div className="flex min-w-0 items-center gap-1.5">{left}</div>
      <div className="flex shrink-0 items-center gap-1.5">{right}</div>
    </div>
  )
}

export interface ListStripMenuItem {
  disabled?: boolean
  label: string
  onSelect: () => void
}

export interface ListStripMenuToggle {
  checked: boolean
  disabled?: boolean
  label: string
  onToggle: (checked: boolean) => void
}

// Overflow kebab for list-wide actions. `toggle` renders as the first row —
// one label + switch line covering enable-all/disable-all (checked = every
// visible item on; mixed reads as off so one flip always means "all on").
export function ListStripMenu({
  items = [],
  label,
  toggle
}: {
  items?: ListStripMenuItem[]
  label: string
  toggle?: ListStripMenuToggle
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={label}
          className={cn(
            ICON_BUTTON,
            'data-[state=open]:bg-(--ui-control-active-background) data-[state=open]:text-foreground'
          )}
          size="icon-xs"
          variant="ghost"
        >
          <MoreVertical />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44" sideOffset={6}>
        {toggle && (
          <DropdownMenuItem
            disabled={toggle.disabled}
            onSelect={event => {
              // Keep the menu open so the switch is seen flipping.
              event.preventDefault()
              toggle.onToggle(!toggle.checked)
            }}
          >
            <span className="min-w-0 flex-1 truncate">{toggle.label}</span>
            <Switch
              checked={toggle.checked}
              className={cn('pointer-events-none shrink-0', !toggle.checked && 'opacity-60')}
              size="xs"
              tabIndex={-1}
            />
          </DropdownMenuItem>
        )}
        {items.map(item => (
          <DropdownMenuItem disabled={item.disabled} key={item.label} onSelect={item.onSelect}>
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
