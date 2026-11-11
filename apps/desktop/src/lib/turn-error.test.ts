import { describe, expect, it } from 'vitest'

import { type Locale, TRANSLATIONS, type TurnErrorKind } from '@/i18n'

import {
  classifyTurnErrorText,
  describeTurnError,
  retryAfterSeconds,
  turnErrorCode,
  turnErrorDetails
} from './turn-error'

const vi = TRANSLATIONS.vi
const en = TRANSLATIONS.en

// Every code a Workmate turn can fail with (tui_gateway/usage_outcome.py), the
// two the app tells apart on screen, and what each is shown as.
const CODES: [code: string, kind: TurnErrorKind, retry: boolean][] = [
  ['offline', 'offline', true],
  ['network_error', 'network_error', true],
  ['timeout', 'timeout', true],
  ['rate_limited', 'rate_limited', true],
  ['quota_exceeded', 'quota_exceeded', false],
  ['auth_failed', 'auth_failed', false],
  ['model_unavailable', 'model_unavailable', false],
  ['model_not_allowed', 'model_not_allowed', false],
  ['context_too_long', 'context_too_long', false],
  ['content_filtered', 'content_filtered', false],
  ['bad_request', 'bad_request', true],
  ['overloaded', 'overloaded', true],
  ['upstream_error', 'upstream_error', true],
  ['stream_interrupted', 'stream_interrupted', true],
  ['empty_response', 'no_response', true],
  ['no_response', 'no_response', true],
  ['max_steps', 'max_steps', false],
  ['local_error', 'local_error', true],
  ['session_save_failed', 'local_error', true],
  ['compute_host_error', 'local_error', true],
  ['app_shutdown', 'local_error', true],
  ['operation_failed', 'operation_failed', true],
  ['guardrail_halt', 'operation_failed', true],
  ['something_new', 'operation_failed', true]
]

describe('describeTurnError', () => {
  it.each(CODES)('shows %s as %s in Vietnamese and English', (code, kind, retry) => {
    for (const t of [vi, en]) {
      const view = describeTurnError({ code, text: 'raw provider text' }, t)
      const copy = t.turnError.kinds[kind as Exclude<TurnErrorKind, 'license'>]

      expect(view).toEqual({ code, hint: copy.hint, kind, retry, title: copy.title })
    }
  })

  it('says the Vietnamese catalog in Workmate words', () => {
    expect(describeTurnError({ code: 'rate_limited', text: '' }, vi)).toMatchObject({
      title: 'Đang có quá nhiều yêu cầu',
      hint: 'Yêu cầu đang được gửi nhanh hơn mức cho phép. Đợi một lát rồi thử lại.'
    })
    // "model" stays English in Workmate's Vietnamese (house style).
    expect(describeTurnError({ code: 'model_unavailable', text: '' }, vi).title).toBe('Model này hiện không dùng được')
    expect(describeTurnError({ code: 'operation_failed', text: '' }, vi)).toMatchObject({
      title: 'Đã có lỗi xảy ra',
      hint: 'Thử lại. Nếu lỗi lặp lại, gửi chi tiết bên dưới cho quản trị viên.'
    })
  })

  it.each(['license_required', 'license_expired', 'license_revoked', 'license_read_only'])(
    'explains %s with the license sentence the turn carried, and offers no retry',
    code => {
      const sentence = 'Giấy phép AgentX của bạn đã hết hạn ngày 01/11/2026. Liên hệ admin@acme.vn để gia hạn.'

      expect(describeTurnError({ code, text: sentence }, vi)).toEqual({
        code,
        hint: sentence,
        kind: 'license',
        retry: false,
        title: 'Giấy phép AgentX không cho phép dùng AI lúc này'
      })
      expect(describeTurnError({ code, text: code }, en).hint).toBe(en.license.readOnlyGeneric)
    }
  )

  it('gives the wait the provider asked for', () => {
    expect(describeTurnError({ code: 'rate_limited', text: 'HTTP 429: Retry-After: 20' }, vi)).toMatchObject({
      hint: 'Yêu cầu đang được gửi nhanh hơn mức cho phép. Thử lại sau khoảng 20 giây.',
      waitSeconds: 20
    })
    expect(describeTurnError({ code: 'rate_limited', text: 'Please try again in 1s.' }, en).hint).toBe(
      'Requests are arriving faster than allowed. Try again in about 1 second.'
    )
    expect(describeTurnError({ code: 'overloaded', text: 'overloaded, retry after 300' }, en)).toMatchObject({
      hint: "It's in heavy demand right now. This isn't on your side. Try again in about 5 minutes.",
      waitSeconds: 300
    })
    expect(describeTurnError({ code: 'overloaded', text: 'retry-after: 150' }, vi).hint).toBe(
      'Nhiều người đang dùng cùng lúc. Lỗi ở phía nhà cung cấp, không phải do bạn. Thử lại sau khoảng 3 phút.'
    )
  })

  it('gives no wait for kinds a wait does not fit', () => {
    expect(describeTurnError({ code: 'upstream_error', text: 'retry-after: 20' }, en).waitSeconds).toBeUndefined()
  })

  it('classifies the text when the row has no code', () => {
    expect(describeTurnError({ text: 'HTTP 429: slow down' }, en).kind).toBe('rate_limited')
    expect(describeTurnError({ code: '', text: '' }, en).kind).toBe('operation_failed')
  })

  it('has its own words for every kind in every language', () => {
    const kinds = Object.keys(en.turnError.kinds) as (keyof typeof en.turnError.kinds)[]

    for (const locale of Object.keys(TRANSLATIONS) as Locale[]) {
      if (locale === 'en') {
        continue
      }

      const copy = TRANSLATIONS[locale].turnError

      for (const kind of kinds) {
        expect(copy.kinds[kind].title, `${locale} ${kind}`).not.toBe(en.turnError.kinds[kind].title)
        expect(copy.kinds[kind].hint, `${locale} ${kind}`).not.toBe(en.turnError.kinds[kind].hint)
      }

      expect(copy.licenseTitle).not.toBe(en.turnError.licenseTitle)
      expect(copy.details).not.toBe(en.turnError.details)
      expect(copy.retry).not.toBe(en.turnError.retry)
      expect(copy.waitSeconds(20)).not.toBe(en.turnError.waitSeconds(20))
    }
  })
})

