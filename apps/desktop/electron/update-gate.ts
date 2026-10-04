'use strict'

/**
 * update-gate.ts
 *
 * Pure, dependency-injected gate that parks local backend spawns while an
 * update owns the agent install (#50238).
 *
 * The signal is the on-disk marker (`AGENTX_HOME/.agentx-update-in-progress`,
 * see update-marker.ts). `agentx update` holds it for its whole run
 * (hermes_cli/update_lock.py), and so does a staged recovery updater
 * (apps/bootstrap-installer) — written by the desktop itself just before it
 * hands off. A backend spawned underneath either would re-lock the venv the
 * update is rewriting.
 */

export type UpdateGateReason = 'marker' | null

export interface UpdateGateDeps {
  /** True when a live on-disk update marker exists (see update-marker.ts). */
  hasLiveMarker: () => boolean
}

/** Why the gate is closed right now, or null when it is open. */
export function updateGateReason(deps: UpdateGateDeps): UpdateGateReason {
  return deps.hasLiveMarker() ? 'marker' : null
}

export type UpdateClearanceOutcome = 'clear' | 'finished' | 'timeout'

export interface WaitForUpdateClearanceOptions {
  timeoutMs: number
  pollMs: number
  /** Invoked once per poll while parked (boot progress / logging). */
  onWaitTick?: (reason: Exclude<UpdateGateReason, null>) => void | Promise<void>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/**
 * Park until no update signal remains, or the deadline passes.
 *
 * Returns 'clear' when the gate was already open (no wait happened),
 * 'finished' when it opened during the wait, and 'timeout' when the deadline
 * expired with the gate still closed (callers proceed anyway — matching the
 * long-standing marker-gate behavior, since a wedged updater must not brick
 * the app forever).
 */
export async function waitForUpdateClearance(
  deps: UpdateGateDeps,
  options: WaitForUpdateClearanceOptions
): Promise<UpdateClearanceOutcome> {
  const now = options.now || Date.now
  const sleep = options.sleep || (ms => new Promise<void>(r => setTimeout(r, ms)))

  let reason = updateGateReason(deps)

  if (!reason) {
    return 'clear'
  }

  const deadline = now() + options.timeoutMs

  while (reason && now() < deadline) {
    if (options.onWaitTick) {
      await options.onWaitTick(reason)
    }

    await sleep(options.pollMs)
    reason = updateGateReason(deps)
  }

  return reason ? 'timeout' : 'finished'
}
