import type { GatewayEvent } from '@agentx/shared'

export interface UsageSignal {
  key: string
  profile?: string
  phase: 'start' | 'finish'
  failed?: boolean
  cancelled?: boolean
  /** Why the turn failed, in the SSO dashboard's words (`failure_code`, tui_gateway/usage_outcome.py). */
  code?: string
}

/**
 * Pass lifecycle signals only; never cross transcript/tool data over IPC.
 *
 * A turn ends at its terminal `message.complete`, never at an `error` event:
 * the gateway also emits those for warnings while the turn goes on.
 */
export function usageSignal(event: GatewayEvent): UsageSignal | null {
  if (!event.session_id || !['message.start', 'message.complete'].includes(event.type)) {
    return null
  }

  if (event.type === 'message.start') {
    return { key: event.session_id, profile: event.profile, phase: 'start' }
  }

  const payload = event.payload && typeof event.payload === 'object' ? (event.payload as Record<string, unknown>) : {}
  const status = String(payload.status || '')
  const code = typeof payload.failure_code === 'string' ? payload.failure_code : undefined
  const cancelled = ['cancelled', 'canceled', 'stopped', 'interrupted'].includes(status)

  return {
    key: event.session_id,
    profile: event.profile,
    phase: 'finish',
    // A turn can end without an error and still without its answer (out of iterations, say).
    failed: !cancelled && (Boolean(code) || ['error', 'failed'].includes(status)),
    cancelled,
    ...(code && !cancelled ? { code } : {})
  }
}

export function reportUsageEvent(event: GatewayEvent): void {
  const signal = usageSignal(event)

  if (signal) {
    void window.agentxDesktop?.usageEvent?.(signal).catch(() => {})
  }
}
