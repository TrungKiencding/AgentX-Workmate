// Quitting with a turn in flight kills the backend mid-tool-call: the work is
// lost, and anything the agent had half-written to disk stays half-written.
// Renderers publish what they're running; the main process asks before it lets
// that go. The decision + copy live here (pure, testable) so main.ts only owns
// the IPC and the dialog call.

const MAX_LISTED = 4

/**
 * The words of the confirmation. The main process has no translations, so the
 * renderer sends them with its report, in the app's language; `{count}` is
 * filled in here. English is the fallback for a renderer that sent none (an
 * older one, or one that died before reporting).
 */
export interface QuitCopy {
  /** Shown under the list: what quitting costs. */
  detail: string
  /** "… {count} chats." */
  messageMany: string
  messageOne: string
  /** Last list line when not every chat is named: "{count} more". */
  more: string
  quit: string
  stay: string
}

export const DEFAULT_QUIT_COPY: QuitCopy = {
  detail: 'Quitting stops the agent mid-turn. Any work it has not finished writing is lost.',
  messageMany: 'AgentX is still working on {count} chats.',
  messageOne: 'AgentX is still working on 1 chat.',
  more: '{count} more',
  quit: 'Quit Anyway',
  stay: 'Keep Running'
}

export interface ActiveWork {
  /** Titles of sessions running a turn. Untitled sessions contribute a count only. */
  titles: string[]
  /** Running turns, including untitled ones — always >= titles.length. */
  count: number
  /** The confirmation's words in the renderer's language, when it sent them. */
  copy?: QuitCopy
}

export const NO_ACTIVE_WORK: ActiveWork = { count: 0, titles: [] }

const COPY_KEYS: readonly (keyof QuitCopy)[] = ['detail', 'messageMany', 'messageOne', 'more', 'quit', 'stay']
const MAX_COPY_CHARS = 300

/** A complete, sanely sized copy object, or undefined — never half of one. */
function normalizeQuitCopy(raw: unknown): QuitCopy | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined
  }

  const copy: Partial<QuitCopy> = {}

  for (const key of COPY_KEYS) {
    const value = (raw as Record<string, unknown>)[key]

    if (typeof value !== 'string' || !value.trim() || value.length > MAX_COPY_CHARS) {
      return undefined
    }

    copy[key] = value.trim()
  }

  return copy as QuitCopy
}

/** Coerce an IPC payload from an untrusted renderer into an ActiveWork. */
export function normalizeActiveWork(payload: unknown): ActiveWork {
  if (!payload || typeof payload !== 'object') {
    return NO_ACTIVE_WORK
  }

  const raw = payload as { copy?: unknown; count?: unknown; titles?: unknown }

  const titles = Array.isArray(raw.titles)
    ? raw.titles
        .filter((title): title is string => typeof title === 'string')
        .map(title => title.trim())
        .filter(Boolean)
    : []

  const count = typeof raw.count === 'number' && Number.isFinite(raw.count) ? Math.max(0, Math.floor(raw.count)) : 0
  const copy = normalizeQuitCopy(raw.copy)

  return { count: Math.max(count, titles.length), titles, ...(copy ? { copy } : {}) }
}

/** Merge every window's report into one. Windows can show the same session. */
export function mergeActiveWork(reports: Iterable<ActiveWork>): ActiveWork {
  const titles: string[] = []
  let count = 0
  let copy: QuitCopy | undefined

  for (const report of reports) {
    count = Math.max(count, report.count)
    // Every window speaks the same language; take the words from one that is
    // actually running something when there is one.
    copy = report.copy && (report.count > 0 || !copy) ? report.copy : copy

    for (const title of report.titles) {
      if (!titles.includes(title)) {
        titles.push(title)
      }
    }
  }

  return { count: Math.max(count, titles.length), titles, ...(copy ? { copy } : {}) }
}

export interface QuitPrompt {
  /** [stay, quit] — index 0 is the safe default and the cancel answer. */
  buttons: [string, string]
  detail: string
  message: string
}

/**
 * The confirmation to show, or null when quitting should just proceed.
 *
 * `quittingForHandoff` covers the update / swap / uninstall relaunches: those
 * are the app replacing itself, not the user walking away, and a modal there
 * would strand the detached script waiting on a PID that never exits.
 */
export function quitPromptFor(work: ActiveWork, quittingForHandoff: boolean): null | QuitPrompt {
  if (quittingForHandoff || work.count < 1) {
    return null
  }

  const copy = work.copy ?? DEFAULT_QUIT_COPY
  const listed = work.titles.slice(0, MAX_LISTED)
  const remaining = work.count - listed.length
  const lines = listed.map(title => `• ${title}`)

  if (remaining > 0 && listed.length > 0) {
    lines.push(`• ${copy.more.replace('{count}', String(remaining))}`)
  }

  return {
    buttons: [copy.stay, copy.quit],
    detail: [lines.join('\n'), lines.length > 0 ? '' : null, copy.detail]
      .filter(line => line !== null)
      .join('\n')
      .trim(),
    message: work.count === 1 ? copy.messageOne : copy.messageMany.replace('{count}', String(work.count))
  }
}

export type CloseDecision = 'close' | 'confirm' | 'hide'

/**
 * What closing a chat window should do while a turn is running.
 *
 * The quit confirmation only ever ran in `before-quit`. Clicking a window's
 * close button is not a quit: on Windows and Linux the window is destroyed
 * first, its report of running work goes with it, and the quit that follows
 * (`window-all-closed`) sees nothing to ask about — the backend is killed
 * mid-turn without a word (pilot feedback 2026-11: "chưa có cảnh báo khi tắt
 * Workmate giữa tác vụ"). On macOS the app outlives its window, so the turn
 * survives, but the report still dies with the renderer and a later ⌘Q is
 * unguarded.
 *
 *  - `confirm` (Windows/Linux, last chat window): ask, exactly as a quit does.
 *  - `hide` (macOS): keep the window — and so the renderer that knows what is
 *    running — alive but out of sight; the Dock brings it back, ⌘Q still asks,
 *    and it is closed for real once the work is done.
 *  - `close`: nothing is running, or the app is already on its way out.
 */
export function closeDecisionFor({
  lastChatWindow,
  platform,
  quitting,
  work
}: {
  /** No other chat window would keep the app (and the backend) alive. */
  lastChatWindow: boolean
  platform: NodeJS.Platform
  /** A confirmed quit or an update/swap/uninstall handoff is in progress. */
  quitting: boolean
  work: ActiveWork
}): CloseDecision {
  if (quitting || work.count < 1) {
    return 'close'
  }

  if (platform === 'darwin') {
    return 'hide'
  }

  return lastChatWindow ? 'confirm' : 'close'
}
