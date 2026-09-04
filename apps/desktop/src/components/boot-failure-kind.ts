/**
 * Which kind of local boot failure a `$desktopBoot.error` describes.
 *
 * The main process reports failures as English prose — it has no locale and
 * its messages double as log lines. The recovery overlay needs a *kind*, so it
 * can explain the failure in the app's language and lead with the action that
 * fixes it. Matching is on the stable phrases `electron/main.ts`,
 * `backend-ready.ts` and `backend-health.ts` raise; keep the two in step.
 *
 * Pure so it can be unit-tested without a React render (the same reason
 * `boot-failure-reauth.ts` exists).
 */
export type BootFailureKind = 'exited' | 'install' | 'port' | 'timeout' | 'unknown' | 'websocket'

export function classifyBootFailure(error: null | string | undefined): BootFailureKind {
  const text = String(error || '').toLowerCase()

  if (!text) {
    return 'unknown'
  }

  // "exited before port announcement" is an exit first and a port problem
  // second — the process is gone, retrying the port would not help.
  if (text.includes('exited before') || text.includes('backend exited') || text.includes('background process exited')) {
    return 'exited'
  }

  if (text.includes('port announcement')) {
    return 'port'
  }

  if (text.includes('/api/ws') || text.includes('websocket')) {
    return 'websocket'
  }

  if (text.includes('bootstrap') || text.includes('install was cancelled')) {
    return 'install'
  }

  if (text.includes('timed out') || text.includes('did not become ready') || text.includes('etimedout')) {
    return 'timeout'
  }

  return 'unknown'
}
