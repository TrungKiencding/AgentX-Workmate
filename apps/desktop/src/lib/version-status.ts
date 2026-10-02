/**
 * Pure derivation of how the app names the versions on screen: this desktop app
 * (`v1.0.3`, `v1.0.3 (update)`, `v1.0.3 · 45%`) and, in remote mode, the backend
 * it is connected to (`backend v0.4.2 (+12)`) — the label, its tooltip, and
 * whether an update is waiting.
 *
 * The status bar and the command palette both name the same targets, so the
 * wording lives here once — a palette row and its status bar item can't drift
 * into describing the same install differently.
 */

import type { AppUpdateState } from '@/global'

export interface VersionStatusResult {
  /** An update is waiting: callers tint the row with it. */
  hasUpdate: boolean
  label: string
  tooltip?: string
  /** Nothing identifies this target yet — callers hide the row. */
  unknown: boolean
}

export interface AppVersionStatusCopy {
  /** Remote mode: the app is one of two versions on screen, so it says so. */
  clientLabel: (version: string) => string
  restart: string
  update: string
  current: (version: string) => string
  available: (version: string) => string
  downloading: (percent: number) => string
  ready: (version: string) => string
  installing: string
}

export interface AppVersionStatusInput {
  /** The app's version, from the main process. */
  version?: null | string
  state: AppUpdateState | null
  remote: boolean
  copy: AppVersionStatusCopy
}

export function resolveAppVersionStatus({ copy, remote, state, version }: AppVersionStatusInput): VersionStatusResult {
  const current = state?.currentVersion ?? version ?? null

  if (!current) {
    return { hasUpdate: false, label: '', unknown: true }
  }

  const base = remote ? copy.clientLabel(current) : `v${current}`
  const next = state?.release?.version

  switch (state?.phase) {
    case 'available':
      return next
        ? { hasUpdate: true, label: `${base} (${copy.update})`, tooltip: copy.available(next), unknown: false }
        : { hasUpdate: false, label: base, tooltip: copy.current(current), unknown: false }
    case 'downloading': {
      const total = state.progress?.totalBytes ?? 0
      const percent = total > 0 ? Math.floor(((state.progress?.receivedBytes ?? 0) / total) * 100) : 0

      return { hasUpdate: false, label: `${base} · ${percent}%`, tooltip: copy.downloading(percent), unknown: false }
    }

    case 'ready':
      return {
        hasUpdate: true,
        label: `${base} · ${copy.restart}`,
        tooltip: next ? copy.ready(next) : undefined,
        unknown: false
      }

    case 'installing':
      return { hasUpdate: false, label: `${base} · ${copy.update}`, tooltip: copy.installing, unknown: false }

    default:
      return { hasUpdate: false, label: base, tooltip: copy.current(current), unknown: false }
  }
}

export interface BackendVersionStatusCopy {
  backendLabel: (version: string) => string
  backendVersion: (version: string) => string
  commitsBehind: (count: number, branch: string) => string
  restart: string
  update: string
  updateInProgress: string
}

export interface BackendVersionStatusInput {
  /** True while an update is in flight (including the restart). */
  applying: boolean
  /** Latest line from the update — leads the tooltip while applying. */
  applyMessage?: string
  behind?: number
  copy: BackendVersionStatusCopy
  /** The update reached the restart — labels `restart`, not `update`. */
  restarting: boolean
  /** An update the commit count can't express (pip installs, shallow clones). */
  updateAvailable?: boolean
  version?: null | string
}

export function resolveBackendVersionStatus({
  applyMessage,
  applying,
  behind = 0,
  copy,
  restarting,
  updateAvailable,
  version = null
}: BackendVersionStatusInput): VersionStatusResult {
  if (!version) {
    return { hasUpdate: false, label: '', unknown: true }
  }

  const busy = applying || restarting
  const available = behind > 0 || Boolean(updateAvailable)
  const base = copy.backendLabel(version)

  // Commits behind is the precise diff; `(update)` is the fallback for a
  // backend that knows it's stale but can't count (pip, non-git checkout).
  const hint = busy ? '' : behind > 0 ? ` (+${behind})` : available ? ` (${copy.update})` : ''

  const tooltip = [
    busy && (applyMessage || copy.updateInProgress),
    !busy && behind > 0 && copy.commitsBehind(behind, 'main'),
    !busy && behind <= 0 && available && copy.update,
    copy.backendVersion(version)
  ]
    .filter(Boolean)
    .join(' · ')

  return {
    hasUpdate: !busy && available,
    label: busy ? `${base} · ${restarting ? copy.restart : copy.update}` : `${base}${hint}`,
    tooltip,
    unknown: false
  }
}