describe('classifyTurnErrorText', () => {
  it.each([
    // What people see today, verbatim shapes.
    ['API call failed after 3 retries: HTTP 429: {"error":{"message":"Rate limit reached"}}', 'rate_limited'],
    ["Error code: 429 - {'error': {'message': 'litellm.RateLimitError: ...', 'code': '429'}}", 'rate_limited'],
    ['Connection error.', 'network_error'],
    ['APIConnectionError', 'network_error'],
    ['getaddrinfo ENOTFOUND gateway.agentx.vn', 'network_error'],
    // LiteLLM budget wall and other quota words.
    [
      "Error code: 400 - {'error': {'message': 'Budget has been exceeded! Current cost: 5.01, Max budget: 5.0', 'type': 'budget_exceeded'}}",
      'quota_exceeded'
    ],
    ['You exceeded your current quota, please check your plan', 'quota_exceeded'],
    ['HTTP 402: Payment Required', 'quota_exceeded'],
    [
      "Error code: 400 - {'error': {'message': \"This model's maximum context length is 8192 tokens\", 'code': 'context_length_exceeded'}}",
      'context_too_long'
    ],
    ['Context length exceeded (210,000 tokens). Cannot compress further.', 'context_too_long'],
    ['Request payload too large (413). Cannot compress further.', 'context_too_long'],
    ['content_policy_blocked: flagged by the safety system', 'content_filtered'],
    ['Error code: 401 - Authentication Error, Invalid proxy server token passed', 'auth_failed'],
    ['OpenRouter rejected the request (403).', 'auth_failed'],
    [
      "Error code: 401 - {'error': {'message': 'Authentication Error - key not allowed to access model. This key can only access models=[a]'}}",
      'model_not_allowed'
    ],
    [
      "Error code: 404 - {'error': {'message': 'The model `gpt-x` does not exist', 'code': 'model_not_found'}}",
      'model_unavailable'
    ],
    ['HTTP 404 Not Found', 'model_unavailable'],
    [
      "Error code: 529 - {'type': 'error', 'error': {'type': 'overloaded_error', 'message': 'Overloaded'}}",
      'overloaded'
    ],
    ['HTTP 503: Service Unavailable', 'overloaded'],
    ['HTTP 500: Internal Server Error', 'upstream_error'],
    ['Error code: 502', 'upstream_error'],
    ['peer closed connection without sending complete message body (incomplete chunked read)', 'stream_interrupted'],
    ['connection reset mid-stream', 'stream_interrupted'],
    ['Response remained truncated after 4 continuation attempts', 'stream_interrupted'],
    ['Request timed out.', 'timeout'],
    ['HTTP 504 Gateway Timeout', 'timeout'],
    ['The model returned an empty response', 'empty_response'],
    ['no response from provider', 'no_response'],
    ['Iteration budget exhausted (90/90)', 'max_steps'],
    // The desktop's own link to the local backend.
    ['AgentX gateway is not connected', 'local_error'],
    ['Could not connect to AgentX gateway', 'local_error'],
    ['request timed out after 30s: prompt.submit', 'local_error'],
    ['agent initialization timed out after 601s — your message was not sent', 'local_error'],
    // An account-gateway refusal arrives wrapped in "agent init failed: …"; it
    // is about the chat's model or the account's key, not the local app.
    ['agent init failed: This account can only use models through AgentX AI Gateway.', 'model_not_allowed'],
    [
      'agent init failed: AgentX AI Gateway is not configured for this account. Retry gateway setup or skip it for now.',
      'auth_failed'
    ],
    ['agent init failed: something else broke', 'local_error'],
    ['Turn cancelled before the agent was ready', 'local_error'],
    // Words only, no status.
    ['BadRequestError: unsupported parameter', 'bad_request'],
    ['something odd happened', 'operation_failed'],
    ['', 'operation_failed']
  ])('reads %j as %s', (text, code) => {
    expect(classifyTurnErrorText(text)).toBe(code)
  })
})

