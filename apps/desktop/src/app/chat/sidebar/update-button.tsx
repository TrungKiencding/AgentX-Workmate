import { useStore } from '@nanostores/react'

import { Button } from '@/components/ui/button'
import type { AppUpdateState } from '@/global'
import { type Translations, useI18n } from '@/i18n'
import { CloudDownload, Loader2, RefreshCw } from '@/lib/icons'
import { $appUpdate } from '@/store/app-update'
import { openUpdateOverlay } from '@/store/update-overlay'

type Copy = Translations['appUpdate']

interface UpdateButtonView {
  /** The whole sentence, for screen readers; the label alone can be terse. */
  description: string
  icon: 'busy' | 'download' | 'restart'
  label: string
  /** The release is downloaded: restarting is the one step left. */
  ready: boolean
}

/** What the button says for `state`, or null when there is no update to act on. */
export function sidebarUpdateView(state: AppUpdateState | null, u: Copy): null | UpdateButtonView {
  const version = state?.release?.version

  if (!state || !version) {
    return null
  }

  switch (state.phase) {
    case 'available':
      return {
        description: u.availableTitle(version),
        icon: 'download',
        label: u.sidebarAvailable(version),
        ready: false
      }
    case 'downloading': {
      const total = state.progress?.totalBytes ?? state.release?.bytes ?? 0
      const received = state.progress?.receivedBytes ?? 0
      const percent = total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : 0
      const label = u.statusDownloading(percent)

      return { description: label, icon: 'busy', label, ready: false }
    }

    case 'ready':
      return { description: u.readyTitle(version), icon: 'restart', label: u.restartToUpdate, ready: true }

    case 'installing':
      return { description: u.statusInstalling, icon: 'busy', label: u.statusInstalling, ready: false }

    default:
      return null
  }
}

const ICONS = {
  busy: <Loader2 className="size-4 animate-spin" />,
  download: <CloudDownload className="size-4 text-(--accent)" />,
  restart: <RefreshCw className="size-4" />
} as const

/**
 * The app's own update, at the foot of the sidebar for as long as there is one
 * (the way Claude and Codex desktop keep theirs in view).
 *
 * The "update available" notice is closed once and snoozed; this stays until
 * the update is installed, so closing the notice never hides the update. A
 * click only opens the updates dialog: the release notes and the button that
 * starts the download or the restart are there, never a restart on one click.
 */
export function SidebarUpdateButton() {
  const state = useStore($appUpdate)
  const { t } = useI18n()
  const view = sidebarUpdateView(state, t.appUpdate)

  if (!view) {
    return null
  }

  return (
    <div className="flex shrink-0 px-3 pb-2 pt-1" data-slot="sidebar-update">
      <Button
        aria-label={view.description}
        className="min-w-0 max-w-full rounded-full"
        onClick={() => openUpdateOverlay('client')}
        size="sm"
        type="button"
        variant={view.ready ? 'default' : 'outline'}
      >
        {ICONS[view.icon]}
        <span className="truncate">{view.label}</span>
      </Button>
    </div>
  )
}
