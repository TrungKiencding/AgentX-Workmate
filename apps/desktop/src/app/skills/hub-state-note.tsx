import { useI18n } from '@/i18n'
import type { HubStateView } from '@/types/hermes'

/**
 * The one sentence a card says of what the hub decided (hub decision §8 #22):
 * why the hub keeps it off, that its author stopped publishing it (and what
 * they point to instead), or that it is no longer the person's to see. The
 * gateway's last day for an MCP server rides on the same line.
 */
export function HubStateNote({
  gateway = false,
  hubState,
  testId = 'hub-card-state'
}: {
  /** An MCP server reached through AgentX Gateway: the gateway's last day is said too. */
  gateway?: boolean
  hubState: HubStateView
  testId?: string
}) {
  const { locale, t } = useI18n()
  const s = t.skills.hub.state
  const lines: string[] = []

  if (hubState.desired_state === 'disabled') {
    lines.push(hubState.reason ? s.held(hubState.reason) : s.heldNoReason)
  } else if (hubState.status === 'archived') {
    lines.push(s.archived)
  } else if (hubState.visible === false) {
    lines.push(s.hidden)
  }

  if (hubState.status === 'archived' && hubState.successor) {
    lines.push(s.successor(hubState.successor.name || hubState.successor.label || hubState.successor.slug))
  }

  if (gateway && hubState.status === 'archived' && hubState.serving_until) {
    const until = new Date(hubState.serving_until)

    lines.push(
      until.getTime() > Date.now()
        ? s.servingUntil(until.toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' }))
        : s.servedNoMore
    )
  }

  if (lines.length === 0) {
    return null
  }

  return (
    <p className="text-xs text-(--ui-text-secondary)" data-testid={testId}>
      {lines.join(' ')}
    </p>
  )
}
