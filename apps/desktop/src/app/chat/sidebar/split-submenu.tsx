import {
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger
} from '@/components/ui/context-menu'
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, LayoutColumns } from '@/lib/icons'
import type { SplitDir } from '@/store/session-states'

/** The leaf + submenu components for one menu flavour, so the split submenu
 *  renders in either the `…` dropdown or a right-click context menu. */
export interface SplitMenuKit {
  Item: typeof DropdownMenuItem | typeof ContextMenuItem
  Sub: typeof DropdownMenuSub | typeof ContextMenuSub
  SubContent: typeof DropdownMenuSubContent | typeof ContextMenuSubContent
  SubTrigger: typeof DropdownMenuSubTrigger | typeof ContextMenuSubTrigger
}

export const DROPDOWN_SPLIT_KIT: SplitMenuKit = {
  Item: DropdownMenuItem,
  Sub: DropdownMenuSub,
  SubContent: DropdownMenuSubContent,
  SubTrigger: DropdownMenuSubTrigger
}

export const CONTEXT_SPLIT_KIT: SplitMenuKit = {
  Item: ContextMenuItem,
  Sub: ContextMenuSub,
  SubContent: ContextMenuSubContent,
  SubTrigger: ContextMenuSubTrigger
}

// Ordered so the default (right) sits first, one hop away. Labels come from
// the catalog (`sidebar.row.split*`) so the menu reads in the app's language.
const SPLIT_DIRS: {
  dir: SplitDir
  icon: typeof ArrowRight
  label: 'splitDown' | 'splitLeft' | 'splitRight' | 'splitUp'
}[] = [
  { dir: 'right', icon: ArrowRight, label: 'splitRight' },
  { dir: 'bottom', icon: ArrowDown, label: 'splitDown' },
  { dir: 'left', icon: ArrowLeft, label: 'splitLeft' },
  { dir: 'top', icon: ArrowUp, label: 'splitUp' }
]

interface SplitSubmenuProps {
  kit: SplitMenuKit
  label: string
  onSplit: (dir: SplitDir) => void
  disabled?: boolean
  /** Dismiss the owning menu after the row's default (right) split — the
   *  dropdown is controlled and can; a context menu can't, so it's a no-op. */
  close?: () => void
}

/**
 * "Open in split ▸": clicking the row splits right (the common case), and the
 * submenu picks any edge. Shared by session rows and page nav rows.
 */
export function SplitSubmenu({ close, disabled, kit, label, onSplit }: SplitSubmenuProps) {
  const { Item, Sub, SubContent, SubTrigger } = kit
  const { t } = useI18n()

  const split = (dir: SplitDir) => {
    triggerHaptic('selection')
    onSplit(dir)
  }

  return (
    <Sub>
      <SubTrigger
        disabled={disabled}
        onClick={() => {
          split('right')
          close?.()
        }}
      >
        <LayoutColumns />
        <span>{label}</span>
      </SubTrigger>
      <SubContent>
        {SPLIT_DIRS.map(({ dir, icon: Icon, label: dirLabel }) => (
          <Item key={dir} onSelect={() => split(dir)}>
            <Icon />
            <span>{t.sidebar.row[dirLabel]}</span>
          </Item>
        ))}
      </SubContent>
    </Sub>
  )
}
