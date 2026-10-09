import { describe, expect, it } from 'vitest'

import type { DesktopAgentxKeyFailure, DesktopLicense } from '@/global'
import { en } from '@/i18n/en'
import { vi as viCatalog } from '@/i18n/vi'

import {
  agentxKeyContact,
  agentxKeyMessage,
  agentxKeyNeedsSupportLine,
  agentxKeyReason,
  agentxKeyReport,
  agentxKeySupportLine
} from './agentx-key'

const failure = (over: Partial<DesktopAgentxKeyFailure> = {}): DesktopAgentxKeyFailure => ({
  code: '',
  detail: '',
  license: null,
  status: 'error',
  ...over
})

const REVOKED_LICENSE: DesktopLicense = {
  access: 'read_only',
  contact: 'it@astralx.com.vn',
  enforced: true,
  notice: 'read_only',
  plan: { name: 'Pilot 2026', slug: 'pilot-2026' },
  state: 'revoked'
}

describe('agentxKeyReason', () => {
  it('names the SSO console refusal from the bug report, not the operator prose', () => {
    const reason = agentxKeyReason(
      failure({
        code: 'no_grantable_models',
        detail:
          'the second brain could not issue a key: the second brain returned HTTP 424: None of the models chosen in the SSO console is served by the model proxy right now.'
      }),
      viCatalog.agentxKey,
      viCatalog.license
    )

    expect(reason).toBe('Tài khoản của bạn chưa được gán model nào đang hoạt động trên AgentX AI Gateway.')
    expect(reason).not.toContain('HTTP 424')
  })

  it.each([
    [{ status: 'offline' }, en.agentxKey.reasons.offline],
    [{ status: 'revoked', code: 'device_revoked' }, en.agentxKey.reasons.revoked],
    [{ status: 'no-answer' }, en.agentxKey.reasons.noAnswer],
    [{ code: 'access_blocked' }, en.agentxKey.reasons.suspended],
    [{ code: 'issuance_disabled' }, en.agentxKey.reasons.issuanceOff],
    [{ code: 'litellm_refused' }, en.agentxKey.reasons.failed],
    [{}, en.agentxKey.reasons.failed]
  ])('gives %o its own sentence', (over, sentence) => {
    expect(agentxKeyReason(failure(over), en.agentxKey, en.license)).toBe(sentence)
  })

  it('says a refusal for the license the way the license is said everywhere', () => {
    expect(
      agentxKeyReason(failure({ license: REVOKED_LICENSE, status: 'license_inactive' }), en.agentxKey, en.license)
    ).toBe(
      'Your AgentX license has been revoked. Workmate is in read-only mode. Contact it@astralx.com.vn to get a license or renew it.'
    )
    expect(agentxKeyReason(failure({ status: 'license_inactive' }), en.agentxKey, en.license)).toBe(
      en.license.readOnlyGeneric
    )
  })

  it('treats a missing failure as no answer', () => {
    expect(agentxKeyReason(null, en.agentxKey, en.license)).toBe(en.agentxKey.reasons.noAnswer)
  })
})

describe('contacting support', () => {
  it('names the license contact the refusal carried, else the one this window knows', () => {
    expect(agentxKeyContact(failure({ license: REVOKED_LICENSE }))).toBe('it@astralx.com.vn')
    expect(agentxKeyContact(failure(), { ...REVOKED_LICENSE, contact: ' help@astralx.com.vn ' })).toBe(
      'help@astralx.com.vn'
    )
    expect(agentxKeyContact(failure(), null)).toBe('')
  })

  it('always ends in whom to contact', () => {
    expect(agentxKeySupportLine('', en.agentxKey)).toBe(en.agentxKey.contactSupport)
    expect(agentxKeySupportLine('it@astralx.com.vn', en.agentxKey)).toContain('it@astralx.com.vn')

    const message = agentxKeyMessage(failure({ code: 'no_grantable_models' }), en.agentxKey, en.license, null)

    expect(message).toBe(`${en.agentxKey.reasons.noModels} ${en.agentxKey.contactSupport}`)
  })

  it('does not name the contact twice when the license refusal already does', () => {
    const named = failure({ license: REVOKED_LICENSE, status: 'license_inactive' })
    const unnamed = failure({ status: 'license_inactive' })

    expect(agentxKeyNeedsSupportLine(named)).toBe(false)
    expect(agentxKeyNeedsSupportLine(unnamed)).toBe(true)
    expect(agentxKeyMessage(named, en.agentxKey, en.license)).toBe(agentxKeyReason(named, en.agentxKey, en.license))
    expect(agentxKeyMessage(unnamed, en.agentxKey, en.license)).toContain(en.agentxKey.contactSupport)
  })
})

describe('agentxKeyReport', () => {
  it('carries what support needs to find the account and the refusal', () => {
    const report = agentxKeyReport({
      appVersion: '1.0.9',
      now: new Date('2026-10-09T02:40:00.000Z'),
      state: {
        account: { displayName: 'Lê Trung Kiên', email: 'kien@astralx.com.vn' },
        attempts: 2,
        failure: failure({ code: 'no_grantable_models', detail: 'HTTP 424: None of the models…' })
      }
    })

    expect(report).toBe(
      [
        'AgentX Workmate 1.0.9',
        'account: Lê Trung Kiên · kien@astralx.com.vn',
        'status: error (no_grantable_models)',
        'detail: HTTP 424: None of the models…',
        'attempts: 2',
        'time: 2026-10-09T02:40:00.000Z'
      ].join('\n')
    )
  })

  it('stays readable with nothing known', () => {
    expect(agentxKeyReport({ now: new Date(0), state: { account: null, attempts: 1, failure: null } })).toBe(
      ['AgentX Workmate', 'status: no-answer', 'attempts: 1', 'time: 1970-01-01T00:00:00.000Z'].join('\n')
    )
  })
})
