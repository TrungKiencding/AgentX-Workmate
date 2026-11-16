import { isKeycloakSignInFailure } from './boot-failure-reauth'

/**
 * Whether the AgentX sign-in gate should own the screen.
 *
 * Pure so it can be unit-tested without a React render (same reason
 * boot-failure-reauth.ts exists — this repo's vitest jsx-dev-runtime
 * resolution is unreliable for component renders).
 *
 * Three surfaces can each claim the whole window, so the conditions matter:
 *  - `bootError` must be the sign-in marker, not any other boot failure —
 *    BootFailureOverlay owns those and sits at the same z-rung.
 *  - `bootRunning` means boot is still in flight; a stale error from the last
 *    attempt must not flash a sign-in prompt over a working boot.
 *  - onboarding, while it owns the flow, surfaces its own progress; stacking on
 *    top of it would hide it.
 *
 * `handingOff` is the exception to all three: the sign-in has succeeded and
 * the gate is restarting the backend and reloading the window. That restart
 * flips the boot back to running at once, and letting go of the window then
 * left nothing in front of the bare chat shell until the reload. The gate
 * keeps the window, in its "signed in" state, until the reload replaces it.
 */
export function shouldShowSignInGate(args: {
  bootError: null | string | undefined
  bootRunning: boolean
  handingOff?: boolean
  onboardingStatus: string
}): boolean {
  if (args.handingOff) {
    return true
  }

  const onboardingOwnsFlow = args.onboardingStatus !== 'idle' && args.onboardingStatus !== 'error'

  if (onboardingOwnsFlow) {
    return false
  }

  return Boolean(args.bootError) && !args.bootRunning && isKeycloakSignInFailure(args.bootError)
}
