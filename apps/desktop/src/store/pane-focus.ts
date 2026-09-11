import { setTerminalTakeover } from '@/app/right-sidebar/store'
import { revealTreePane } from '@/components/pane-shell/tree/store'

import { setFileBrowserOpen, setSidebarOpen } from './layout'
import { openReview } from './review'

// Explicit-request pane reveals, keyed to the backend `focus_pane` tool. Each
// entry drives the pane's own reveal path (some are toggle-bound) so a revealed
// pane matches a user-driven open. files/review are workspace-gated — a no-op
// without a project cwd, which is the honest behavior.
const PANE_REVEALERS: Record<string, () => void> = {
  chat: () => revealTreePane('workspace'),
  files: () => setFileBrowserOpen(true),
  review: () => openReview(),
  sessions: () => setSidebarOpen(true),
  terminal: () => setTerminalTakeover(true)
}

// The store setters above are same-value no-ops: `$open` already reads true
// while the pane sits in a zone the user minimized from its chevron, so the
// listener never fires and the tool reported success over an invisible pane
// (#106009). An explicit reveal also un-minimizes and fronts the tree pane.
const TREE_PANE_OF: Record<string, string> = {
  files: 'files',
  review: 'review',
  sessions: 'sessions',
  terminal: 'terminal'
}

/** Reveal a desktop pane by name. Returns false for an unknown pane. */
export function revealDesktopPane(pane: string): boolean {
  const reveal = PANE_REVEALERS[pane]

  if (!reveal) {
    return false
  }

  reveal()

  const treePane = TREE_PANE_OF[pane]

  if (treePane) {
    revealTreePane(treePane)
  }

  return true
}
