import type { Translations, TurnErrorKind } from '@/i18n'

/**
 * A failed turn in plain words — the transcript's error block, the toast and
 * the OS notification all say it the same way, in the UI language. The wording
 * is shared with AgentX Chat and WebMate; the codes are the ones Workmate
 * already reports as `failure_code` (tui_gateway/usage_outcome.py, AgentX-sso
 * docs/dashboard.md "Mã lỗi"), plus two the app tells apart only on screen:
 * `offline` (this device has no network) and `overloaded` (an upstream error
 * the provider said was capacity).
 *
 * The gateway's code wins. The text is read only when there is no code, or
 * just the fallback one: frames from an older backend, bare `error` events,
 * and a prompt.submit the local gateway rejected.
 */

export const TURN_ERROR_FALLBACK_CODE = 'operation_failed'

/** What a failed turn is shown as, ready to render. */
export interface TurnErrorView {
  /** The code shown under "Error details": the gateway's, or what the text says. */
  code: string
  kind: TurnErrorKind
  title: string
  hint: string
  /** True when sending the same turn again can help. */
  retry: boolean
  /** How long the provider asked to wait, when it said. */
  waitSeconds?: number
}

export interface TurnErrorSource {
  /** `failure_code` of the terminal frame (or the retained inflight turn). */
  code?: null | string
  /** `failure_reason`: the classified reason behind the code. */
  reason?: null | string
  /** The raw error text the gateway or provider sent. */
  text?: null | string
  /** Whether the device was online when the turn failed; omit when unknown. */
  online?: boolean
}

const KIND_BY_CODE: Readonly<Record<string, TurnErrorKind>> = {
  app_shutdown: 'local_error',
  auth_failed: 'auth_failed',
  bad_request: 'bad_request',
  compute_host_error: 'local_error',
  content_filtered: 'content_filtered',
  context_too_long: 'context_too_long',
  empty_response: 'no_response',
  license_expired: 'license',
  license_read_only: 'license',
  license_required: 'license',
  license_revoked: 'license',
  local_error: 'local_error',
  max_steps: 'max_steps',
  model_not_allowed: 'model_not_allowed',
  model_unavailable: 'model_unavailable',
  network_error: 'network_error',
  no_response: 'no_response',
  offline: 'offline',
  operation_failed: 'operation_failed',
  overloaded: 'overloaded',
  quota_exceeded: 'quota_exceeded',
  rate_limited: 'rate_limited',
  session_save_failed: 'local_error',
  stream_interrupted: 'stream_interrupted',
  timeout: 'timeout',
  upstream_error: 'upstream_error'
}

/** Kinds where sending the turn again can help; the rest need a person to act. */
const RETRYABLE = new Set<TurnErrorKind>([
  'bad_request',
  'local_error',
  'network_error',
  'no_response',
  'offline',
  'operation_failed',
  'overloaded',
  'rate_limited',
  'stream_interrupted',
  'timeout',
  'upstream_error'
])

/** A failure that a missing network explains better than its own words. */
const NETWORK_SHAPED = new Set(['network_error', 'operation_failed', 'stream_interrupted', 'timeout'])

const OVERLOADED_TEXT = /overloaded|over capacity|at capacity|insufficient capacity|server is busy|service unavailable/i

