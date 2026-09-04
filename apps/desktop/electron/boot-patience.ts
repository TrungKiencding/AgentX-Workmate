/**
 * Boot patience — retry the first requests to a backend that is still warming up.
 *
 * `waitForHermesReady` only proves that `/api/health` answers. Right after
 * that, on a cold machine, the backend is still importing tools, scanning
 * skills and warming caches, so its *next* few answers can take longer than
 * one request's socket timeout. Boot used to treat that single slow answer as
 * a hard failure ("Timed out connecting to AgentX backend after 8000ms") and
 * put a recovery dialog in front of someone whose install was perfectly fine
 * — pressing Retry a few seconds later worked every time.
 *
 * A patience instance is one boot's worth of tolerance: every step it wraps
 * shares one deadline, only timeout-shaped errors are retried, and anything
 * else (a 401, a malformed body, a dead process) propagates immediately, so
 * the real failures still fail fast.
 *
 * Pure: the clock, the sleep and the log are injected, so the policy is
 * testable without a backend.
 */

export const DEFAULT_BOOT_PATIENCE_BUDGET_MS = 60_000
export const DEFAULT_BOOT_PATIENCE_DELAY_MS = 1_500

const WARMUP_MARKERS = ['timed out connecting to agentx backend', 'etimedout', 'socket hang up']

/** True for the failure shapes a still-starting backend produces. */
export function isBackendWarmupError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error ?? '')).toLowerCase()

  return WARMUP_MARKERS.some(marker => message.includes(marker))
}

export interface BootPatienceRetry {
  /** 1-based attempt that just failed. */
  attempt: number
  label: string
  remainingMs: number
}

export interface BootPatienceOptions {
  /** Total time, across every wrapped step, this boot is willing to wait. */
  budgetMs?: number
  /** Pause between attempts. */
  delayMs?: number
  isRetryable?: (error: unknown) => boolean
  log?: (message: string) => void
  now?: () => number
  /** Called before each retry — the boot surface uses it to say "still warming up". */
  onRetry?: (retry: BootPatienceRetry) => void
  sleep?: (ms: number) => Promise<void>
}

export interface BootPatience {
  /** Run `fn`, retrying warm-up failures while the shared budget lasts. */
  run<T>(label: string, fn: () => Promise<T>): Promise<T>
  /** How many retries this boot has needed so far (diagnostics). */
  readonly retries: number
}

export function createBootPatience(options: BootPatienceOptions = {}): BootPatience {
  const budgetMs = options.budgetMs ?? DEFAULT_BOOT_PATIENCE_BUDGET_MS
  const delayMs = options.delayMs ?? DEFAULT_BOOT_PATIENCE_DELAY_MS
  const isRetryable = options.isRetryable ?? isBackendWarmupError
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  // One deadline for the whole boot, started when the patience is created —
  // three slow steps must not each get a fresh minute.
  const deadline = now() + budgetMs
  let retries = 0

  return {
    get retries() {
      return retries
    },

    async run<T>(label: string, fn: () => Promise<T>): Promise<T> {
      let attempt = 0

      for (;;) {
        attempt += 1

        try {
          return await fn()
        } catch (error) {
          const remainingMs = deadline - now()

          if (!isRetryable(error) || remainingMs <= 0) {
            throw error
          }

          retries += 1
          options.log?.(
            `[boot] ${label}: backend still warming up (${
              error instanceof Error ? error.message : String(error)
            }); retrying in ${delayMs}ms, ${Math.ceil(remainingMs / 1000)}s of patience left`
          )
          options.onRetry?.({ attempt, label, remainingMs })
          await sleep(Math.min(delayMs, remainingMs))
        }
      }
    }
  }
}
