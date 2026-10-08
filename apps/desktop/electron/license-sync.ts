/**
 * license-sync.ts
 *
 * Keep every window's view of this person's AgentX license current.
 *
 * The keys service decides whether somebody may use AI; the local backend
 * keeps its last answer (license.json in the account home), refuses AI turns
 * from it, and re-evaluates it as time passes (hermes_cli/account_license.py).
 * This is the main process's half: it asks the backend to refresh that record
 * after sign-in and then every LICENSE_REFRESH_INTERVAL_MS while the app runs
 * (riding the account ticker main already has rather than a timer of its own,
 * and a window coming back into focus), re-reads the record on the beats in
 * between, and tells every window when the answer changed.
 *
 * An unreachable backend never erases what is known: a window that hid the
 * read-only banner because the backend was restarting would let somebody type
 * into a composer that every turn then refuses.
 *
 * Kept free of electron imports so the cadence and the change detection are
 * testable without booting Electron.
 */

export const LICENSE_ROUTE = '/api/account/license'

/** How old the last refresh may get before the ticker or a focus asks again. */
export const LICENSE_REFRESH_INTERVAL_MS = 30 * 60_000

/** What a window is told: the backend route's answer, normalised. */
export interface LicenseView {
  /** The account the license belongs to (the backend's slug), when known. */
  account: null | string
  detail: string
  /** The license as it stands now, or null while none is known. */
  license: null | Record<string, unknown>
  /**
   * How the last read went: `cached` (read from the backend's record), the
   * refresh outcome (`ok`, `offline`, `unsupported`, `unauthorized`, `revoked`,
   * `unconfigured`, `error`), `unavailable` when the backend itself could not
   * be asked — no news, the license shown is the last one known — or
   * `signed_out` after a sign-out cleared it.
   */
  status: string
}

export interface LicenseSyncDeps {
  /** GET the license route; `refresh` asks the keys service first. May throw. */
  fetch: (refresh: boolean) => Promise<unknown>
  /** Tell every window the view changed. */
  broadcast: (view: LicenseView) => void
  now?: () => number
  log?: (line: string) => void
}

const INITIAL_VIEW: LicenseView = { account: null, detail: '', license: null, status: 'unavailable' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isLicense(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value.state === 'string' && typeof value.access === 'string'
}

/**
 * The backend's answer as a view, or null when it is not one — a route that is
 * missing on an older backend, an HTML error page, a failed request.
 */
export function licenseViewFrom(body: unknown): LicenseView | null {
  if (!isRecord(body) || !('license' in body)) {
    return null
  }

  return {
    account: typeof body.account === 'string' && body.account ? body.account : null,
    detail: typeof body.detail === 'string' ? body.detail : '',
    license: isLicense(body.license) ? body.license : null,
    status: typeof body.status === 'string' && body.status ? body.status : 'cached'
  }
}

/**
 * What the windows care about. `server_time` moves on every refresh and says
 * nothing new by itself; everything else that changes (a state, a day count, a
 * reminder) is news.
 */
function fingerprint(view: LicenseView): string {
  const license = view.license ? { ...view.license, server_time: undefined } : null

  return JSON.stringify({ account: view.account, license })
}

export function createLicenseSync(deps: LicenseSyncDeps) {
  const now = deps.now ?? Date.now
  let view: LicenseView = INITIAL_VIEW
  let lastRefreshAt = 0
  let inFlight: null | Promise<LicenseView> = null
  // Answers arrive out of order. Bumped by `forget`: nothing asked before a
  // sign-out may land after it. Bumped by every finished refresh: a read of
  // the backend's record that started earlier may carry what it replaced.
  let epoch = 0
  let refreshesDone = 0

  function settle(next: LicenseView): LicenseView {
    const changed = fingerprint(next) !== fingerprint(view)

    view = next

    if (changed) {
      try {
        deps.broadcast(next)
      } catch (error) {
        // A window going away mid-send must not stop the cadence or reject a
        // caller that only asked for the answer.
        deps.log?.(`[license] could not tell the windows: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    return next
  }

  async function ask(refresh: boolean): Promise<LicenseView> {
    const askedIn = { epoch, refreshesDone }
    let body: unknown

    try {
      body = await deps.fetch(refresh)
    } catch (error) {
      body = null
      deps.log?.(`[license] could not ask the backend: ${error instanceof Error ? error.message : String(error)}`)
    }

    if (askedIn.epoch !== epoch || (!refresh && askedIn.refreshesDone !== refreshesDone)) {
      return view
    }

    if (refresh) {
      refreshesDone += 1
    }

    const answer = licenseViewFrom(body)

    if (!answer) {
      // The backend could not be asked at all. What it said last still holds.
      const detail = isRecord(body) && typeof body.detail === 'string' ? body.detail : ''

      return settle({ ...view, detail, status: 'unavailable' })
    }

    return settle(answer)
  }

  /** The backend's record, without asking the keys service. */
  function read(): Promise<LicenseView> {
    return ask(false)
  }

  /** Ask the keys service now. Concurrent callers share one request. */
  function refresh(reason: string): Promise<LicenseView> {
    if (inFlight) {
      return inFlight
    }

    lastRefreshAt = now()

    const pending: Promise<LicenseView> = ask(true)
      .then(result => {
        if (result.status !== 'ok') {
          deps.log?.(`[license] ${reason}: ${result.status}${result.detail ? ` — ${result.detail}` : ''}`)
        }

        return result
      })
      .finally(() => {
        if (inFlight === pending) {
          inFlight = null
        }
      })

    inFlight = pending

    return pending
  }

  /**
   * The account ticker's beat (and a window coming back into focus). Asks the
   * keys service once the last refresh is old enough; in between, re-reads the
   * backend's record, which the backend re-evaluates as time passes — so a
   * plan starting, ending or running out of grace shows within a beat rather
   * than at the next refresh. Never starts the cadence on its own: before the
   * first refresh (sign-in) there is nobody whose license to ask about.
   */
  function tick(reason: string): null | Promise<LicenseView> {
    if (lastRefreshAt === 0) {
      return null
    }

    return now() - lastRefreshAt >= LICENSE_REFRESH_INTERVAL_MS ? refresh(reason) : read()
  }

  /**
   * Somebody signed out. Whoever signs in next starts from nothing known —
   * never from the last person's read-only banner — and the cadence waits for
   * their first refresh.
   */
  function forget(): void {
    epoch += 1
    inFlight = null
    lastRefreshAt = 0
    settle({ ...INITIAL_VIEW, status: 'signed_out' })
  }

  return {
    current: (): LicenseView => view,
    forget,
    read,
    refresh,
    tick
  }
}

export type LicenseSync = ReturnType<typeof createLicenseSync>
