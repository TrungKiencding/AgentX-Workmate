import { randomUUID } from 'node:crypto'

import type { NativeTokenSet } from './native-oauth'

export interface UsageIdentity {
  subject: string
  /**
   * The Keycloak OAuth access token. The SSO console answers an ID token with
   * 401. Empty while the session has none, and then nothing is sent.
   */
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
  /** Desktop log. Gets each distinct delivery failure once, never a token or event content. */
  log?: (line: string) => void
}

/**
 * Who a turn counts for, from the desktop's Keycloak session.
 *
 * The token is `oauthAccessToken`, never `accessToken`: the latter holds the
 * ID token the backend verifies, and the usage endpoint refuses ID tokens.
 */
export function usageIdentityFromSession(
  tokens: Pick<NativeTokenSet, 'userId' | 'oauthAccessToken'> | null,
  issuer: string
): UsageIdentity | null {
  return tokens?.userId ? { subject: tokens.userId, token: tokens.oauthAccessToken || '', issuer } : null
}

interface ActiveTurn {
  started: number
  identity: Promise<UsageIdentity | null>
  profile?: string
}
/** Main-process owner: multiple renderer windows cannot duplicate a turn. */
export class UsageReporter {
  private readonly active = new Map<string, ActiveTurn>()
  private readonly logged = new Set<string>()
  private readonly now: () => number
  private pending = 0
  constructor(private readonly deps: UsageDependencies) {
    this.now = deps.now || (() => performance.now())
  }
  /** Once per distinct line: a rejected token would otherwise repeat on every turn. */
  private logOnce(line: string): void {
    if (this.logged.has(line)) {
      return
    }

    this.logged.add(line)
    this.deps.log?.(line)
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

      // Only the account at the end needs a token. One that started on a
      // session saved by an earlier release may have gained it meanwhile.
      if (!identity || !current?.token || identity.subject !== current.subject || identity.issuer !== current.issuer) {
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

      let lastFailure = ''

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
            this.logOnce(`[usage] the SSO console refused usage metrics: HTTP ${response.status}`)

            return false
          }

          lastFailure = `HTTP ${response.status}`
        } catch (error) {
          /* Retry with the same UUID; never include prompt text. */
          lastFailure = error instanceof Error ? error.name : 'network error'
        }

        if (attempt < 2) {
          await (this.deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms))))((attempt + 1) * 1000)
        }
      }

      this.logOnce(`[usage] usage metrics could not be delivered after 3 attempts: ${lastFailure}`)
    } catch {
      /* Metrics never change the operation or sign-in result. */
    } finally {
      this.pending--
    }

    return false
  }
}
