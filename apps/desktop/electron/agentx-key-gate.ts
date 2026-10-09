/**
 * agentx-key-gate.ts
 *
 * A person signed in to AgentX does not use Workmate until their account
 * holds an AgentX AI Gateway key.
 *
 * Sign-in provisions that key (`ensureAccountProvisioned` in main.ts). When it
 * could not — the keys service refused (HTTP 424: none of the models chosen
 * in the SSO console is served right now), the network was down, the device
 * was revoked, the license does not cover AI — the app used to finish booting
 * anyway and drop the person on the provider picker, where "Choose another
 * provider", an API-key form and "I'll choose later" all led past the missing
 * key. Every one of those is a way of running Workmate on something AgentX
 * does not manage, so the boot now stops short of handing the app over: the
 * connection is not reported ready until the key is on this machine. Nothing
 * behind the gate can be reached, because nothing behind it has started —
 * no session list, no composer, no Quick Entry, no wake word.
 *
 * What the person can do at the gate is narrow on purpose: try again (an
 * outage or a fixed SSO console resolves it), sign out (somebody else's
 * account), or contact support with the reason shown. When provisioning is not
 * part of this install at all — `accounts.litellm` disabled, or no keys
 * service configured — there is no key to wait for and the gate stays open.
 *
 * Pure apart from the injected I/O, so the whole policy is unit-tested.
 */

/** What `/api/account`'s `litellm` block says about the key on this machine. */
export type AccountKeyStanding = 'has-key' | 'missing' | 'not-required' | 'unknown'

/** Statuses `account_key_status` / `ensure_account_key` report for a key that is in place. */
const KEY_PRESENT = new Set(['provisioned', 'reused', 'rotated'])

/** Statuses meaning this install does not provision keys at all. */
const NOT_REQUIRED = new Set(['disabled', 'unconfigured'])

export function classifyAccountKey(litellm: unknown): AccountKeyStanding {
  const status = typeof (litellm as any)?.status === 'string' ? (litellm as any).status : ''

  if (!status) {
    return 'unknown'
  }

  if (NOT_REQUIRED.has(status)) {
    return 'not-required'
  }

  if (status === 'missing') {
    return 'missing'
  }

  return (litellm as any).ok === true || KEY_PRESENT.has(status) ? 'has-key' : 'unknown'
}

/** Why the key could not be issued, in the shape the gate renders. */
export interface AgentxKeyFailure {
  /** The provisioning status (`error`, `offline`, `revoked`, `license_inactive`, …), or `no-answer`. */
  status: string
  /** The service's machine-readable reason when it gave one (`no_grantable_models`, …). */
  code: string
  /** The operator-facing detail — what support needs, never the headline. */
  detail: string
  /** The license the service sent with a `license_inactive` refusal. */
  license: unknown
}

export function failureFromProvision(litellm: unknown): AgentxKeyFailure {
  const body = (litellm || {}) as Record<string, unknown>
  const status = typeof body.status === 'string' && body.status ? body.status : 'no-answer'

  return {
    code: typeof body.code === 'string' ? body.code : '',
    detail: typeof body.detail === 'string' ? body.detail.trim() : '',
    license: body.license ?? null,
    status
  }
}

export interface AgentxKeyGateAccount {
  displayName: string
  email: string
}

export interface AgentxKeyGateState {
  /** True while the signed-in account must hold an AgentX key — whether or not it has one yet. */
  required: boolean
  /** `open`: nothing to wait for. `provisioning`: asking for the key now. `blocked`: waiting for the person. */
  phase: 'blocked' | 'open' | 'provisioning'
  failure: AgentxKeyFailure | null
  account: AgentxKeyGateAccount | null
  /** Provisioning attempts made at this gate, the one sign-in made included. */
  attempts: number
}

export const OPEN_KEY_GATE: AgentxKeyGateState = Object.freeze({
  account: null,
  attempts: 0,
  failure: null,
  phase: 'open',
  required: false
}) as AgentxKeyGateState

export interface AgentxKeyGateHold {
  account: AgentxKeyGateAccount
  /** The answer sign-in's own provisioning already got this launch, or undefined when it did not wait for one. */
  lastAttempt?: unknown
  /** `/api/account`'s `litellm` block; null when it could not be read. */
  readKey(): Promise<unknown>
  /** `/api/account/provision`'s `litellm` block; null when the backend gave no answer. */
  provision(): Promise<unknown>
  /** Aborting it (the backend went away, a new boot started) lets go of the hold with the abort reason. */
  signal?: AbortSignal
}

export interface AgentxKeyGateDeps {
  publish(state: AgentxKeyGateState): void
  log(message: string): void
}

function isOk(litellm: unknown): boolean {
  return Boolean(litellm) && (litellm as any).ok === true
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('The AgentX key gate was released.')
}

export class AgentxKeyGate {
  private current: AgentxKeyGateState = OPEN_KEY_GATE
  private hold_: (AgentxKeyGateHold & { reject(error: Error): void; resolve(): void }) | null = null
  private retrying: Promise<AgentxKeyGateState> | null = null

  constructor(private readonly deps: AgentxKeyGateDeps) {}

