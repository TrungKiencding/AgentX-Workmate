/**
 * after-sign.mjs — electron-builder's `afterSign` hook, dispatched by platform.
 *
 * This hook fires once the packed executable is final: electron-builder has
 * written its version resources and icon (and signed it, where signing is
 * configured). Two unrelated jobs hang off that moment, one per platform, so
 * this file is only the switch — each job lives in its own module.
 *
 *   darwin → notarize.mjs             submit the .app to Apple and staple it
 *   win32  → verify-win-exe-identity  refuse to ship an unbranded exe
 *
 * afterSign rather than afterPack for the Windows check: electron-builder
 * edits the exe's resources inside doSignAfterPack, which runs after the
 * afterPack hooks, so a check there would read the binary before it has been
 * stamped. See verify-win-exe-identity.mjs for the full story.
 */

import notarize from './notarize.mjs'
import verifyWindowsExeIdentity from './verify-win-exe-identity.mjs'

export default async function afterSign(context) {
  if (context.electronPlatformName === 'darwin') {
    await notarize(context)

    return
  }

  if (context.electronPlatformName === 'win32') {
    await verifyWindowsExeIdentity(context)
  }
}
