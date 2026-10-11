import { randomUUID } from 'node:crypto'

export interface UsageIdentity {
  subject: string
  token: string
  issuer: string
}
interface UsageDependencies {
  identity: (profile?: string) => Promise<UsageIdentity | null>
  version: string
  os: 'Windows' | 'macOS' | 'Linux' | 'Other'
  fetch?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}
interface ActiveTurn {
  started: number
  identity: Promise<UsageIdentity | null>
  profile?: string
}
/** Main-process owner: multiple renderer windows cannot duplicate a turn. */
export class UsageReporter {
  private readonly active = new Map<string, ActiveTurn>()
  private readonly now: () => number
  private pending = 0
  constructor(private readonly deps: UsageDependencies) {
    this.now = deps.now || (() => performance.now())
  }
  begin(key: string, profile?: string): void {
    if (this.active.has(key)) {
      return
    }

    if (this.active.size >= 256) {
      this.active.delete(this.active.keys().next().value!)
    }

    this.active.set(key, {
      started: this.now(),
      profile,
      identity: Promise.resolve()
        .then(() => this.deps.identity(profile))
        .catch(() => null)
    })
  }
  async end(key: string, failed: boolean, cancelled = false): Promise<boolean> {
    const turn = this.active.get(key)

    if (!turn) {
      return false
    }

    this.active.delete(key)

    if (cancelled || this.pending >= 128) {
      return false
    }

    this.pending++

    try {
      const identity = await turn.identity
      const current = await this.deps.identity(turn.profile)

      if (!identity || !current || identity.subject !== current.subject || identity.issuer !== current.issuer) {
        return false
      }

      const issuer = new URL(current.issuer)

      if (issuer.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(issuer.hostname)) {
        return false
      }

      const event = {
        product: 'agentx-workmate',
        event_id: randomUUID(),
        occurred_at: new Date().toISOString(),
        feature: 'chat.turn',
        outcome: failed ? 'failure' : 'success',
        version: this.deps.version,
        os: this.deps.os,
        browser: 'Native',
        duration_ms: Math.min(3600000, Math.max(0, Math.round(this.now() - turn.started))),
        ...(failed ? { error_code: 'operation_failed' } : {})
      }

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await (this.deps.fetch || fetch)(`${issuer.origin}/sso/api/analytics/events`, {
            method: 'POST',
            redirect: 'error',
            headers: {
              Authorization: `Bearer ${current.token}`,
              'Content-Type': 'application/json',
              'X-SSO-Request': '1'
            },
            body: JSON.stringify({ events: [event] }),
            signal: AbortSignal.timeout(3000)
          })

          if (response.status === 202) {
            return true
          }

          if (response.status < 500 && response.status !== 429) {
            return false
          }
        } catch {
          /* Retry with the same UUID; never include prompt text. */
        }

        if (attempt < 2) {
          await (this.deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms))))((attempt + 1) * 1000)
        }
      }
    } catch {
      /* Metrics never change the operation or sign-in result. */
    } finally {
      this.pending--
    }

    return false
  }
}
