import { isDataHubToolName } from '@/components/assistant-ui/tool/data-hub-sources-model'
import type { SessionInfo, SessionMessage } from '@/hermes'
import { getSessionMessages } from '@/hermes'
import { translateNow } from '@/i18n'
import { notify, notifyError } from '@/store/notifications'

interface ExportSessionParams {
  sessionId: string
  profile?: string | null
  title?: string | null
  session?: SessionInfo
}

function sanitizeFilenamePart(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

function sessionExportFilename(sessionId: string, title?: string | null) {
  const titlePart = title ? sanitizeFilenamePart(title) : ''
  const idPart = sanitizeFilenamePart(sessionId).slice(0, 8) || 'session'

  return `${titlePart || 'session'}-${idPart}.json`
}

function toolCallNames(toolCalls: unknown): Map<string, string> {
  const names = new Map<string, string>()
  let calls = toolCalls

  if (typeof calls === 'string') {
    try {
      calls = JSON.parse(calls)
    } catch {
      return names
    }
  }

  if (!Array.isArray(calls)) {
    return names
  }

  for (const call of calls) {
    if (!call || typeof call !== 'object') {
      continue
    }

    const { function: fn, id, name } = call as { function?: { name?: unknown }; id?: unknown; name?: unknown }
    const callName = fn?.name ?? name

    if (typeof id === 'string' && typeof callName === 'string') {
      names.set(id, callName)
    }
  }

  return names
}

/**
 * Whether a transcript holds a result of a Data Hub tool (hub server
 * `agentx-data`) — those may only be read in Workmate, so such a chat is never
 * exported. Mirrors `session_has_data_hub_result` in hermes_cli/session_export.py:
 * a `tool` row named by its `tool_name`, or by the call it answers.
 */
export function hasDataHubResult(messages: readonly SessionMessage[]): boolean {
  const called = new Map<string, string>()

  for (const message of messages) {
    if (message.role === 'assistant') {
      toolCallNames(message.tool_calls).forEach((name, id) => called.set(id, name))
    }
  }

  return messages.some(
    message =>
      message.role === 'tool' &&
      [message.tool_name, message.name, called.get(message.tool_call_id ?? '')].some(isDataHubToolName)
  )
}

export async function exportSession(sessionId: string, params: Omit<ExportSessionParams, 'sessionId'> = {}) {
  if (!sessionId) {
    return
  }

  try {
    const profile = params.profile ?? params.session?.profile
    const { data_hub: dataHub, messages } = await getSessionMessages(sessionId, profile)

    // The store's flag covers what no tool row here shows (a subagent's
    // findings, a compressed continuation); the rows are the fallback for an
    // older backend.
    if (dataHub || hasDataHubResult(messages)) {
      notify({ kind: 'error', message: translateNow('desktop.sessionExportDataHubBlocked') })

      return
    }

    const payload = {
      exported_at: new Date().toISOString(),
      session_id: sessionId,
      title: params.title ?? null,
      session: params.session ?? null,
      message_count: messages.length,
      messages
    }

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const downloadUrl = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = downloadUrl
    anchor.download = sessionExportFilename(sessionId, params.title)
    anchor.click()
    URL.revokeObjectURL(downloadUrl)

    notify({ kind: 'success', message: translateNow('desktop.sessionExported'), durationMs: 2_000 })
  } catch (err) {
    notifyError(err, translateNow('desktop.sessionExportFailed'))
  }
}
