import { atom } from 'nanostores'

import { translateNow } from '@/i18n'

export type NotificationKind = 'error' | 'warning' | 'info' | 'success'

export interface NotificationAction {
  label: string
  onClick: () => void
}

export type NotificationScope = 'app' | 'session'

export interface AppNotification {
  id: string
  kind: NotificationKind
  /** When set, renders this codicon instead of the default kind icon. */
  icon?: string
  /** When set, tints the icon and message with this CSS color (severity ramp). */
  accentColor?: string
  /** Secondary detail line rendered below the message, muted (e.g. "$220.00 cap"). */
  meta?: string
  title?: string
  message: string
  detail?: string
  action?: NotificationAction
  /** Runs when the person closes the notice; see NotificationInput.onDismiss. */
  onDismiss?: () => void
  createdAt: number
  scope: NotificationScope
}

export interface NotificationInput {
  id?: string
  kind?: NotificationKind
  icon?: string
  accentColor?: string
  meta?: string
  title?: string
  message: string
  detail?: string
  action?: NotificationAction
  /**
   * Runs when the person closes the notice: its close button, its action, or
   * "Clear all". Not when the app withdraws it (dismissNotification,
   * clearNotifications) or it times out, so a snooze hung here only ever follows
   * the person saying "not now".
   */
  onDismiss?: () => void
  durationMs?: number
  /**
   * 'app' for a notice about the app rather than the open chat: an update, an
   * agent that needs a restart. Moving to another chat or starting a turn clears
   * the chat's notices (clearNotifications); an app notice stays up until the
   * person closes it or the app withdraws it. Defaults to 'session'.
   */
  scope?: NotificationScope
}

// The most chat notices kept at once; a burst drops the oldest. App notices have
// fixed ids, so only a few can exist, and a burst never pushes one out.
const MAX_SESSION_NOTIFICATIONS = 4

let notificationCounter = 0

// A running auto-dismiss: the pending timeout and when it fires. While the
// toast region is hovered or focused every timer is held (spec §5.15) — the
// handle is dropped and `remaining` remembers the time left.
interface DismissTimer {
  handle?: number
  deadline: number
  remaining: number
}

const timers = new Map<string, DismissTimer>()
let held = false

export const $notifications = atom<AppNotification[]>([])

// Spec §5.15: 4s, 6s when the toast carries an action (it takes longer to
// decide). Errors and warnings need handling, so they never time out.
function defaultDuration(kind: NotificationKind, action?: NotificationAction) {
  if (kind === 'error' || kind === 'warning') {
    return 0
  }

  return action ? 6_000 : 4_000
}

function armTimer(id: string, remaining: number) {
  const timer: DismissTimer = { deadline: Date.now() + remaining, remaining }

  if (!held) {
    timer.handle = window.setTimeout(() => dismissNotification(id), remaining)
  }

  timers.set(id, timer)
}

/** Pause every auto-dismiss — the pointer or focus is inside the toast region. */
export function holdNotificationTimers() {
  if (held) {
    return
  }

  held = true

  for (const timer of timers.values()) {
    window.clearTimeout(timer.handle)
    timer.handle = undefined
    timer.remaining = Math.max(0, timer.deadline - Date.now())
  }
}

/** Resume the held timers with the time each had left. */
export function releaseNotificationTimers() {
  if (!held) {
    return
  }

  held = false

  for (const [id, timer] of timers) {
    armTimer(id, timer.remaining)
  }
}

function cleanErrorText(value: string) {
  return value.replace(/^Error:\s*/, '').trim()
}

/** True when an error string is a disk-full / ENOSPC / SQLITE_FULL failure. */
export function isDiskFullErrorMessage(message: string): boolean {
  return (
    /no space left on device/i.test(message) ||
    /not enough space/i.test(message) ||
    /database or disk is full/i.test(message) ||
    /\bENOSPC\b/i.test(message) ||
    /disk full/i.test(message) ||
    /full disk/i.test(message)
  )
}

