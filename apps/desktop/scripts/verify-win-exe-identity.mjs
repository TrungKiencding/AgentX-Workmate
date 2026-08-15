/**
 * verify-win-exe-identity.mjs — fail the build when the packed Windows exe is
 * not branded as AgentX.
 *
 * WHY THIS EXISTS
 * ---------------
 * `build.win.signAndEditExecutable: false` used to be set, to keep
 * electron-builder away from signtool — enabling its exe editing also enables
 * its signing step, which fetches winCodeSign-2.6.0.7z, whose macOS symlinks
 * crash 7-Zip on non-admin Windows. Avoiding that is still correct.
 *
 * But that flag disables the RESOURCE EDITING too, and resource editing is
 * what puts the AgentX icon and product name into `AgentX Workmate.exe`. A
 * hand-rolled `rcedit` afterPack hook was meant to compensate; rcedit drives a
 * Windows .exe, so on a macOS or Linux build host it needs Wine and simply
 * failed — and the hook swallowed the failure so the build stayed green. Every
 * Windows artifact cut from a Mac shipped with Electron's stock atom icon,
 * calling itself "Electron" by "GitHub, Inc." in Task Manager, on the desktop
 * shortcut, and in Alt-Tab. A screenshot from a user is how that was found.
 *
 * The flag is now `signExecutable: false`, which turns off ONLY signing and
 * leaves electron-builder's own resource editing on. That editing is pure
 * JavaScript (`resedit` — no rcedit, no Wine, no winCodeSign), so it works
 * identically on every build host, and nothing needs to stamp anything by
 * hand. This module exists so that promise is CHECKED rather than trusted.
 *
 * WHICH HOOK
 * ----------
 * `afterSign`, not `afterPack`. electron-builder edits the executable's
 * resources inside `doSignAfterPack`, which runs AFTER the afterPack hooks
 * (see platformPackager.doPack) — a check there reads the exe before it has
 * been stamped and fails every build, including good ones. `signApp` still
 * returns true under `signExecutable: false`, so afterSign fires.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { checkWindowsExeIdentity, readIcoEntries, readPeIdentity } from './win-exe-identity.mjs'

export default async function verifyWindowsExeIdentity(context) {
  if (context.electronPlatformName !== 'win32') {
    return
  }

  const desktopRoot = path.resolve(import.meta.dirname, '..')
  const appInfo = context.packager?.appInfo
  const productFilename = appInfo?.productFilename || 'AgentX Workmate'
  const exe = path.join(context.appOutDir, `${productFilename}.exe`)
  const icon = path.join(desktopRoot, 'assets', 'icon.ico')

  let identity
  let icoEntries

  try {
    identity = readPeIdentity(readFileSync(exe))
    icoEntries = readIcoEntries(readFileSync(icon))
  } catch (error) {
    // Name the file. "not a PE executable" on its own, thrown from inside a
    // build hook, sends the reader looking in the wrong place.
    throw new Error(
      `Could not read the packed Windows identity (${exe} / ${icon}): ` +
        `${error instanceof Error ? error.message : String(error)}`
    )
  }

  // Only the two fields an operator would recognise on sight are pinned here.
  // The rest are covered by the "still says Electron" sweep inside the
  // checker, which is what actually catches an unstamped binary.
  const result = checkWindowsExeIdentity({
    identity,
    icoEntries,
    expect: {
      ProductName: appInfo?.productName || 'AgentX Workmate',
      CompanyName: appInfo?.companyName || 'AstralX Technology'
    }
  })

  if (!result.ok) {
    throw new Error(
      `${exe} is not branded as AgentX:\n` +
        result.problems.map(p => `  - ${p}`).join('\n') +
        '\n\nelectron-builder writes these resources during packing. It skips that ' +
        'when build.win.signAndEditExecutable is false — use signExecutable: false ' +
        'instead, which disables only code signing.'
    )
  }

  console.log(`[verify-win-exe-identity] ${productFilename}.exe carries the AgentX icon and identity`)
}
