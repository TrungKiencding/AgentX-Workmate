import type { WebmateCommandAction, WebmateCommandPayload, WebmateLastCommand } from './commands'
import type { WebmateConnection, WebmateLocalStatus } from './status'

export interface BrowserCommands {
  readStatus: () => WebmateLocalStatus
  sendCommand: (action: WebmateCommandAction, payload?: WebmateCommandPayload) => string
  waitForCommand: (id: string, timeoutMs: number) => Promise<WebmateLastCommand | null>
}

/** Developer copies do not read the managed installation being replaced. */
export function managedConnections(status: WebmateLocalStatus): WebmateConnection[] {
  return status.connections.filter(connection => connection.installType !== 'dev')
}

export function assertParticipantsUnchanged(before: WebmateLocalStatus, current: WebmateLocalStatus): void {
  const targets = managedConnections(before)

  if (
    before.connections.length &&
    managedConnections(current).some(c => !targets.some(t => t.instanceId === c.instanceId))
  ) {
    throw new Error('another browser connected during the update; retry when it is idle')
  }
}

export async function drainBrowsers(
  deps: BrowserCommands,
  before: WebmateLocalStatus,
  timeoutMs = 65_000
): Promise<void> {
  const targets = managedConnections(before)

  if (!before.connected || (before.connections.length && !targets.length)) {
    return
  }

  const id = deps.sendCommand(
    'prepare_update',
    targets.length ? { instanceIds: targets.map(c => c.instanceId) } : undefined
  )

  const result = await deps.waitForCommand(id, timeoutMs)
  // Silence is not evidence that a browser has closed. Only a fresh status
  // with no managed connections permits the offline path.
  const current = deps.readStatus()

  if (!current.connected || (current.connections.length && !managedConnections(current).length)) {
    return
  }

  if (!result?.ok) {
    throw new Error(result?.error || 'browser drain was not acknowledged')
  }

  if ((result.busy ?? 0) > 0) {
    throw new Error('browser still has running tasks')
  }

  if (
    before.connections.length > 1 &&
    targets.some(c => !result.results?.some(r => r.instanceId === c.instanceId && r.ok))
  ) {
    throw new Error('bridge did not acknowledge every browser; update the WebMate MCP server')
  }

  assertParticipantsUnchanged(before, current)
}

export async function reloadBrowsers(deps: BrowserCommands): Promise<void> {
  const status = deps.readStatus()
  const targets = managedConnections(status)

  if (!status.connected || (status.connections.length && !targets.length)) {
    return
  }

  const id = deps.sendCommand('reload', targets.length ? { instanceIds: targets.map(c => c.instanceId) } : undefined)
  const result = await deps.waitForCommand(id, 15_000)

  if (!result?.ok) {
    throw new Error(result?.error || 'browser reload was not acknowledged')
  }

  if (targets.length > 1 && targets.some(c => !result.results?.some(r => r.instanceId === c.instanceId && r.ok))) {
    throw new Error('bridge did not reload every browser')
  }
}

/** Every participant must return; an unrelated active browser cannot confirm an update. */
export function browsersConfirmed(
  before: WebmateLocalStatus,
  current: WebmateLocalStatus,
  version: string,
  freshHello = false
): boolean {
  const targets = managedConnections(before)

  if (targets.length) {
    return targets.every(target =>
      managedConnections(current).some(
        c =>
          c.instanceId === target.instanceId &&
          c.extensionVersion === version &&
          c.paired &&
          (!freshHello || (c.lastHelloAt !== null && c.lastHelloAt !== target.lastHelloAt))
      )
    )
  }

  if (before.connections.length || !before.connected) {
    return true
  }

  return (
    current.connected &&
    current.extensionVersion === version &&
    (!freshHello || (current.bridge?.lastHelloAt != null && current.bridge.lastHelloAt !== before.bridge?.lastHelloAt))
  )
}
