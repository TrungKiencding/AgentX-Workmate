import type { GatewayEvent } from '@agentx/shared'

/** Pass lifecycle signals only; never cross transcript/tool data over IPC. */
export function usageSignal(
  event: GatewayEvent
): { key: string; profile?: string; phase: 'start' | 'finish'; failed?: boolean; cancelled?: boolean } | null {
  if (!event.session_id || !['message.start', 'message.complete', 'error'].includes(event.type)) {
    return null
  }

  const payload = event.payload && typeof event.payload === 'object' ? (event.payload as Record<string, unknown>) : {}

  if (event.type === 'message.start') {
    return { key: event.session_id, profile: event.profile, phase: 'start' }
  }

  return {
    key: event.session_id,
    profile: event.profile,
    phase: 'finish',
    failed: event.type === 'error' || ['error', 'failed'].includes(String(payload.status || '')),
    cancelled: ['cancelled', 'canceled', 'stopped', 'interrupted'].includes(String(payload.status || ''))
  }
}

export function reportUsageEvent(event: GatewayEvent): void {
  const signal = usageSignal(event)

  if (signal) {
    void window.agentxDesktop?.usageEvent?.(signal).catch(() => {})
  }
}
