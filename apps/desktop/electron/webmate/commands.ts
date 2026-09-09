/**
 * Commands from Workmate to the running WebMate MCP server.
 *
 * The server opens no second port for us. Instead it watches
 * `<webmate>/commands/` and runs one `<uuid>.json` file per command, deleting
 * the file on pick-up and recording the outcome as `state.json.lastCommand`
 * (docs/workmate-integration.md in the WebMate repository, "Commands").
 *
 *   { "id": "<uuid>", "action": "prepare_update" | "reload" | "resume" }
 *
 * `prepare_update` asks the extension to stop taking new runs and reports
 * `busy` (runs still in flight); the server keeps polling the extension until
 * busy reaches 0 or its own 60 s deadline passes. `reload` makes the extension
 * call chrome.runtime.reload(). `resume` lifts a drain when an update is
 * called off. With no extension attached the server answers
 * `ok: false, error: "WEBMATE_NOT_CONNECTED"` — the caller reads that as
 * "browser closed, swap the folder now".
 */

import { randomUUID } from 'node:crypto'

import { defaultPairingIo, type PairingIo } from './pairing'
import type { WebmatePaths } from './paths'

export const WEBMATE_COMMAND_ACTIONS = ['prepare_update', 'reload', 'resume'] as const
export type WebmateCommandAction = (typeof WEBMATE_COMMAND_ACTIONS)[number]

/** `state.json.lastCommand` as the server writes it. */
export interface WebmateLastCommand {
  id: string
  action: string
  ok: boolean
  busy?: number
  error?: string | null
  startedAt: string
  finishedAt: string
}

export type CommandIo = Pick<PairingIo, 'writeTextAtomic' | 'mkdirp'> & { uuid?: () => string }

/** Write one command file (temp + rename) and return its id. */
export function sendWebmateCommand(
  paths: WebmatePaths,
  action: WebmateCommandAction,
  io: CommandIo = defaultPairingIo(),
  pathModule: { join: (...parts: string[]) => string } = { join: (...parts) => parts.join('/') }
): string {
  const id = (io.uuid ?? randomUUID)()

  io.mkdirp(paths.commandsDir)
  io.writeTextAtomic(pathModule.join(paths.commandsDir, `${id}.json`), `${JSON.stringify({ id, action })}\n`)

  return id
}

export interface WaitForCommandOptions {
  timeoutMs: number
  pollMs?: number
  /** The current `state.json.lastCommand`, or null. */
  readLastCommand: () => WebmateLastCommand | null
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

/**
 * Poll state.json until `lastCommand.id` equals `id`, or give up. Null means
 * the server never acknowledged the command within the deadline — it is not
 * running, or it is wedged; callers decide (an update falls back to swapping
 * the folder without draining).
 */
export async function waitForCommandResult(
  id: string,
  options: WaitForCommandOptions
): Promise<WebmateLastCommand | null> {
  const pollMs = options.pollMs ?? 250
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const now = options.now ?? Date.now
  const deadline = now() + options.timeoutMs

  for (;;) {
    const last = options.readLastCommand()

    if (last && last.id === id) {
      return last
    }

    if (now() >= deadline) {
      return null
    }

    await sleep(pollMs)
  }
}

/** Parse a `lastCommand` value from a state.json document; null for anything malformed. */
export function parseLastCommand(value: unknown): WebmateLastCommand | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const record = value as Record<string, unknown>

  if (typeof record.id !== 'string' || typeof record.action !== 'string') {
    return null
  }

  return {
    id: record.id,
    action: record.action,
    ok: record.ok === true,
    busy: typeof record.busy === 'number' ? record.busy : undefined,
    error: typeof record.error === 'string' ? record.error : null,
    startedAt: typeof record.startedAt === 'string' ? record.startedAt : '',
    finishedAt: typeof record.finishedAt === 'string' ? record.finishedAt : ''
  }
}
