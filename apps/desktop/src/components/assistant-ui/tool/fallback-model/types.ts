export type ToolTone = 'agent' | 'browser' | 'default' | 'file' | 'image' | 'terminal' | 'web'
/** `awaiting`: a memory or skill write the approval gate staged. Not saved,
 *  not refused: it waits for the user. */
export type ToolStatus = 'awaiting' | 'error' | 'running' | 'success' | 'warning'

export interface ToolPart {
  args?: unknown
  isError?: boolean
  result?: unknown
  toolCallId?: string
  toolName: string
  type: 'tool-call'
}

export interface SearchResultRow {
  snippet: string
  title: string
  url: string
}

export interface ToolTitleAction {
  prefix: string
  suffix: string
  text: string
}

export interface CountMetric {
  count: number
  noun: string
}

export interface ToolView {
  countLabel?: string
  /** What the expanded row shows. A failed or refused row shows it under
   *  `errorLead`; a failed row leaves out the result fields that only
   *  restated the error. */
  detail: string
  /** `detail` is a file's text that isn't markdown (a script or template a
   *  skill_view opened): the renderer prints it as code instead of rendering
   *  it as markdown, which would turn its `#` comments into headings. */
  detailIsCode?: boolean
  detailLabel: string
  /** A staged memory or skill write only: the approval gate's own line (where
   *  to review the write), under `detail`. Not part of the row's Copy. */
  detailNote?: string
  durationLabel?: string
  /** Failed rows and refused memory writes only: the error the expanded row
   *  opens with, above `detail`. Empty when `detail` already says it
   *  (execute_code folds a script's stderr into its output), so the row never
   *  prints it twice. */
  errorLead?: string
  icon?: string
  imageUrl?: string
  inlineDiff: string
  previewTarget?: string
  /** Set for tools whose output naturally contains ANSI escape codes
   *  (terminal/execute_code) so the renderer knows to run them through
   *  the ANSI parser instead of printing them as literals. */
  rendersAnsi?: boolean
  /** Original query, shown above structured web-search results. */
  searchQuery?: string
  searchHits?: SearchResultRow[]
  /** When the backend reports stderr as a separate stream (terminal /
   *  execute_code), the renderer shows it as its own labeled, neutrally
   *  tinted block under stdout — distinct from an error tone. */
  stderr?: string
  /** Terminal-only command shown as the prompt in the expanded transcript. */
  terminalCommand?: string
  /** Terminal-only process exit code, when the backend reported one. */
  terminalExitCode?: number
  /** When set, the renderer uses stdout+stderr as separate sections and
   *  ignores the merged `detail`. */
  stdout?: string
  status: ToolStatus
  subtitle: string
  title: string
  titleAction?: ToolTitleAction
  tone: ToolTone
}

export interface ToolMeta {
  done: string
  /** Titles a failed call in place of `done`, for the tools that have one. */
  failed?: string
  icon?: string
  pending: string
  pendingAction: string
  tone: ToolTone
}

export interface ToolMetaSpec {
  icon?: string
  tone: ToolTone
}

export interface MessageRunningStateSlice {
  message: {
    status?: {
      type?: string
    }
  }
  thread: {
    isRunning: boolean
  }
}
