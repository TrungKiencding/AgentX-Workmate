/**
 * checkout-pin.ts
 *
 * Where the managed agent checkout stands relative to the commit this desktop
 * build was stamped with (build/install-stamp.json, shipped as
 * resources/install-stamp.json).
 *
 * Why this exists
 * ───────────────
 * The desktop shell and the Python agent ship separately. An installer (or a
 * dragged-in .app) replaces the shell; the agent is a git checkout under
 * AGENTX_HOME that the first-launch bootstrap cloned and that every later
 * launch reuses for as long as it runs. Nothing compared the two, so a new
 * build installed over a machine that already had an agent kept running the
 * OLD agent: a September shell over an August checkout whose defaults the
 * account service had long moved past (`accounts.litellm.mode: direct`, an
 * admin key no installer carries any more).
 *
 * The rule is deliberately one-directional. A checkout BEHIND the stamp is
 * reported so the bootstrap can bring it forward before launch. A checkout AT
 * or AHEAD of the stamp is left exactly where it is: the in-app update path,
 * `agentx update`, and a developer's own branch all move HEAD legitimately,
 * and an installer built months ago must never rewind them. The install
 * scripts enforce the same rule on their side (`-Commit` without
 * `-ForceCommit` skips a pin that is already an ancestor of HEAD), so asking
 * them to pin an existing tree is safe.
 *
 * Pure decision + one thin git probe, so the decision is unit-tested without
 * a repository and the probe is tested with a fake `execGit`.
 */

import { execFileSync } from 'node:child_process'

import { hiddenWindowsChildOptions } from './windows-child-options'

export type CheckoutPinRelation =
  /** No real stamp to compare against (dev run, non-git fallback build). */
  | 'unpinned'
  /** Not a git checkout, or git could not be asked: leave it alone. */
  | 'unknown'
  /** HEAD is the stamped commit. */
  | 'at-pin'
  /** The stamped commit is an ancestor of HEAD: the checkout is newer. */
  | 'ahead'
  /** HEAD does not contain the stamped commit: the checkout is older. */
  | 'behind'

const COMMIT_RE = /^[0-9a-f]{7,40}$/i
const FALLBACK_COMMIT_RE = /^0{7,40}$/

/** A commit the stamp writer actually resolved — not the all-zero placeholder. */
export function isRealPin(commit: unknown): commit is string {
  return typeof commit === 'string' && COMMIT_RE.test(commit) && !FALLBACK_COMMIT_RE.test(commit)
}

export interface CheckoutPinFacts {
  pinnedCommit: unknown
  /** `git rev-parse HEAD`, or null when there is no checkout to ask. */
  headSha: string | null
  /**
   * `git merge-base --is-ancestor <pin> HEAD`: true / false when git answered,
   * null when it could not (no such object locally, no repository).
   */
  pinIsAncestorOfHead: boolean | null
}

export function relateCheckoutToPin({
  pinnedCommit,
  headSha,
  pinIsAncestorOfHead
}: CheckoutPinFacts): CheckoutPinRelation {
  if (!isRealPin(pinnedCommit)) {
    return 'unpinned'
  }

  if (typeof headSha !== 'string' || !COMMIT_RE.test(headSha)) {
    return 'unknown'
  }

  const pin = pinnedCommit.toLowerCase()
  const head = headSha.toLowerCase()

  // Stamps are full SHAs today; tolerate an abbreviated one.
  if (head === pin || head.startsWith(pin)) {
    return 'at-pin'
  }

  if (pinIsAncestorOfHead === true) {
    return 'ahead'
  }

  // false: HEAD provably lacks the commit. null: git has no such object,
  // which on a managed checkout means it was never fetched — the checkout
  // predates it. Both are "behind"; the install scripts re-check after
  // fetching and never roll a newer checkout back, so erring this way costs
  // one no-op installer pass, never a downgrade.
  return 'behind'
}

export interface GitResult {
  /** Exit status, or null when git could not run at all (missing binary, timeout). */
  status: number | null
  stdout: string
}

export type ExecGit = (args: string[], cwd: string) => GitResult

/**
 * A synchronous git runner for the boot path: quiet, no credential prompts,
 * no console window on Windows, bounded by a timeout. Non-zero exits and
 * spawn failures both come back as a result rather than a throw, because
 * `merge-base --is-ancestor` answers with its exit status.
 */
export function defaultExecGit(gitBinary: string, isWindows: boolean = process.platform === 'win32'): ExecGit {
  return (args, cwd) => {
    const fullArgs = isWindows ? ['-c', 'windows.appendAtomically=false', ...args] : args

    try {
      const stdout = execFileSync(
        gitBinary,
        fullArgs,
        hiddenWindowsChildOptions(
          {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 15_000,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
          },
          isWindows
        )
      )

      return { status: 0, stdout: String(stdout) }
    } catch (err: any) {
      return {
        status: typeof err?.status === 'number' ? err.status : null,
        stdout: typeof err?.stdout === 'string' ? err.stdout : ''
      }
    }
  }
}

export interface CheckoutPinProbe {
  relation: CheckoutPinRelation
  headSha: string | null
}

/**
 * Ask the checkout at `activeRoot` where it stands against `pinnedCommit`.
 * Two git calls at most, and none at all when there is no real pin.
 */
export function probeCheckoutPin(
  activeRoot: string | null | undefined,
  pinnedCommit: unknown,
  execGit: ExecGit
): CheckoutPinProbe {
  if (!isRealPin(pinnedCommit) || !activeRoot) {
    return { relation: isRealPin(pinnedCommit) ? 'unknown' : 'unpinned', headSha: null }
  }

  const head = execGit(['rev-parse', 'HEAD'], activeRoot)
  const headSha = head.status === 0 ? head.stdout.trim() : null

  if (!headSha || !COMMIT_RE.test(headSha)) {
    return { relation: 'unknown', headSha: null }
  }

  let pinIsAncestorOfHead: boolean | null = null

  if (
    headSha.toLowerCase() !== pinnedCommit.toLowerCase() &&
    !headSha.toLowerCase().startsWith(pinnedCommit.toLowerCase())
  ) {
    const ancestry = execGit(['merge-base', '--is-ancestor', pinnedCommit, 'HEAD'], activeRoot)

    pinIsAncestorOfHead = ancestry.status === 0 ? true : ancestry.status === 1 ? false : null
  }

  return { relation: relateCheckoutToPin({ pinnedCommit, headSha, pinIsAncestorOfHead }), headSha }
}
