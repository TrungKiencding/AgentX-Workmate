/**
 * after-sign.mjs — electron-builder's `afterSign` hook, dispatched by platform.
 *
 * This hook fires once the packed executable is final: electron-builder has
 * written its version resources and icon (and signed it, where signing is
 * configured). Each job hanging off that moment lives in its own module, so
 * this file is only the switch:
 *
 *   darwin → sign-mac-adhoc.mjs       no Developer ID: a signature that stays the
 *                                     same app across releases (TCC, keychain)
 *            notarize.mjs             a Developer ID: submit to Apple and staple
 *   win32  → verify-win-exe-identity  refuse to ship an unbranded exe
 *
 * afterSign rather than afterPack: electron-builder signs, and on Windows edits
 * the exe's resources, inside doSignAfterPack, which runs after the afterPack
 * hooks — work there would be overwritten, and a check would read the binary
 * before it has been stamped. See verify-win-exe-identity.mjs for that story.
 */

import notarize from './notarize.mjs'
import signMacAdHoc from './sign-mac-adhoc.mjs'
import verifyWindowsExeIdentity from './verify-win-exe-identity.mjs'

export default async function afterSign(context) {
  if (context.electronPlatformName === 'darwin') {
    // Exactly one of the two applies: the ad-hoc signer leaves a build with a
    // real identity alone, and notarizing needs one.
    await signMacAdHoc(context)
    await notarize(context)

    return
  }

  if (context.electronPlatformName === 'win32') {
    await verifyWindowsExeIdentity(context)
  }
}