describe('turnErrorCode', () => {
  // Pilot 2026-11: the card said "Workmate hit a problem on this machine …
  // restart Workmate" over "This account can only use models through AgentX AI
  // Gateway" — the wrong failure and the wrong remedy.
  it('shows an account-gateway refusal as a model the account cannot use', () => {
    const text = 'agent init failed: This account can only use models through AgentX AI Gateway.'

    // With the code a current backend sends…
    expect(turnErrorCode({ code: 'model_not_allowed', text })).toBe('model_not_allowed')
    // …and from the text alone, for one that does not.
    expect(turnErrorCode({ text })).toBe('model_not_allowed')
    expect(describeTurnError({ text }, en).kind).toBe('model_not_allowed')
    expect(describeTurnError({ text }, en).retry).toBe(false)
  })

  it("keeps the gateway's code over the text", () => {
    expect(turnErrorCode({ code: 'rate_limited', text: 'Connection error.' })).toBe('rate_limited')
    expect(turnErrorCode({ code: 'license_expired', text: 'whatever' })).toBe('license_expired')
  })

  it('reads the text when the code is only the fallback, or missing', () => {
    expect(
      turnErrorCode({
        code: 'operation_failed',
        text: 'Context length exceeded: max compression attempts (3) reached.'
      })
    ).toBe('context_too_long')
    expect(turnErrorCode({ code: null, text: 'HTTP 429' })).toBe('rate_limited')
    expect(turnErrorCode({ text: 'odd' })).toBe('operation_failed')
  })

  it("lets the backend's broad buckets give way to what the text names", () => {
    // Seen on the real backend: its classifier files these as a malformed request…
    expect(turnErrorCode({ code: 'bad_request', text: 'HTTP 400: Budget has been exceeded! Current cost: 5.01' })).toBe(
      'quota_exceeded'
    )
    expect(
      turnErrorCode({
        code: 'bad_request',
        text: 'HTTP 400: Your request was rejected as a result of our safety system.'
      })
    ).toBe('content_filtered')
    // …and a refused connection as a timeout.
    expect(turnErrorCode({ code: 'timeout', text: 'Connection error.' })).toBe('network_error')
    // A vague reading never replaces the code, and other codes stand.
    expect(turnErrorCode({ code: 'bad_request', text: 'HTTP 400: unsupported value' })).toBe('bad_request')
    expect(turnErrorCode({ code: 'timeout', text: 'HTTP 429' })).toBe('timeout')
    expect(turnErrorCode({ code: 'rate_limited', text: 'Budget has been exceeded!' })).toBe('rate_limited')
  })

  it('tells an overloaded provider apart from other upstream failures', () => {
    expect(turnErrorCode({ code: 'upstream_error', reason: 'overloaded', text: 'HTTP 500' })).toBe('overloaded')
    expect(turnErrorCode({ code: 'upstream_error', text: 'HTTP 503: Service Unavailable' })).toBe('overloaded')
    expect(turnErrorCode({ code: 'upstream_error', reason: 'server_error', text: 'HTTP 500' })).toBe('upstream_error')
  })

  it('says offline when the device had no network and the failure is network-shaped', () => {
    for (const code of ['network_error', 'timeout', 'stream_interrupted', 'operation_failed']) {
      expect(turnErrorCode({ code, online: false, text: 'x' })).toBe('offline')
    }

    expect(turnErrorCode({ code: 'rate_limited', online: false, text: 'x' })).toBe('rate_limited')
    expect(turnErrorCode({ code: 'network_error', online: true, text: 'x' })).toBe('network_error')
  })
})

describe('retryAfterSeconds', () => {
  it.each([
    ['Retry-After: 20', 20],
    ["{'retry-after': '20'}", 20],
    ['retry_after=7', 7],
    ['Please try again in 20s.', 20],
    ['Please try again in 1.2s.', 2],
    ['Please try again in 450ms.', 1],
    ['try again in 2 minutes', 120],
    ['limit resets in 45 seconds', 45]
  ])('reads %j as %i s', (text, seconds) => {
    expect(retryAfterSeconds(text)).toBe(seconds)
  })

  it.each(['Retry-After: 0', 'Retry-After: 7200', 'no wait given'])('ignores %j', text => {
    expect(retryAfterSeconds(text)).toBeUndefined()
  })
})

describe('turnErrorDetails', () => {
  it('puts the code first, then the raw text', () => {
    expect(turnErrorDetails({ code: 'rate_limited' }, ' HTTP 429: slow down ', vi.turnError)).toBe(
      'Mã lỗi: rate_limited\nHTTP 429: slow down'
    )
  })

  it('shows the code alone when the failure came with no text', () => {
    expect(turnErrorDetails({ code: 'operation_failed' }, 'operation_failed', en.turnError)).toBe(
      'Error code: operation_failed'
    )
    expect(turnErrorDetails({ code: 'operation_failed' }, '', en.turnError)).toBe('Error code: operation_failed')
  })
})
