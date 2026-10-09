import { atom, computed } from 'nanostores'

import type { DesktopAgentxKeyGate } from '@/global'

/**
 * The AgentX key gate, mirrored from the main process (electron/agentx-key-gate.ts).
 *
 * The main process decides: it holds the boot of a signed-in account that has
 * no AgentX AI Gateway key and pushes every change here. This window renders
 * the gate while it is shut, and reads `required` to keep the onboarding card
 * on the gateway — an account that must hold an AgentX key is never offered
 * another provider or a way to skip.
 */

export const OPEN_AGENTX_KEY_GATE: DesktopAgentxKeyGate = Object.freeze({
  account: null,
  attempts: 0,
  failure: null,
  phase: 'open',
  required: false
}) as DesktopAgentxKeyGate

export const $agentxKeyGate = atom<DesktopAgentxKeyGate>(OPEN_AGENTX_KEY_GATE)

/** The gate owns the screen: the account has no key yet and the boot is waiting for one. */
export const $agentxKeyGateShut = computed($agentxKeyGate, state => state.required && state.phase !== 'open')

/** The signed-in account must run on its AgentX key (whether or not it has one yet). */
export const $agentxKeyRequired = computed($agentxKeyGate, state => state.required)

function bridge() {
  return typeof window === 'undefined' ? undefined : window.agentxDesktop?.account?.keyGate
}

const PHASES = new Set(['blocked', 'open', 'provisioning'])

/** Take the main process's state, ignoring anything that is not shaped like one. */
function receive(state: unknown): void {
  if (!state || typeof state !== 'object') {
    return
  }

  const candidate = state as Partial<DesktopAgentxKeyGate>

  if (typeof candidate.required !== 'boolean' || !PHASES.has(String(candidate.phase))) {
    return
  }

  $agentxKeyGate.set({
    account: candidate.account ?? null,
    attempts: typeof candidate.attempts === 'number' ? candidate.attempts : 0,
    failure: candidate.failure ?? null,
    phase: candidate.phase as DesktopAgentxKeyGate['phase'],
    required: candidate.required
  })
}

/** Mirror the main process's key gate into this window. Returns the unsubscribe. */
export function startAgentxKeyGateSync(): () => void {
  const api = bridge()

  if (!api) {
    return () => undefined
  }

  const off = api.onChanged(receive)

  void api
    .get()
    .then(receive)
    .catch(() => undefined)

  return off
}

/** "Try again" at the gate. The main process answers with the state it ended in. */
export async function retryAgentxKey(): Promise<void> {
  const api = bridge()

  if (!api) {
    return
  }

  try {
    receive(await api.retry())
  } catch {
    receive(await api.get().catch(() => null))
  }
}