  get state(): AgentxKeyGateState {
    return this.current
  }

  /**
   * Resolve once the signed-in account holds an AgentX key, or straight away
   * when it does not need one. Rejects only when released (see `release`).
   */
  async hold(options: AgentxKeyGateHold): Promise<void> {
    this.release(new Error('A newer boot took over the AgentX key gate.'))

    if (options.signal?.aborted) {
      throw abortReason(options.signal)
    }

    const standing = classifyAccountKey(await options.readKey())

    if (standing === 'not-required' || standing === 'unknown') {
      if (standing === 'unknown') {
        // Fail open: the backend that just authenticated this person could not
        // say what key it holds. Better a working app that the onboarding
        // card still steers to the gateway than a lock nobody can explain.
        this.deps.log('[account] could not read the account key status; not holding the boot for it')
      }

      this.set({ ...OPEN_KEY_GATE })

      return
    }

    if (standing === 'has-key') {
      this.set({ ...OPEN_KEY_GATE, account: options.account, required: true })

      return
    }

    let attempts = 0
    let failure: AgentxKeyFailure

    if (options.lastAttempt !== undefined && !isOk(options.lastAttempt)) {
      attempts = 1
      failure = failureFromProvision(options.lastAttempt)
    } else {
      // Sign-in did not wait for provisioning (the account had a key before)
      // or reported one that is not here: ask once now.
      this.set({ account: options.account, attempts: 1, failure: null, phase: 'provisioning', required: true })
      attempts = 1

      const issued = await this.provisionAndCheck(options)

      if (issued === true) {
        this.set({ ...OPEN_KEY_GATE, account: options.account, attempts, required: true })

        return
      }

      failure = issued
    }

    if (options.signal?.aborted) {
      throw abortReason(options.signal)
    }

    this.deps.log(
      `[account] no AgentX key for this account (${failure.status}${failure.code ? `/${failure.code}` : ''}: ${
        failure.detail || 'no detail'
      }); holding the app at the key gate`
    )

    await new Promise<void>((resolve, reject) => {
      this.hold_ = { ...options, reject, resolve }
      this.set({ account: options.account, attempts, failure, phase: 'blocked', required: true })

      const { signal } = options

      if (signal?.aborted) {
        this.release(abortReason(signal))
      } else {
        signal?.addEventListener('abort', () => this.release(abortReason(signal)), { once: true })
      }
    })
  }

  /**
   * "Try again" at the gate. Returns the state it ends in; a key that arrived
   * opens the gate and lets the held boot finish.
   */
  retry(): Promise<AgentxKeyGateState> {
    const held = this.hold_

    if (!held || this.current.phase !== 'blocked') {
      return Promise.resolve(this.current)
    }

    if (this.retrying) {
      return this.retrying
    }

    const attempts = this.current.attempts + 1

    this.set({ ...this.current, attempts, phase: 'provisioning' })

    this.retrying = this.provisionAndCheck(held)
      .then(issued => {
        // Released while the request was out: the boot it belonged to is gone.
        if (this.hold_ !== held) {
          return this.current
        }

        if (issued === true) {
          this.hold_ = null
          this.set({ ...OPEN_KEY_GATE, account: held.account, attempts, required: true })
          this.deps.log('[account] the AgentX key is in place; opening the key gate')
          held.resolve()
        } else {
          this.set({ account: held.account, attempts, failure: issued, phase: 'blocked', required: true })
        }

        return this.current
      })
      .finally(() => {
        this.retrying = null
      })

    return this.retrying
  }

  /**
   * Let go of a pending hold — the backend went away, a new boot started — so
   * the boot it was holding fails or is superseded instead of hanging. Whether
   * the account needs a key does not change with that, so `required` stays.
   */
  release(error: Error): void {
    const held = this.hold_

    this.hold_ = null

    if (held) {
      this.deps.log(`[account] key gate released: ${error.message}`)
      held.reject(error)
    }

    if (this.current.phase !== 'open') {
      this.set({ ...this.current, failure: null, phase: 'open' })
    }
  }

  /** Nobody is signed in any more (sign-out, an ungated or remote backend): no account, no key to need. */
  forget(): void {
    this.release(new Error('Nobody is signed in to AgentX.'))

    if (this.current.required || this.current.account) {
      this.set({ ...OPEN_KEY_GATE })
    }
  }

  private async provisionAndCheck(options: AgentxKeyGateHold): Promise<AgentxKeyFailure | true> {
    let result: unknown = null

    try {
      result = await options.provision()
    } catch (error) {
      this.deps.log(
        `[account] provisioning at the key gate failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    if (!isOk(result)) {
      return failureFromProvision(result)
    }

    // The service said yes; the gate opens on the key actually being here.
    let standing: AccountKeyStanding = 'unknown'

    try {
      standing = classifyAccountKey(await options.readKey())
    } catch {
      standing = 'unknown'
    }

    if (standing === 'missing') {
      return {
        code: '',
        detail: 'the key was issued but this machine did not keep it',
        license: null,
        status: 'error'
      }
    }

    return true
  }

  private set(next: AgentxKeyGateState): void {
    this.current = next
    this.deps.publish(next)
  }
}
