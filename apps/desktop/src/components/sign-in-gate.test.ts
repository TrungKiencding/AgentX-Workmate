import { describe, expect, it } from 'vitest'

import { shouldShowSignInGate } from './sign-in-gate'

// Three surfaces can each claim the whole window (BootFailureOverlay,
// onboarding, and this gate). Getting this predicate wrong means either two
// stacked full-screen surfaces or a sign-in prompt flashing over a healthy boot.

const SIGN_IN_ERROR = 'AgentX sign-in required. Sign in with your AgentX account to start using AgentX Workmate.'

const base = { bootError: SIGN_IN_ERROR, bootRunning: false, onboardingStatus: 'idle' }

describe('shouldShowSignInGate', () => {
  it('shows for the sign-in marker on a settled boot', () => {
    expect(shouldShowSignInGate(base)).toBe(true)
  })

  it('leaves ordinary boot failures to the recovery overlay', () => {
    expect(shouldShowSignInGate({ ...base, bootError: 'Could not connect to AgentX gateway' })).toBe(false)
    expect(shouldShowSignInGate({ ...base, bootError: 'Remote gateway session has expired' })).toBe(false)
  })

  it('stays hidden while boot is still running', () => {
    // A stale error from the previous attempt must not flash over a boot that
    // is currently working.
    expect(shouldShowSignInGate({ ...base, bootRunning: true })).toBe(false)
  })

  it('stays hidden with no error at all', () => {
    expect(shouldShowSignInGate({ ...base, bootError: null })).toBe(false)
    expect(shouldShowSignInGate({ ...base, bootError: undefined })).toBe(false)
    expect(shouldShowSignInGate({ ...base, bootError: '' })).toBe(false)
  })

  it('yields to onboarding while it owns the flow', () => {
    for (const status of ['starting', 'awaiting_user', 'polling', 'submitting', 'success', 'confirming_model']) {
      expect(shouldShowSignInGate({ ...base, onboardingStatus: status })).toBe(false)
    }
  })

  it('takes over once onboarding is idle or has errored', () => {
    expect(shouldShowSignInGate({ ...base, onboardingStatus: 'idle' })).toBe(true)
    expect(shouldShowSignInGate({ ...base, onboardingStatus: 'error' })).toBe(true)
  })
})
