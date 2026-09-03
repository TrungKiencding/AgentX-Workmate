import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { listPackage } from '@electron/asar'

import PACKAGE_JSON from '../package.json' with { type: 'json' }

const MODE = process.argv[2] || 'help'
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64'
const DESKTOP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RELEASE_ROOT = path.join(DESKTOP_ROOT, 'release')
const PLATFORM = process.platform

// Platform-specific packaged-app layout. The thin installer ships an Electron
// app shell plus extraResources (install-stamp.json + native-deps/) -- it
// no longer bundles the AgentX Workmate Python payload (that's fetched at first
// launch via install.ps1 / install.sh, per the Phase 1 thin-installer flow).
const APP = (() => {
  if (PLATFORM === 'darwin') {
    const appPath = path.join(RELEASE_ROOT, `mac-${ARCH}`, 'AgentX Workmate.app')
    return {
      appPath,
      binary: path.join(appPath, 'Contents', 'MacOS', 'AgentX Workmate'),
      resourcesPath: path.join(appPath, 'Contents', 'Resources'),
      asarPath: path.join(appPath, 'Contents', 'Resources', 'app.asar'),
      unpackedDistIndex: path.join(appPath, 'Contents', 'Resources', 'app.asar.unpacked', 'dist', 'index.html')
    }
  }
  if (PLATFORM === 'win32') {
    const unpacked = path.join(RELEASE_ROOT, 'win-unpacked')
    return {
      appPath: unpacked,
      binary: path.join(unpacked, 'AgentX Workmate.exe'),
      resourcesPath: path.join(unpacked, 'resources'),
      asarPath: path.join(unpacked, 'resources', 'app.asar'),
      unpackedDistIndex: path.join(unpacked, 'resources', 'app.asar.unpacked', 'dist', 'index.html')
    }
  }
  // linux unpacked layout matches windows but with different binary name
  const unpacked = path.join(RELEASE_ROOT, 'linux-unpacked')
  return {
    appPath: unpacked,
    binary: path.join(unpacked, 'AgentX Workmate'),
    resourcesPath: path.join(unpacked, 'resources'),
    asarPath: path.join(unpacked, 'resources', 'app.asar'),
    unpackedDistIndex: path.join(unpacked, 'resources', 'app.asar.unpacked', 'dist', 'index.html')
  }
})()

// Default AGENTX_HOME for non-sandboxed runs -- matches main.ts's
// resolveHermesHome(). On Windows it's %LOCALAPPDATA%\agentx; elsewhere
// it's ~/.agentx. The fresh-install sandbox launchFresh() sets its own
// AGENTX_HOME and never touches this.
const DEFAULT_AGENTX_HOME = (() => {
  if (PLATFORM === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'agentx')
  }
  return path.join(os.homedir(), '.agentx')
})()
const VENV_ROOT = path.join(DEFAULT_AGENTX_HOME, 'agentx-agent', 'venv')
const FRESH_SANDBOX_ROOT = path.join(os.tmpdir(), 'agentx-desktop-fresh-install')

function die(message) {
  console.error(`\n${message}`)
  process.exit(1)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || DESKTOP_ROOT,
    env: options.env || process.env,
    shell: Boolean(options.shell) || PLATFORM === 'win32',
    stdio: 'inherit'
  })

  if (result.status !== 0) {
    die(`${command} ${args.join(' ')} failed`)
  }
}

function exists(target) {
  return fs.existsSync(target)
}

// Match node-pty native binding location to what the bundled electron-main.cjs
// resolves at runtime. stage-native-deps.mjs stages node-pty into
// dist/node_modules/node-pty, and dist/** is asarUnpacked (see package.json
// build.asarUnpack), so in a packaged build it lands under
// resources/app.asar.unpacked/dist/node_modules/node-pty — reachable by a bare
// require('node-pty') from the bundle. Upstream node-pty 1.x is N-API based and
// ships per-arch prebuilts under prebuilds/<platform>-<arch>/; nix/local builds
// instead compile from source into build/Release/. The stage script copies
// whichever is present, so we accept either as the native payload.
function expectedNativeDepPaths() {
  const root = path.join(APP.resourcesPath, 'app.asar.unpacked', 'dist', 'node_modules', 'node-pty')
  const prebuildsDir = path.join(root, 'prebuilds', `${PLATFORM}-${ARCH}`)
  const buildReleaseDir = path.join(root, 'build', 'Release')
  return {
    packageJson: path.join(root, 'package.json'),
    prebuildsDir,
    buildReleaseDir,
    libIndex: path.join(root, 'lib', 'index.js')
  }
}

