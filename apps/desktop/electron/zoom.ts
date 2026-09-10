/**
 * Pure helpers for window zoom. The main process owns webContents.setZoomLevel,
 * so the menu items, the Ctrl/Cmd shortcuts, and the settings UI all funnel
 * through this one clamped scale. Percent is the user-facing unit (100 = the
 * Chromium actual-size baseline); Chromium's internal unit is the zoom level,
 * where factor = 1.2 ^ level.
 *
 * Our shipped default is the Appearance 90% preset — tight enough to feel
 * denser than Chromium 100%, and selected in the UI Scale control on first run.
 */

export const ZOOM_STORAGE_KEY = 'agentx:desktop:zoomLevel'

const ZOOM_FACTOR_BASE = 1.2
const MIN_ZOOM_LEVEL = -9
const MAX_ZOOM_LEVEL = 9

/** Half Chromium's default step; matching the shortcuts and View menu. */
export const ZOOM_STEP = 0.1

/** Appearance 90% preset. Fresh installs + Actual Size / Ctrl+0. */
export const DEFAULT_ZOOM_LEVEL = Math.log(0.9) / Math.log(ZOOM_FACTOR_BASE)

export function clampZoomLevel(value) {
  if (!Number.isFinite(value)) {
    return DEFAULT_ZOOM_LEVEL
  }

  return Math.min(Math.max(value, MIN_ZOOM_LEVEL), MAX_ZOOM_LEVEL)
}

export function zoomLevelToPercent(level) {
  return Math.round(Math.pow(ZOOM_FACTOR_BASE, clampZoomLevel(level)) * 100)
}

export function percentToZoomLevel(percent) {
  if (!Number.isFinite(percent) || percent <= 0) {
    return DEFAULT_ZOOM_LEVEL
  }

  return clampZoomLevel(Math.log(percent / 100) / Math.log(ZOOM_FACTOR_BASE))
}

/**
 * Apply a clamped zoom level to a webContents AND notify the renderer, in that
 * order. Every path that changes zoom (user action, restore-on-load, lifecycle
 * re-assert) funnels through here so the settings UI Scale control can never
 * drift from the actually-applied level — the bug where restore set the level
 * but forgot to emit 'agentx:zoom:changed', leaving the control stuck at 100%.
 * Returns the clamped level so callers can persist it.
 */
export function applyZoomLevel(webContents, level) {
  const clamped = clampZoomLevel(level)
  webContents.setZoomLevel(clamped)
  webContents.send('agentx:zoom:changed', { level: clamped, percent: zoomLevelToPercent(clamped) })

  return clamped
}

// Chromium can drop webContents zoom when a BrowserWindow is resized, minimized
// and restored, or crosses onto a monitor with different display scaling. macOS
// and Windows provide trailing `resized`/`moved` events; Linux only provides the
// noisy `resize`/`move` pair, so debounce those fallbacks before re-applying the
// persisted level.
export const ZOOM_RESIZE_REASSERT_DELAY_MS = 100

export function zoomReassertWindowEvents(platform = process.platform) {
  return platform === 'linux' ? ['show', 'restore', 'resize', 'move'] : ['show', 'restore', 'resized', 'moved']
}

export function installZoomReassertOnWindowEvents(win, reassert, platform = process.platform) {
  if (!win?.on) {
    return
  }

  let resizeTimer

  for (const event of zoomReassertWindowEvents(platform)) {
    win.on(event, () => {
      if (win.isDestroyed?.()) {
        return
      }

      if (event !== 'resize' && event !== 'move') {
        reassert()

        return
      }

      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        if (!win.isDestroyed?.()) {
          reassert()
        }
      }, ZOOM_RESIZE_REASSERT_DELAY_MS)
    })
  }
}

/**
 * Chromium persists zoom PER URL, and a hash route is a distinct URL. A
 * `file://` URL has no host, so its zoom record is keyed by the full URL,
 * fragment included — and the packaged app is a HashRouter over one
 * `file://…/index.html`. Every session/settings route therefore carries its own
 * `partition.per_host_zoom_levels` record: a route never zoomed on resolves to
 * Chromium's default (level 0, i.e. 100%), and a route last visited before the
 * user changed UI Scale keeps the old level.
 *
 * In-page navigation fires neither `did-finish-load` nor any window event, so
 * after a tab switch `getZoomLevel()` already reports the target route's record
 * while the renderer keeps painting the previous scale — until the next
 * visual-properties sync (resize, restore, display change) pushes that record
 * and the whole UI jumps, e.g. from 125% down to 100%. Dev builds never show
 * it: the dev server URL is keyed by host, not by route.
 *
 * Re-assert the persisted level on main-frame `did-navigate-in-page`, and on
 * every full load (crash recovery reloads and would outlive a spent `once`
 * listener — #46429). restorePersistedZoomLevel's drift-guard makes this a
 * no-op when the route's record already matches. Subframe hash changes must not
 * touch the chat window's UI scale. #48658, #38854, #79863.
 */
export function installZoomReassertOnNavigation(webContents, reassert) {
  if (!webContents?.on) {
    return
  }

  const reassertIfAlive = () => {
    if (!webContents.isDestroyed?.()) {
      reassert()
    }
  }

  webContents.on('did-finish-load', reassertIfAlive)
  webContents.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
    if (isMainFrame) {
      reassertIfAlive()
    }
  })
}

/**
 * Zoom-wiring decision per window kind. Chat windows (main + session) keep
 * global UI zoom; the pet overlay and the Quick Entry composer opt out because
 * they size their own OS window and inheriting zoom would crop/overflow them.
 *
 * Extracted so the "helper windows opt out, everything else opts in" contract is
 * unit-testable without booting a BrowserWindow or reading source.
 */
export const ZOOM_WINDOW_CONFIG = {
  chat: { zoom: true },
  petOverlay: { zoom: false },
  quickEntry: { zoom: false },
  wakeIndicator: { zoom: false }
} as const

export function zoomWiringForWindowKind(kind) {
  return ZOOM_WINDOW_CONFIG[kind] ?? ZOOM_WINDOW_CONFIG.chat
}
