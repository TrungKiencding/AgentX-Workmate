#!/usr/bin/env node
/**
 * `npm run dev`, except every launch boots like the first one: sign-in,
 * onboarding, no conversation history.
 *
 * Dev runs against an AgentX home and an Electron userData of its own, and
 * both are wiped before each launch. The real ones are never touched: plain
 * `npm run dev` uses ~/.agentx and the `AgentX Workmate` userData directory,
 * the same two an installed Workmate and the `agentx` CLI use, and ~/.agentx
 * also holds things that are not app state at all (webmate-keys). Plain
 * `npm run dev` keeps using them exactly as before.
 *
 * One deliberate departure from a literal first launch: device.json survives a
 * reset. The keys service keeps one row per device id, so a new id every launch
 * would leave one more stale device in the account's device list every launch.
 * The sandbox keeps an id of its own.
 *
 * Usage:
 *   npm run dev:fresh --workspace apps/desktop
 */

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { isCredentialEnvVar, isMain } from './utils.mjs'

const DESKTOP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_SANDBOX_ROOT = path.join(os.tmpdir(), 'agentx-desktop-dev-fresh')

const USAGE = `Usage: npm run dev:fresh --workspace apps/desktop

Wipes the dev sandbox, then runs \`npm run dev\` inside it.`

export function sandboxPaths(root = DEFAULT_SANDBOX_ROOT) {
  const runDir = path.join(root, 'run')

  return {
    root,
    runDir,
    savedDeviceId: path.join(root, 'device.json'),
    userDataDir: path.join(runDir, 'electron-user-data'),
    agentxHome: path.join(runDir, 'agentx-home')
  }
}

// Chromium's singleton lock is a symlink to `<hostname>-<pid>` on macOS and
// Linux, and it is left behind whenever the app is killed rather than quit
// (Ctrl+C, concurrently -k). A live pid alone would let a pid the OS has since
// handed to another process block every reset, so it must still be a dev
// Electron. (Windows keeps a plain lockfile instead, which rmSync cannot delete
// while the app holds it.)
export function liveSandboxPid(userDataDir) {
  let target

  try {
    target = fs.readlinkSync(path.join(userDataDir, 'SingletonLock'))
  } catch {
    return null
  }

  const pid = Number(target.slice(target.lastIndexOf('-') + 1))

  if (!Number.isInteger(pid) || pid <= 0) {
    return null
  }

  const ps = spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' })

  return ps.status === 0 && /[\\/]electron[\\/]dist[\\/]/i.test(ps.stdout) ? pid : null
}

export function resetSandbox(paths) {
  const pid = liveSandboxPid(paths.userDataDir)

  if (pid) {
    throw new Error(`the last dev:fresh app is still running (pid ${pid}); quit it first`)
  }

  const deviceId = path.join(paths.userDataDir, 'device.json')

  if (fs.existsSync(deviceId)) {
    fs.copyFileSync(deviceId, paths.savedDeviceId)
  }

  fs.rmSync(paths.runDir, { recursive: true, force: true })
  fs.mkdirSync(paths.userDataDir, { recursive: true })
  fs.mkdirSync(paths.agentxHome, { recursive: true })

  if (fs.existsSync(paths.savedDeviceId)) {
    fs.copyFileSync(paths.savedDeviceId, deviceId)
  }
}

export function freshEnv(baseEnv, paths) {
  const env = Object.fromEntries(Object.entries(baseEnv).filter(([name]) => !isCredentialEnvVar(name)))

  env.AGENTX_HOME = paths.agentxHome
  env.AGENTX_DESKTOP_USER_DATA_DIR = paths.userDataDir

  return env
}

function main() {
  const args = process.argv.slice(2)

  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE)

    return
  }

  if (args.length > 0) {
    console.error(`Unknown option: ${args.join(' ')}\n\n${USAGE}`)
    process.exit(2)
  }

  const paths = sandboxPaths()

  try {
    resetSandbox(paths)
  } catch (error) {
    console.error(`[dev:fresh] ${error.message}`)
    process.exit(1)
  }

  console.log(`[dev:fresh] sandbox wiped, starting dev inside it
  AGENTX_HOME   ${paths.agentxHome}
  userData      ${paths.userDataDir}
`)

  // npm sets npm_execpath for the scripts it runs; going through its CLI with
  // this same node avoids resolving npm vs npm.cmd per platform.
  const npmCli = process.env.npm_execpath
  const [command, commandArgs] = npmCli ? [process.execPath, [npmCli, 'run', 'dev']] : ['npm', ['run', 'dev']]

  const child = spawn(command, commandArgs, {
    cwd: DESKTOP_ROOT,
    env: freshEnv(process.env, paths),
    shell: !npmCli && process.platform === 'win32',
    stdio: 'inherit'
  })

  // Ctrl+C reaches the whole foreground process group, so dev gets it directly;
  // stay alive until it has shut down and pass its exit code on.
  process.on('SIGINT', () => {})
  process.on('SIGTERM', () => child.kill('SIGTERM'))
  child.on('error', error => {
    console.error(`[dev:fresh] could not start npm run dev: ${error.message}`)
    process.exit(1)
  })
  child.on('exit', code => process.exit(code ?? 1))
}

if (isMain(import.meta.url)) {
  main()
}