// Anything shaped like a LiteLLM virtual key. The prefix alone is too common
// to assert on (it appears in prose and in variable names); a prefix followed
// by a long opaque run is not.
//
// The lookbehind keeps `sk-` from matching mid-word. Without it the shiki
// bundle tripped the gate on its emacs-lisp grammar, where the builtin
// `ask-user-about-supersession-threat` reads as sk- plus a 30-char run. A
// real key is always at a token boundary: after `=`, a quote, or whitespace.
const LITELLM_KEY_SHAPE = /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{24,}/

// Skip files large enough that scanning them costs real time and that could
// not plausibly be hiding a hand-placed credential.
const SCAN_SIZE_LIMIT_BYTES = 96 * 1024 * 1024

/**
 * Fail if anything under resources/ looks like it carries the LiteLLM admin
 * key.
 *
 * The plan's acceptance check, done the only way that is worth anything:
 * against the built artifact. A source-level assertion would pass on a build
 * whose deployment step put the key back.
 */
function assertNoAdminKeyInPackage() {
  const offenders = []

  const walk = directory => {
    let entries = []
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const target = path.join(directory, entry.name)

      if (entry.isDirectory()) {
        walk(target)
        continue
      }
      if (!entry.isFile()) continue

      let text
      try {
        if (fs.statSync(target).size > SCAN_SIZE_LIMIT_BYTES) continue
        // latin1 so the asar archive's embedded strings are searchable as
        // bytes rather than being mangled by UTF-8 decoding.
        text = fs.readFileSync(target, 'latin1')
      } catch {
        continue
      }

      const match = text.match(LITELLM_KEY_SHAPE)
      if (match) {
        offenders.push(`${target} (matched ${match[0].slice(0, 8)}…)`)
      }
    }
  }

  walk(APP.resourcesPath)

  if (offenders.length) {
    die(
      'This package carries something shaped like a LiteLLM key:\n  ' +
        offenders.join('\n  ') +
        '\n\nNothing secret ships with the app. The admin key lives on the ' +
        'second-brain service, which issues each person one key over their ' +
        'Keycloak bearer.'
    )
  }
}

function ensurePlatformBuilds() {
  if (PLATFORM === 'darwin') return
  if (PLATFORM === 'win32') return
  if (PLATFORM === 'linux') return
  die(
    `Desktop bundle validation is only wired for darwin / win32 / linux; platform=${PLATFORM} is not supported.`
  )
}

function ensurePackagedApp() {
  if (process.env.AGENTX_DESKTOP_SKIP_BUILD === '1' && exists(APP.binary)) {
    return
  }

  run('npm', ['run', 'pack'])
}

function resolveDmgPath() {
  if (!exists(RELEASE_ROOT)) {
    return path.join(RELEASE_ROOT, `AgentX-${PACKAGE_JSON.version}-${ARCH}.dmg`)
  }

  const prefix = `AgentX-${PACKAGE_JSON.version}`
  const candidates = fs
    .readdirSync(RELEASE_ROOT)
    .filter(name => name.endsWith('.dmg'))
    .filter(name => name.startsWith(prefix))
    .filter(name => name.includes(ARCH))
    .sort((a, b) => {
      const aMtime = fs.statSync(path.join(RELEASE_ROOT, a)).mtimeMs
      const bMtime = fs.statSync(path.join(RELEASE_ROOT, b)).mtimeMs
      return bMtime - aMtime
    })

  return candidates.length > 0
    ? path.join(RELEASE_ROOT, candidates[0])
    : path.join(RELEASE_ROOT, `AgentX-${PACKAGE_JSON.version}-${ARCH}.dmg`)
}

