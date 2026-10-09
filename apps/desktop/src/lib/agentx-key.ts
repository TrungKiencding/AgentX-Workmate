import type { DesktopAgentxKeyFailure, DesktopAgentxKeyGate, DesktopLicense } from '@/global'
import type { Translations } from '@/i18n'
import { asLicense, type LicenseCopy, licenseReadOnlyMessage } from '@/lib/license'

/**
 * The words for an AgentX key that could not be issued — shared by the key gate
 * that holds the app and the onboarding card that connects the gateway, so both
 * say the same thing. Pure: the caller passes the copy.
 *
 * Every reason ends in "contact support": a signed-in person has no other
 * provider to fall back on and nothing to skip, so the one thing left besides
 * trying again is somebody who can fix the account. The service's own detail is
 * kept out of the sentence and offered as error details for that person.
 */

export type AgentxKeyCopy = Translations['agentxKey']

/** The keys service's codes (AgentX SSO, sso_console/ai/core.py) that have a sentence of their own. */
const REASON_BY_CODE: Record<string, keyof AgentxKeyCopy['reasons']> = {
  access_blocked: 'suspended',
  issuance_disabled: 'issuanceOff',
  no_grantable_models: 'noModels'
}

const REASON_BY_STATUS: Record<string, keyof AgentxKeyCopy['reasons']> = {
  'no-answer': 'noAnswer',
  offline: 'offline',
  revoked: 'revoked'
}

/** Why the key could not be issued, in this app's words. */
export function agentxKeyReason(
  failure: DesktopAgentxKeyFailure | null | undefined,
  copy: AgentxKeyCopy,
  licenseCopy: LicenseCopy
): string {
  if (!failure) {
    return copy.reasons.noAnswer
  }

  if (failure.status === 'license_inactive') {
    const license = asLicense(failure.license)

    return license ? licenseReadOnlyMessage(license, licenseCopy) : licenseCopy.readOnlyGeneric
  }

  const reason = REASON_BY_STATUS[failure.status] ?? REASON_BY_CODE[failure.code] ?? 'failed'

  return copy.reasons[reason]
}

/** Whom to ask, when the license names somebody: the one the refusal carried, else the one this window knows. */
export function agentxKeyContact(
  failure: DesktopAgentxKeyFailure | null | undefined,
  known?: DesktopLicense | null
): string {
  return (asLicense(failure?.license)?.contact ?? known?.contact ?? '').trim()
}

/** "Contact support", naming the contact when there is one. */
export function agentxKeySupportLine(contact: string, copy: AgentxKeyCopy): string {
  return contact ? copy.contactSupportAt(contact) : copy.contactSupport
}

/**
 * Whether "contact support" still needs saying after the reason. A license
 * refusal that names its contact already ends in whom to ask
 * (licenseReadOnlyMessage); saying it twice reads like two different people.
 */
export function agentxKeyNeedsSupportLine(failure: DesktopAgentxKeyFailure | null | undefined): boolean {
  const named = (asLicense(failure?.license)?.contact ?? '').trim()

  return !(failure?.status === 'license_inactive' && named)
}

/** The reason and whom to contact, as one paragraph — for surfaces with room for a sentence, not a notice. */
export function agentxKeyMessage(
  failure: DesktopAgentxKeyFailure | null | undefined,
  copy: AgentxKeyCopy,
  licenseCopy: LicenseCopy,
  known?: DesktopLicense | null
): string {
  const reason = agentxKeyReason(failure, copy, licenseCopy)

  return agentxKeyNeedsSupportLine(failure)
    ? `${reason} ${agentxKeySupportLine(agentxKeyContact(failure, known), copy)}`
    : reason
}

/**
 * The text "Copy error details" puts on the clipboard: everything support needs
 * to find the account and the refusal, in a form that survives a chat paste.
 */
export function agentxKeyReport({
  appVersion,
  now = new Date(),
  state
}: {
  appVersion?: string
  now?: Date
  state: Pick<DesktopAgentxKeyGate, 'account' | 'attempts' | 'failure'>
}): string {
  const { account, failure } = state
  const who = [account?.displayName, account?.email].filter(Boolean).join(' · ')

  return [
    `AgentX Workmate${appVersion ? ` ${appVersion}` : ''}`,
    who ? `account: ${who}` : '',
    `status: ${failure?.status || 'no-answer'}${failure?.code ? ` (${failure.code})` : ''}`,
    failure?.detail ? `detail: ${failure.detail}` : '',
    `attempts: ${state.attempts}`,
    `time: ${now.toISOString()}`
  ]
    .filter(Boolean)
    .join('\n')
}