// Read in order: the first match names the failure. Specific wordings come
// before the HTTP status (a budget wall and a long prompt both arrive as 400),
// and the status comes before the catch-all words.
const TEXT_RULES: readonly [RegExp, string][] = [
  [/content[_ -]?(?:policy|filter|management)|safety (?:filter|system)|flagged by|moderation/i, 'content_filtered'],
  [
    /context[_ ](?:length|window)|maximum context|too many tokens|prompt is too long|input is too long|reduce the length|request entity too large|payload too large/i,
    'context_too_long'
  ],
  [/iteration budget|max(?:imum)? iterations|step limit/i, 'max_steps'],
  [
    /budget(?:_exceeded| has been exceeded| exceeded)|exceededbudget|over budget|exceeded your current quota|insufficient[_ ]quota|insufficient (?:credits|balance|funds)|credit balance|out of credits|payment required|spend(?:ing)? limit/i,
    'quota_exceeded'
  ],
  [/not allowed to (?:access|use|call) (?:this )?model|team not allowed|model not allowed/i, 'model_not_allowed'],
  // A signed-in account's inference always goes through its AgentX gateway
  // (hermes_cli/account_inference.py). These two arrive wrapped in "agent init
  // failed: …", and were read as a fault of the local app — "restart Workmate"
  // — when the first means this chat is pinned to a model the account cannot
  // use, and the second that the account has no AI key yet (pilot feedback
  // 2026-11). They sit above the agent-init rule for backends that send no code.
  [/can only use models through AgentX AI Gateway/i, 'model_not_allowed'],
  [/AgentX AI Gateway is not configured for this account/i, 'auth_failed'],
  [/rate[_ -]?limit|too many requests|requests per min|tokens per min/i, 'rate_limited'],
  [OVERLOADED_TEXT, 'overloaded'],
  [
    /unauthori[sz]ed|authentication|invalid[_ ](?:x-)?api[_ ]key|incorrect api key|api key (?:is )?(?:invalid|expired|revoked|not valid)|permission denied|forbidden|key (?:is )?(?:blocked|expired|revoked)/i,
    'auth_failed'
  ],
  [
    /model[_ ]not[_ ]found|no such model|unknown model|invalid model|notfounderror|(?:model|deployment)\b[^.]{0,80}\b(?:does not exist|not found|is not available)/i,
    'model_unavailable'
  ],
  [
    /incomplete chunked read|peer closed connection|remoteprotocolerror|mid-stream|remained truncated after \d+ continuation|stream (?:was )?(?:interrupted|cut off|closed|ended unexpectedly|disconnected)|connection (?:was )?(?:lost|dropped|reset) (?:while|during)/i,
    'stream_interrupted'
  ],
  // The desktop's own link to the local backend, and its request watchdog.
  [
    /AgentX gateway (?:is not connected|connection closed)|could not connect to AgentX gateway|request timed out after \d+s: /i,
    'local_error'
  ],
  [
    /connection error|apiconnectionerror|connecterror|econnrefused|econnreset|enotfound|eai_again|etimedout|getaddrinfo|network (?:is )?unreachable|failed to fetch|fetch failed|could not connect|connection refused|name resolution|certificate verify failed|can(?:'|’|no)t reach the model provider/i,
    'network_error'
  ],
  [/agent init(?:ialization)?\b|before the agent was ready/i, 'local_error'],
  [/timed? ?out\b|timeout|deadline exceeded/i, 'timeout'],
  [/empty (?:response|reply)|returned (?:no|empty) content/i, 'empty_response'],
  [/\bno response\b/i, 'no_response']
]

const STATUS_PATTERNS = [
  /(?:HTTP(?:\/\d(?:\.\d)?)?|status(?:[ _]code)?|error code|\bcode)["']?\s*[:=]?\s*["']?(\d{3})\b/i,
  /\((?:HTTP\s*)?([45]\d\d)\)/,
  /\b(\d{3})\s+(?:Bad Request|Unauthorized|Payment Required|Forbidden|Not Found|Request Timeout|Payload Too Large|Too Many Requests|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out)\b/i
]

const LATE_RULES: readonly [RegExp, string][] = [
  [/internal server error|bad gateway|server error|internalservererror|upstream|apierror/i, 'upstream_error'],
  [/bad request|invalid request|badrequesterror|unsupported/i, 'bad_request']
]

function statusCode(status: number): null | string {
  if (status === 401 || status === 403) {
    return 'auth_failed'
  }

  if (status === 402) {
    return 'quota_exceeded'
  }

  if (status === 404) {
    return 'model_unavailable'
  }

  if (status === 408 || status === 504) {
    return 'timeout'
  }

  if (status === 413) {
    return 'context_too_long'
  }

  if (status === 429) {
    return 'rate_limited'
  }

  if (status === 503 || status === 529) {
    return 'overloaded'
  }

  if (status >= 500 && status < 600) {
    return 'upstream_error'
  }

  if (status >= 400 && status < 500) {
    return 'bad_request'
  }

  return null
}

/** The failure a raw error text describes, or the fallback code. */
export function classifyTurnErrorText(text: string): string {
  const rule = TEXT_RULES.find(([pattern]) => pattern.test(text))

  if (rule) {
    return rule[1]
  }

  for (const pattern of STATUS_PATTERNS) {
    const status = Number(pattern.exec(text)?.[1])
    const code = Number.isFinite(status) ? statusCode(status) : null

    if (code) {
      return code
    }
  }

  return LATE_RULES.find(([pattern]) => pattern.test(text))?.[1] ?? TURN_ERROR_FALLBACK_CODE
}

/** Text readings too vague to replace a code the gateway gave. */
const VAGUE_READINGS = new Set([TURN_ERROR_FALLBACK_CODE, 'bad_request'])

/**
 * Readings that may replace a code the gateway gave, by that code. The
 * backend's classifier files what it does not recognise under a broad bucket
 * — a provider's wording it has no pattern for as a malformed request
 * (`bad_request`). A backend older than this check also reported a refused
 * connection and a stream cut off mid-answer as `timeout`, and LiteLLM's
 * "key not allowed to access model" (a 401) as `auth_failed` — which sent the
 * person to sign in again for a model their account was never granted.
 */
const PRECISE_READINGS: Readonly<Record<string, ReadonlySet<string>>> = {
  auth_failed: new Set(['model_not_allowed']),
  timeout: new Set(['network_error', 'stream_interrupted'])
}

/** Whether the text names the failure better than the gateway's code. */
function textNamesItBetter(given: string, read: string): boolean {
  if (!given || given === TURN_ERROR_FALLBACK_CODE) {
    return true
  }

  if (given === 'bad_request') {
    return !VAGUE_READINGS.has(read)
  }

  return PRECISE_READINGS[given]?.has(read) ?? false
}

/**
 * The code a failed turn is stored and shown under: the gateway's code, unless
 * it is only a broad bucket the text names better; `overloaded` when the
 * provider said capacity; `offline` when the device had no network and the
 * failure is one a missing network explains.
 */
export function turnErrorCode({ code, online, reason, text }: TurnErrorSource): string {
  const given = code?.trim() ?? ''
  const raw = text ?? ''
  const read = classifyTurnErrorText(raw)
  let resolved = textNamesItBetter(given, read) ? read : given

  if (resolved === 'upstream_error' && (reason === 'overloaded' || OVERLOADED_TEXT.test(raw))) {
    resolved = 'overloaded'
  }

  if (online === false && NETWORK_SHAPED.has(resolved)) {
    resolved = 'offline'
  }

  return resolved
}

/** Whether this device has a network right now, as far as the browser knows. */
export function deviceOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false
}

const WAIT_PATTERNS: readonly [RegExp, (match: RegExpExecArray) => number][] = [
  [/retry[-_ ]after["']?\s*[:=]?\s*["']?(\d+(?:\.\d+)?)/i, match => Number(match[1])],
  [
    /try again in (\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?)\b/i,
    match => {
      const value = Number(match[1])
      const unit = match[2].toLowerCase()

      return unit.startsWith('ms') || unit.startsWith('milli')
        ? value / 1000
        : unit.startsWith('m')
          ? value * 60
          : value
    }
  ],
  [/\bin (\d+) seconds\b/i, match => Number(match[1])]
]

/** How long the provider asked to wait, in whole seconds — when it said, and
 *  it is a wait worth showing (1 s to an hour). */
export function retryAfterSeconds(text: string): number | undefined {
  for (const [pattern, toSeconds] of WAIT_PATTERNS) {
    const match = pattern.exec(text)

    if (!match) {
      continue
    }

    const seconds = Math.ceil(toSeconds(match))

    return seconds > 0 && seconds <= 3600 ? seconds : undefined
  }

  return undefined
}

function waitSentence(seconds: number, copy: Translations['turnError']): string {
  return seconds >= 120 ? copy.waitMinutes(Math.ceil(seconds / 60)) : copy.waitSeconds(seconds)
}

/**
 * What to show for a failed turn. `code` is the stored one (turnErrorCode);
 * without it the text is classified here. A license refusal's explanation is
 * the license's own sentence, which the turn stored as its text.
 */
export function describeTurnError(
  { code, text }: { code?: null | string; text?: null | string },
  t: Pick<Translations, 'license' | 'turnError'>
): TurnErrorView {
  const raw = text?.trim() ?? ''
  const resolved = code?.trim() || turnErrorCode({ text: raw })
  const kind = KIND_BY_CODE[resolved] ?? 'operation_failed'
  const retry = RETRYABLE.has(kind)

  if (kind === 'license') {
    const hint = raw && raw !== resolved ? raw : t.license.readOnlyGeneric

    return { code: resolved, hint, kind, retry, title: t.turnError.licenseTitle }
  }

  const { hint, title } = t.turnError.kinds[kind]

  if (kind === 'rate_limited' || kind === 'overloaded') {
    const waitSeconds = retryAfterSeconds(raw)

    if (waitSeconds !== undefined) {
      const waitHint = `${t.turnError.waitCauses[kind]} ${waitSentence(waitSeconds, t.turnError)}`

      return { code: resolved, hint: waitHint, kind, retry, title, waitSeconds }
    }
  }

  return { code: resolved, hint, kind, retry, title }
}

/** The folded details an administrator reads and copies: the code, then the
 *  raw text (absent when the failure came with none and the code stood in). */
export function turnErrorDetails(view: Pick<TurnErrorView, 'code'>, text: string, copy: Translations['turnError']) {
  const raw = text.trim()

  return raw && raw !== view.code ? `${copy.code(view.code)}\n${raw}` : copy.code(view.code)
}