function resolveNsisPath() {
  // electron-builder NSIS artifactName template is 'AgentX-${version}-${os}-${arch}.${ext}'
  if (!exists(RELEASE_ROOT)) return null
  const candidates = fs
    .readdirSync(RELEASE_ROOT)
    .filter(name => /\.exe$/i.test(name) && /win/i.test(name))
    .sort((a, b) => {
      const aMtime = fs.statSync(path.join(RELEASE_ROOT, a)).mtimeMs
      const bMtime = fs.statSync(path.join(RELEASE_ROOT, b)).mtimeMs
      return bMtime - aMtime
    })
  return candidates.length > 0 ? path.join(RELEASE_ROOT, candidates[0]) : null
}

function ensureDmg() {
  if (PLATFORM !== 'darwin') {
    die('DMG mode is macOS-only; on Windows use the `nsis` mode instead.')
  }
  if (process.env.AGENTX_DESKTOP_SKIP_BUILD === '1' && exists(resolveDmgPath())) {
    return
  }
  run('npm', ['run', 'dist:mac:dmg'])
}

function ensureNsis() {
  if (PLATFORM !== 'win32') {
    die('NSIS mode is win32-only; on macOS use the `dmg` mode instead.')
  }
  if (process.env.AGENTX_DESKTOP_SKIP_BUILD === '1' && resolveNsisPath()) {
    return
  }
  run('npm', ['run', 'dist:win:nsis'])
}

function openApp() {
  if (!exists(APP.binary)) {
    die(`Missing packaged app: ${APP.binary}`)
  }

  if (PLATFORM === 'darwin') {
    run('open', ['-n', APP.appPath])
  } else if (PLATFORM === 'win32') {
    // Spawn detached so the test script exits while the app keeps running.
    spawn(APP.binary, [], { detached: true, stdio: 'ignore' }).unref()
  } else {
    spawn(APP.binary, [], { detached: true, stdio: 'ignore' }).unref()
  }
}

function openDmg() {
  if (PLATFORM !== 'darwin') {
    die('DMG mode is macOS-only.')
  }
  const dmgPath = resolveDmgPath()
  if (!exists(dmgPath)) {
    die(`Missing DMG: ${dmgPath}`)
  }
  run('open', [dmgPath])
}

const CREDENTIAL_ENV_SUFFIXES = [
  '_API_KEY',
  '_TOKEN',
  '_SECRET',
  '_PASSWORD',
  '_CREDENTIALS',
  '_ACCESS_KEY',
  '_PRIVATE_KEY',
  '_OAUTH_TOKEN'
]

const CREDENTIAL_ENV_NAMES = new Set([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'CUSTOM_API_KEY',
  'GEMINI_BASE_URL',
  'OPENAI_BASE_URL',
  'OPENROUTER_BASE_URL',
  'OLLAMA_BASE_URL',
  'GROQ_BASE_URL',
  'XAI_BASE_URL'
])

function isCredentialEnvVar(name) {
  if (CREDENTIAL_ENV_NAMES.has(name)) return true
  return CREDENTIAL_ENV_SUFFIXES.some(suffix => name.endsWith(suffix))
}

function launchFresh() {
  if (!exists(APP.binary)) {
    die(`Missing app executable: ${APP.binary}`)
  }

  const sandbox = fs.mkdtempSync(`${FRESH_SANDBOX_ROOT}-`)
  const userDataDir = path.join(sandbox, 'electron-user-data')
  const hermesHome = path.join(sandbox, 'agentx-home')
  const cwd = path.join(sandbox, 'workspace')

  fs.mkdirSync(userDataDir, { recursive: true })
  fs.mkdirSync(hermesHome, { recursive: true })
  fs.mkdirSync(cwd, { recursive: true })

  // Strip every credential-shaped env var so the sandbox is actually fresh.
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (isCredentialEnvVar(key)) continue
    env[key] = value
  }

  env.AGENTX_DESKTOP_CWD = cwd
  env.AGENTX_DESKTOP_IGNORE_EXISTING = '1'
  env.AGENTX_DESKTOP_TEST_MODE = 'fresh-install'
  env.AGENTX_DESKTOP_USER_DATA_DIR = userDataDir
  env.AGENTX_HOME = hermesHome
  delete env.AGENTX_DESKTOP_AGENTX
  delete env.AGENTX_DESKTOP_AGENTX_ROOT

  const child = spawn(APP.binary, [], {
    cwd: os.homedir(),
    detached: true,
    env,
    stdio: 'ignore'
  })
  child.unref()

  console.log('\nFresh install sandbox:')
  console.log(`  root: ${sandbox}`)
  console.log(`  electron userData: ${userDataDir}`)
  console.log(`  AGENTX_HOME: ${hermesHome}`)
  console.log(`  cwd: ${cwd}`)

  return { runtimeRoot: path.join(hermesHome, 'agentx-agent', 'venv') }
}

