import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { LogTail } from '@/components/chat/log-tail'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  focusDialogContent
} from '@/components/ui/dialog'
import { TextTab } from '@/components/ui/text-tab'
import { getLogs } from '@/hermes'
import { useI18n } from '@/i18n'
import { $activeGatewayProfile } from '@/store/profile'

import { filterStdioSections } from './mcp-model'

const LOG_POLL_MS = 2000

type LogSource = 'agent' | 'stdio'

// The MCP output channel — Cursor's "MCP Logs" equivalent. `server` scopes it
// to one connection (its own stdio sections, agent lines that name it); null
// is every server. The body is the app's tool-output surface: CodeCardBody
// typography + the floating hover-reveal copy button. It polls only while
// mounted, so a folded "Nhật ký" costs nothing.
function McpLogTail({ emptyLabel, server, source }: { emptyLabel: string; server: null | string; source: LogSource }) {
  const [lines, setLines] = useState<null | string[]>(null)
  // A profile switch reroutes getLogs to the new backend; keying the effect on
  // the active profile tears down the old poll (its `cancelled` flag blocks a
  // late setLines) so profile A's logs never flash in B.
  const activeProfile = useStore($activeGatewayProfile)

  useEffect(() => {
    let cancelled = false

    const poll = async () => {
      try {
        const response =
          source === 'stdio'
            ? await getLogs({ file: 'mcp', lines: 500 })
            : await getLogs({ file: 'agent', lines: 300, search: server ?? 'mcp' })

        if (!cancelled) {
          setLines(source === 'stdio' && server ? filterStdioSections(response.lines, server) : response.lines)
        }
      } catch {
        // Backend momentarily unavailable — keep the last tail.
      }
    }

    setLines(null)
    void poll()
    const timer = window.setInterval(() => void poll(), LOG_POLL_MS)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [server, source, activeProfile])

  return <LogTail emptyLabel={emptyLabel} lines={lines} />
}

/** The log with its source switch: `stdio` (the server's own output) · `agent` (AgentX's side). */
export function McpLogs({ className, server }: { className?: string; server: null | string }) {
  const { t } = useI18n()
  const [source, setSource] = useState<LogSource>('stdio')

  return (
    <div className={className} data-testid="mcp-logs">
      <div className="mb-1 flex items-center gap-1.5">
        {(['stdio', 'agent'] as const).map(kind => (
          <TextTab active={source === kind} className="h-6 px-1 text-xs" key={kind} onClick={() => setSource(kind)}>
            {kind}
          </TextTab>
        ))}
      </div>
      <div className="h-64 overflow-hidden rounded-(--radius-card) border border-(--ui-stroke-tertiary)">
        <McpLogTail emptyLabel={t.settings.mcp.noOutput} server={server} source={source} />
      </div>
    </div>
  )
}

/** Every server's log, from the MCP segment's ⋯ menu. */
export function McpLogsDialog({ onClose, open }: { onClose: () => void; open: boolean }) {
  const { t } = useI18n()
  const m = t.settings.mcp

  return (
    <Dialog onOpenChange={next => !next && onClose()} open={open}>
      <DialogContent className="max-w-3xl" data-testid="mcp-logs-dialog" onOpenAutoFocus={focusDialogContent}>
        <DialogHeader>
          <DialogTitle>{m.logsAll}</DialogTitle>
          <DialogDescription>{m.logsHint}</DialogDescription>
        </DialogHeader>
        {open && <McpLogs server={null} />}
      </DialogContent>
    </Dialog>
  )
}
