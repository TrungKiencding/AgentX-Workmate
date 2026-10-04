/**
 * sign-mac-adhoc.mjs — give a macOS build without a Developer ID a signature that
 * stays the same app across releases.
 *
 * Without a signing identity electron-builder skips signing, and the bundle keeps
 * only the linker's ad-hoc signature: no sealed resources, an `Electron`
 * identifier, and a designated requirement that is just the binary's cdhash. Every
 * release has a new cdhash, so macOS treats each one as a different program: it
 * asks again for the microphone, Accessibility and folder access (TCC), and again
 * for the keychain item Electron's safeStorage keeps the sign-in in. Since the app
 * now replaces itself on every release (electron/app-update/), that would be every
 * update.
 *
 * This signs the bundle the way `agentx desktop` signs a local build
 * (hermes_cli/main.py _desktop_macos_local_codesign): inside out — standalone
 * Mach-O files, then nested frameworks and helper apps, then the app — keeping
 * the repo's entitlements under the hardened runtime, and pinning an
 * identifier-based designated requirement, which is what TCC and the keychain
 * match the next release against.
 *
 * A build that electron-builder signed with a real identity is left alone.
 */

import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const STANDALONE_NAMES = new Set(['chrome_crashpad_handler', 'spawn-helper'])
const STANDALONE_SUFFIXES = new Set(['.node', '.dylib'])

async function defaultRun(file, args) {
  const { stdout, stderr } = await execFileAsync(file, args, { maxBuffer: 16 * 1024 * 1024 })

  return { stdout: String(stdout), stderr: String(stderr) }
}

/** true when `app` carries an intact signature from a real (Team ID) identity. */
export async function hasRealSignature(app, run = defaultRun) {
  let details

  try {
    // codesign -dv writes its report to stderr.
    const { stdout, stderr } = await run('/usr/bin/codesign', ['-dv', app])

    details = `${stdout}\n${stderr}`
  } catch {
    return false
  }

  if (!/TeamIdentifier=/.test(details) || /TeamIdentifier=not set/.test(details)) {
    return false
  }

  try {
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])

    return true
  } catch {
    return false
  }
}

function walk(dir, visit) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)

    visit(full, entry)

    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      walk(full, visit)
    }
  }
}

/**
 * The signing passes, in order: every standalone Mach-O outside nested apps
 * (deepest first), then frameworks and helper apps (deepest first), then the app.
 * `bundleId(bundle)` reads a bundle's CFBundleIdentifier (null when it has none).
 */
export function signingPlan(app, { entitlements, inheritEntitlements, bundleId }) {
  const contents = path.join(app, 'Contents')
  const standalone = []
  const bundles = []

  walk(contents, (full, entry) => {
    const relative = path.relative(app, full).split(path.sep)
    // A nested helper app is signed as a bundle, everything inside it with it.
    const insideNestedApp = relative.slice(0, -1).some(part => part.endsWith('.app'))

    if (entry.isFile() && !insideNestedApp) {
      if (STANDALONE_NAMES.has(entry.name) || STANDALONE_SUFFIXES.has(path.extname(entry.name))) {
        standalone.push(full)
      }
    }

    if (
      entry.isDirectory() &&
      relative[1] === 'Frameworks' &&
      (entry.name.endsWith('.framework') || entry.name.endsWith('.app'))
    ) {
      bundles.push(full)
    }
  })

  const deepestFirst = (a, b) => b.split(path.sep).length - a.split(path.sep).length || a.localeCompare(b)

  return [
    ...standalone
      .sort(deepestFirst)
      .map(file => ({ path: file, runtime: false, entitlements: null, identifier: null })),
    ...bundles.sort(deepestFirst).map(bundle => ({
      path: bundle,
      runtime: true,
      entitlements: bundle.endsWith('.app') && path.basename(bundle).includes('Helper') ? inheritEntitlements : null,
      identifier: bundleId(bundle)
    })),
    { path: app, runtime: true, entitlements, identifier: bundleId(app) }
  ]
}

/** The codesign arguments for one step of the plan. */
export function codesignArgs(step) {
  const args = ['--force', '--sign', '-', '--timestamp=none']

  if (step.runtime) {
    args.push('--options', 'runtime')
  }

  if (step.entitlements) {
    args.push('--entitlements', step.entitlements)
  }

  if (step.identifier) {
    // An ad-hoc signature's default requirement is the cdhash; pin the
    // identifier so the next release still satisfies it.
    args.push('--requirements', `=designated => identifier "${step.identifier}"`)
  }

  args.push(step.path)

  return args
}

/** CFBundleIdentifier from an Info.plist, or null. */
export function plutilBundleId(info) {
  try {
    return (
      execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', info], { encoding: 'utf8' }).trim() ||
      null
    )
  } catch {
    return null
  }
}

/** A bundle's identifier: an app's Contents/Info.plist, a framework's Resources/Info.plist. */
function bundleIdOf(bundle, readBundleId) {
  const info = [path.join(bundle, 'Contents', 'Info.plist'), path.join(bundle, 'Resources', 'Info.plist')].find(file =>
    fs.existsSync(file)
  )

  return info ? readBundleId(info) : null
}

/**
 * Sign `app` ad-hoc with stable designated requirements, then verify it strictly.
 * `readBundleId(infoPlist)` returns the plist's CFBundleIdentifier.
 */
export async function signAppAdHoc(
  app,
  { entitlements, inheritEntitlements, readBundleId = plutilBundleId, run = defaultRun }
) {
  for (const file of [entitlements, inheritEntitlements]) {
    if (!fs.existsSync(file)) {
      // The hardened runtime is enforced for ad-hoc signatures too: without the
      // allow-jit entitlements Electron would crash on launch.
      throw new Error(`missing entitlements ${file}`)
    }
  }

  const plan = signingPlan(app, {
    entitlements,
    inheritEntitlements,
    bundleId: bundle => bundleIdOf(bundle, readBundleId)
  })

  for (const step of plan) {
    await run('/usr/bin/codesign', codesignArgs(step))
  }

  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])

  return plan.length
}

/** electron-builder afterSign step for darwin; see the header. */
export default async function signMacAdHoc(context, { run = defaultRun, log = console.log } = {}) {
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)

  if (await hasRealSignature(app, run)) {
    return false
  }

  const desktopRoot = context.packager.projectDir
  const steps = await signAppAdHoc(app, {
    entitlements: path.join(desktopRoot, 'electron', 'entitlements.mac.plist'),
    inheritEntitlements: path.join(desktopRoot, 'electron', 'entitlements.mac.inherit.plist'),
    run
  })

  log(`[sign-mac-adhoc] signed ${path.basename(app)} ad-hoc with stable requirements (${steps} items)`)

  return true
}