// Validate the packaged bundle matches the thin-installer architecture:
//   - The AgentX Workmate Python payload is NOT shipped (it's fetched at first
//     launch via install.ps1's stage protocol).
//   - install-stamp.json IS shipped in resources/ with a valid commit + branch.
//   - node-pty IS shipped inside app.asar.unpacked/dist/node_modules/node-pty
//     with package.json + lib/ + at least one .node binary (the renderer's
//     integrated terminal needs this; see Phase 1F.6).
//   - The renderer's dist/index.html is reachable (either unpacked or
//     inside app.asar).
function validateBundle() {
  if (!exists(APP.binary)) {
    die(`Missing packaged app binary: ${APP.binary}`)
  }

  // Negative assertion: the OLD fat-installer factory payload must NOT be
  // present anymore. If a stray ship of hermes_cli sneaks back in we want
  // to fail loudly rather than re-introduce the 400MB delta we just removed.
  const staleFactoryMarker = path.join(APP.resourcesPath, 'agentx-agent', 'hermes_cli', 'main.py')
  if (exists(staleFactoryMarker)) {
    die(
      `Thin-installer regression: factory-payload file should NOT be in the package: ${staleFactoryMarker}`
    )
  }

  // Positive assertion: install-stamp.json carries a sane commit + branch
  const stampPath = path.join(APP.resourcesPath, 'install-stamp.json')
  if (!exists(stampPath)) {
    die(`Missing install-stamp.json (required for first-launch bootstrap pinning): ${stampPath}`)
  }
  let stamp
  try {
    stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8'))
  } catch (err) {
    die(`install-stamp.json is not valid JSON: ${err.message}`)
  }
  if (!stamp.commit || typeof stamp.commit !== 'string' || stamp.commit.length < 7) {
    die(`install-stamp.json is missing a usable commit field: ${JSON.stringify(stamp)}`)
  }
  if (!stamp.branch || typeof stamp.branch !== 'string') {
    die(`install-stamp.json is missing the branch field: ${JSON.stringify(stamp)}`)
  }

  // Negative assertion: no LiteLLM admin key ships inside the package.
  //
  // This used to be the opposite assertion. Every release carried the admin
  // credential in resources/deployment.json so that `mode: direct` laptops
  // could mint their own keys — which meant anyone who unpacked the .app or
  // .exe could read a key that mints and revokes for the whole estate. The
  // second-brain service holds it now.
  //
  // Checked against the artifact rather than the source, because the failure
  // this catches is a build script or a stray file putting it back, and
  // nothing about the running app would tell you.
  const deploymentPath = path.join(APP.resourcesPath, 'deployment.json')
  if (exists(deploymentPath)) {
    die(
      `deployment.json is back in the package: ${deploymentPath}\n` +
        'It existed to carry the LiteLLM admin key into installers. Nothing secret ' +
        'ships with the app any more — the second-brain service issues model keys.'
    )
  }
  assertNoAdminKeyInPackage()

  // Positive assertion: node-pty native deps shipped
  const native = expectedNativeDepPaths()
  if (!exists(native.packageJson)) {
    die(`Missing node-pty package.json in app.asar.unpacked: ${native.packageJson}`)
  }
  if (!exists(native.libIndex)) {
    die(`Missing node-pty lib/index.js in app.asar.unpacked: ${native.libIndex}`)
  }
  // The native binary lands in prebuilds/<platform>-<arch>/ (downloaded prebuild)
  // OR build/Release/ (compiled from source). stage-native-deps.mjs copies
  // whichever is present, so accept either.
  const nativeBinaryDirs = [native.prebuildsDir, native.buildReleaseDir].filter(exists)
  if (nativeBinaryDirs.length === 0) {
    die(
      `Missing node-pty native binary dir for ${PLATFORM}-${ARCH}: neither ` +
        `${native.prebuildsDir} nor ${native.buildReleaseDir} exists`
    )
  }
  const nodeBinaries = nativeBinaryDirs.flatMap(dir =>
    fs.readdirSync(dir).filter(name => name.endsWith('.node'))
  )
  if (nodeBinaries.length === 0) {
    die(`No .node native binaries found in: ${nativeBinaryDirs.join(', ')}`)
  }
  // Darwin requires a runtime-execed spawn-helper alongside pty.node; missing
  // it manifests as "ENOENT: spawn-helper" on first pty.spawn() call.
  if (PLATFORM === 'darwin') {
    const spawnHelper = nativeBinaryDirs
      .map(dir => path.join(dir, 'spawn-helper'))
      .find(exists)
    if (!spawnHelper) {
      die(`Missing node-pty spawn-helper (required on darwin) in: ${nativeBinaryDirs.join(', ')}`)
    }
  }

  // Renderer payload check (either unpacked or in the asar)
  if (exists(APP.unpackedDistIndex)) {
    return { stamp, nodeBinaries }
  }
  if (!exists(APP.asarPath)) {
    die(`Missing renderer payload: neither ${APP.unpackedDistIndex} nor ${APP.asarPath} exists`)
  }
  const files = listPackage(APP.asarPath)
  // Normalize separators because @electron/asar's listPackage returns
  // backslash-prefixed entries on Windows ('\\dist\\index.html') and
  // forward-slash on Unix.
  const normalized = files.map(f => f.replace(/\\/g, '/').replace(/^\/+/, ''))
  if (!normalized.includes('dist/index.html')) {
    die(`Missing renderer payload file in app.asar: ${APP.asarPath} (expected dist/index.html)`)
  }
  return { stamp, nodeBinaries }
}