const ERROR_SUMMARIES: { test: (msg: string) => boolean; summarize: (msg: string) => string }[] = [
  {
    // Disk full / ENOSPC — session DB write, backend crash, or any path that
    // bubbles "no space left" / SQLITE_FULL through notifyError. Match before
    // generic length truncation so the user gets a clear "free space" toast
    // instead of a silent send or a raw errno dump.
    test: isDiskFullErrorMessage,
    summarize: () => translateNow('notifications.errors.diskFull')
  },
  {
    test: msg => /['"]code['"]\s*:\s*['"]gateway_auth_failed['"]/i.test(msg),
    summarize: () => translateNow('notifications.errors.gatewayAuthFailed')
  },
  {
    test: msg => /incorrect api key provided/i.test(msg) || /['"]code['"]\s*:\s*['"]invalid_api_key['"]/i.test(msg),
    summarize: msg => {
      const status = msg.match(/(?:error code|status(?:Code)?)[^\d]*(\d{3})/i)?.[1]

      return status
        ? translateNow('notifications.errors.openaiRejectedApiKeyWithStatus', status)
        : translateNow('notifications.errors.openaiRejectedApiKey')
    }
  },
  {
    test: msg => /neither voice_tools_openai_key nor openai_api_key is set/i.test(msg),
    summarize: () => translateNow('notifications.errors.openaiTtsNeedsKey')
  },
  {
    test: msg => /ELEVENLABS_API_KEY not set/i.test(msg) || /ElevenLabs STT API error \(HTTP 401\)/i.test(msg),
    summarize: msg =>
      /ELEVENLABS_API_KEY not set/i.test(msg)
        ? translateNow('notifications.errors.elevenLabsNeedsKey')
        : translateNow('notifications.errors.elevenLabsRejectedKey')
  },
  {
    test: msg => /method not allowed/i.test(msg),
    summarize: () => translateNow('notifications.errors.methodNotAllowed')
  },
  {
    test: msg => /microphone permission/i.test(msg),
    summarize: () => translateNow('notifications.errors.microphonePermission')
  }
]

function summarizeErrorMessage(message: string, fallback: string) {
  const rule = ERROR_SUMMARIES.find(r => r.test(message))

  if (rule) {
    return rule.summarize(message)
  }

  return message.length > 180 ? fallback : message || fallback
}

/** An error as a person can read it: the IPC wrapper stripped, the API's
 *  `detail` pulled out of its JSON, and a summary for the well-known cases.
 *  `notifyError` toasts this; an inline error surface renders the same pair. */
export function readableError(error: unknown, fallback: string): { message: string; detail?: string } {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : fallback
  const unwrapped = raw.match(/Error invoking remote method '[^']+': Error: (.+)$/)?.[1] ?? raw
  const cleaned = cleanErrorText(unwrapped)
  const detail = cleaned.match(/"detail"\s*:\s*"([^"]+)"/)?.[1] ?? cleaned
  const summary = summarizeErrorMessage(detail, fallback)

  return { message: summary, detail: detail === summary ? undefined : detail }
}

export function notify(input: NotificationInput): string {
  const kind = input.kind ?? 'info'
  const id = input.id ?? `${Date.now()}-${notificationCounter++}`

  const notification: AppNotification = {
    id,
    kind,
    icon: input.icon,
    accentColor: input.accentColor,
    meta: input.meta,
    title: input.title,
    message: input.message,
    detail: input.detail,
    action: input.action,
    onDismiss: input.onDismiss,
    createdAt: Date.now(),
    scope: input.scope ?? 'session'
  }

  forgetTimer(id)

  let sessionCount = 0
  const kept: AppNotification[] = []

  for (const item of [notification, ...$notifications.get().filter(item => item.id !== id)]) {
    if (item.scope === 'app' || ++sessionCount <= MAX_SESSION_NOTIFICATIONS) {
      kept.push(item)
    } else {
      forgetTimer(item.id)
    }
  }

  $notifications.set(kept)

  const duration = input.durationMs ?? defaultDuration(kind, input.action)

  if (duration > 0) {
    armTimer(id, duration)
  }

  return id
}

export function notifyError(error: unknown, fallback: string): string {
  const readable = readableError(error, fallback)

  return notify({
    kind: 'error',
    title: fallback,
    message: readable.message,
    detail: readable.detail
  })
}

function forgetTimer(id: string) {
  window.clearTimeout(timers.get(id)?.handle)
  timers.delete(id)
}

function remove(id: string): AppNotification | undefined {
  forgetTimer(id)
  const removed = $notifications.get().find(item => item.id === id)

  if (removed) {
    $notifications.set($notifications.get().filter(item => item.id !== id))
  }

  return removed
}

/** Withdraw a notice: what it said no longer applies. Also how one times out. */
export function dismissNotification(id: string) {
  remove(id)
}

/** The person closed a notice, with its close button or by taking its action. */
export function closeNotification(id: string) {
  remove(id)?.onDismiss?.()
}

/** The open chat's notices go as the person moves on: another chat, a new turn. */
export function clearNotifications() {
  const all = $notifications.get()

  for (const item of all) {
    if (item.scope !== 'app') {
      forgetTimer(item.id)
    }
  }

  $notifications.set(all.filter(item => item.scope === 'app'))
}

/** The person cleared every notice ("Clear all"). */
export function closeAllNotifications() {
  const all = $notifications.get()

  resetNotifications()

  for (const item of all) {
    item.onDismiss?.()
  }
}

/** Drop every notice and timer, running nothing. For tests. */
export function resetNotifications() {
  for (const timer of timers.values()) {
    window.clearTimeout(timer.handle)
  }

  timers.clear()
  held = false
  $notifications.set([])
}
