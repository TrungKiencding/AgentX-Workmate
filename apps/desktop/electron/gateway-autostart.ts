/**
 * gateway-autostart.ts
 *
 * Bring the messaging gateway (Telegram, Discord, …) back when the app opens.
 *
 * The gateway is its own process, started detached from the backend so it
 * outlives the window. A reboot still ends it, and nothing used to start it
 * again: the bot stayed silent until someone found "Restart gateway". So after
 * every successful local boot (behind sign-in, once it has settled whose home
 * this is), main asks the backend to start it, and the backend decides whether
 * there is anything to start: a channel turned on, no gateway already running,
 * no login service in charge of it (see hermes_cli/web_routers/gateway_autostart.py).
 *
 * Fire-and-forget: a gateway that cannot start must never hold up, or fail, the
 * app's own boot. The outcome only goes to the desktop log.
 *
 * Kept free of electron imports so the request and the log lines are testable
 * without booting Electron.
 */

export const GATEWAY_AUTOSTART_PATH = '/api/gateway/autostart'

/**
 * Loading the gateway config runs plugin discovery, which a cold Windows
 * machine can take several seconds over; nothing waits on this answer.
 */
export const GATEWAY_AUTOSTART_TIMEOUT_MS = 30_000

export interface GatewayAutostartDeps {
  /** POST the autostart route on the local backend and return the parsed body. */
  post: () => Promise<unknown>
  log: (line: string) => void
}

function channelList(body: Record<string, unknown>): string {
  const platforms = Array.isArray(body.platforms) ? body.platforms.map(String).filter(Boolean) : []

  return platforms.length > 0 ? platforms.join(', ') : 'the configured channels'
}

/** One desktop-log line for the backend's answer. */
export function describeGatewayAutostart(answer: unknown): string {
  const body = answer && typeof answer === 'object' ? (answer as Record<string, unknown>) : {}

  switch (body.reason) {
    case 'started':
      return `[messaging] started the gateway for ${channelList(body)}`

    case 'running':
      return `[messaging] the gateway is already running${typeof body.pid === 'number' ? ` (pid ${body.pid})` : ''}`

    case 'no_platforms':
      return '[messaging] no channel is turned on; the gateway was not started'

    case 'service':
      return `[messaging] a login service runs the gateway for ${channelList(body)}; leaving it to that`

    case 'busy':
      return `[messaging] ${typeof body.action === 'string' ? body.action : 'a gateway action'} is already in progress; leaving the gateway alone`

    default:
      return `[messaging] unexpected answer from the gateway autostart: ${JSON.stringify(answer)}`
  }
}

/** Ask the backend to start the gateway if it should run; log the outcome. Never throws. */
export async function autostartMessagingGateway(deps: GatewayAutostartDeps): Promise<void> {
  try {
    deps.log(describeGatewayAutostart(await deps.post()))
  } catch (error) {
    deps.log(`[messaging] could not start the gateway: ${error instanceof Error ? error.message : String(error)}`)
  }
}