function printArtifacts(options = {}) {
  const runtimeRoot = options.runtimeRoot || VENV_ROOT
  const stamp = options.stamp

  console.log('\nDesktop artifacts:')
  console.log(`  app: ${APP.appPath}`)
  if (PLATFORM === 'darwin') {
    console.log(`  dmg: ${resolveDmgPath()}`)
  } else if (PLATFORM === 'win32') {
    const exe = resolveNsisPath()
    if (exe) console.log(`  installer: ${exe}`)
  }
  console.log(`  runtime: ${runtimeRoot}`)
  if (stamp) {
    console.log(`  install-stamp: ${stamp.commit.slice(0, 12)} on ${stamp.branch}`)
  }
  if (options.nodeBinaries && options.nodeBinaries.length > 0) {
    console.log(`  node-pty binaries: ${options.nodeBinaries.join(', ')}`)
  }
}

function help() {
  console.log(`Usage:
  npm run test:desktop:existing  # build packaged app, launch with normal PATH/existing AgentX
  npm run test:desktop:fresh     # build packaged app, launch with temp userData + AGENTX_HOME
  npm run test:desktop:dmg       # (macOS only) build DMG and open it
  npm run test:desktop:nsis      # (win32 only) build NSIS installer
  npm run test:desktop:all       # build installer, validate app payload, print paths

Fast rerun (skip rebuild if the packaged app already exists):
  AGENTX_DESKTOP_SKIP_BUILD=1 npm run test:desktop:fresh
`)
}

ensurePlatformBuilds()

if (MODE === 'existing') {
  ensurePackagedApp()
  const result = validateBundle()
  openApp()
  printArtifacts(result)
} else if (MODE === 'fresh') {
  ensurePackagedApp()
  const result = validateBundle()
  printArtifacts({ ...launchFresh(), ...result })
} else if (MODE === 'dmg') {
  ensureDmg()
  openDmg()
  printArtifacts()
} else if (MODE === 'nsis') {
  ensureNsis()
  printArtifacts(validateBundle())
} else if (MODE === 'all') {
  if (PLATFORM === 'darwin') {
    ensureDmg()
  } else if (PLATFORM === 'win32') {
    ensureNsis()
  } else {
    ensurePackagedApp()
  }
  printArtifacts(validateBundle())
} else {
  help()
}
