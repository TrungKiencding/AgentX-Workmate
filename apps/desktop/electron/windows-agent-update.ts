/**
 * windows-agent-update.ts
 *
 * One decision, isolated so it can be argued with in a test: on Windows, may
 * this desktop drive `agentx update` itself, or must it hand off?
 *
 * THE BACKGROUND
 * --------------
 * Windows update normally means: quit, let the staged AgentX-Setup.exe run
 * `agentx update` and rebuild the desktop, then relaunch. It exists because the
 * desktop is BUILT FROM the checkout it is updating — the rebuilt exe is the
 * one running, and Windows will not let a running image be replaced. Handing
 * the work to a binary outside the checkout is the only way out.
 *
 * That is true of a `agentx desktop` source install. It is not true of an NSIS
 * install: that desktop lives in %LOCALAPPDATA%\Programs\AgentX Workmate,
 * ships its own Electron, and is replaced by downloading a new installer. It
 * has nothing in the checkout to rebuild. Yet it took the same path — and with
 * no AgentX-Setup.exe staged (the NSIS installer does not put one there), the
 * hand-off resolved to nothing and the app could only print `agentx update` and
 * ask the user to run it in a terminal themselves.
 *
 * So an NSIS user's agent stayed on whatever commit it was bootstrapped at,
 * indefinitely, unless they noticed the message and acted on it. Every
 * agent-side fix — the second brain key collection, the uninstall — waited
 * behind that.
 *
 * WHAT MAKES IT SAFE
 * ------------------
 * `agentx update` refuses on Windows when another process is running one of the
 * venv's entry-point shims, because `uv pip install` cannot replace a running
 * `agentx.exe` (hermes_cli/dashboard_procs.py::_detect_concurrent_hermes_instances).
 * The desktop's own backend IS such a process. So the caller must stop it and
 * confirm the shim unlocked BEFORE invoking the update — which is exactly what
 * releaseBackendLockForUpdate already does for the hand-off path.
 *
 * With the backend down, this is the same command the app currently asks the
 * user to type, run under the same conditions — minus the part where the user
 * forgets to close AgentX first and gets a half-written venv.
 */

import path from 'node:path'

export interface AgentUpdateContext {
  /** process.execPath — the desktop binary that is running. */
  execPath: string
  /** The agent checkout `agentx update` would mutate. */
  updateRoot: string
  /** app.isPackaged. A dev run is never eligible. */
  isPackaged: boolean
  /** process.platform. */
  platform: string
  /** Whether a staged AgentX-Setup binary was found. */
  hasStagedUpdater: boolean
}

export type AgentUpdateDecision =
  | { inApp: true }
  | { inApp: false; reason: 'not-windows' | 'has-staged-updater' | 'not-packaged' | 'built-from-checkout' }

/**
 * Normalize for comparison. Windows paths are case-insensitive and reach us in
 * mixed separators (`process.execPath` uses backslashes, a config-derived root
 * may not), so a raw `startsWith` answers "different install" for two spellings
 * of the same directory — and getting THAT wrong means rebuilding nothing when
 * a rebuild was needed.
 */
function normalize(value: string): string {
  return path.win32
    .normalize(String(value || ''))
    .replace(/[\\/]+$/, '')
    .toLowerCase()
}

/** True when `child` is inside `parent` (or is `parent`). */
export function isInside(child: string, parent: string): boolean {
  const c = normalize(child)
  const p = normalize(parent)

  if (!c || !p) {
    return false
  }

  return c === p || c.startsWith(p + '\\')
}

/**
 * May this desktop run `agentx update` itself instead of handing off?
 *
 * Only when all four hold:
 *   - we are on Windows (elsewhere the existing in-app path already applies);
 *   - no staged updater exists (if one does, it is the better-tested route and
 *     it also rebuilds, which we deliberately cannot);
 *   - the app is packaged (a dev `electron .` run must never mutate a checkout);
 *   - the running binary lives OUTSIDE the checkout, so `agentx update` has
 *     nothing of ours to rebuild and nothing of ours to lock.
 *
 * That last one is the whole safety argument. A desktop running from
 * `<checkout>\apps\desktop\release\win-unpacked` IS the thing an update would
 * rebuild, and Windows cannot replace it while it runs — those installs keep
 * the hand-off, and the manual message when there is nothing to hand off to.
 */
export function decideInAppAgentUpdate(context: AgentUpdateContext): AgentUpdateDecision {
  if (context.platform !== 'win32') {
    return { inApp: false, reason: 'not-windows' }
  }

  if (context.hasStagedUpdater) {
    return { inApp: false, reason: 'has-staged-updater' }
  }

  if (!context.isPackaged) {
    return { inApp: false, reason: 'not-packaged' }
  }

  if (isInside(context.execPath, context.updateRoot)) {
    return { inApp: false, reason: 'built-from-checkout' }
  }

  return { inApp: true }
}
