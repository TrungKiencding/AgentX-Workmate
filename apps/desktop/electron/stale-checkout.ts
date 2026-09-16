/**
 * stale-checkout.ts
 *
 * Replacing an older agent checkout with a fresh one at the commit this
 * desktop build ships — without ever leaving the machine with no agent.
 *
 * Why replace rather than patch
 * ─────────────────────────────
 * Bringing a checkout forward in place (fetch + checkout + venv sync) has too
 * many ways to half-fail on an install nobody has touched for a month: a
 * clone without git metadata, a venv the new code no longer matches, a pin
 * the checkout's remote cannot fetch, a git binary that went missing. A
 * fresh install has exactly one failure mode — the network — and the
 * first-run bootstrap already handles that with a progress screen and a
 * retry. So the old checkout is moved ASIDE (a rename: instant, and atomic
 * on the same volume), the bootstrap clones and builds a new one exactly as
 * it would on an empty machine, and only once that succeeded is the old one
 * discarded. If the bootstrap fails or is cancelled, the old checkout goes
 * back and launches as before.
 *
 * User data never lives inside the checkout: config.yaml, .env, sessions and
 * the model key sit BESIDE it under AGENTX_HOME. None of this touches them.
 *
 * Windows detail: a rename is refused while any file inside is open, and a
 * delete is refused for the open files only. The rename refusing is the
 * signal to fall back to bringing the checkout forward in place; a delete
 * refusing leaves an `agentx-agent.stale-<ts>` directory that the next
 * launch (and the uninstaller) sweep.
 */

import fs from 'node:fs'
import path from 'node:path'

/** Suffix of a checkout moved aside; a timestamp follows so two replacements never collide. */
export const STALE_SUFFIX = '.stale-'

export interface SetAsideCheckout {
  activeRoot: string
  asidePath: string
}

/** The subset of `fs` these helpers use — injectable for tests that fake a refusal. */
export interface StaleCheckoutIo {
  existsSync: (p: string) => boolean
  renameSync: (from: string, to: string) => void
  rmSync: (p: string, options: fs.RmOptions) => void
  readdirSync: (dir: string) => string[]
}

const RM_OPTIONS: fs.RmOptions = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }

export function stalePathFor(activeRoot: string, now: number = Date.now()): string {
  return `${activeRoot}${STALE_SUFFIX}${now}`
}

/**
 * Move the checkout aside. Returns where it went, or null when there was
 * nothing at `activeRoot` or the rename was refused (a file inside is still
 * open — the caller then brings the checkout forward in place instead).
 */
export function setAsideStaleCheckout(
  activeRoot: string,
  io: StaleCheckoutIo = fs,
  now: number = Date.now()
): SetAsideCheckout | null {
  if (!io.existsSync(activeRoot)) {
    return null
  }

  const asidePath = stalePathFor(activeRoot, now)

  try {
    io.renameSync(activeRoot, asidePath)

    return { activeRoot, asidePath }
  } catch {
    return null
  }
}

/**
 * Put the old checkout back after a bootstrap that did not complete.
 * Whatever partial clone landed at `activeRoot` is removed first. Returns
 * false when the old checkout could not be put back — the caller then has
 * no runtime to launch and takes the ordinary install-failure path.
 */
export function restoreStaleCheckout(aside: SetAsideCheckout, io: StaleCheckoutIo = fs): boolean {
  try {
    if (io.existsSync(aside.activeRoot)) {
      io.rmSync(aside.activeRoot, RM_OPTIONS)
    }

    io.renameSync(aside.asidePath, aside.activeRoot)

    return io.existsSync(aside.activeRoot)
  } catch {
    return false
  }
}

/**
 * Delete the old checkout after a successful bootstrap. Returns false when
 * something in it is still held open; `sweepStaleCheckouts` gets it later.
 */
export function discardStaleCheckout(aside: SetAsideCheckout, io: StaleCheckoutIo = fs): boolean {
  try {
    io.rmSync(aside.asidePath, RM_OPTIONS)

    return !io.existsSync(aside.asidePath)
  } catch {
    return false
  }
}

/** Remove leftovers of earlier replacements sitting next to the checkout. */
export function sweepStaleCheckouts(
  activeRoot: string,
  io: StaleCheckoutIo = fs
): { removed: string[]; kept: string[] } {
  const dir = path.dirname(activeRoot)
  const prefix = path.basename(activeRoot) + STALE_SUFFIX
  let entries: string[]

  try {
    entries = io.readdirSync(dir)
  } catch {
    return { removed: [], kept: [] }
  }

  const removed: string[] = []
  const kept: string[] = []

  for (const name of entries) {
    if (!name.startsWith(prefix)) {
      continue
    }

    const full = path.join(dir, name)

    try {
      io.rmSync(full, { ...RM_OPTIONS, maxRetries: 2, retryDelay: 100 })
      ;(io.existsSync(full) ? kept : removed).push(full)
    } catch {
      kept.push(full)
    }
  }

  return { removed, kept }
}
